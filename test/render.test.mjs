// The pure rendering helpers, called directly. No fake server, no session, no sleeping.

import {
	ago,
	BUTTON_TEXT_MAX,
	badgeLine,
	buttonText,
	clip,
	duration,
	extractQuestionPreviews,
	fenceFor,
	fitToTelegram,
	isMarkupFailure,
	packRows,
	stanceOf,
	TELEGRAM_TEXT_MAX,
	toTelegramHtml,
} from "../render.ts";

let fails = 0;
const heading = (title) => {
	console.log(`\n-- ${title}`);
};
const check = (label, ok) => {
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
	if (!ok) fails++;
};

heading("markdown to telegram html");
check("bold, italic and strikethrough render", toTelegramHtml("**b** *i* ~~s~~") === "<b>b</b> <i>i</i> <s>s</s>");
check("a heading becomes bold", toTelegramHtml("## Title") === "<b>Title</b>");
check("inline code escapes its contents", toTelegramHtml("`a<b>`") === "<code>a&lt;b&gt;</code>");
check(
	"a fence keeps its language",
	toTelegramHtml("```rust\nlet x = 1;\n```") === '<pre><code class="language-rust">let x = 1;</code></pre>',
);
check("a fence without a language has no code element", toTelegramHtml("```\nplain\n```") === "<pre>plain</pre>");
check("emphasis cannot reach inside code", toTelegramHtml("`a *b* c`") === "<code>a *b* c</code>");
check(
	"snake_case survives single-underscore emphasis",
	toTelegramHtml("call some_long_name now").includes("some_long_name"),
);
check("a quote becomes a blockquote", toTelegramHtml("> quoted") === "<blockquote>quoted</blockquote>");
check(
	"consecutive quote lines merge into one blockquote",
	toTelegramHtml("> one\n> two") === "<blockquote>one\ntwo</blockquote>",
);
check("a spoiler renders", toTelegramHtml("||secret||") === "<tg-spoiler>secret</tg-spoiler>");
check(
	"a link keeps its label and escapes quotes in the href",
	toTelegramHtml('[doc](https://e.com/"q")') === '<a href="https://e.com/&quot;q&quot;">doc</a>',
);
check("a stash marker in the input cannot be forged", !toTelegramHtml("\u00000\u0000 `x`").includes("\u0000"));
check("ampersands escape before anything else", toTelegramHtml("a & b") === "a &amp; b");

heading("fitting a message to the telegram limit");
{
	const short = "a short message";
	check("text under the limit is untouched", fitToTelegram(short, "") === short);
	check("the kept tail is appended when nothing is cut", fitToTelegram(short, "\n\nfooter") === `${short}\n\nfooter`);

	// Escaping costs nothing on the wire, so 900 ampersands are 900 characters and fit whole.
	const dense = "&".repeat(900);
	check("escaping does not spend the budget", fitToTelegram(dense, "") === dense);

	const long = "&".repeat(5000);
	const cut = fitToTelegram(long, "\n\n`12 in / 34 out`");
	check("an oversized body is cut to fit", cut.length <= TELEGRAM_TEXT_MAX);
	check("the cut says it happened", cut.includes("truncated, full text at the terminal"));
	check("the kept tail survives the cut", cut.endsWith("\n\n`12 in / 34 out`"));
	check("the cut keeps as much as it can", cut.length > 4000);

	const fenced = `\`\`\`\n${"&".repeat(5000)}\n\`\`\``;
	const cutFence = fitToTelegram(fenced, "");
	check("a cut inside a fence closes it", (cutFence.match(/```/g) ?? []).length % 2 === 0);
	check("a closed fence renders as one pre block", (toTelegramHtml(cutFence).match(/<pre>/g) ?? []).length === 1);
	check("a cut fenced body fits", cutFence.length <= TELEGRAM_TEXT_MAX);

	const emoji = "\u{1F600}".repeat(3000);
	const cutEmoji = fitToTelegram(emoji, "");
	const lastUnit = cutEmoji.charCodeAt(cutEmoji.indexOf("\n\n(truncated") - 1);
	check("a cut between surrogate halves is pulled back", lastUnit < 0xd800 || lastUnit > 0xdbff);
}

heading("classifying a telegram refusal");
check(
	"a text-entity complaint is a markup failure",
	isMarkupFailure('Bad Request: can\'t parse entities: Unsupported start tag "b" at byte offset 12'),
);
check(
	"the older message-text wording is too",
	isMarkupFailure("Bad Request: can't parse message text: Can't find end of the entity starting at byte offset 40"),
);
// The plain retry keeps the same keyboard, so re-sending would repeat the identical request.
check("a keyboard complaint is not", !isMarkupFailure("Bad Request: can't parse reply markup JSON object"));
check(
	"a keyboard complaint naming a tag is not either",
	!isMarkupFailure("Bad Request: can't parse reply markup JSON object: Unsupported start tag"),
);
check("a rate limit is not", !isMarkupFailure("Too Many Requests: retry after 60"));
check("a missing message is not", !isMarkupFailure("Bad Request: message to edit not found"));
check("an unrelated refusal naming a tag is not", !isMarkupFailure("Bad Request: sticker set tag is invalid"));
check("a refusal with no description is not", !isMarkupFailure("no description"));

heading("clipping to a length cap");
check("text under the cap is untouched", clip("abc", 10) === "abc");
check("text at the cap is untouched", clip("abcde", 5) === "abcde");
check("a clip between surrogate halves drops the orphan", clip(`ab${"\u{1F600}"}`, 3) === "ab");
check("a clip on a whole pair keeps it", clip(`ab${"\u{1F600}"}cd`, 4) === `ab${"\u{1F600}"}`);

heading("budgeting a button label against its marker");
check("a label that fits keeps its marker", buttonText("ok", " (preferable)") === "ok (preferable)");
const longMarked = buttonText("x".repeat(80), " \u{1F7E0} (lukewarm)");
check("a long label yields to the marker", longMarked.endsWith(" \u{1F7E0} (lukewarm)"));
check("a budgeted label fits the cap", longMarked.length <= BUTTON_TEXT_MAX);
check("a budgeted cut never orphans a surrogate", buttonText(`${"x".repeat(59)}\u{1F600}`).length === 59);

heading("packing buttons into rows");
const button = (text) => ({ text, callback_data: "x" });
check("one button is one row", packRows([button("Go")]).length === 1);
check("two short labels share a row", packRows([button("Yes"), button("No")]).length === 1);
check("three tiny labels share a row", packRows([button("Yes"), button("No"), button("Maybe")]).length === 1);
check("a long label takes its own row", packRows([button("Yes"), button("A considerably longer label")]).length === 2);
// Three 8-character labels total 24, exactly the three-up cap. Measured in UTF-16 units
// they would total 48 and never share a row.
check(
	"width is counted in characters, not code units",
	packRows([button("\u{1F600}".repeat(8)), button("\u{1F600}".repeat(8)), button("\u{1F600}".repeat(8))]).length === 1,
);
check("no buttons means no rows", packRows([]).length === 0);

heading("previewing a half-streamed ask");
check(
	"a complete question is read",
	extractQuestionPreviews('{"questions":[{"question":"Ship it?"}]}')[0] === "Ship it?",
);
check(
	"a question cut mid-string is still read",
	extractQuestionPreviews('{"questions":[{"question":"Ship the big rel')[0] === "Ship the big rel",
);
check(
	"escaped quotes survive",
	extractQuestionPreviews('{"question":"Ship the \\"big\\" release?"}')[0] === 'Ship the "big" release?',
);
check("escaped newlines become newlines", extractQuestionPreviews('{"question":"a\\nb"}')[0] === "a\nb");
check("unicode escapes decode", extractQuestionPreviews('{"question":"caf\\u00e9"}')[0] === "caf\u00e9");
check("two questions are read in order", extractQuestionPreviews('{"question":"one"},{"question":"two"}').length === 2);
check("a blank question is skipped", extractQuestionPreviews('{"question":"   "}').length === 0);
check("a truncated unicode escape stops the read", extractQuestionPreviews('{"question":"a\\u00"}')[0] === "a");

heading("option stance");
const opts = [{ label: "a" }, { label: "b", lukewarm: true }, { label: "c", discouraged: true }];
const question = { id: "q", question: "?", options: opts, recommended: 0 };
check("the recommended index is preferable", stanceOf(question, opts[0], 0)?.marker === "(preferable)");
check("a lukewarm option is marked lukewarm", stanceOf(question, opts[1], 1)?.marker.includes("lukewarm") === true);
check("a discouraged option is marked discouraged", stanceOf(question, opts[2], 2)?.marker === "(discouraged)");
check("an unmarked option has no stance", stanceOf({ ...question, recommended: undefined }, opts[0], 0) === null);
check(
	"recommended wins over a contradicting discouraged",
	stanceOf({ ...question, recommended: 2 }, opts[2], 2)?.marker === "(preferable)",
);

heading("elapsed and badge text");
check("under a minute reads in seconds", duration(45_000) === "45s");
check("a whole minute drops the seconds", duration(120_000) === "2m");
check("a part minute keeps the seconds", duration(95_000) === "1m 35s");
check("a whole hour drops the minutes", duration(7_200_000) === "2h");
check("a part hour keeps the minutes", duration(5_400_000) === "1h 30m");
check("a negative elapsed clamps to zero", duration(-5_000) === "0s");
check("fresh reads as seconds ago", ago(1_000_000, 1_000_000) === "0s ago");
check("minutes round", ago(0, 150_000) === "3m ago");
check("hours round", ago(0, 7_200_000) === "2h ago");
check(
	"a badge names the folder and the detail",
	badgeLine("\u{1F98A}", "/home/dev/work/subql", "index work", "t1") === "\u{1F98A} subql \u00B7 index work",
);
check(
	"a badge falls back to the tag",
	badgeLine("\u{1F98A}", "/home/dev/work/subql", "", "t1") === "\u{1F98A} subql \u00B7 t1",
);
check(
	"a trailing slash does not empty the folder",
	badgeLine("x", "/home/dev/work/subql/", "d", "t") === "x subql \u00B7 d",
);
check(
	"a badge without an emoji does not open with a space",
	badgeLine("", "/home/dev/work/subql", "index work", "t1") === "subql \u00B7 index work",
);

heading("a fence that survives a fence inside it");
check("plain text takes the shortest fence", fenceFor("no ticks here") === "```");
check("a three-tick run inside forces four", fenceFor("before\n```rust\nlet x = 1;\n```\nafter") === "````");
check("a four-tick run inside forces five", fenceFor("x ```` y") === "`````");
check("an inline pair does not lengthen the fence", fenceFor("call `foo` twice") === "```");
check(
	"a longer fence closes only on its own run",
	toTelegramHtml("````\n```\ninner\n```\n````") === "<pre>```\ninner\n```</pre>",
);
check(
	"a longer fence still keeps its language",
	toTelegramHtml("````md\n```\nx\n```\n````") === '<pre><code class="language-md">```\nx\n```</code></pre>',
);
check("an unclosed fence stays literal", toTelegramHtml("```\nhalf a block").includes("```"));
check("a four-tick fence closed by three stays literal", toTelegramHtml("````\nbody\n```") === "````\nbody\n```");
check(
	"a closing run longer than the opener leaves no stray backtick",
	toTelegramHtml("```\nx\n````") === "<pre>x</pre>",
);

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);

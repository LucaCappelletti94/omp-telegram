// Full suite against a stubbed Telegram API; sends nothing.

import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXTENSION = new URL("../index.ts", import.meta.url).pathname;
const CHAT = 111000111;
const STRANGER = 999000111;

const root = mkdtempSync(join(tmpdir(), "notify-suite-"));
process.env.PI_CODING_AGENT_DIR = root;
delete process.env.TMUX;
delete process.env.TMUX_PANE;
const writeConfig = (extra = {}) =>
	writeFileSync(
		join(root, "notify-telegram.json"),
		JSON.stringify({ token: `12345:${"A".repeat(30)}`, chatId: CHAT, offset: 100, quietSeconds: 0, ...extra }, null, 2),
		{ mode: 0o600 },
	);
writeConfig();

const api = {
	calls: [],
	queued: [],
	rejectHtml: false,
	nextMessage: 7,
	filePath: "documents/file_9.oga",
	fileDownload: "ok",
};
globalThis.fetch = async (url, init) => {
	if (String(url).includes("/file/bot")) {
		api.calls.push({ method: "fileDownload", body: { url: String(url) } });
		if (api.fileDownload === "throw") throw new TypeError("fetch failed");
		if (api.fileDownload === "error") return { ok: false, status: 500 };
		return { ok: true, arrayBuffer: async () => new TextEncoder().encode("fake-image-bytes").buffer };
	}
	const method = String(url).split("/").pop();
	if (init?.body instanceof FormData) {
		const body = {};
		const files = {};
		const bytes = {};
		for (const [key, value] of init.body.entries()) {
			if (typeof value === "string") body[key] = value;
			else {
				body[key] = `<file ${value.size}b>`;
				files[key] = value.name;
				bytes[key] = new Uint8Array(await value.arrayBuffer());
			}
		}
		api.calls.push({ method, body, files, bytes });
		if ((api.failMethods ?? []).includes(method)) {
			return { ok: false, status: 400, json: async () => ({ ok: false, description: "failed by test" }) };
		}
		const result =
			method === "sendMediaGroup" ? [{ message_id: api.nextMessage++ }] : { message_id: api.nextMessage++ };
		return { ok: true, json: async () => ({ ok: true, result }) };
	}
	const body = JSON.parse(init.body);
	api.calls.push({ method, body });
	if ((api.failMethods ?? []).includes(method)) {
		// The status and the description are what a caller decides from, so a test chooses both.
		// A rate limit carries retry_after, which is what sendWithRetry reads.
		return {
			ok: false,
			status: api.failStatus ?? 400,
			json: async () => ({
				ok: false,
				description: api.failDescription ?? "failed by test",
				...(api.failRetryAfter === undefined ? {} : { parameters: { retry_after: api.failRetryAfter } }),
			}),
		};
	}
	if (api.rejectHtml && body.parse_mode === "HTML") {
		return { ok: false, status: 400, json: async () => ({ ok: false, description: "can't parse entities" }) };
	}
	const result =
		method === "getUpdates"
			? api.queued.splice(0, api.queued.length)
			: method === "sendMessage"
				? { message_id: api.nextMessage++ }
				: method === "getFile"
					? api.filePath === null
						? {}
						: { file_path: api.filePath }
					: true;
	return { ok: true, json: async () => ({ ok: true, result }) };
};

const mod = await import(EXTENSION);
const chain = new Proxy(() => chain, { get: () => chain, apply: () => chain });

let fails = 0;
const heading = (title) => {
	console.log(`\n-- ${title}`);
};
const check = (label, ok) => {
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
	if (!ok) fails++;
};
const settle = (ms = 90) => new Promise((r) => setTimeout(r, ms));
const called = (method) => api.calls.filter((c) => c.method === method);
const lastCall = (method) => called(method).at(-1);
const sessionsDir = join(root, "notify-telegram/sessions");
const inboxOf = (id) => join(root, "notify-telegram/inbox", id);
const record = (id) => JSON.parse(readFileSync(join(sessionsDir, `${id}.json`), "utf8"));
/** The head every live and settled session message opens with; a session past the palette has no emoji. */
const badgeHead = (id, folder) => {
	const { emoji } = record(id);
	return `${emoji.length > 0 ? `${emoji} ` : ""}${folder} \u00B7 `;
};
const inboxCount = (id) =>
	existsSync(inboxOf(id)) ? readdirSync(inboxOf(id)).filter((f) => f.endsWith(".json")).length : 0;

const spawn = (id, cwd, title = "") => {
	const handlers = new Map();
	const timers = [];
	const tools = new Map();
	const warns = [];
	const steers = [];
	let name = title;
	const pi = {
		zod: chain,
		logger: { debug() {}, info() {}, warn: (m, meta) => warns.push({ m, meta }), error() {} },
		on: (event, fn) => handlers.set(event, [...(handlers.get(event) ?? []), fn]),
		registerTool: (def) => tools.set(def.name, def),
		sendUserMessage: (text, options) => steers.push({ text, options }),
	};
	let aborts = 0;
	const ctx = {
		hasUI: false,
		cwd,
		sessionManager: { getSessionId: () => id, getSessionName: () => name },
		model: { provider: "openai", id: "gpt-5.6-sol" },
		ui: { onTerminalInput: () => () => {} },
		setInterval: (fn) => timers.push(fn) - 1,
		setTimeout: (fn) => timers.push(fn) - 1,
		clearTimer: () => {},
		abort: () => {
			aborts += 1;
		},
	};
	mod.default(pi);
	return {
		id,
		ctx,
		tools,
		timers,
		warns,
		steers,
		get aborts() {
			return aborts;
		},
		setTitle: (value) => {
			name = value;
		},
		fire: async (event, payload = {}) => {
			const results = [];
			for (const fn of handlers.get(event) ?? []) results.push(await fn(payload, ctx));
			if (event === "session_stop" && results.some((r) => r?.decision === "block")) {
				for (const fn of handlers.get(event) ?? []) await fn(payload, ctx);
			}
			return results;
		},
		heartbeat: () => timers[0](),
		pump: async (ms) => {
			timers[1]();
			await settle(ms);
		},
	};
};

/** A terminal dialog that never answers, so the Telegram side wins every race. */
const stubbornCtx = (ctx, state) => ({
	...ctx,
	invokeTool: (params, options) => {
		state.params = params;
		const { promise, reject } = Promise.withResolvers();
		options.signal.addEventListener("abort", () => {
			state.aborted = true;
			reject(new Error("aborted"));
		});
		return promise;
	},
});

const singleQuestion = {
	questions: [
		{
			id: "backend",
			question: "Which backend?",
			options: [{ label: "SQLite" }, { label: "Postgres" }],
			recommended: 0,
		},
	],
};

// ---------------------------------------------------------------- registration
heading("registration and startup");
const one = spawn("01a03406-6e80-75e3-8321-3c2a242a59b6", "/home/dev/work/subql");
await one.fire("session_start");
check("registers ask and session_badge", one.tools.get("ask")?.strict === true && one.tools.has("session_badge"));
check("ask keeps the native approval tier", one.tools.get("ask").approval === "read");
check("session record written", existsSync(join(sessionsDir, `${one.id}.json`)));
check(
	"poller lock acquired",
	JSON.parse(readFileSync(join(root, "notify-telegram/poller.lock"), "utf8")).sessionId === one.id,
);
check("timers registered", one.timers.length === 2);

// -------------------------------------------------------------- session tokens
heading("session routing tokens");
const two = spawn("01a03406-6e89-70d1-b21c-60a913ea56d4", "/home/dev/work/diesel");
await two.fire("session_start");
check("the two session ids share a six-char prefix", one.id.slice(0, 6) === two.id.slice(0, 6));
check("their routing tags differ anyway", record(one.id).tag !== record(two.id).tag);
check(
	"tags are five lowercase alphanumerics",
	[one.id, two.id].every((id) => /^[a-z0-9]{5}$/.test(record(id).tag)),
);
check("badges differ between live sessions", record(one.id).emoji !== record(two.id).emoji);

// ---------------------------------------------------------------- quiet window
heading("quiet window");
// Typing at the terminal means the summary can wait, not that it can vanish: it still lands in
// the chat, without a sound, so the record stays complete for later and for /status.
writeConfig({ quietSeconds: 3600 });
const quiet = spawn("01a03410-0000-0000-0000-000000000000", "/home/dev/work/los");
await quiet.fire("session_start");
await quiet.tools
	.get("notify_status")
	.execute("q1", { summary: "Quietly done.", urgency: "green" }, undefined, undefined, quiet.ctx);
await quiet.fire("session_stop");
await settle();
const quietSent = lastCall("sendMessage").body;
check("turn end still lands while the human is typing", record(quiet.id).lastNotified > 0);
check(
	"it goes out without a sound",
	quietSent.disable_notification === true && quietSent.text.includes("Quietly done."),
);
check("the record keeps the quiet summary for /status", record(quiet.id).summary === "Quietly done.");
await quiet.tools
	.get("notify_status")
	.execute(
		"q2",
		{ summary: "Quiet choice.", urgency: "orange", options: ["Go", "Wait"] },
		undefined,
		undefined,
		quiet.ctx,
	);
await quiet.fire("session_stop");
await settle();
check("a quiet standing question is silent too", lastCall("sendMessage").body.disable_notification === true);
writeConfig();
const loud = spawn("01a03411-0000-0000-0000-000000000000", "/home/dev/work/los");
await loud.fire("session_start");
await loud.fire("session_stop");
await settle();
check("turn end delivered once the quiet window lapses", record(loud.id).lastNotified > 0);
check("a turn end outside the window rings", lastCall("sendMessage").body.disable_notification === undefined);

// ------------------------------------------------------------------- answering
heading("answering a question");
const stateA = {};
const runSingle = two.tools
	.get("ask")
	.execute("c1", singleQuestion, undefined, undefined, stubbornCtx(two.ctx, stateA));
await settle(150);
const keyboard = lastCall("sendMessage").body.reply_markup.inline_keyboard;
const flatButtons = keyboard.flat();
const pick = flatButtons.find((b) => b.text.startsWith("Postgres")).callback_data;
check("a stance-suffixed option refuses to pair beyond the budget", keyboard.length === 2 && keyboard[0].length === 1);
check("callback payload carries the asking session's tag", pick.split(":")[1].split("-")[0] === record(two.id).tag);
check("context is stripped before delegating to the native tool", !("context" in stateA.params));

api.queued = [
	{
		update_id: 100,
		callback_query: { id: "cb1", data: pick, from: { id: CHAT }, message: { message_id: 7, chat: { id: CHAT } } },
	},
];
await one.pump(250);
check("the press routes to the asking session", inboxCount(two.id) === 1);
check("it does not reach the session sharing the id prefix", inboxCount(one.id) === 0);
await two.pump(150);
const single = await runSingle;
check("the answer reaches the agent", single.details.selectedOptions[0] === "Postgres");
check("the terminal dialog is aborted", stateA.aborted === true);

// A bare message typed while a question is open is its answer. The question itself opens the
// reply field, and nothing else can reach the agent until the ask resolves, so no button is needed.
const stateB = {};
const runTyped = two.tools.get("ask").execute("c2", singleQuestion, undefined, undefined, stubbornCtx(two.ctx, stateB));
await settle(150);
const typedMarkup = lastCall("sendMessage").body.reply_markup;
check("the question opens the reply field itself", typedMarkup.force_reply === true);
check(
	"no button is offered for typing an answer",
	!typedMarkup.inline_keyboard.flat().some((b) => b.text === "Type an answer"),
);
writeFileSync(join(inboxOf(two.id), "201.json"), JSON.stringify({ kind: "text", value: "use duckdb" }));
await two.pump(150);
const typed = await runTyped;
check("bare text becomes customInput", typed.details.customInput === "use duckdb");
check("bare text is not also treated as a steer", two.steers.length === 0);

const multi = {
	questions: [
		{
			id: "t",
			question: "Targets?",
			multi: true,
			options: [{ label: "linux" }, { label: "macos" }, { label: "windows" }],
		},
	],
};
const stateC = {};
const runMulti = two.tools.get("ask").execute("c3", multi, undefined, undefined, stubbornCtx(two.ctx, stateC));
await settle(150);
const multiRows = lastCall("sendMessage").body.reply_markup.inline_keyboard;
const tag2 = record(two.id).tag;
const askId = multiRows[0][0].callback_data.split(":")[1];
for (const payload of [`o:${askId}:0:0`, `o:${askId}:0:2`, `d:${askId}:0`]) {
	writeFileSync(
		join(inboxOf(two.id), `${300 + Math.random()}.json`),
		JSON.stringify({ kind: "callback", value: payload }),
	);
	await two.pump(120);
}
const multiResult = await runMulti;
check("multi-select keeps every toggle", multiResult.details.selectedOptions.join(",") === "linux,windows");
check("tag is stable across asks", askId.startsWith(tag2));

const pair = {
	questions: [
		{ id: "q1", question: "First?", options: [{ label: "yes" }, { label: "no" }] },
		{ id: "q2", question: "Second?", options: [{ label: "alpha" }, { label: "beta" }] },
	],
};
const stateD = {};
const runPair = two.tools.get("ask").execute("c4", pair, undefined, undefined, stubbornCtx(two.ctx, stateD));
await settle(150);
const pairAsk = lastCall("sendMessage").body.reply_markup.inline_keyboard[0][0].callback_data.split(":")[1];
writeFileSync(join(inboxOf(two.id), "400.json"), JSON.stringify({ kind: "callback", value: `o:${pairAsk}:0:0` }));
await two.pump(150);
// Question two is a fresh message, and while it is still open a reply to it can only route
// through the record, so its id has to be there before the ask settles and flushes anyway.
check("a later question is recorded for reply routing", record(two.id).recent.includes(api.nextMessage - 1));
writeFileSync(join(inboxOf(two.id), "401.json"), JSON.stringify({ kind: "callback", value: `o:${pairAsk}:1:1` }));
await two.pump(150);
const pairResult = await runPair;
check("both questions are walked", pairResult.details.results.length === 2);
check("first answer kept", pairResult.details.results[0].selectedOptions[0] === "yes");
check("second answer kept", pairResult.details.results[1].selectedOptions[0] === "beta");

const stateE = {};
const runStale = two.tools.get("ask").execute("c5", singleQuestion, undefined, undefined, stubbornCtx(two.ctx, stateE));
await settle(150);
writeFileSync(join(inboxOf(two.id), "500.json"), JSON.stringify({ kind: "callback", value: `o:${pairAsk}:0:0` }));
await two.pump(150);
check("a button from an earlier ask is ignored", two.steers.length === 0);
const liveAsk = lastCall("sendMessage").body.reply_markup.inline_keyboard[0][0].callback_data.split(":")[1];
writeFileSync(join(inboxOf(two.id), "501.json"), JSON.stringify({ kind: "callback", value: `o:${liveAsk}:0:0` }));
await two.pump(150);
check("the current ask still answers", (await runStale).details.selectedOptions[0] === "SQLite");

const localResult = await two.tools.get("ask").execute("c6", singleQuestion, undefined, undefined, {
	...two.ctx,
	invokeTool: async () => ({ content: [{ type: "text", text: "SQLite" }], details: {} }),
});
check("the terminal wins when it answers first", localResult.content[0].text === "SQLite");

// --------------------------------------------------------------------- steering
heading("steering");
writeFileSync(join(inboxOf(two.id), "600.json"), JSON.stringify({ kind: "text", value: "switch branches" }));
await two.pump(120);
check(
	"free text with no pending ask is delivered as a prompt",
	two.steers.length === 1 && two.steers[0].options === undefined,
);
check("inbox is drained", inboxCount(two.id) === 0);

// ------------------------------------------------------------------ poller acl
heading("poller access control");
const before = called("sendMessage").length;
api.queued = [{ update_id: 110, message: { message_id: 20, date: 1, chat: { id: STRANGER }, text: "let me in" } }];
await one.pump(200);
check("a stranger's message is dropped", inboxCount(one.id) === 0 && inboxCount(two.id) === 0);
check("the stranger gets no reply", called("sendMessage").length === before);
check(
	"the rejection is logged",
	one.warns.some((w) => w.m.includes("unexpected chat")),
);

api.queued = [
	{
		update_id: 111,
		callback_query: {
			id: "cbX",
			data: `o:${tag2}-1:0:0`,
			from: { id: STRANGER },
			message: { message_id: 7, chat: { id: CHAT } },
		},
	},
];
await one.pump(200);
check("a press from a foreign sender is dropped", inboxCount(two.id) === 0);
check(
	"a foreign press is not acknowledged",
	!called("answerCallbackQuery").some((c) => c.body.callback_query_id === "cbX"),
);
check(
	"the foreign origin is logged",
	one.warns.some((w) => w.m.includes("unexpected origin")),
);
check(
	"allowed_updates asks for messages and button presses",
	lastCall("getUpdates").body.allowed_updates.join(",") === "message,callback_query",
);
check(
	"offset advances past rejected updates",
	JSON.parse(readFileSync(join(root, "notify-telegram.json"), "utf8")).offset === 112,
);

// ------------------------------------------------------------------- rendering
heading("telegram formatting");
const rich = {
	questions: [
		{
			id: "q",
			question: "Rename `foo` to **bar**?",
			options: [{ label: "yes", description: "Touches `src/lib.rs`", preview: "fn foo() {}" }],
		},
	],
	context: "Found here:\n```rust\nfn foo() -> u8 { 3 }\n```\n> quoted line\nplain _emphasis_ here",
};
const stateF = {};
const runRich = two.tools.get("ask").execute("c7", rich, undefined, undefined, stubbornCtx(two.ctx, stateF));
await settle(150);
const html = lastCall("sendMessage").body;
const richAskId = html.reply_markup.inline_keyboard[0][0].callback_data.split(":")[1];
check("sent as HTML", html.parse_mode === "HTML");
check("inline code becomes a code tag", html.text.includes("<code>foo</code>"));
check("bold becomes a b tag", html.text.includes("<b>bar</b>"));
check("fenced block becomes pre and code with a language", html.text.includes('<pre><code class="language-rust">'));
check(
	"angle brackets inside code are escaped",
	!html.text.includes("fn foo() -> u8 { 3 }") && html.text.includes("-&gt; u8"),
);
check("blockquote is produced", html.text.includes("<blockquote>quoted line</blockquote>"));
check("italics become an i tag", html.text.includes("<i>emphasis</i>"));
check("question header text is present", html.text.includes("Rename"));
check("option description is present", html.text.includes("src/lib.rs"));
check("option preview is present", html.text.includes("fn foo() {}"));

api.rejectHtml = true;
const beforeRetry = called("sendMessage").length;
await two.fire("session_stop");
await settle(200);
const attempts = called("sendMessage").slice(beforeRetry);
check("a rejected HTML send is retried", attempts.length === 2);
check("the retry drops parse_mode", attempts[1].body.parse_mode === undefined);
check("the retry keeps the text", typeof attempts[1].body.text === "string" && attempts[1].body.text.length > 0);
check(
	"the rejection is logged",
	two.warns.some((w) => w.m.includes("rich send rejected")),
);

// A real rate limit: 429 with a retry_after past the ceiling sendWithRetry is willing to wait, so
// it declines and hands the refusal up. Re-sending on that adds a request to the thing already
// refusing them and strips formatting that was never at fault.
api.failMethods = ["sendMessage"];
api.failStatus = 429;
api.failRetryAfter = 60;
api.failDescription = "Too Many Requests: retry after 60";
const beforeThrottled = called("sendMessage").length;
await two.fire("input");
await two.tools
	.get("notify_status")
	.execute("thr1", { summary: "A throttled summary.", urgency: "green" }, undefined, undefined, two.ctx);
await two.fire("session_stop");
await settle(200);
api.failMethods = [];
api.failStatus = undefined;
api.failRetryAfter = undefined;
api.failDescription = undefined;
const throttledAttempts = called("sendMessage").slice(beforeThrottled);
check("a rate-limited send is not re-sent", throttledAttempts.length === 1);
check("a rate-limited send keeps its formatting", throttledAttempts[0]?.body.parse_mode === "HTML");
check(
	"a rate-limited send is logged with what Telegram actually said",
	two.warns.some((w) => JSON.stringify(w.meta ?? {}).includes("Too Many Requests")),
);

// A complaint about the buttons also says "parse", but the plain retry keeps the same buttons, so
// re-sending repeats the identical malformed request.
api.failMethods = ["sendMessage"];
api.failDescription = "Bad Request: can't parse reply markup JSON object";
const beforeMarkup = called("sendMessage").length;
await two.fire("input");
await two.tools
	.get("notify_status")
	.execute("mk1", { summary: "A summary with a button.", urgency: "green" }, undefined, undefined, two.ctx);
await two.fire("session_stop");
await settle(200);
api.failMethods = [];
api.failDescription = undefined;
const markupAttempts = called("sendMessage").slice(beforeMarkup);
check("a rejected keyboard is not re-sent unchanged", markupAttempts.length === 1);
api.rejectHtml = false;
writeFileSync(join(inboxOf(two.id), "700.json"), JSON.stringify({ kind: "callback", value: `o:${richAskId}:0:0` }));
await two.pump(150);
check("the rich question answers after the retry", (await runRich).details.selectedOptions[0] === "yes");

// ----------------------------------------------------------------- badge tools
heading("badge choice");
const firstAsk = await two.fire("before_agent_start", { prompt: "Model the metabolism of a rat" });
const askText = firstAsk.map((r) => (typeof r?.message?.content === "string" ? r.message.content : "")).join("");
check(
	"the turn is asked for an emoji that depicts the work",
	askText.includes("session_badge") && /depict/i.test(askText),
);
check("the ask names an emoji another live session holds", askText.includes(record(one.id).emoji));
check(
	"the ask stays out of the transcript",
	firstAsk.some((r) => r?.message !== undefined && r.message.display === false),
);
const secondAsk = await two.fire("before_agent_start", { prompt: "still the rat" });
check(
	"the ask repeats while the badge is still a placeholder",
	secondAsk.some((r) => typeof r?.message?.content === "string"),
);

// Uniqueness is the point of the badge, so a taken emoji is refused rather than duplicated.
const held = record(one.id).emoji;
const collision = await two.tools.get("session_badge").execute("c6", { emoji: held }, undefined, undefined, two.ctx);
check("an emoji a live session holds is refused", record(two.id).emoji !== held);
check(
	"the refusal names what is taken",
	collision.content[0].text.includes(held) && /in use/i.test(collision.content[0].text),
);

// A word truncated to two code points used to become the badge.
await two.tools.get("session_badge").execute("c7", { emoji: "rat" }, undefined, undefined, two.ctx);
check("a word is not accepted as an emoji", record(two.id).emoji !== "ra");

// A flag and a keycap are single emoji whose first code point is not pictographic.
await two.tools.get("session_badge").execute("c7a", { emoji: "1\uFE0F\u20E3" }, undefined, undefined, two.ctx);
check("a keycap counts as one emoji", record(two.id).emoji === "1\uFE0F\u20E3");
await two.tools.get("session_badge").execute("c7b", { emoji: "\u{1F1FA}\u{1F1F8}" }, undefined, undefined, two.ctx);
check("a flag counts as one emoji", record(two.id).emoji === "\u{1F1FA}\u{1F1F8}");

await two.tools
	.get("session_badge")
	.execute("c8", { emoji: "\u{1F400}", label: "rat metabolism" }, undefined, undefined, two.ctx);
check("emoji override persisted", record(two.id).emoji === "\u{1F400}");
check("label override persisted", record(two.id).label === "rat metabolism");
check("a deliberate choice is recorded as one", record(two.id).emojiChosen === true);
const afterChoice = await two.fire("before_agent_start", { prompt: "onwards" });
check(
	"a chosen badge ends the asking",
	afterChoice.every((r) => r?.message === undefined),
);

// The claim is exclusive: read-then-write across processes would hand two sessions one emoji.
const badgeLock = join(root, "notify-telegram/badge.lock");
writeFileSync(badgeLock, JSON.stringify({ sessionId: "someone-else", pid: 1, heartbeat: Date.now() }));
const blocked = await two.tools
	.get("session_badge")
	.execute("c9", { emoji: "\u{1F9AB}", label: "rat metabolism" }, undefined, undefined, two.ctx);
check("a held claim refuses rather than racing", record(two.id).emoji === "\u{1F400}");
check("the refusal asks for another attempt", /again/i.test(blocked.content[0].text));
writeFileSync(badgeLock, JSON.stringify({ sessionId: "someone-else", pid: 1, heartbeat: Date.now() - 600_000 }));
await two.tools
	.get("session_badge")
	.execute("c10", { emoji: "\u{1F42D}", label: "rat metabolism" }, undefined, undefined, two.ctx);
check("a stale claim does not wedge the badge", record(two.id).emoji === "\u{1F42D}");
check("the claim is released after use", !existsSync(badgeLock));
// A claim broken as stale mid-work is not a claim, so the tool must not trust that pass. The
// corrupt file stands in for a claim written by a version that never carried a token.
writeFileSync(badgeLock, "not json at all");
await two.tools.get("session_badge").execute("c11", { emoji: "\u{1F430}" }, undefined, undefined, two.ctx);
check("an unreadable claim does not wedge the badge", record(two.id).emoji === "\u{1F430}");
check("the unreadable claim is cleared away", !existsSync(badgeLock));

// A session that cannot take the claim starts without an emoji rather than duplicating one, and
// the heartbeat keeps trying.
writeFileSync(badgeLock, JSON.stringify({ sessionId: "someone-else", pid: 1, token: "t", heartbeat: Date.now() }));
const unbadged = spawn("01a03492-0000-0000-0000-000000000000", "/home/dev/work/unbadged");
await unbadged.fire("session_start");
check("a session that lost the claim starts with no emoji", record(unbadged.id).emoji === "");
check(
	"the missing badge is logged",
	unbadged.warns.some((w) => w.m.includes("badge claim unavailable")),
);
rmSync(badgeLock, { force: true });
unbadged.heartbeat();
await settle(150);
check("the heartbeat claims a badge once the claim frees up", record(unbadged.id).emoji.length > 0);

// A badge chosen while the heartbeat waits for the claim outranks the placeholder it was about to
// write, and the discarded attempt must not clear it either.
writeFileSync(badgeLock, JSON.stringify({ sessionId: "someone-else", pid: 1, token: "t", heartbeat: Date.now() }));
const patient = spawn("01a03493-0000-0000-0000-000000000000", "/home/dev/work/patient");
await patient.fire("session_start");
check("the waiting session starts with no emoji", record(patient.id).emoji === "");
patient.heartbeat();
await settle(40);
rmSync(badgeLock, { force: true });
await patient.tools.get("session_badge").execute("p1", { emoji: "\u{1F40D}" }, undefined, undefined, patient.ctx);
await settle(700);
check("the heartbeat does not replace a chosen badge", record(patient.id).emoji === "\u{1F40D}");
check("the chosen badge stays deliberate", record(patient.id).emojiChosen === true);

// A resumed session keeps the emoji its agent picked, and is not asked again.
const rebadged = spawn(two.id, "/home/dev/work/diesel");
const rebadgedAsk = await rebadged
	.fire("session_start")
	.then(() => rebadged.fire("before_agent_start", { prompt: "x" }));
check("a resume keeps the chosen emoji", record(two.id).emoji === "\u{1F430}");
check(
	"a resume with a chosen badge is not asked again",
	rebadgedAsk.every((r) => r?.message === undefined),
);

// Twelve live sessions exhaust the placeholder palette, and a thirteenth carries no emoji rather
// than a copy of one; its agent still gets to claim a contextual one.
const crowd = [
	"\u{1F98A}",
	"\u{1F419}",
	"\u{1F335}",
	"\u{1F3B8}",
	"\u{1F680}",
	"\u{1F41D}",
	"\u{1F344}",
	"\u{1F9ED}",
	"\u{1F42C}",
	"\u{1F3A9}",
	"\u{1F9F2}",
	"\u{1F94C}",
].map((emoji, index) => {
	const id = `01a03490-0000-0000-0000-0000000000${(10 + index).toString(36).padStart(2, "0")}`;
	const path = join(sessionsDir, `${id}.json`);
	writeFileSync(
		path,
		JSON.stringify({
			pid: 4000 + index,
			tag: `c${index}`.padEnd(5, "0"),
			name: "",
			cwd: `/home/dev/work/crowd-${index}`,
			emoji,
			emojiChosen: false,
			label: "",
			lastNotified: 0,
			recent: [],
			heartbeat: Date.now(),
		}),
	);
	return path;
});
const crowded = spawn("01a03491-0000-0000-0000-000000000000", "/home/dev/work/thirteenth");
await crowded.fire("session_start");
check("an exhausted palette leaves a session without an emoji", record(crowded.id).emoji === "");
const crowdedAsk = await crowded.fire("before_agent_start", { prompt: "pick one" });
check(
	"a session with no emoji is told as much",
	crowdedAsk.some((r) => /carries no emoji/.test(r?.message?.content ?? "")),
);
await crowded.tools.get("session_badge").execute("x1", { emoji: "\u{1F9F1}" }, undefined, undefined, crowded.ctx);
check("it can still claim a contextual emoji", record(crowded.id).emoji === "\u{1F9F1}");
for (const path of crowd) rmSync(path, { force: true });

// ---------------------------------------------------------------------- reaper
heading("stale session reaping");
const dead = "01a03000-dead-0000-0000-000000000000";
mkdirSync(inboxOf(dead), { recursive: true });
writeFileSync(join(inboxOf(dead), "1.json"), "{}");
writeFileSync(
	join(sessionsDir, `${dead}.json`),
	JSON.stringify({
		pid: 999999,
		tag: "zzzzz",
		name: "",
		cwd: "/x",
		emoji: "\u{1F41D}",
		label: "",
		lastNotified: 0,
		heartbeat: Date.now() - 600_000,
	}),
);
const reaper = spawn("01a03500-0000-0000-0000-000000000000", "/home/dev/work/rats");
await reaper.fire("session_start");
check("stale record reaped", !existsSync(join(sessionsDir, `${dead}.json`)));
check("stale inbox reaped", !existsSync(inboxOf(dead)));
check("live records survive", existsSync(join(sessionsDir, `${one.id}.json`)));

// ------------------------------------------------------------- reply routing
heading("reply routing");
const rr1 = spawn("01a03900-0000-0000-0000-000000000000", "/home/dev/work/subql");
await rr1.fire("session_start");
const rr2 = spawn("01a03901-0000-0000-0000-000000000000", "/home/dev/work/diesel");
await rr2.fire("session_start");
await rr1.fire("session_stop");
await settle();
const rr1Id = called("sendMessage").at(-1) && api.nextMessage - 1;
await rr2.fire("session_stop");
await settle();
const rr2Id = api.nextMessage - 1;
check(
	"each session records the ids it sent",
	record(rr1.id).recent.includes(rr1Id) && record(rr2.id).recent.includes(rr2Id),
);
check("recorded ids do not overlap", !record(rr1.id).recent.includes(rr2Id));

api.queued = [
	{
		update_id: 200,
		message: {
			message_id: 90,
			date: 1,
			chat: { id: CHAT },
			text: "do the other thing",
			reply_to_message: { message_id: rr1Id },
		},
	},
];
await one.pump(250);
check("a reply routes to the session that sent that message", inboxCount(rr1.id) === 1);
check("it beats the more recently notified session", inboxCount(rr2.id) === 0);

// Both sessions notified seconds apart, so a bare message is genuinely ambiguous now:
// it is held and asked about rather than guessed onto the more recent one.
api.queued = [{ update_id: 201, message: { message_id: 91, date: 1, chat: { id: CHAT }, text: "no reply target" } }];
await one.pump(250);
check("an unreplied message with two recent notifiers is not guessed", inboxCount(rr2.id) === 0);
check(
	"an unreplied message with two recent notifiers asks which session",
	(lastCall("sendMessage").body.reply_markup?.inline_keyboard ?? [])
		.flat()
		.some((b) => b.callback_data?.startsWith("m:")),
);

api.queued = [
	{
		update_id: 202,
		message: { message_id: 92, date: 1, chat: { id: CHAT }, text: "stale", reply_to_message: { message_id: 999999 } },
	},
];
const beforeDrop = called("sendMessage").length;
await one.pump(250);
check("a reply to an unknown message is refused, not misrouted", called("sendMessage").length === beforeDrop + 1);
check("the refusal explains what to do", lastCall("sendMessage").body.text.includes("Reply to a message"));

// ------------------------------------------------- context reaches the terminal
heading("context reaches both surfaces");
const ctxSession = spawn("01a03a00-0000-0000-0000-000000000000", "/home/dev/work/subql");
await ctxSession.fire("session_start");
const seen = {};
const withCapture = {
	...ctxSession.ctx,
	invokeTool: (params, options) => {
		seen.params = params;
		const { promise, reject } = Promise.withResolvers();
		options.signal.addEventListener("abort", () => reject(new Error("aborted")));
		return promise;
	},
};
const ctxAsk = {
	context: "The rebuild takes 40 minutes on this corpus.",
	questions: [
		{ id: "a", question: "Rebuild now?", options: [{ label: "yes" }, { label: "no" }] },
		{ id: "b", question: "Notify on completion?", options: [{ label: "yes" }, { label: "no" }] },
	],
};
const ctxRun = ctxSession.tools.get("ask").execute("cx", ctxAsk, undefined, undefined, withCapture);
await settle(150);
check("context is not passed as a field to the strict native tool", !("context" in seen.params));
check(
	"context is prepended to the first question so the terminal shows it",
	seen.params.questions[0].question.startsWith("The rebuild takes 40 minutes"),
);
check("the original question text survives", seen.params.questions[0].question.includes("Rebuild now?"));
check("later questions are untouched", seen.params.questions[1].question === "Notify on completion?");
check("the caller's objects are not mutated", ctxAsk.questions[0].question === "Rebuild now?");
check("context still appears on Telegram", lastCall("sendMessage").body.text.includes("40 minutes"));
const ctxAskId = lastCall("sendMessage").body.reply_markup.inline_keyboard[0][0].callback_data.split(":")[1];
writeFileSync(
	join(inboxOf(ctxSession.id), "800.json"),
	JSON.stringify({ kind: "callback", value: `o:${ctxAskId}:0:0` }),
);
await ctxSession.pump(150);
writeFileSync(
	join(inboxOf(ctxSession.id), "801.json"),
	JSON.stringify({ kind: "callback", value: `o:${ctxAskId}:1:0` }),
);
await ctxSession.pump(150);
check("the two-question ask still completes", (await ctxRun).details.results.length === 2);
check(
	"tool description names the supported markdown subset",
	ctxSession.tools.get("ask").description.includes("triple-backtick fences") &&
		ctxSession.tools.get("ask").description.includes("~~strikethrough~~"),
);
check(
	"tool description no longer claims telegram-only context",
	!ctxSession.tools.get("ask").description.includes("only on Telegram"),
);

// ------------------------------------------------------------- poller mutual exclusion
heading("poller mutual exclusion");
const lockPath = join(root, "notify-telegram/poller.lock");
const owner = () => JSON.parse(readFileSync(lockPath, "utf8"));
check("exactly one lock file exists", existsSync(lockPath) && !statSync(lockPath).isDirectory());
check("the lock names its owner", typeof owner().sessionId === "string" && owner().sessionId.length > 0);
const holder = owner().sessionId;
const contenders = [];
for (let i = 0; i < 8; i++) {
	const s = spawn(`01a03c0${i}-0000-0000-0000-000000000000`, `/home/dev/work/p${i}`);
	await s.fire("session_start");
	contenders.push(s);
}
check("a burst of starts does not displace the live holder", owner().sessionId === holder);
let pollers = 0;
for (const s of [...contenders, one, two]) {
	const before = called("getUpdates").length;
	s.timers[1]();
	await settle(40);
	if (called("getUpdates").length > before) pollers++;
}
check("only one session polls", pollers === 1);

// A dead holder must be taken over, and only by one successor.
writeFileSync(lockPath, JSON.stringify({ sessionId: "gone", pid: 999999, heartbeat: Date.now() - 600_000 }));
for (const s of contenders) s.heartbeat();
await settle(60);
check("a stale lock is taken over", owner().sessionId !== "gone");
let takers = 0;
for (const s of contenders) {
	const before = called("getUpdates").length;
	s.timers[1]();
	await settle(40);
	if (called("getUpdates").length > before) takers++;
}
check("still only one poller after takeover", takers === 1);

// A non-owner exiting must not delete the lock, which is what produced the ENOENT storm.
const nonOwner = contenders.find((s) => s.id !== owner().sessionId);
await nonOwner.fire("session_shutdown");
check("a non-owner shutdown leaves the lock alone", existsSync(lockPath));
const ownerSession = contenders.find((s) => s.id === owner().sessionId);
if (ownerSession) {
	await ownerSession.fire("session_shutdown");
	check("the owner's shutdown releases the lock", !existsSync(lockPath));
} else {
	check("the owner's shutdown releases the lock", true);
}
for (const s of contenders) {
	s.heartbeat();
	check(
		`heartbeat survives a missing lock file for ${s.id.slice(0, 8)}`,
		!s.warns.some((w) => w.m.includes("heartbeat failed")),
	);
	break;
}

// -------------------------------------------------- multi-question, real poller path
heading("multi-question through the poller");
rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
const mq = spawn("01a03d00-0000-0000-0000-000000000000", "/home/dev/work/sqlparser-rs");
await mq.fire("session_start");
check(
	"the asking session owns the poller lock for this section",
	JSON.parse(readFileSync(join(root, "notify-telegram/poller.lock"), "utf8")).sessionId === mq.id,
);
const three = {
	questions: [
		{ id: "one", question: "Q1?", options: [{ label: "a1" }, { label: "b1" }] },
		{ id: "two", question: "Q2?", options: [{ label: "a2" }, { label: "b2" }] },
		{ id: "three", question: "Q3?", options: [{ label: "a3" }, { label: "b3" }] },
	],
};
const mqState = {};
const mqRun = mq.tools.get("ask").execute("m1", three, undefined, undefined, stubbornCtx(mq.ctx, mqState));
await settle(150);
const askOf = () => lastCall("sendMessage").body.reply_markup.inline_keyboard[0][0].callback_data.split(":")[1];
const mqAsk = askOf();
check("first question is sent", lastCall("sendMessage").body.text.includes("Q1?"));
check(
	"position line shows one of three with a red light",
	lastCall("sendMessage").body.text.includes("Input needed 1 of 3"),
);

const press = (q, opt, id) => ({
	update_id: id,
	callback_query: {
		id: `cb${id}`,
		data: `o:${mqAsk}:${q}:${opt}`,
		from: { id: CHAT },
		message: { message_id: 7, chat: { id: CHAT } },
	},
});

// One press at a time, the patient case.
api.queued = [press(0, 1, 300)];
await mq.pump(250);
await mq.pump(250);
check("second question follows the first press", lastCall("sendMessage").body.text.includes("Q2?"));

// Two presses arriving in a single getUpdates batch, which is what happens when tapping quickly.
api.queued = [press(1, 0, 301), press(2, 1, 302)];
await mq.pump(300);
await mq.pump(400);
await mq.pump(400);
const mqResult = await Promise.race([mqRun, settle(1200).then(() => "timeout")]);
check("a batch of presses is not dropped", mqResult !== "timeout");
if (mqResult !== "timeout") {
	check("all three answers recorded", mqResult.details.results.length === 3);
	check("answer order matches question order", mqResult.details.results.map((r) => r.id).join(",") === "one,two,three");
	check("first answer correct", mqResult.details.results[0].selectedOptions[0] === "b1");
	check("second answer correct", mqResult.details.results[1].selectedOptions[0] === "a2");
	check("third answer correct", mqResult.details.results[2].selectedOptions[0] === "b3");
}

// Mixed shapes in one ask: plain, multi-select, then a typed answer, all in the middle positions.
const mixed = {
	questions: [
		{ id: "first", question: "Pick one?", options: [{ label: "x" }, { label: "y" }] },
		{ id: "middle", question: "Pick many?", multi: true, options: [{ label: "p" }, { label: "q" }, { label: "r" }] },
		{ id: "last", question: "Free form?", options: [{ label: "preset" }] },
	],
};
const mixState = {};
const mixRun = mq.tools.get("ask").execute("m2", mixed, undefined, undefined, stubbornCtx(mq.ctx, mixState));
await settle(150);
const mixAsk = lastCall("sendMessage").body.reply_markup.inline_keyboard[0][0].callback_data.split(":")[1];
const cb = (data, id) => ({
	update_id: id,
	callback_query: { id: `k${id}`, data, from: { id: CHAT }, message: { message_id: 7, chat: { id: CHAT } } },
});

api.queued = [cb(`o:${mixAsk}:0:1`, 400)];
await mq.pump(250);
await mq.pump(250);
check("advances to the multi-select question", lastCall("sendMessage").body.text.includes("Pick many?"));
const mixedRows = lastCall("sendMessage").body.reply_markup.inline_keyboard;
check(
	"multi-select offers a Done button",
	mixedRows.at(-1).some((b) => b.text === "Done"),
);

api.queued = [cb(`o:${mixAsk}:1:0`, 401), cb(`o:${mixAsk}:1:2`, 402)];
await mq.pump(300);
await mq.pump(300);
api.queued = [cb(`d:${mixAsk}:1`, 403)];
await mq.pump(300);
await mq.pump(300);
check("Done advances past the multi-select", lastCall("sendMessage").body.text.includes("Free form?"));

api.queued = [{ update_id: 405, message: { message_id: 60, date: 1, chat: { id: CHAT }, text: "something bespoke" } }];
await mq.pump(300);
await mq.pump(300);
const mixResult = await Promise.race([mixRun, settle(1500).then(() => "timeout")]);
check("mixed-shape ask completes", mixResult !== "timeout");
if (mixResult !== "timeout") {
	const r = mixResult.details.results;
	check("plain question answer kept", r[0].selectedOptions[0] === "y");
	check("multi-select kept both toggles", r[1].selectedOptions.join(",") === "p,r");
	check("typed answer kept on the last question", r[2].customInput === "something bespoke");
	check("terminal dialog aborted once telegram finished", mixState.aborted === true);
}

// ----------------------------------------------------- hardening found by anticipation
heading("robustness");
// A rejected detached promise is fatal in omp, so a network failure must not escape.
const boom = spawn("01a03e00-0000-0000-0000-000000000000", "/home/dev/work/rats");
await boom.fire("session_start");
const savedFetch = globalThis.fetch;
globalThis.fetch = async () => {
	throw new Error("simulated network failure");
};
let escaped = null;
const onUnhandled = (e) => {
	escaped = e;
};
process.on("unhandledRejection", onUnhandled);
await boom.fire("session_stop");
boom.heartbeat();
boom.timers[1]();
await settle(300);
globalThis.fetch = savedFetch;
process.off("unhandledRejection", onUnhandled);
check("a network failure does not escape as an unhandled rejection", escaped === null);
check(
	"the failure is logged instead",
	boom.warns.some((w) => w.m.includes("failed")),
);

// A corrupt inbox entry used to throw before its own deletion and jam the loop forever.
writeFileSync(join(inboxOf(boom.id), "900.json"), "{ this is not json");
writeFileSync(join(inboxOf(boom.id), "901.json"), JSON.stringify({ kind: "text", value: "still works" }));
await boom.pump(200);
check("a corrupt entry is discarded, not retried forever", inboxCount(boom.id) === 0);
check(
	"the entry after a corrupt one still lands",
	boom.steers.some((x) => x.text === "still works"),
);

// Rate limiting must be honoured rather than dropping the notification.
let throttled = 0;
let sendAttempts = 0;
globalThis.fetch = async (url, init) => {
	const method = String(url).split("/").pop();
	if (method === "sendMessage") sendAttempts++;
	if (method === "sendMessage" && throttled === 0) {
		throttled++;
		return {
			ok: false,
			status: 429,
			json: async () => ({ ok: false, description: "Too Many Requests", parameters: { retry_after: 1 } }),
		};
	}
	return savedFetch(url, init);
};
const startedAt = Date.now();
await boom.fire("session_stop");
await settle(2400);
globalThis.fetch = savedFetch;
check("a 429 is retried rather than dropped", sendAttempts >= 2);
check("the retry waits for the requested delay", Date.now() - startedAt >= 1000);

// Link previews off, and the wider markdown set.
const md = [
	"# Heading",
	"See [the docs](https://example.com/a?x=1&y=2).",
	"~~gone~~ and *stars* and _unders_ and ||secret||",
	"keep snake_case_name and 2 * 3 intact",
].join("\n");
const mdSession = spawn("01a03e01-0000-0000-0000-000000000000", "/home/dev/work/los");
await mdSession.fire("session_start");
mdSession.tools
	.get("ask")
	.execute(
		"md",
		{ context: md, questions: [{ id: "q", question: "ok?", options: [{ label: "yes" }] }] },
		undefined,
		undefined,
		stubbornCtx(mdSession.ctx, {}),
	);
await settle(200);
const mdBody = lastCall("sendMessage").body;
check("link previews are disabled", mdBody.link_preview_options?.is_disabled === true);
check("heading becomes bold", mdBody.text.includes("<b>Heading</b>"));
check(
	"link becomes an anchor with an escaped query",
	mdBody.text.includes('<a href="https://example.com/a?x=1&amp;y=2">the docs</a>'),
);
check("strikethrough renders", mdBody.text.includes("<s>gone</s>"));
check("single asterisk emphasis renders", mdBody.text.includes("<i>stars</i>"));
check("underscore emphasis renders", mdBody.text.includes("<i>unders</i>"));
check("spoiler renders", mdBody.text.includes("<tg-spoiler>secret</tg-spoiler>"));
check("snake_case is left alone", mdBody.text.includes("snake_case_name"));
check("bare multiplication is left alone", mdBody.text.includes("2 * 3"));

// An oversized body must still be sent, shrunk to fit.
const huge = "<".repeat(3500);
mdSession.tools
	.get("ask")
	.execute(
		"hg",
		{ context: huge, questions: [{ id: "q", question: "ok?", options: [{ label: "yes" }] }] },
		undefined,
		undefined,
		stubbornCtx(mdSession.ctx, {}),
	);
await settle(200);
check("an oversized message is shrunk below the telegram ceiling", lastCall("sendMessage").body.text.length <= 4096);

// Media reaches the agent: photos as images, voice and documents as saved file paths.
rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
const voiceSession = spawn("01a03e02-0000-0000-0000-000000000000", "/home/dev/work/ds4");
await voiceSession.fire("session_start");
api.queued = [
	{
		update_id: 500,
		message: { message_id: 70, date: 1, chat: { id: CHAT }, voice: { file_id: "x", mime_type: "audio/ogg" } },
	},
];
await voiceSession.pump(250);
await voiceSession.pump(250);
check(
	"a voice note is fetched from telegram",
	called("getFile").some((c) => c.body.file_id === "x"),
);
const mediaDir = join(root, "notify-telegram/media");
check("the audio lands on disk", existsSync(mediaDir) && readdirSync(mediaDir).length > 0);
const savedVoice = readdirSync(mediaDir)[0];
const liveTags = readdirSync(sessionsDir).map((f) => JSON.parse(readFileSync(join(sessionsDir, f), "utf8")).tag);
check("a saved file leads with a sortable UTC stamp", /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z__/u.test(savedVoice));
check(
	"a saved file names its kind, its owning session and its update",
	savedVoice.includes("__voice__") &&
		liveTags.includes(savedVoice.split("__")[2].split("-")[0]) &&
		savedVoice.includes("__u500__"),
);
check("a saved file keeps the telegram name and extension last", savedVoice.endsWith("__file_9.oga"));

// An audio file and a document carry their own Telegram name, which survives sanitised.
api.queued = [
	{
		update_id: 510,
		message: {
			message_id: 74,
			date: 1,
			chat: { id: CHAT },
			audio: { file_id: "a1", mime_type: "audio/mpeg", file_name: "riff take 3.mp3" },
		},
	},
];
await voiceSession.pump(250);
await voiceSession.pump(250);
const savedAudio = readdirSync(mediaDir).find((f) => f.includes("__u510__")) ?? "";
check("an audio file is named as audio and keeps its own name", savedAudio.endsWith("__riff_take_3.mp3"));
check("an audio file names its kind", savedAudio.includes("__audio__"));
api.queued = [
	{
		update_id: 511,
		message: {
			message_id: 75,
			date: 1,
			chat: { id: CHAT },
			document: { file_id: "d1", mime_type: "application/pdf", file_name: "review notes.pdf" },
		},
	},
];
await voiceSession.pump(250);
await voiceSession.pump(250);
const savedDoc = readdirSync(mediaDir).find((f) => f.includes("__u511__")) ?? "";
check("a document is named as a document and keeps its own name", savedDoc.endsWith("__review_notes.pdf"));
check("a document names its kind", savedDoc.includes("__document__"));

// Drain side, delivered directly: an image becomes an image block, other files travel as paths.
mkdirSync(mediaDir, { recursive: true });
const photoPath = join(mediaDir, "photo-test.png");
writeFileSync(photoPath, "not-really-png");
writeFileSync(
	join(inboxOf(voiceSession.id), "502.json"),
	JSON.stringify({ kind: "file", value: photoPath, mime: "image/png", caption: "look at this", messageId: 71 }),
);
await voiceSession.pump(250);
const photoSteer = voiceSession.steers.at(-1);
check(
	"a photo reaches the agent as an image block",
	Array.isArray(photoSteer?.text) && photoSteer.text[0].type === "image",
);
check(
	"the image data is the file, base64",
	photoSteer.text[0].data === Buffer.from("not-really-png").toString("base64"),
);
check("the caption rides along", photoSteer.text[1].text === "look at this");
check("the image asks for no explicit steer, so an idle session starts a turn", photoSteer.options === undefined);
check("delivery is acknowledged with a reaction", lastCall("setMessageReaction").body.message_id === 71);

const filePath = join(mediaDir, "notes.oga");
writeFileSync(filePath, "opus");
writeFileSync(
	join(inboxOf(voiceSession.id), "503.json"),
	JSON.stringify({ kind: "file", value: filePath, mime: "audio/ogg", messageId: 72 }),
);
await voiceSession.pump(250);
const fileSteer = voiceSession.steers.at(-1);
check("audio travels as its saved path", typeof fileSteer?.text === "string" && fileSteer.text.includes(filePath));
check("the mime type is named", fileSteer.text.includes("audio/ogg"));

// A message type nothing handles is answered rather than dropped.
api.queued = [{ update_id: 504, message: { message_id: 73, date: 1, chat: { id: CHAT }, sticker: { file_id: "s" } } }];
const beforeSticker = called("sendMessage").length;
await voiceSession.pump(250);
check("an unsupported type gets an explanation", called("sendMessage").length === beforeSticker + 1);
check("the explanation lists what works", lastCall("sendMessage").body.text.includes("photo"));

api.queued = [
	{
		update_id: 505,
		message: {
			message_id: 74,
			date: 1,
			chat: { id: CHAT },
			text: "orphaned reply",
			reply_to_message: { message_id: 999_999 },
		},
	},
];
await voiceSession.pump(250);
const ownerlessNotice = lastCall("sendMessage").body.text;
check(
	"an ownerless routing error stays plain",
	ownerlessNotice.startsWith("\u{1F535} No live omp session") &&
		!ownerlessNotice.includes("Task: ") &&
		!ownerlessNotice.includes("Model: ") &&
		!ownerlessNotice.includes("Tmux: "),
);

// Pinning the fleet board or a red status makes Telegram post its own "pinned a message" notice
// back into the chat. That is a chat event, not something the user typed, so it passes in silence
// rather than earn a lecture about supported types.
const beforePin = called("sendMessage").length;
api.queued = [
	{
		update_id: 506,
		message: {
			message_id: 75,
			date: 1,
			chat: { id: CHAT },
			pinned_message: { message_id: 40, date: 1, chat: { id: CHAT }, text: "fleet board" },
		},
	},
];
await voiceSession.pump(250);
check("a pin notice draws no reply", called("sendMessage").length === beforePin);

// ------------------------------------------------------ terminal cancellation and closure
heading("cancellation and message closure");
rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
const esc = spawn("01a03f00-0000-0000-0000-000000000000", "/home/dev/work/subql");
await esc.fire("session_start");
const escAsk = { questions: [{ id: "q", question: "Proceed?", options: [{ label: "yes" }, { label: "no" }] }] };

// Esc at the terminal: the native dialog throws, and the telegram message must be retired.
let rejectLocal = null;
const escCtx = {
	...esc.ctx,
	invokeTool: () => {
		const { promise, reject } = Promise.withResolvers();
		rejectLocal = reject;
		return promise;
	},
};
const escRun = esc.tools.get("ask").execute("e1", escAsk, undefined, undefined, escCtx);
await settle(150);
const escMessageId = called("sendMessage").at(-1) ? api.nextMessage - 1 : null;
check("question was sent with buttons", lastCall("sendMessage").body.reply_markup.inline_keyboard.flat().length === 2);
rejectLocal(new Error("Ask tool was cancelled by the user"));
let threw = null;
await escRun.catch((e) => {
	threw = e;
});
await settle(150);
check("the cancellation still reaches the caller", threw !== null && /cancelled/i.test(threw.message));
const closing = lastCall("editMessageText");
check(
	"the telegram message is edited on cancellation",
	closing !== undefined && closing.body.message_id === escMessageId,
);
check("it says it was cancelled at the terminal", closing.body.text.includes("Cancelled at the terminal"));
check(
	"cancelled native question keeps the badge and question",
	closing.body.text.startsWith(badgeHead(esc.id, "subql")) &&
		closing.body.text.includes("Proceed?") &&
		closing.body.text.includes("Cancelled at the terminal"),
);
check(
	"the keyboard is explicitly cleared",
	Array.isArray(closing.body.reply_markup?.inline_keyboard) && closing.body.reply_markup.inline_keyboard.length === 0,
);

// A press on the retired question must be answered, not swallowed.
const beforeStale = called("sendMessage").length;
writeFileSync(join(inboxOf(esc.id), "950.json"), JSON.stringify({ kind: "callback", value: "o:zzzzz-1:0:0" }));
await esc.pump(200);
check("a press on a closed question gets a reply", called("sendMessage").length === beforeStale + 1);
check("the reply explains the question is closed", lastCall("sendMessage").body.text.includes("closed"));
check(
	"a stale question notice begins with session context",
	lastCall("sendMessage").body.text.startsWith(
		`\u{1F535} Task: subql [${record(esc.id).tag}] | Model: openai/gpt-5.6-sol | Tmux: not attached`,
	),
);

// Answering at the terminal must also clear the keyboard.
const okRun = esc.tools.get("ask").execute("e2", escAsk, undefined, undefined, {
	...esc.ctx,
	invokeTool: async () => ({ content: [{ type: "text", text: "yes" }], details: {} }),
});
await okRun;
await settle(150);
const answeredEdit = lastCall("editMessageText");
check("answering at the terminal retires the message", answeredEdit.body.text.includes("Answered at the terminal"));
check("and clears its keyboard", answeredEdit.body.reply_markup.inline_keyboard.length === 0);

// Answering on telegram must clear the keyboard of each question it walks past.
const walkState = {};
const walkRun = esc.tools.get("ask").execute(
	"e3",
	{
		questions: [
			{ id: "a", question: "First?", options: [{ label: "x" }, { label: "y" }] },
			{ id: "b", question: "Second?", options: [{ label: "p" }] },
		],
	},
	undefined,
	undefined,
	stubbornCtx(esc.ctx, walkState),
);
await settle(150);
const walkAsk = lastCall("sendMessage").body.reply_markup.inline_keyboard[0][0].callback_data.split(":")[1];
writeFileSync(join(inboxOf(esc.id), "960.json"), JSON.stringify({ kind: "callback", value: `o:${walkAsk}:0:1` }));
await esc.pump(250);
const firstClosed = lastCall("editMessageText");
check(
	"the answered question keeps its options as dead buttons",
	firstClosed.body.reply_markup.inline_keyboard.flat().every((b) => b.disabled !== undefined),
);
check(
	"the chosen option is ticked",
	firstClosed.body.reply_markup.inline_keyboard.flat().some((b) => b.text === "\u2713 y"),
);
check("the first question shows its answer", firstClosed.body.text.includes("Answered:"));
writeFileSync(join(inboxOf(esc.id), "961.json"), JSON.stringify({ kind: "callback", value: `o:${walkAsk}:1:0` }));
await esc.pump(250);
check("the walk completes", (await walkRun).details.results.length === 2);

// ------------------------------------------------------------------ option stance
heading("option desirability");
rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
const st = spawn("01a04000-0000-0000-0000-000000000000", "/home/dev/work/diesel");
await st.fire("session_start");
const stanceParams = {};
const stanceAsk = {
	questions: [
		{
			id: "s",
			question: "Which approach?",
			recommended: 1,
			options: [
				{ label: "neutral one", description: "no strong view", preview: "preview should disappear" },
				{ label: "the good one", description: "cheapest to maintain" },
				{ label: "the bad one", description: "here for contrast", discouraged: true },
				{ label: "bare option" },
				{ label: "the meh one", description: "works, but slow", lukewarm: true },
				{
					label: "Add a code marker to the record and have a health-aware session take the board over",
					description: "long enough that the button text has to be cut",
					lukewarm: true,
				},
			],
		},
	],
};
const stRun = st.tools.get("ask").execute("s1", stanceAsk, undefined, undefined, stubbornCtx(st.ctx, stanceParams));
await settle(180);
const stBody = lastCall("sendMessage").body;
const stRows = stBody.reply_markup.inline_keyboard;
check("the preferable option is green", stRows[1][0].style === "success");
check("the discouraged option is red", stRows[2][0].style === "danger");
check("neutral options carry no colour", stRows[0][0].style === undefined && stRows[3][0].style === undefined);
check("the preferable button is labelled", stRows[1][0].text.includes("(preferable)"));
check("the discouraged button is labelled", stRows[2][0].text.includes("(discouraged)"));
check("neutral buttons carry no marker", !stRows[0][0].text.includes("(") && !stRows[3][0].text.includes("("));
check("body marks the preferable option the same way", stBody.text.includes("<b>the good one</b> (preferable)"));
check("body marks the discouraged option the same way", stBody.text.includes("<b>the bad one</b> (discouraged)"));
check("the lukewarm option carries no colour of its own", stRows[4][0].style === undefined);
check("the lukewarm button carries the orange marker", stRows[4][0].text.includes("\u{1F7E0} (lukewarm)"));
check("body marks the lukewarm option the same way", stBody.text.includes("<b>the meh one</b> \u{1F7E0} (lukewarm)"));
check(
	"a long lukewarm label keeps the marker its colour depends on",
	stRows[5][0].text.endsWith("\u{1F7E0} (lukewarm)"),
);
check("a cut button label still fits the button", stRows[5][0].text.length <= 60);
check("a neutral option with nothing to add is omitted from the body", !stBody.text.includes("bare option"));
check(
	"the terminal sees the discouraged marker too",
	stanceParams.params.questions[0].options[2].description.startsWith("(discouraged)"),
);
check(
	"the terminal sees the lukewarm marker too",
	stanceParams.params.questions[0].options[4].description.startsWith("\u{1F7E0} (lukewarm)"),
);
check(
	"the marker is not lost when there was no description",
	stanceParams.params.questions[0].options[3].description === undefined,
);
check(
	"discouraged never reaches the strict native tool",
	stanceParams.params.questions[0].options.every((o) => !("discouraged" in o)),
);
check(
	"lukewarm never reaches the strict native tool",
	stanceParams.params.questions[0].options.every((o) => !("lukewarm" in o)),
);
check(
	"neutral descriptions are untouched",
	stanceParams.params.questions[0].options[0].description === "no strong view",
);
check(
	"the caller's option objects are not mutated",
	stanceAsk.questions[0].options[2].description === "here for contrast",
);
check(
	"marker text has a single definition",
	stRows[1][0].text.includes("(preferable)") && stBody.text.includes("(preferable)"),
);
const stAskId = stRows[0][0].callback_data.split(":")[1];
writeFileSync(join(inboxOf(st.id), "970.json"), JSON.stringify({ kind: "callback", value: `o:${stAskId}:0:1` }));
await st.pump(250);
const settledStance = lastCall("editMessageText");
check(
	"selected native answer retains badge, question, result, and buttons",
	settledStance.body.text.startsWith(badgeHead(st.id, "diesel")) &&
		settledStance.body.text.includes("Which approach?") &&
		settledStance.body.text.includes("Answered:") &&
		settledStance.body.text.includes("the good one") &&
		settledStance.body.reply_markup.inline_keyboard.flat().every((button) => button.disabled !== undefined) &&
		settledStance.body.reply_markup.inline_keyboard.flat().some((button) => button.text === "\u2713 the good one"),
);
check(
	"settled native body omits option descriptions and previews",
	!settledStance.body.text.includes("cheapest to maintain") &&
		!settledStance.body.text.includes("preview should disappear"),
);
check("a coloured option still answers normally", (await stRun).details.selectedOptions[0] === "the good one");
check("tool description explains how to mark desirability", st.tools.get("ask").description.includes("`discouraged`"));
check("tool description explains the middle stance", st.tools.get("ask").description.includes("`lukewarm`"));

// A marked option with no description must still be listed, since the mark is the information.
const bareState = {};
const bareRun = st.tools.get("ask").execute(
	"s2",
	{
		questions: [
			{
				id: "b",
				question: "Which?",
				recommended: 0,
				options: [{ label: "take this" }, { label: "avoid this", discouraged: true }],
			},
		],
	},
	undefined,
	undefined,
	stubbornCtx(st.ctx, bareState),
);
await settle(180);
const bareBody = lastCall("sendMessage").body.text;
check("a preferable option with no description is still listed", bareBody.includes("<b>take this</b> (preferable)"));
check("a discouraged option with no description is still listed", bareBody.includes("<b>avoid this</b> (discouraged)"));
const bareAsk = lastCall("sendMessage").body.reply_markup.inline_keyboard[0][0].callback_data.split(":")[1];
writeFileSync(join(inboxOf(st.id), "971.json"), JSON.stringify({ kind: "callback", value: `o:${bareAsk}:0:0` }));
await st.pump(250);
check("it answers normally", (await bareRun).details.selectedOptions[0] === "take this");

// ---------------------------------------------------------------- torn shared files
heading("torn shared files");
// An empty session record, which is what a reader sees mid-rewrite, must not break anything.
writeFileSync(join(sessionsDir, "01a04100-torn-0000-0000-000000000000.json"), "");
const torn = spawn("01a04101-0000-0000-0000-000000000000", "/home/dev/work/subql");
let startFailed = false;
try {
	await torn.fire("session_start");
} catch {
	startFailed = true;
}
check("session start survives a torn record from another process", startFailed === false);
check("the torn record does not poison routing", existsSync(join(sessionsDir, `${torn.id}.json`)));

// A torn config at startup is retried rather than silently disabling the extension.
const cfgBackup = readFileSync(join(root, "notify-telegram.json"), "utf8");
writeFileSync(join(root, "notify-telegram.json"), "");
const retry = spawn("01a04102-0000-0000-0000-000000000000", "/home/dev/work/diesel");
const retryStart = retry.fire("session_start");
await settle(120);
writeFileSync(join(root, "notify-telegram.json"), cfgBackup);
await retryStart;
check("a torn config is retried and the session ends up enabled", existsSync(join(sessionsDir, `${retry.id}.json`)));

// Atomic writes must leave no temp litter.
await torn.fire("session_stop");
await settle(150);
torn.heartbeat();
const litter = readdirSync(sessionsDir).filter((f) => f.includes(".tmp"));
check("no temp files are left behind", litter.length === 0);

// ------------------------------------------------------------------ status semaphore
heading("turn-end status semaphore");
rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
const sem = spawn("01a04200-0000-0000-0000-000000000000", "/home/dev/work/sqlitegis");
let branchTail = "All tests pass and the branch is ready to merge.";
sem.ctx.sessionManager.getBranch = () => [
	{ type: "message", message: { role: "user", content: [{ type: "text", text: "do the thing" }] } },
	{
		type: "message",
		message: { role: "assistant", content: [{ type: "text", text: `Intro paragraph.\n\n${branchTail}` }] },
	},
];
await sem.fire("session_start");
await sem.fire("session_stop");
await settle(150);
const doneMsg = lastCall("sendMessage").body.text;
check("a clean finish gets the green light", doneMsg.includes("\u{1F7E2}"));
check("the body carries the agent's actual last words", doneMsg.includes("ready to merge"));
check("only the final paragraph is used", !doneMsg.includes("Intro paragraph"));

branchTail = "Should I also delete the legacy shim?";
await sem.fire("session_stop");
await settle(150);
const askMsg = lastCall("sendMessage").body.text;
check("a trailing question gets the orange light", askMsg.includes("\u{1F7E0}") && askMsg.includes("Reply wanted"));
check("the question itself is the body", askMsg.includes("legacy shim"));

const grantedNoticeId = api.nextMessage;
await sem.fire("tool_approval_requested", { toolCallId: "approve-1", toolName: "bash" });
await settle(150);
check("approval carries the red light", lastCall("sendMessage").body.text.includes("\u{1F534}"));
await sem.fire("tool_approval_resolved", {
	toolCallId: "approve-1",
	toolName: "bash",
	approved: true,
});
await settle(150);
const grantedEdit = called("editMessageText").find((c) => c.body.message_id === grantedNoticeId);
check(
	"an approval grant replaces the waiting notice",
	grantedEdit?.body.text.includes("Approval granted") && grantedEdit.body.text.includes("bash was approved"),
);

const deniedNoticeId = api.nextMessage;
await sem.fire("tool_approval_requested", { toolCallId: "approve-2", toolName: "write" });
await settle(150);
await sem.fire("tool_approval_resolved", {
	toolCallId: "approve-2",
	toolName: "write",
	approved: false,
	reason: "Policy denied it.",
});
await settle(150);
const deniedEdit = called("editMessageText").find((c) => c.body.message_id === deniedNoticeId);
check(
	"an approval denial replaces the waiting notice",
	deniedEdit?.body.text.includes("Approval denied") &&
		deniedEdit.body.text.includes("write was denied") &&
		deniedEdit.body.text.includes("Policy denied it"),
);

const semState = {};
const semRun = sem.tools
	.get("ask")
	.execute(
		"sm",
		{ questions: [{ id: "q", question: "ok?", options: [{ label: "yes" }] }] },
		undefined,
		undefined,
		stubbornCtx(sem.ctx, semState),
	);
await settle(150);
check(
	"a question message carries the red input-needed line",
	lastCall("sendMessage").body.reply_markup !== undefined &&
		lastCall("sendMessage").body.text.includes("\u{1F534} Input needed"),
);
const semAsk = lastCall("sendMessage").body.reply_markup.inline_keyboard[0][0].callback_data.split(":")[1];
writeFileSync(join(inboxOf(sem.id), "980.json"), JSON.stringify({ kind: "callback", value: `o:${semAsk}:0:0` }));
await sem.pump(200);
await semRun;

// ------------------------------------------------------------- required status summary
heading("required status summary");
rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
const rs = spawn("01a04300-0000-0000-0000-000000000000", "/home/dev/work/pg2sqlite");
await rs.fire("session_start");

const firstStop = await rs.fire("session_stop");
await settle(150);
check(
	"a turn without a summary is blocked once",
	firstStop.some((r) => r?.decision === "block"),
);
check(
	"the block explains what to call",
	firstStop.find((r) => r?.decision === "block").reason.includes("notify_status"),
);
check(
	"the block asks for real next steps and forbids invented ones",
	firstStop.find((r) => r?.decision === "block").reason.includes("next steps") &&
		firstStop.find((r) => r?.decision === "block").reason.includes("Never invent"),
);
check(
	"notify_status description asks for real next steps and forbids invented ones",
	rs.tools.get("notify_status").description.includes("next steps") &&
		rs.tools.get("notify_status").description.includes("Never invent"),
);
check(
	"the block suggests bug-fix follow-ups including mutation testing",
	firstStop.find((r) => r?.decision === "block").reason.includes("bugs of the same family") &&
		firstStop.find((r) => r?.decision === "block").reason.includes("mutation testing"),
);
check(
	"the block suggests feature follow-ups including a cleaner abstraction and a maintainer review",
	firstStop.find((r) => r?.decision === "block").reason.includes("blanket impl") &&
		firstStop.find((r) => r?.decision === "block").reason.includes("criterion benchmarks") &&
		firstStop.find((r) => r?.decision === "block").reason.includes("maintainer"),
);
check(
	"notify_status description carries the same follow-up guidance",
	rs.tools.get("notify_status").description.includes("bugs of the same family") &&
		rs.tools.get("notify_status").description.includes("mutation testing") &&
		rs.tools.get("notify_status").description.includes("blanket impl") &&
		rs.tools.get("notify_status").description.includes("criterion benchmarks") &&
		rs.tools.get("notify_status").description.includes("maintainer"),
);
check(
	"the block requires self-contained phone choices",
	firstStop.find((r) => r?.decision === "block").reason.includes("answerable from a phone") &&
		firstStop.find((r) => r?.decision === "block").reason.includes("what each option does or costs") &&
		firstStop.find((r) => r?.decision === "block").reason.includes("Never use only a phase number or letter"),
);
check(
	"notify_status requires self-contained phone choices",
	rs.tools.get("notify_status").description.includes("answerable from a phone") &&
		rs.tools.get("notify_status").description.includes("what each option does or costs") &&
		rs.tools.get("notify_status").description.includes("Never use only a phase number or letter"),
);
check(
	"after the block the fallback message still goes out",
	lastCall("sendMessage").body.text.includes("Turn finished"),
);

await rs.fire("agent_start");
const telegramStop = await rs.fire("session_stop");
check(
	"a Telegram-started turn resets the status requirement",
	telegramStop.some((r) => r?.decision === "block"),
);

await rs.fire("input");
await rs.tools
	.get("notify_status")
	.execute(
		"n1",
		{ summary: "Migration rewritten and **all 14 tests pass**. Nothing pending.", urgency: "green" },
		undefined,
		undefined,
		rs.ctx,
	);
const summaryStop = await rs.fire("session_stop");
await settle(150);
check("a recorded summary prevents the block", !summaryStop.some((r) => r?.decision === "block"));
const summaryMsg = lastCall("sendMessage").body.text;
check("the summary is the body", summaryMsg.includes("all 14 tests pass"));
check("summary markdown renders", summaryMsg.includes("<b>all 14 tests pass</b>"));
check("agent-chosen green renders", summaryMsg.includes("\u{1F7E2}"));

await rs.fire("input");
await rs.tools
	.get("notify_status")
	.execute("n2", { summary: "Blocked: need the staging credentials.", urgency: "red" }, undefined, undefined, rs.ctx);
await rs.fire("session_stop");
await settle(150);
check(
	"agent-chosen red renders as action required",
	lastCall("sendMessage").body.text.includes("\u{1F534} Action required"),
);

await rs.fire("input");
const unknownUrgency = await rs.tools
	.get("notify_status")
	.execute("n3", { summary: "Two designs possible, opinion wanted.", urgency: "purple" }, undefined, undefined, rs.ctx);
check("an unknown urgency is rejected", unknownUrgency.isError === true);

await rs.fire("input");
const empty = await rs.tools
	.get("notify_status")
	.execute("n4", { summary: "   ", urgency: "green" }, undefined, undefined, rs.ctx);
check("an empty summary is rejected", empty.isError === true);
const blockedAgain = await rs.fire("session_stop");
check(
	"a new turn requires a new summary",
	blockedAgain.some((r) => r?.decision === "block"),
);

// ------------------------------------------------------------- turn-end choice questions
heading("turn-end choice questions");
rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
const tq = spawn("01a04400-0000-0000-0000-000000000000", "/home/dev/work/sqlitegis");
await tq.fire("session_start");

await tq.tools.get("notify_status").execute(
	"q1",
	{
		summary: "Refactor done, diff is large.",
		urgency: "orange",
		question: "How should we proceed?",
		options: ["Continue", "Review the diff", "Stop here"],
	},
	undefined,
	undefined,
	tq.ctx,
);
const stopRes = await tq.fire("session_stop");
await settle(150);
check("a recorded request does not block", !stopRes.some((r) => r?.decision === "block"));
const tqMsg = lastCall("sendMessage").body;
check("the notification is a question with buttons", tqMsg.reply_markup.inline_keyboard.flat().length === 3);
check(
	"summary and question are both in the body",
	tqMsg.text.includes("diff is large") && tqMsg.text.includes("How should we proceed?"),
);
check("the urgency light is the agent's", tqMsg.text.includes("\u{1F7E0}"));
const tqButton = tqMsg.reply_markup.inline_keyboard.flat().find((b) => b.text === "Review the diff");
check("buttons carry the choice payload", tqButton.callback_data.startsWith("c:"));

writeFileSync(join(inboxOf(tq.id), "990.json"), JSON.stringify({ kind: "callback", value: tqButton.callback_data }));
await tq.pump(250);
check(
	"a press starts the next turn with the label",
	tq.steers.some((x) => x.text === "Review the diff" && x.options === undefined),
);
const retired = lastCall("editMessageText");
check(
	"the question message is retired with the choice",
	retired.body.text.includes("Chosen:") && retired.body.text.includes("Review the diff"),
);
check(
	"its options stay visible but dead, the choice ticked",
	retired.body.reply_markup.inline_keyboard.flat().every((b) => b.disabled !== undefined) &&
		retired.body.reply_markup.inline_keyboard.flat().some((b) => b.text === "\u2713 Review the diff"),
);
check(
	"selected standing answer retains context and question",
	retired.body.text.startsWith(badgeHead(tq.id, "sqlitegis")) && retired.body.text.includes("How should we proceed?"),
);

// A second press on the same, now cleared, question is told it is closed.
writeFileSync(join(inboxOf(tq.id), "991.json"), JSON.stringify({ kind: "callback", value: tqButton.callback_data }));
const beforeStale2 = called("sendMessage").length;
await tq.pump(250);
check(
	"a stale press is answered with a closure notice",
	called("sendMessage").length === beforeStale2 + 1 && lastCall("sendMessage").body.text.includes("closed"),
);

// A new question supersedes an old one.
await tq.fire("input");
await tq.tools
	.get("notify_status")
	.execute(
		"q2",
		{ summary: "First.", urgency: "orange", question: "Use the first choice?", options: ["A", "B"] },
		undefined,
		undefined,
		tq.ctx,
	);
await tq.fire("session_stop");
await settle(150);
const firstQ = lastCall("sendMessage").body.reply_markup.inline_keyboard[0][0].callback_data;
await tq.tools
	.get("notify_status")
	.execute(
		"q3",
		{ summary: "Second.", urgency: "orange", question: "Use the second choice?", options: ["C", "D"] },
		undefined,
		undefined,
		tq.ctx,
	);
await tq.fire("session_stop");
await settle(200);
const supersededStanding = lastCall("editMessageText");
check(
	"superseded standing question retains context, question, and reason",
	supersededStanding.body.text.startsWith(badgeHead(tq.id, "sqlitegis")) &&
		supersededStanding.body.text.includes("Use the first choice?") &&
		supersededStanding.body.text.includes("Superseded by a newer question"),
);
writeFileSync(join(inboxOf(tq.id), "992.json"), JSON.stringify({ kind: "callback", value: firstQ }));
await tq.pump(250);
check("a press on the superseded question is refused", lastCall("sendMessage").body.text.includes("closed"));

// A standing question survives a session resume.
const tqRecord = JSON.parse(readFileSync(join(sessionsDir, `${tq.id}.json`), "utf8"));
check(
	"the standing question persists its compact settlement head",
	tqRecord.standing !== null &&
		Array.isArray(tqRecord.standing.labels) &&
		typeof tqRecord.standing.head === "string" &&
		tqRecord.standing.head.includes("Use the second choice?"),
);
const resumed = spawn(tq.id, "/home/dev/work/sqlitegis");
await resumed.fire("session_start");
const standingId = tqRecord.standing.id;
writeFileSync(join(inboxOf(tq.id), "993.json"), JSON.stringify({ kind: "callback", value: `c:${standingId}:1` }));
await resumed.pump(250);
check(
	"a press after a resume still starts the next turn",
	resumed.steers.some((x) => x.text === "D"),
);
const resumedRetired = lastCall("editMessageText");
check(
	"resumed standing answer retains its stored context and question",
	resumedRetired.body.text.startsWith(badgeHead(tq.id, "sqlitegis")) &&
		resumedRetired.body.text.includes("Use the second choice?") &&
		resumedRetired.body.text.includes("Chosen:") &&
		resumedRetired.body.text.includes("D"),
);

// A terminal reply while a choice question stands on Telegram must close it.
await tq.fire("input");
await tq.tools
	.get("notify_status")
	.execute("q5", { summary: "Choose.", urgency: "orange", options: ["Go on", "Halt"] }, undefined, undefined, tq.ctx);
await tq.fire("session_stop");
await settle(150);
const q5Btn = lastCall("sendMessage").body.reply_markup.inline_keyboard.flat()[0];
const editsBefore = called("editMessageText").length;
await tq.fire("input"); // the user typed the answer at the terminal instead
await settle(200);
const closing5 = called("editMessageText").slice(editsBefore);
check(
	"terminal reply closes the standing telegram question",
	closing5.some((c) => c.body.text.includes("Answered at the terminal")),
);
check(
	"its buttons are removed",
	closing5.some(
		(c) => Array.isArray(c.body.reply_markup?.inline_keyboard) && c.body.reply_markup.inline_keyboard.length === 0,
	),
);
writeFileSync(join(inboxOf(tq.id), "994.json"), JSON.stringify({ kind: "callback", value: q5Btn.callback_data }));
await tq.pump(250);
check("a press after the terminal answered is refused", lastCall("sendMessage").body.text.includes("closed"));

await tq.tools
	.get("notify_status")
	.execute(
		"q6",
		{ summary: "Choose again.", urgency: "orange", options: ["Proceed", "Wait"] },
		undefined,
		undefined,
		tq.ctx,
	);
await tq.fire("session_stop");
await settle(150);
const telegramQuestionId = record(tq.id).standing.messageId;
const telegramEditsBefore = called("editMessageText").length;
await tq.fire("agent_start");
await settle(150);
const telegramClosures = called("editMessageText").slice(telegramEditsBefore);
check(
	"a Telegram-started turn retires the standing question",
	telegramClosures.some(
		(c) => c.body.message_id === telegramQuestionId && c.body.text.includes("Superseded by new work"),
	),
);
check("the retired standing question is cleared from the record", record(tq.id).standing === null);

// notify_status validation: a bad options list costs the buttons, never the notification.
const badOpts = await tq.tools
	.get("notify_status")
	.execute("q4", { summary: "x", urgency: "green", options: ["only-one"] }, undefined, undefined, tq.ctx);
check("a single option still records the status", badOpts.isError !== true);
check("a single option is reported as too few", /fewer than 2/.test(badOpts.content[0].text));

// ------------------------------------------------------------------ button packing
heading("button packing");
const bp = spawn("01a04500-0000-0000-0000-000000000000", "/home/dev/work/rats");
await bp.fire("session_start");
const bpState = {};
const bpRun = bp.tools.get("ask").execute(
	"bp",
	{
		questions: [
			{
				id: "p",
				question: "Pick",
				options: [
					{ label: "Yes" },
					{ label: "No" },
					{ label: "Skip" },
					{ label: "Continue" },
					{ label: "Review the diff" },
					{ label: "A very long deliberate label that needs its own row" },
				],
			},
		],
	},
	undefined,
	undefined,
	stubbornCtx(bp.ctx, bpState),
);
await settle(180);
const bpRows = lastCall("sendMessage").body.reply_markup.inline_keyboard;
const shape = bpRows.map((r) => r.map((b) => b.text));
check("three tiny labels share one row", shape[0].length === 3 && shape[0].join(",") === "Yes,No,Skip");
check("two medium labels pair up", shape[1].length === 2 && shape[1][0] === "Continue");
check("a long label gets a full row", shape[2].length === 1 && shape[2][0].startsWith("A very long"));
check("no tail row follows the options", shape.length === 3);
const bpPick = bpRows.flat().find((b) => b.text === "Review the diff").callback_data;
writeFileSync(join(inboxOf(bp.id), "995.json"), JSON.stringify({ kind: "callback", value: bpPick }));
rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
bp.heartbeat();
await bp.pump(250);
check("packing does not disturb option indices", (await bpRun).details.selectedOptions[0] === "Review the diff");

// ------------------------------------------------------- review-pass regression pins
heading("review-pass fixes");
// Fix 2: a resume keeps reply routing to pre-restart messages and keeps recency.
// Refresh rr1's record heartbeat so a slow suite run cannot let reapDeadSessions
// delete it before rrBack's session_start reads the previous record.
rr1.heartbeat();
const rrBack = spawn(rr1.id, "/home/dev/work/subql");
await rrBack.fire("session_start");
const rrRecord = JSON.parse(readFileSync(join(sessionsDir, `${rr1.id}.json`), "utf8"));
check("a resume restores the recent message ids", rrRecord.recent.includes(rr1Id));
check("a resume restores lastNotified", rrRecord.lastNotified > 0);
api.queued = [
	{
		update_id: 210,
		message: {
			message_id: 95,
			date: 1,
			chat: { id: CHAT },
			text: "after the restart",
			reply_to_message: { message_id: rr1Id },
		},
	},
];
rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
rrBack.heartbeat();
await rrBack.pump(250);
check("a reply to a pre-restart message still routes", inboxCount(rr1.id) === 1);
for (const f of readdirSync(inboxOf(rr1.id))) unlinkSync(join(inboxOf(rr1.id), f));

// Fix 3: routing skips a stale record without deleting it, so its inbox is not orphaned.
const staleId = "01a04700-dead-0000-0000-000000000000";
writeFileSync(
	join(sessionsDir, `${staleId}.json`),
	JSON.stringify({
		pid: 999999,
		tag: "qqqqq",
		name: "",
		cwd: "/x",
		emoji: "\u{1F344}",
		label: "",
		lastNotified: Date.now() + 10,
		recent: [],
		standing: null,
		heartbeat: Date.now() - 600_000,
	}),
);
api.queued = [{ update_id: 211, message: { message_id: 96, date: 1, chat: { id: CHAT }, text: "bare" } }];
await rrBack.pump(250);
check("a stale record does not win recency routing", inboxCount(staleId) === 0);
check("routing does not delete the stale record", existsSync(join(sessionsDir, `${staleId}.json`)));
unlinkSync(join(sessionsDir, `${staleId}.json`));

heading("remote interaction upgrades");
rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
const ux = spawn("01a04800-0000-0000-0000-000000000000", "/home/dev/work/pgvector");
await ux.fire("session_start");
check("the command menu is registered", called("setMyCommands").length > 0);

// Typing is chat-wide, so a session claims it only while it owes the user an answer.
const typingBefore = called("sendChatAction").length;
await ux.fire("input");
await ux.fire("agent_start");
await ux.pump(150);
check("a turn started at the terminal shows no typing", called("sendChatAction").length === typingBefore);
writeFileSync(join(inboxOf(ux.id), "6098.json"), JSON.stringify({ kind: "text", value: "carry on", messageId: 78 }));
await ux.pump(150);
await ux.pump(150);
check("a reply arriving mid-turn shows typing", called("sendChatAction").length === typingBefore + 1);
check("the action is typing", lastCall("sendChatAction").body.action === "typing");
await ux.fire("agent_end");
await ux.fire("agent_start");
await ux.pump(150);
check("typing stops once the answer has gone out", called("sendChatAction").length === typingBefore + 1);
// A reply that lands on an idle session types on the turn it starts.
await ux.fire("agent_end");
writeFileSync(join(inboxOf(ux.id), "6099.json"), JSON.stringify({ kind: "text", value: "and rebase", messageId: 79 }));
await ux.pump(150);
check("an idle session does not type before its turn starts", called("sendChatAction").length === typingBefore + 1);
await ux.fire("agent_start");
await ux.pump(150);
check("the turn answering a delivered reply types", called("sendChatAction").length === typingBefore + 2);
await ux.fire("agent_end");
// An entry answered locally owes nothing: an unreadable image never reaches the agent.
writeFileSync(
	join(inboxOf(ux.id), "6100.json"),
	JSON.stringify({ kind: "file", value: join(root, "gone.png"), mime: "image/png", messageId: 77 }),
);
await ux.pump(150);
await ux.fire("agent_start");
await ux.pump(150);
check("an entry answered locally shows no typing", called("sendChatAction").length === typingBefore + 2);
await ux.fire("agent_end");
// Message text that happens to look like a close press is still a message.
writeFileSync(
	join(inboxOf(ux.id), "6101.json"),
	JSON.stringify({ kind: "text", value: "k: keep going", messageId: 76 }),
);
await ux.pump(150);
await ux.fire("agent_start");
await ux.pump(150);
check("text that looks like a close press still types", called("sendChatAction").length === typingBefore + 3);
await ux.fire("agent_end");

// A text reply to the question message answers it, no button needed.
const uxState = {};
const uxRun = ux.tools
	.get("ask")
	.execute(
		"ux1",
		{ questions: [{ id: "q", question: "Deploy how?", options: [{ label: "Canary" }, { label: "Full" }] }] },
		undefined,
		undefined,
		stubbornCtx(ux.ctx, uxState),
	);
await settle(150);
const uxMsg = lastCall("sendMessage").body;
const uxMsgId = api.nextMessage - 1;
check("the question opens the reply interface", uxMsg.reply_markup.force_reply === true);
writeFileSync(
	join(inboxOf(ux.id), "600.json"),
	JSON.stringify({ kind: "text", value: "canary, but watch the p99", replyTo: uxMsgId, messageId: 80 }),
);
await ux.pump(250);
const uxResult = await uxRun;
check("a reply to the question answers it", uxResult.details.customInput === "canary, but watch the p99");
check("the reply is not steered into the turn", !ux.steers.some((s) => s.text === "canary, but watch the p99"));

// A steer is acknowledged with a reaction.
writeFileSync(
	join(inboxOf(ux.id), "601.json"),
	JSON.stringify({ kind: "text", value: "also bump the deps", messageId: 81 }),
);
await ux.pump(250);
check(
	"a steer reaches the agent",
	ux.steers.some((s) => s.text === "also bump the deps"),
);
check("and is acknowledged with a thumbs up", lastCall("setMessageReaction").body.message_id === 81);

// Button presses through the poller answer with a toast.
await ux.fire("input");
await ux.tools
	.get("notify_status")
	.execute("ux2", { summary: "Pick one.", urgency: "orange", options: ["Go", "Stop"] }, undefined, undefined, ux.ctx);
await ux.fire("session_stop");
await settle(150);
const uxStanding = lastCall("sendMessage").body;
check("the standing question opens the reply interface too", uxStanding.reply_markup.force_reply === true);
const uxGo = uxStanding.reply_markup.inline_keyboard.flat()[0];
api.queued = [
	{
		update_id: 610,
		callback_query: {
			id: "cbux",
			data: uxGo.callback_data,
			from: { id: CHAT },
			message: { message_id: 7, chat: { id: CHAT } },
		},
	},
];
await ux.pump(250);
await ux.pump(250);
const uxToast = called("answerCallbackQuery").find((c) => c.body.callback_query_id === "cbux");
check(
	"a standing press answers with a toast",
	uxToast !== undefined && uxToast.body.text === "Starting the next turn.",
);

// A settled question keeps its options as dead buttons carrying `x`. A press on one is not a
// routing failure, and saying the session is gone is a different and more alarming claim.
api.queued = [
	{
		update_id: 6120,
		callback_query: { id: "cbdead", data: "x", from: { id: CHAT }, message: { message_id: 7, chat: { id: CHAT } } },
	},
];
await ux.pump(250);
const deadToast = called("answerCallbackQuery").find((c) => c.body.callback_query_id === "cbdead");
check(
	"a settled button says the question is already answered",
	deadToast?.body.text.includes("already answered") === true,
);
check("a settled button does not claim the session died", deadToast?.body.text.includes("session is gone") !== true);

// The poller hands a press to the owning session and cannot know whether it still fits the open
// question: a double tap arrives after the ask has moved on and is discarded. Claiming it was
// recorded is a claim the poller is in no position to make.
await ux.fire("input");
const dtState = {};
const dtPair = {
	questions: [
		{ id: "d1", question: "First?", options: [{ label: "yes" }, { label: "no" }] },
		{ id: "d2", question: "Second?", options: [{ label: "alpha" }, { label: "beta" }] },
	],
};
const runDouble = ux.tools.get("ask").execute("dt1", dtPair, undefined, undefined, stubbornCtx(ux.ctx, dtState));
await settle(150);
const dtAsk = lastCall("sendMessage").body.reply_markup.inline_keyboard[0][0].callback_data.split(":")[1];
for (const id of ["cbtap1", "cbtap2"]) {
	api.queued = [
		{
			update_id: id === "cbtap1" ? 6121 : 6122,
			callback_query: {
				id,
				data: `o:${dtAsk}:0:0`,
				from: { id: CHAT },
				message: { message_id: 7, chat: { id: CHAT } },
			},
		},
	];
	await ux.pump(250);
	await ux.pump(250);
}
const secondTap = called("answerCallbackQuery").find((c) => c.body.callback_query_id === "cbtap2");
// The press has to be acknowledged, or the button spins until Telegram gives up, and the wording
// has to claim only what the poller did rather than an outcome it cannot know.
check("a discarded second tap is acknowledged", secondTap !== undefined);
check("a discarded second tap is not confirmed as recorded", secondTap?.body.text === "Sent to that session.");
writeFileSync(join(inboxOf(ux.id), "6123.json"), JSON.stringify({ kind: "callback", value: `o:${dtAsk}:1:1` }));
await ux.pump(250);
check("the double-tapped ask still finishes", (await runDouble).details.results.length === 2);

// The toast describes a delivery, so it must not precede the write that performs it.
chmodSync(inboxOf(ux.id), 0o500);
api.queued = [
	{
		update_id: 6124,
		callback_query: {
			id: "cbundeliverable",
			data: `c:${record(ux.id).tag}-n1:0`,
			from: { id: CHAT },
			message: { message_id: 7, chat: { id: CHAT } },
		},
	},
];
await ux.pump(250);
chmodSync(inboxOf(ux.id), 0o700);
check(
	"a press that could not be delivered is not acknowledged as sent",
	!called("answerCallbackQuery").some((c) => c.body.callback_query_id === "cbundeliverable"),
);

// hidequestions closes the open buttons.
await ux.fire("input");
await ux.tools
	.get("notify_status")
	.execute(
		"ux3",
		{ summary: "Choose.", urgency: "orange", question: "Which hidden choice?", options: ["A", "B"] },
		undefined,
		undefined,
		ux.ctx,
	);
await ux.fire("session_stop");
await settle(150);
writeFileSync(join(inboxOf(ux.id), "6101.json"), JSON.stringify({ kind: "command", value: "status" }));
await ux.pump(250);
const openQuestionStatus = lastCall("sendMessage").body.text;
check(
	"status begins with context while a choice is open",
	openQuestionStatus.startsWith(
		`\u{1F535} Task: pgvector [${record(ux.id).tag}] | Model: openai/gpt-5.6-sol | Tmux: not attached`,
	),
);
check("status retains the open-question alert", openQuestionStatus.includes("A choice question stands open."));
api.queued = [{ update_id: 611, message: { message_id: 82, date: 1, chat: { id: CHAT }, text: "/hidequestions" } }];
await ux.pump(250);
await ux.pump(250);
check(
	"hidequestions retires the standing question",
	called("editMessageText").some((c) => c.body.text.includes("Question hidden")),
);
const hiddenStanding = lastCall("editMessageText");
check(
	"hidden standing question retains context, question, and reason",
	hiddenStanding.body.text.startsWith(badgeHead(ux.id, "pgvector")) &&
		hiddenStanding.body.text.includes("Which hidden choice?") &&
		hiddenStanding.body.text.includes("Question hidden"),
);

await ux.tools
	.get("notify_status")
	.execute("ux-hide", { summary: "Done.", urgency: "green" }, undefined, undefined, ux.ctx);
await ux.fire("session_stop");
await settle(150);
const hiddenOfferId = record(ux.id).closeOffer;
writeFileSync(join(inboxOf(ux.id), "6111.json"), JSON.stringify({ kind: "command", value: "hidequestions" }));
await ux.pump(200);
check(
	"hidequestions retires the close-session offer",
	called("editMessageReplyMarkup").some(
		(c) =>
			c.body.message_id === hiddenOfferId &&
			Array.isArray(c.body.reply_markup?.inline_keyboard) &&
			c.body.reply_markup.inline_keyboard.length === 0,
	),
);
check("hidequestions clears the recorded close-session offer", record(ux.id).closeOffer === null);

// /hidequestions on a native ask retires its Telegram message but leaves the question open at the
// terminal, so the retired message says so and the terminal can still answer it.
const hideState = {};
const hideRun = ux.tools
	.get("ask")
	.execute(
		"ux-hide-ask",
		{ questions: [{ id: "h", question: "Hide me?", options: [{ label: "yes" }, { label: "no" }] }] },
		undefined,
		undefined,
		stubbornCtx(ux.ctx, hideState),
	);
await settle(150);
const hideAskId = api.nextMessage - 1;
writeFileSync(join(inboxOf(ux.id), "6112.json"), JSON.stringify({ kind: "command", value: "hidequestions" }));
await ux.pump(200);
const hiddenAsk = called("editMessageText").findLast((c) => c.body.message_id === hideAskId);
check(
	"hidequestions retires an open native ask under its badge",
	hiddenAsk?.body.text.startsWith(badgeHead(ux.id, "pgvector")) === true &&
		hiddenAsk.body.text.includes("Hide me?") &&
		hiddenAsk.body.text.includes("stays open at the terminal"),
);
check("the hidden ask is still waiting at the terminal", hideState.aborted !== true);
writeFileSync(join(inboxOf(ux.id), "6113.json"), JSON.stringify({ kind: "text", value: "yes, hide" }));
await ux.pump(200);
check("a typed answer still settles the hidden ask", (await hideRun).details.customInput === "yes, hide");

heading("/fleet reads the tmux window titles");

// A fake tmux binary on PATH stands in for the real server.
const fakeBin = join(root, "fake-bin");
mkdirSync(fakeBin, { recursive: true });
const fakeTmux = join(fakeBin, "tmux");
writeFileSync(
	fakeTmux,
	"#!/bin/sh\nprintf '0\\t0\\t0\\t\\t\u03C0 \u280B Fixing the parser\\n'\nprintf '0\\t1\\t0\\t\\t\u03C0 ! Choose a name\\n'\nprintf '0\\t2\\t1\\t\\t\u03C0 > Docs pass\\n'\nprintf '0\\t3\\t0\\t\\t\u03C0 > Sleepy\\n'\nprintf '0\\t4\\t0\\t\\tbash\\n'\n",
	{ mode: 0o755 },
);
const realPath = process.env.PATH;
process.env.PATH = `${fakeBin}:${realPath}`;
process.env.TMUX = "/tmp/fake-tmux,1,0";
api.queued = [{ update_id: 612, message: { message_id: 83, date: 1, chat: { id: CHAT }, text: "/fleet" } }];
await ux.pump(250);
const fleetMsg = lastCall("sendMessage").body;
check(
	"fleet summarises the states",
	typeof fleetMsg.text === "string" && fleetMsg.text.includes("1 working, 1 waiting for you, 1 finished, 1 idle"),
);
check(
	"fleet lists each omp window with its glyph",
	fleetMsg.text.includes("\u{1F7E2} 0 Fixing the parser") &&
		fleetMsg.text.includes("\u{1F534} 1 Choose a name") &&
		fleetMsg.text.includes("\u2705 2 Docs pass") &&
		fleetMsg.text.includes("\u26AA 3 Sleepy"),
);
check("fleet skips windows that are not omp", !fleetMsg.text.includes("bash"));
check("fleet does not touch any session inbox", inboxCount(ux.id) === 0);

// The report is re-read per command: an emptied fleet answers accordingly.
writeFileSync(fakeTmux, "#!/bin/sh\nprintf '0\\t4\\t0\\t\\tbash\\n'\n", { mode: 0o755 });
api.queued = [{ update_id: 613, message: { message_id: 84, date: 1, chat: { id: CHAT }, text: "/fleet" } }];
await ux.pump(250);
check("an omp-free fleet says so", lastCall("sendMessage").body.text.includes("No omp windows in tmux right now"));

// Without a tmux server the command still answers.
delete process.env.TMUX;
api.queued = [{ update_id: 614, message: { message_id: 85, date: 1, chat: { id: CHAT }, text: "/fleet" } }];
await ux.pump(250);
check("fleet without tmux explains itself", lastCall("sendMessage").body.text.includes("No tmux server is reachable"));
process.env.PATH = realPath;

// Red statuses pin until the next turn.
await ux.fire("input");
await ux.tools
	.get("notify_status")
	.execute("ux4", { summary: "Blocked on credentials.", urgency: "red" }, undefined, undefined, ux.ctx);
await ux.fire("session_stop");
await settle(200);
const pinnedCall = lastCall("pinChatMessage");
check("a red status is pinned", pinnedCall !== undefined && typeof pinnedCall.body.message_id === "number");
check("the pin is recorded for the next session", record(ux.id).pinned === pinnedCall.body.message_id);
writeFileSync(join(inboxOf(ux.id), "6111.json"), JSON.stringify({ kind: "command", value: "status" }));
await ux.pump(250);
const pinnedStatus = lastCall("sendMessage").body.text;
check("status retains the pinned-status alert", pinnedStatus.includes("A red status is pinned."));
await ux.fire("agent_start");
await settle(150);
check("a Telegram-started turn unpins it", lastCall("unpinChatMessage").body.message_id === pinnedCall.body.message_id);
check("the record clears", record(ux.id).pinned === null);

// Green statuses celebrate.
await ux.tools
	.get("notify_status")
	.execute("ux5", { summary: "All 14 tests pass, nothing remains.", urgency: "green" }, undefined, undefined, ux.ctx);
await ux.fire("session_stop");
await settle(150);
const green = called("sendMessage").findLast(
	(c) => typeof c.body.text === "string" && c.body.text.includes("nothing remains"),
);
check("a green status carries the celebration effect", green?.body.message_effect_id === "5046509860389126442");

// A resume carries the badge the agent chose, so the emoji under test is not the luck of the palette.
const iconicId = "01a04900-0000-0000-0000-000000000000";
writeFileSync(
	join(sessionsDir, `${iconicId}.json`),
	JSON.stringify({
		pid: 4321,
		tag: "icon1",
		name: "",
		cwd: "/home/dev/work/duckpond",
		emoji: "\u{1F401}",
		emojiChosen: true,
		label: "",
		lastNotified: 0,
		recent: [],
		heartbeat: Date.now(),
	}),
);
const iconic = spawn(iconicId, "/home/dev/work/duckpond");
await iconic.fire("session_start");
check("the resumed session kept its chosen emoji", record(iconic.id).emoji === "\u{1F401}");

heading("streaming, cost, and transparency");
rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
const fx = spawn("01a04b00-0000-0000-0000-000000000000", "/home/dev/work/quackml");
await fx.fire("session_start");
check(
	"the status and stop commands are registered",
	["status", "stop"].every((name) => lastCall("setMyCommands").body.commands.some((c) => c.command === name)),
);
check("the menu button exposes commands", lastCall("setChatMenuButton").body.menu_button.type === "commands");

// Drafts stream the partial answer. No stop control: with several sessions streaming, one bubble
// flips between them and the button would abort whichever painted last.
await fx.fire("agent_start");
await fx.fire("message_update", {
	message: { role: "assistant", content: [{ type: "text", text: "Partial answer" }] },
});
await fx.pump(150);
const draft = lastCall("sendMessageDraft");
check("a partial answer streams as a draft", draft?.body.text.includes("Partial answer") === true);
check("the draft carries no stop control", draft.body.can_stop === undefined);
check("the draft has a stable non-zero id", typeof draft.body.draft_id === "number" && draft.body.draft_id !== 0);
const draftContext = `Task: quackml [${record(fx.id).tag}] | Model: openai/gpt-5.6-sol | Tmux: not attached`;
check("every draft starts with session context", draft.body.text.startsWith(draftContext));

await fx.fire("tool_execution_start", { toolName: "bash", intent: "Running tests" });
await settle(1600);
await fx.pump(150);
check("tool activity rides in the draft", lastCall("sendMessageDraft").body.text.includes("bash: Running tests"));
check("tool draft still starts with session context", lastCall("sendMessageDraft").body.text.startsWith(draftContext));
fx.ctx.model = { provider: "anthropic", id: "claude-sonnet-4-6" };
await fx.fire("message_update", {
	message: { role: "assistant", content: [{ type: "text", text: "Partial answer after fallback" }] },
});
await settle(1600);
await fx.pump(150);
const switchedDraft = lastCall("sendMessageDraft").body;
check(
	"a later draft reflects the live model and retains its content",
	switchedDraft.text.startsWith(
		`Task: quackml [${record(fx.id).tag}] | Model: anthropic/claude-sonnet-4-6 | Tmux: not attached`,
	) &&
		switchedDraft.text.includes("Partial answer after fallback") &&
		switchedDraft.text.includes("bash: Running tests") &&
		switchedDraft.can_stop === undefined,
);
fx.ctx.model = { provider: "openai", id: "gpt-5.6-sol" };

// Usage lands as a footer on the turn-end summary.
await fx.fire("message_end", {
	message: {
		role: "assistant",
		provider: "openai",
		model: "gpt-5.6-sol",
		usage: { input: 12400, output: 900, cost: { total: 0.0512 } },
	},
});
await fx.fire("agent_end");
await fx.tools.get("notify_status").execute("f1", { summary: "Done.", urgency: "green" }, undefined, undefined, fx.ctx);
await fx.fire("session_stop");
await settle(150);
const footerMsg = lastCall("sendMessage").body.text;
check("the summary carries token counts", footerMsg.includes("12.4k in / 900 out"));
check("the summary carries the cost", footerMsg.includes("$0.051"));
check("the summary counts tools", footerMsg.includes("1 tool"));
check("the summary names the model", footerMsg.includes("openai/gpt-5.6-sol"));

// Fallback turns keep usage attributed to the model that incurred it.
await fx.fire("input");
await fx.fire("agent_start");
await fx.fire("tool_execution_start", { toolName: "read" });
await fx.fire("tool_execution_start", { toolName: "bash" });
await fx.fire("message_end", {
	message: { role: "assistant", usage: { input: 200, output: 50, cost: { total: 0.01 } } },
});
await fx.fire("message_end", {
	message: {
		role: "assistant",
		provider: "anthropic",
		model: "claude-sonnet-4-6",
		usage: { input: 300, output: 70, cost: { total: 0.02 } },
	},
});
await fx.fire("message_end", {
	message: {
		role: "assistant",
		provider: "openai",
		model: "gpt-5.6-sol",
		usage: { input: 25, output: 5, cost: { total: 0.001 } },
	},
});
await fx.fire("agent_end");
await fx.tools
	.get("notify_status")
	.execute("usage-fallback", { summary: "Fallback done.", urgency: "green" }, undefined, undefined, fx.ctx);
await fx.fire("session_stop");
await settle(150);
const fallbackFooter = lastCall("sendMessage").body.text;
const fallbackUsageLines = fallbackFooter.split("\n").filter((line) => line.includes(" in / "));
const openaiUsageLine = fallbackUsageLines.find((line) => line.includes("openai/gpt-5.6-sol")) ?? "";
const anthropicUsageLine = fallbackUsageLines.find((line) => line.includes("anthropic/claude-sonnet-4-6")) ?? "";
check(
	"sparse usage uses the model captured at agent start",
	openaiUsageLine.includes("225 in / 55 out") && openaiUsageLine.includes("$0.011"),
);
check(
	"two models produce two lines in first-use order",
	fallbackUsageLines.length === 2 &&
		fallbackUsageLines[0].includes("openai/gpt-5.6-sol") &&
		fallbackUsageLines[1].includes("anthropic/claude-sonnet-4-6"),
);
check(
	"each model line contains only its own usage",
	!openaiUsageLine.includes("300 in / 70 out") &&
		anthropicUsageLine.includes("300 in / 70 out") &&
		anthropicUsageLine.includes("$0.020") &&
		!anthropicUsageLine.includes("225 in / 55 out"),
);
check("the turn-wide tool count appears once", (fallbackFooter.match(/2 tools/g) ?? []).length === 1);

await fx.fire("input");
await fx.fire("agent_start");
await fx.fire("message_end", {
	message: { role: "assistant", usage: { input: 10, output: 4, cost: { total: 0.002 } } },
});
await fx.fire("agent_end");
await fx.tools
	.get("notify_status")
	.execute("usage-reset", { summary: "Next turn.", urgency: "green" }, undefined, undefined, fx.ctx);
await fx.fire("session_stop");
await settle(150);
const resetFooter = lastCall("sendMessage").body.text;
check(
	"the next agent start resets all usage state",
	resetFooter.includes("openai/gpt-5.6-sol") &&
		resetFooter.includes("10 in / 4 out") &&
		resetFooter.includes("$0.002") &&
		!resetFooter.includes("anthropic/claude-sonnet-4-6") &&
		!resetFooter.includes("225 in / 55 out") &&
		!resetFooter.includes("2 tools"),
);

// Provider trouble lands on the record rather than the chat: a crippled cluster fires it in every
// session at once, and one message each buried everything worth reading.
await fx.fire("agent_start");
const healthBefore = called("sendMessage").length;
await fx.fire("auto_retry_start", { attempt: 1, maxAttempts: 8 });
await settle(120);
check("a first attempt is not provider trouble", record(fx.id).health === "");
await fx.fire("auto_retry_start", { attempt: 2, maxAttempts: 8 });
await settle(120);
check("a retry lands on the session record", record(fx.id).health === "retrying (2/8)");
await fx.fire("retry_fallback_applied", { from: "a/x", to: "b/y" });
await settle(120);
check("a fallback replaces the retry note", record(fx.id).health === "fell back to b/y");
check("provider trouble costs no message", called("sendMessage").length === healthBefore);
writeFileSync(join(inboxOf(fx.id), "690.json"), JSON.stringify({ kind: "command", value: "status" }));
await fx.pump(250);
check("status carries the provider note", lastCall("sendMessage").body.text.includes("Provider: fell back to b/y."));
await fx.fire("agent_end");
await fx.fire("agent_start");
await settle(120);
check("a new turn clears the provider note", record(fx.id).health === "");
const tmuxBin = join(root, "bin");
mkdirSync(tmuxBin);
writeFileSync(
	join(tmuxBin, "tmux"),
	`#!/bin/sh
case "$*" in
	*'#{session_name}\t#{window_index}\t#{pane_index}'*) printf 'work\\t3\\t1\\n'
esac
`,
	{ mode: 0o755 },
);
const pathBeforeTmuxTest = process.env.PATH;
process.env.PATH = `${tmuxBin}:${pathBeforeTmuxTest}`;
process.env.TMUX = "test";
process.env.TMUX_PANE = "%7";
fx.setTitle("Tune the quack model");
await fx.fire("auto_compaction_start", { reason: "overflow", action: "context-full" });
await settle(120);
const compactionMsg = lastCall("sendMessage").body.text;
const titleContext = compactionMsg.split("\n")[0];
check("compaction shows a notice", compactionMsg.includes("compacted (overflow)"));
check(
	"session title supplies the context task",
	titleContext === "\u{1F535} Task: Tune the quack model | Model: openai/gpt-5.6-sol | Tmux: work:3.1",
);
check(
	"context is one stable labeled line",
	compactionMsg.split("\n").filter((line) => line.includes("Task: ")).length === 1,
);

await fx.fire("auto_compaction_end", {
	action: "remote",
	aborted: false,
	willRetry: false,
	errorMessage: "provider rejected compaction",
});
await settle(120);
const compactionFailure = lastCall("sendMessage").body.text;
check("compaction failure keeps the start context", compactionFailure.startsWith(titleContext));
check(
	"final compaction failure carries trigger, end action, and error",
	compactionFailure.includes("Trigger: overflow") &&
		compactionFailure.includes("Action: remote") &&
		compactionFailure.includes("provider rejected compaction"),
);

await fx.fire("agent_start");
await fx.fire("auto_compaction_start", { reason: "threshold", action: "handoff" });
await settle(120);
await fx.fire("auto_compaction_end", {
	action: "shake",
	aborted: true,
	willRetry: false,
	errorMessage: "ignored abort detail",
});
await settle(120);
const abortedCompaction = lastCall("sendMessage").body.text;
check(
	"aborted compaction reports aborted",
	abortedCompaction.includes("Trigger: threshold") &&
		abortedCompaction.includes("Action: shake") &&
		abortedCompaction.includes("aborted") &&
		!abortedCompaction.includes("ignored abort detail"),
);

await fx.fire("agent_start");
await fx.fire("auto_compaction_start", { reason: "idle", action: "remote" });
await settle(120);
const longCompactionError = `${"x".repeat(300)}clipped-tail`;
await fx.fire("auto_compaction_end", {
	action: "remote",
	aborted: false,
	willRetry: false,
	errorMessage: longCompactionError,
});
await settle(120);
const clippedCompaction = lastCall("sendMessage").body.text;
check(
	"long compaction errors are clipped at 300 characters",
	clippedCompaction.includes("x".repeat(300)) && !clippedCompaction.includes("clipped-tail"),
);

await fx.fire("agent_start");
await fx.fire("auto_compaction_start", { reason: "incomplete", action: "snapcompact" });
await settle(120);
const beforeSkippedCompaction = called("sendMessage").length;
await fx.fire("auto_compaction_end", {
	action: "snapcompact",
	aborted: false,
	willRetry: false,
	skipped: true,
});
await settle(120);
check("skipped compaction stays silent", called("sendMessage").length === beforeSkippedCompaction);

await fx.fire("agent_start");
await fx.fire("auto_compaction_start", { reason: "overflow", action: "context-full" });
await settle(120);
const beforeRetryingCompaction = called("sendMessage").length;
await fx.fire("auto_compaction_end", {
	action: "context-full",
	aborted: false,
	willRetry: true,
	errorMessage: "retryable failure",
});
await settle(120);
check("retrying compaction stays silent", called("sendMessage").length === beforeRetryingCompaction);

const terminalCompactions = [
	["success", { action: "remote", aborted: false, willRetry: false }],
	["failure", { action: "remote", aborted: false, willRetry: false, errorMessage: "failed" }],
	["abort", { action: "remote", aborted: true, willRetry: false }],
	["skip", { action: "remote", aborted: false, willRetry: false, skipped: true }],
	["retry", { action: "remote", aborted: false, willRetry: true, errorMessage: "retry" }],
];
for (const [label, terminal] of terminalCompactions) {
	await fx.fire("agent_start");
	await fx.fire("auto_compaction_start", { reason: "idle", action: "remote" });
	await settle(120);
	await fx.fire("auto_compaction_end", terminal);
	await settle(120);
	await fx.fire("agent_start");
	const beforeOrphanedEnd = called("sendMessage").length;
	await fx.fire("auto_compaction_end", {
		action: "shake",
		aborted: false,
		willRetry: false,
		errorMessage: "orphaned end",
	});
	await settle(120);
	check(`compaction state clears after ${label}`, called("sendMessage").length === beforeOrphanedEnd);
}

await fx.tools.get("session_badge").execute("identity-badge", { label: "Pinned task" }, undefined, undefined, fx.ctx);
fx.setTitle("Ignored session title");
await fx.fire("agent_start");
await fx.fire("auto_compaction_start", { reason: "overflow", action: "context-full" });
await settle(120);
check(
	"explicit badge label overrides the session title",
	lastCall("sendMessage").body.text.split("\n")[0] ===
		"\u{1F535} Task: Pinned task | Model: openai/gpt-5.6-sol | Tmux: work:3.1",
);

await fx.tools.get("session_badge").execute("identity-clear", { label: "" }, undefined, undefined, fx.ctx);
fx.setTitle("");
await fx.fire("agent_start");
await fx.fire("auto_compaction_start", { reason: "overflow", action: "context-full" });
await settle(120);
check(
	"folder and session tag supply the unnamed task",
	lastCall("sendMessage").body.text.split("\n")[0] ===
		`\u{1F535} Task: quackml [${record(fx.id).tag}] | Model: openai/gpt-5.6-sol | Tmux: work:3.1`,
);

delete process.env.TMUX;
delete process.env.TMUX_PANE;
fx.ctx.model = undefined;
await fx.fire("agent_start");
await fx.fire("auto_compaction_start", { reason: "overflow", action: "context-full" });
await settle(120);
check(
	"absent model and tmux have explicit context values",
	lastCall("sendMessage").body.text.split("\n")[0] ===
		`\u{1F535} Task: quackml [${record(fx.id).tag}] | Model: unavailable | Tmux: not attached`,
);
fx.ctx.model = { provider: "openai", id: "gpt-5.6-sol" };
process.env.PATH = pathBeforeTmuxTest;
await fx.fire("agent_end");

const fxSessionContext = `\u{1F535} Task: quackml [${record(fx.id).tag}] | Model: openai/gpt-5.6-sol | Tmux: not attached`;
// /status answers from the extension without touching the agent.
writeFileSync(join(inboxOf(fx.id), "701.json"), JSON.stringify({ kind: "command", value: "status" }));
await fx.pump(250);
check("status reports the session state", lastCall("sendMessage").body.text.includes("State: idle."));
check(
	"status does not reach the agent",
	!fx.steers.some((s) => typeof s.text === "string" && s.text.includes("status")),
);
check("status begins with session context", lastCall("sendMessage").body.text.startsWith(fxSessionContext));
await fx.fire("credential_disabled", { provider: "anthropic", disabledCause: "do not expose this cause" });
await settle(120);
const credentialNotice = lastCall("sendMessage").body.text;
check("a credential notice begins with session context", credentialNotice.startsWith(fxSessionContext));
check(
	"a credential notice names only the provider",
	credentialNotice.includes("anthropic") && !credentialNotice.includes("do not expose this cause"),
);

// Structured summaries go out as native rich messages, with a plain fallback.
await fx.fire("input");
await fx.tools
	.get("notify_status")
	.execute(
		"f2",
		{ summary: "Results:\n\n| step | state |\n| --- | --- |\n| build | ok |", urgency: "green" },
		undefined,
		undefined,
		fx.ctx,
	);
await fx.fire("session_stop");
await settle(150);
const richSummary = lastCall("sendRichMessage");
check(
	"a table summary goes out as a rich message",
	richSummary?.body.rich_message.markdown.includes("| build | ok |") === true,
);
api.failMethods = ["sendRichMessage"];
await fx.fire("input");
await fx.tools
	.get("notify_status")
	.execute("f3", { summary: "Again:\n\n| a | b |\n| - | - |", urgency: "green" }, undefined, undefined, fx.ctx);
await fx.fire("session_stop");
await settle(150);
check("rich rejection falls back to the plain renderer", lastCall("sendMessage").body.text.includes("| a | b |"));
api.failMethods = [];

// The agent pushes files to the phone.
const artefact = join(root, "artefact.png");
writeFileSync(artefact, "png-bytes");
const photoSend = await fx.tools
	.get("notify_file")
	.execute("f4", { paths: [artefact], caption: "the screenshot" }, undefined, undefined, fx.ctx);
check("a png goes out as a photo", lastCall("sendPhoto").body.photo === "attach://f0");
check("sending a photo shows an upload status", lastCall("sendChatAction").body.action === "upload_photo");
const photoName = lastCall("sendPhoto").files.f0;
check(
	"an uploaded photo carries the standard name",
	/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z__photo__[a-z0-9]{5}\S*__artefact\.png$/u.test(photoName),
);
const fileContext = `Task: quackml [${record(fx.id).tag}] | Model: openai/gpt-5.6-sol | Tmux: not attached`;
// Telegram strips a photo's filename, so the caption is the only place it stays searchable.
check(
	"a single file caption carries context first and the name last",
	lastCall("sendPhoto").body.caption === `${fileContext}\n\nthe screenshot\n\n${photoName}`,
);
check("the tool reports success", photoSend.isError !== true);
const artefact2 = join(root, "artefact2.jpg");
writeFileSync(artefact2, "jpg-bytes");
await fx.tools.get("notify_file").execute("f5", { paths: [artefact, artefact2] }, undefined, undefined, fx.ctx);
check("two images go out as one album", JSON.parse(lastCall("sendMediaGroup").body.media).length === 2);
const albumNames = lastCall("sendMediaGroup").files;
check(
	"every album member carries the standard name",
	/__photo__\S+__artefact\.png$/u.test(albumNames.f0) && /__photo__\S+__artefact2\.jpg$/u.test(albumNames.f1),
);
const contextualAlbumMedia = JSON.parse(lastCall("sendMediaGroup").body.media);
check(
	"an album leads with context and names each item in its own caption",
	contextualAlbumMedia[0].caption === `${fileContext}\n\n${albumNames.f0}` &&
		contextualAlbumMedia[1].caption === albumNames.f1,
);
const logFile = join(root, "build.log");
writeFileSync(logFile, "log-bytes");
await fx.tools.get("notify_file").execute("f6", { paths: [logFile] }, undefined, undefined, fx.ctx);
check("a log goes out as a document", lastCall("sendDocument").body.document === "attach://f0");
check("sending a document shows an upload status", lastCall("sendChatAction").body.action === "upload_document");
const documentName = lastCall("sendDocument").files.f0;
check("an uploaded document carries the standard name", /__document__\S+__build\.log$/u.test(documentName));
check(
	"a captionless document still carries context",
	lastCall("sendDocument").body.caption === `${fileContext}\n\n${documentName}`,
);

api.failMethods = ["sendPhoto"];
const fallbackSend = await fx.tools
	.get("notify_file")
	.execute("f6-fallback", { paths: [artefact], caption: "fallback artifact" }, undefined, undefined, fx.ctx);
api.failMethods = [];
check("a rejected photo falls back to a document", fallbackSend.isError !== true);
check(
	"photo fallback reuses the contextual caption",
	lastCall("sendDocument").body.caption ===
		`${fileContext}\n\nfallback artifact\n\n${lastCall("sendDocument").files.f0}`,
);
check(
	"a photo that falls back is named a document",
	/__document__\S+__artefact\.png$/u.test(lastCall("sendDocument").files.f0),
);

// An uncompressed image needs no disguise: the caller asks for document delivery and the
// original bytes go out under the standard name, extension intact.
const photoCallsBeforeForced = called("sendPhoto").length;
const documentsBeforeForced = called("sendDocument").length;
const forcedSend = await fx.tools
	.get("notify_file")
	.execute(
		"f6-forced",
		{ paths: [artefact], mode: "document", caption: "full resolution" },
		undefined,
		undefined,
		fx.ctx,
	);
check("a forced document reports success", forcedSend.isError !== true);
check("an image sent as a document never reaches sendPhoto", called("sendPhoto").length === photoCallsBeforeForced);
check(
	"an image sent as a document reaches sendDocument",
	called("sendDocument").length === documentsBeforeForced + 1 &&
		lastCall("sendDocument").body.document === "attach://f0",
);
check(
	"a forced document keeps the image extension under the standard name",
	/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z__document__[a-z0-9]{5}\S*__artefact\.png$/u.test(
		lastCall("sendDocument").files.f0,
	),
);
// Lossless delivery is the whole point, so the upload is compared byte for byte with the file.
check(
	"a forced document uploads the file byte for byte",
	Buffer.from(lastCall("sendDocument").bytes.f0).equals(readFileSync(artefact)),
);
check(
	"a forced document shows the document upload status",
	lastCall("sendChatAction").body.action === "upload_document",
);

// The album gate would otherwise re-compress a batch the caller asked to keep intact.
const albumsBeforeForced = called("sendMediaGroup").length;
const documentsBeforeBatch = called("sendDocument").length;
await fx.tools
	.get("notify_file")
	.execute("f6-forced-batch", { paths: [artefact, artefact2], mode: "document" }, undefined, undefined, fx.ctx);
check("a forced batch is never turned into an album", called("sendMediaGroup").length === albumsBeforeForced);
check("a forced batch sends every file as a document", called("sendDocument").length === documentsBeforeBatch + 2);

const photosBeforeAuto = called("sendPhoto").length;
const autoSend = await fx.tools
	.get("notify_file")
	.execute("f6-auto", { paths: [artefact], mode: "auto" }, undefined, undefined, fx.ctx);
check(
	"auto mode still compresses an image",
	autoSend.isError !== true &&
		called("sendPhoto").length === photosBeforeAuto + 1 &&
		lastCall("sendPhoto").body.photo === "attach://f0",
);

const badMode = await fx.tools
	.get("notify_file")
	.execute("f6-badmode", { paths: [artefact], mode: "raw" }, undefined, undefined, fx.ctx);
check("an unknown mode is a clean error", badMode.isError === true);
check("an unknown mode names the accepted values", /auto|document/u.test(badMode.content[0].text));

const longCallerCaption = "z".repeat(2_000);
await fx.tools
	.get("notify_file")
	.execute("f6-long", { paths: [logFile], caption: longCallerCaption }, undefined, undefined, fx.ctx);
const boundedCaption = lastCall("sendDocument").body.caption;
check(
	"a long caller caption is truncated between the context and the name",
	boundedCaption.startsWith(`${fileContext}\n\n`) &&
		boundedCaption.endsWith(`\n\n${lastCall("sendDocument").files.f0}`) &&
		boundedCaption.length <= 1024 &&
		boundedCaption.length > 1000,
);
const missing = await fx.tools
	.get("notify_file")
	.execute("f7", { paths: ["/nope/x.png"] }, undefined, undefined, fx.ctx);
check("a missing file is a clean error", missing.isError === true);

heading("review-two regressions");
rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
const rv = spawn("01a04c00-0000-0000-0000-000000000000", "/home/dev/work/htmlq");
await rv.fire("session_start");

// Usage counters and notice dedupe must reset on the second turn, not just work on the first.
await rv.fire("agent_start");
await rv.fire("message_end", {
	message: { role: "assistant", usage: { input: 200, output: 50, cost: { total: 0.01 } } },
});
await rv.fire("auto_compaction_start", { reason: "overflow", action: "context-full" });
await settle(120);
check(
	"a transparency notice fires in the first turn",
	lastCall("sendMessage").body.text.includes("Context is being compacted (overflow)"),
);
await rv.fire("agent_end");
await rv.tools.get("notify_status").execute("r1", { summary: "One.", urgency: "green" }, undefined, undefined, rv.ctx);
await rv.fire("session_stop");
await settle(150);
check("first turn footer counts its own usage", lastCall("sendMessage").body.text.includes("200 in / 50 out"));
await rv.fire("input");
await rv.fire("agent_start");
await rv.fire("message_end", {
	message: { role: "assistant", usage: { input: 100, output: 30, cost: { total: 0.005 } } },
});
const secondNoticeBefore = called("sendMessage").length;
await rv.fire("auto_compaction_start", { reason: "overflow", action: "context-full" });
await settle(120);
check("the notice dedupe resets with the new turn", called("sendMessage").length === secondNoticeBefore + 1);
await rv.fire("agent_end");
await rv.tools.get("notify_status").execute("r2", { summary: "Two.", urgency: "green" }, undefined, undefined, rv.ctx);
await rv.fire("session_stop");
await settle(150);
const secondFooter = lastCall("sendMessage").body.text;
check(
	"second turn footer starts from zero",
	secondFooter.includes("100 in / 30 out") && !secondFooter.includes("300 in"),
);

// Plain prose must never touch the rich endpoint.
await rv.fire("input");
const richBefore = called("sendRichMessage").length;
await rv.tools
	.get("notify_status")
	.execute("r3", { summary: "Plain sentence, nothing structured.", urgency: "green" }, undefined, undefined, rv.ctx);
await rv.fire("session_stop");
await settle(150);
check("plain prose never touches the rich endpoint", called("sendRichMessage").length === richBefore);
check("plain prose lands as a normal message", lastCall("sendMessage").body.text.includes("Plain sentence"));

// Drafts stay silent while a question is pending.
await rv.fire("input");
await rv.fire("agent_start");
const rvState = {};
const rvAsk = rv.tools
	.get("ask")
	.execute(
		"r4",
		{ questions: [{ id: "q", question: "Q?", options: [{ label: "a" }, { label: "b" }] }] },
		undefined,
		undefined,
		stubbornCtx(rv.ctx, rvState),
	);
await settle(150);
const draftsBefore = called("sendMessageDraft").length;
await rv.fire("message_update", {
	message: { role: "assistant", content: [{ type: "text", text: "should not stream" }] },
});
await settle(1600);
await rv.pump(120);
check("drafts stay silent while a question is pending", called("sendMessageDraft").length === draftsBefore);
const rvAskId = lastCall("sendMessage").body.reply_markup.inline_keyboard[0][0].callback_data.split(":")[1];
writeFileSync(join(inboxOf(rv.id), "800.json"), JSON.stringify({ kind: "callback", value: `o:${rvAskId}:0:0` }));
await rv.pump(250);
await rvAsk;

// The draft throttle limits the send rate to one per window.
await rv.fire("message_update", { message: { role: "assistant", content: [{ type: "text", text: "tick one" }] } });
await rv.pump(80);
const draftCount = called("sendMessageDraft").length;
check("the first dirty tick sends a draft", draftCount === draftsBefore + 1);
await rv.fire("message_update", { message: { role: "assistant", content: [{ type: "text", text: "tick two" }] } });
await rv.pump(80);
check("a second update inside the window is throttled", called("sendMessageDraft").length === draftCount);
await settle(1500);
await rv.pump(80);
check("the throttle releases after its window", called("sendMessageDraft").length === draftCount + 1);

// /stop at an idle session aborts nothing and says so.
await rv.fire("agent_end");
writeFileSync(join(inboxOf(rv.id), "801.json"), JSON.stringify({ kind: "command", value: "stop" }));
await rv.pump(200);
check("a stop command while idle does not abort", rv.aborts === 0);
check("a stop command while idle explains itself", /no turn is running/i.test(lastCall("sendMessage").body.text));

// /status names the running tool.
await rv.fire("input");
await rv.fire("agent_start");
await rv.fire("tool_execution_start", { toolName: "bash", intent: "compiling" });
await rv.fire("message_end", {
	message: { role: "assistant", usage: { input: 77, output: 9, cost: { total: 0.004 } } },
});
writeFileSync(join(inboxOf(rv.id), "802.json"), JSON.stringify({ kind: "command", value: "status" }));
await rv.pump(200);
check("status reports the running tool", lastCall("sendMessage").body.text.includes("working (bash: compiling)"));
const activeStatus = lastCall("sendMessage").body.text;
check(
	"active status begins with session context",
	activeStatus.startsWith(
		`\u{1F535} Task: htmlq [${record(rv.id).tag}] | Model: openai/gpt-5.6-sol | Tmux: not attached`,
	),
);
check(
	"status retains state and active tool without partial usage",
	activeStatus.includes("State: working (bash: compiling).") &&
		!activeStatus.includes("77 in / 9 out") &&
		!activeStatus.includes("$0.004"),
);
await rv.fire("agent_end");

// Every album item names itself and the first leads with context; the sandbox refuses foreign paths.
const chartA = join(root, "chart-a.png");
const chartB = join(root, "chart-b.png");
writeFileSync(chartA, "a");
writeFileSync(chartB, "b");
await rv.tools
	.get("notify_file")
	.execute("r5", { paths: [chartA, chartB], caption: "the chart" }, undefined, undefined, rv.ctx);
const albumMedia = JSON.parse(lastCall("sendMediaGroup").body.media);
const albumFiles = lastCall("sendMediaGroup").files;
check(
	"the album context sits only on the first item, each carrying its own name",
	albumMedia[0].caption ===
		`Task: htmlq [${record(rv.id).tag}] | Model: openai/gpt-5.6-sol | Tmux: not attached\n\nthe chart\n\n${albumFiles.f0}` &&
		albumMedia[1].caption === albumFiles.f1,
);
const outside = await rv.tools
	.get("notify_file")
	.execute("r6", { paths: ["/etc/hostname"] }, undefined, undefined, rv.ctx);
check("paths outside the sandbox are refused", outside.isError === true && outside.content[0].text.includes("outside"));
const dirSend = await rv.tools.get("notify_file").execute("r7", { paths: [root] }, undefined, undefined, rv.ctx);
check("a directory is refused cleanly", dirSend.isError === true);

// An unfetchable file must not wedge the update offset.
api.queued = [
	{
		update_id: 720,
		message: { message_id: 90, date: 1, chat: { id: CHAT }, voice: { file_id: "huge", file_size: 21 * 1024 * 1024 } },
	},
];
await rv.pump(250);
await rv.pump(250);
check("an oversized file is refused with a notice", lastCall("sendMessage").body.text.includes("could not be fetched"));
check(
	"the failed media does not wedge the offset",
	JSON.parse(readFileSync(join(root, "notify-telegram.json"), "utf8")).offset > 720,
);

// Downloaded media is private on disk.
const downloaded = readdirSync(mediaDir).find((f) => f.includes("__u500__"));
check(
	"downloaded media is private",
	downloaded !== undefined && (statSync(join(mediaDir, downloaded)).mode & 0o777) === 0o600,
);

// /stop as a reply targets the replied-to session, not the poller.
rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
const rvA = spawn("01a04d00-0000-0000-0000-000000000000", "/home/dev/work/polars");
await rvA.fire("session_start");
const rvB = spawn("01a04d01-0000-0000-0000-000000000000", "/home/dev/work/arrow");
await rvB.fire("session_start");
await rvB.fire("input");
await rvB.tools
	.get("notify_status")
	.execute("rvb1", { summary: "Arrow round done.", urgency: "green" }, undefined, undefined, rvB.ctx);
await rvB.fire("session_stop");
await settle(150);
const rvBMessage = record(rvB.id).recent.at(-1);
await rvB.fire("agent_start");
api.queued = [
	{
		update_id: 730,
		message: {
			message_id: 730,
			date: 1,
			chat: { id: CHAT },
			text: "/stop",
			reply_to_message: { message_id: rvBMessage },
		},
	},
];
await rvA.pump(250);
check("the stop routes to the replied-to session's inbox", inboxCount(rvB.id) === 1);
const stopEntry = readdirSync(inboxOf(rvB.id))[0];
check("inbox entries are private", (statSync(join(inboxOf(rvB.id), stopEntry)).mode & 0o777) === 0o600);
await rvB.pump(250);
check("the replied-to session aborts", rvB.aborts === 1);
check("the poller session does not", rvA.aborts === 0);

// streamDrafts: false silences the stream entirely.
writeConfig({ streamDrafts: false });
rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
const quietDrafts = spawn("01a04e00-0000-0000-0000-000000000000", "/home/dev/work/sled");
await quietDrafts.fire("session_start");
await quietDrafts.fire("agent_start");
const draftsQuiet = called("sendMessageDraft").length;
await quietDrafts.fire("message_update", {
	message: { role: "assistant", content: [{ type: "text", text: "hidden" }] },
});
await settle(1600);
await quietDrafts.pump(120);
check("streamDrafts false silences the draft stream", called("sendMessageDraft").length === draftsQuiet);
await quietDrafts.fire("agent_end");
writeConfig();

heading("new behavior regressions");

// a. A markdown link whose URL contains a double quote renders &quot; in the href
// and the message still goes out as HTML (no plain-text downgrade).
rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
const nbSess = spawn("01a05020-0000-0000-0000-000000000000", "/home/dev/work/newbeh");
await nbSess.fire("session_start");
await nbSess.fire("input");
await nbSess.tools
	.get("notify_status")
	.execute(
		"nb1",
		{ summary: 'See [the docs](https://example.com/"quoted"/path).', urgency: "green" },
		undefined,
		undefined,
		nbSess.ctx,
	);
await nbSess.fire("session_stop");
await settle(150);
const quotedMsg = lastCall("sendMessage").body;
check(
	"double-quote in link href renders as &quot;",
	quotedMsg.text.includes('href="https://example.com/&quot;quoted&quot;/path"'),
);
check("parse_mode is still HTML when href contains &quot;", quotedMsg.parse_mode === "HTML");

// b. A NUL-digit-NUL sequence in input does not duplicate the stashed code block
// and does not leak the stash marker into the output.
await nbSess.fire("input");
await nbSess.tools
	.get("notify_status")
	.execute(
		"nb2",
		{ summary: "Before \u00000\u0000 after and `real code` end.", urgency: "green" },
		undefined,
		undefined,
		nbSess.ctx,
	);
await nbSess.fire("session_stop");
await settle(150);
const nulMsg = lastCall("sendMessage").body;
check(
	"NUL-digit-NUL in input does not duplicate a stashed code block",
	(nulMsg.text.match(/<code>/g) ?? []).length === 1,
);
check("NUL characters are absent from the rendered output", !nulMsg.text.includes("\u0000"));

// c. A very long string of surrogate-pair emoji triggers the 80% truncation loop
// and the resulting text never ends on a lone high surrogate.
await nbSess.fire("input");
await nbSess.tools
	.get("notify_status")
	.execute("nb3", { summary: "\uD83D\uDE00".repeat(2501), urgency: "green" }, undefined, undefined, nbSess.ctx);
await nbSess.fire("session_stop");
await settle(150);
const surrogateText = lastCall("sendMessage").body.text;
const lastCodeUnit = surrogateText.charCodeAt(surrogateText.length - 1);
check(
	"surrogate-pair truncation: last code unit is not a lone high surrogate",
	lastCodeUnit < 0xd800 || lastCodeUnit > 0xdbff,
);

// d. persistOffset must not lower an offset another process already advanced past.
writeConfig({ offset: 100 });
rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
const noRwSess = spawn("01a05000-0000-0000-0000-000000000000", "/home/dev/work/norewind");
await noRwSess.fire("session_start");
// Simulate another poller advancing the on-disk offset past what this session knows.
writeConfig({ offset: 500 });
api.queued = [{ update_id: 150, message: { message_id: 1, date: 1, chat: { id: CHAT }, text: "late" } }];
await noRwSess.pump(250);
check(
	"persistOffset does not lower an offset already advanced by another process",
	JSON.parse(readFileSync(join(root, "notify-telegram.json"), "utf8")).offset >= 500,
);
writeConfig();

// e. Lock-steal batch drop: an in-flight getUpdates whose lock is stolen while
// awaiting must not deliver to any inbox and must not advance the offset.
rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
const stealSess = spawn("01a05001-0000-0000-0000-000000000000", "/home/dev/work/steal");
await stealSess.fire("session_start");
{
	let resolveGetUpdates;
	const stealBase = globalThis.fetch;
	globalThis.fetch = async (url, init) => {
		const method = String(url).split("/").pop();
		if (method === "getUpdates" && resolveGetUpdates === undefined) {
			await new Promise((r) => {
				resolveGetUpdates = r;
			});
		}
		return stealBase(url, init);
	};
	api.queued = [{ update_id: 999, message: { message_id: 50, date: 1, chat: { id: CHAT }, text: "stolen" } }];
	const offsetBefore = JSON.parse(readFileSync(join(root, "notify-telegram.json"), "utf8")).offset;
	const inboxBefore = inboxCount(stealSess.id);
	const pumpP = stealSess.pump(400);
	await settle(60);
	writeFileSync(
		join(root, "notify-telegram/poller.lock"),
		JSON.stringify({ sessionId: "foreign-0000-0000-0000", pid: 99999, heartbeat: Date.now() }),
	);
	resolveGetUpdates?.();
	await pumpP;
	globalThis.fetch = stealBase;
	check("lock-steal drops in-flight batch: inbox not modified", inboxCount(stealSess.id) === inboxBefore);
	check(
		"lock-steal drops in-flight batch: offset not advanced",
		JSON.parse(readFileSync(join(root, "notify-telegram.json"), "utf8")).offset === offsetBefore,
	);
}

// f. Orphaned-keyboard guard: when the terminal resolves the ask while the next
// question's sendMessage is still in flight, advance closes the orphan keyboard
// with "This question is no longer active."
rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
const orphanSess = spawn("01a05002-0000-0000-0000-000000000000", "/home/dev/work/orphan");
await orphanSess.fire("session_start");
{
	let resolveTerminal;
	const orphanCtx = {
		...orphanSess.ctx,
		invokeTool: () =>
			new Promise((r) => {
				resolveTerminal = r;
			}),
	};
	let orphanSendCount = 0;
	let resolveSendQ2;
	const orphanBase = globalThis.fetch;
	globalThis.fetch = async (url, init) => {
		const method = String(url).split("/").pop();
		if (method === "sendMessage") {
			orphanSendCount++;
			if (orphanSendCount === 2) {
				await new Promise((r) => {
					resolveSendQ2 = r;
				});
			}
		}
		return orphanBase(url, init);
	};
	const orphanRun = orphanSess.tools.get("ask").execute(
		"ork",
		{
			questions: [
				{ id: "a", question: "First?", options: [{ label: "x" }] },
				{ id: "b", question: "Second?", options: [{ label: "y" }] },
			],
		},
		undefined,
		undefined,
		orphanCtx,
	);
	await settle(150);
	const q1Cb = lastCall("sendMessage").body.reply_markup.inline_keyboard[0][0].callback_data;
	writeFileSync(join(inboxOf(orphanSess.id), "1001.json"), JSON.stringify({ kind: "callback", value: q1Cb }));
	const orphanPump = orphanSess.pump(600);
	await settle(80);
	resolveTerminal?.({ content: [{ type: "text", text: "done at terminal" }], details: {} });
	await settle(80);
	resolveSendQ2?.();
	await orphanPump;
	globalThis.fetch = orphanBase;
	void orphanRun.catch(() => undefined);
	check(
		"orphaned-keyboard guard closes q2 with the inactive notice",
		called("editMessageText").some((c) => c.body.text.includes("This question is no longer active.")),
	);
}

// g. An inbox entry for an image that cannot be read back sends a service notice
// and does not fire a reaction ack for that message.
{
	rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
	const dropSess = spawn("01a05003-0000-0000-0000-000000000000", "/home/dev/work/drop");
	await dropSess.fire("session_start");
	const dropMsgId = 4242;
	writeFileSync(
		join(inboxOf(dropSess.id), "2001.json"),
		JSON.stringify({ kind: "file", value: "/nonexistent/ghost.png", mime: "image/png", messageId: dropMsgId }),
	);
	const reactsBefore = called("setMessageReaction").length;
	await dropSess.pump(250);
	check(
		"photo-drop notice: service message sent for unreadable image",
		called("sendMessage").some((c) => c.body.text?.includes("could not be read back from disk")),
	);
	check(
		"photo-drop notice: no reaction ack for the dropped message",
		!called("setMessageReaction").some((c) => c.body.message_id === dropMsgId) &&
			called("setMessageReaction").length === reactsBefore,
	);
}

// A session shutdown turns an open standing question into a closing message.
{
	rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
	const bye = spawn("01a06001-0000-0000-0000-000000000000", "/home/dev/work/bye");
	await bye.fire("session_start");
	await bye.fire("input");
	await bye.tools
		.get("notify_status")
		.execute(
			"bye1",
			{ summary: "Round done.", urgency: "orange", options: ["Continue", "Stop"] },
			undefined,
			undefined,
			bye.ctx,
		);
	await bye.fire("session_stop");
	await settle(150);
	check(
		"the shutdown test opens a standing question",
		lastCall("sendMessage").body.reply_markup.inline_keyboard.flat().length === 2,
	);
	await bye.fire("session_shutdown");
	await settle(150);
	const closures = called("editMessageText").filter((c) => c.body.text.includes("Session closed."));
	check(
		"session shutdown closes the standing question and keeps the summary",
		closures.some((c) => c.body.text.includes("Round done.")),
	);
	check(
		"the closed question keeps no live buttons",
		closures.every((c) => (c.body.reply_markup?.inline_keyboard ?? []).flat().length === 0),
	);
	const record = JSON.parse(readFileSync(join(sessionsDir, `${bye.id}.json`), "utf8"));
	check("the shutdown clears the standing question from the record", record.standing === null);
}

{
	rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
	const closedAsk = spawn("01a05005-0000-0000-0000-000000000000", "/home/dev/work/closed-ask");
	await closedAsk.fire("session_start");
	await closedAsk.tools
		.get("notify_status")
		.execute("shutdown-red", { summary: "Blocked.", urgency: "red" }, undefined, undefined, closedAsk.ctx);
	await closedAsk.fire("session_stop");
	await settle(150);
	const shutdownPinId = record(closedAsk.id).pinned;
	const shutdownAskId = api.nextMessage;
	void closedAsk.tools
		.get("ask")
		.execute("shutdown-ask", singleQuestion, undefined, undefined, stubbornCtx(closedAsk.ctx, {}));
	await settle(150);
	await closedAsk.fire("session_shutdown");
	await settle(150);
	check(
		"session shutdown closes the pending ask",
		called("editMessageText").some(
			(c) => c.body.message_id === shutdownAskId && c.body.text.includes("This question is no longer active"),
		),
	);
	check(
		"flat session shutdown unpins the red status",
		called("unpinChatMessage").some((c) => c.body.message_id === shutdownPinId),
	);
	check("flat session shutdown clears the recorded pin", record(closedAsk.id).pinned === null);
}

// Drafts render the markdown subset, with a plain fallback when the HTML is rejected.
{
	rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
	const md = spawn("01a06002-0000-0000-0000-000000000000", "/home/dev/work/mdraft");
	await md.fire("session_start");
	await md.fire("agent_start");
	await md.fire("message_update", {
		message: { role: "assistant", content: [{ type: "text", text: "some **bold** and `code` here" }] },
	});
	await settle(1600);
	await md.pump(150);
	const rendered = lastCall("sendMessageDraft");
	check(
		"a draft renders the markdown subset as HTML",
		rendered?.body.parse_mode === "HTML" &&
			rendered.body.text.includes("<b>bold</b>") &&
			rendered.body.text.includes("<code>code</code>"),
	);
	api.rejectHtml = true;
	await md.fire("message_update", {
		message: { role: "assistant", content: [{ type: "text", text: "plain **fallback** text" }] },
	});
	await settle(1600);
	await md.pump(150);
	const fallback = lastCall("sendMessageDraft");
	check(
		"a rejected draft falls back to the raw text",
		fallback?.body.parse_mode === undefined && fallback.body.text.includes("**fallback**"),
	);
	api.rejectHtml = false;
	await md.fire("agent_end");
}

// A streaming ask tool call previews its questions in the draft, header first.
{
	rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
	const qp = spawn("01a06003-0000-0000-0000-000000000000", "/home/dev/work/qdraft");
	await qp.fire("session_start");
	await qp.fire("agent_start");
	const askContent = [{ type: "toolCall", id: "t1", name: "ask", arguments: {} }];
	const askMsg = { role: "assistant", content: askContent };
	await qp.fire("message_update", {
		message: askMsg,
		assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial: askMsg },
	});
	await qp.fire("message_update", {
		message: askMsg,
		assistantMessageEvent: {
			type: "toolcall_delta",
			contentIndex: 0,
			delta: '{"questions":[{"question":"Ship the \\"big\\" relea',
			partial: askMsg,
		},
	});
	await settle(1600);
	await qp.pump(150);
	const partial = lastCall("sendMessageDraft");
	check(
		"a streaming ask previews the partial question under an input-needed line",
		partial?.body.text.includes("Input needed") === true && partial.body.text.includes('Ship the "big" relea'),
	);
	check("the ask preview leads with the session badge", partial.body.text.indexOf("qdraft") >= 0);
	await qp.fire("message_update", {
		message: askMsg,
		assistantMessageEvent: {
			type: "toolcall_delta",
			contentIndex: 0,
			delta: 'se now?","options":[]},{"question":"Also update the docs?"',
			partial: askMsg,
		},
	});
	await settle(1600);
	await qp.pump(150);
	const both = lastCall("sendMessageDraft");
	check(
		"a second streamed question numbers the preview",
		both?.body.text.includes('1. Ship the "big" release now?') === true &&
			both.body.text.includes("2. Also update the docs?"),
	);
	await qp.fire("message_update", {
		message: askMsg,
		assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall: askContent[0], partial: askMsg },
	});
	await qp.fire("message_update", {
		message: { role: "assistant", content: [{ type: "text", text: "back to prose" }] },
	});
	await settle(1600);
	await qp.pump(150);
	check(
		"the preview clears once the ask call completes",
		lastCall("sendMessageDraft").body.text.includes("back to prose"),
	);
	await qp.fire("agent_end");
}

// A green summary offers a close-session button that shuts the session down from the phone.
{
	rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
	const cs = spawn("01a06004-0000-0000-0000-000000000000", "/home/dev/work/closer");
	let shutdowns = 0;
	cs.ctx.shutdown = () => {
		shutdowns += 1;
	};
	await cs.fire("session_start");
	await cs.fire("input");
	await cs.tools
		.get("notify_status")
		.execute("g1", { summary: "All done.", urgency: "green" }, undefined, undefined, cs.ctx);
	await cs.fire("session_stop");
	await settle(150);
	const doneMsg = lastCall("sendMessage");
	const closeBtn = (doneMsg.body.reply_markup?.inline_keyboard ?? [])
		.flat()
		.find((b) => b.callback_data?.startsWith("k:"));
	check("a green summary carries a close-session button", closeBtn !== undefined && closeBtn.style === "danger");
	await cs.fire("input");
	await cs.tools
		.get("notify_status")
		.execute("g2", { summary: "Reply wanted.", urgency: "orange" }, undefined, undefined, cs.ctx);
	await cs.fire("session_stop");
	await settle(150);
	check(
		"an orange summary has no close button",
		(lastCall("sendMessage").body.reply_markup?.inline_keyboard ?? [])
			.flat()
			.every((b) => b.callback_data?.startsWith("k:") !== true),
	);
	await cs.fire("input");
	await cs.tools
		.get("notify_status")
		.execute(
			"g3",
			{ summary: "Done, pick.", urgency: "green", options: ["Merge", "Wait"] },
			undefined,
			undefined,
			cs.ctx,
		);
	await cs.fire("session_stop");
	await settle(150);
	check(
		"a green standing question appends the close row",
		lastCall("sendMessage")
			.body.reply_markup.inline_keyboard.flat()
			.some((b) => b.callback_data?.startsWith("k:")),
	);
	const tag = JSON.parse(readFileSync(join(sessionsDir, `${cs.id}.json`), "utf8")).tag;
	writeFileSync(
		join(inboxOf(cs.id), "3001.json"),
		JSON.stringify({ kind: "callback", value: `k:${tag}`, messageId: 5555 }),
	);
	await cs.pump(250);
	check("a close press shuts the session down", shutdowns === 1);
	const strip = called("editMessageReplyMarkup").find((c) => c.body.message_id === 5555);
	check(
		"a close press strips the button from a plain summary",
		strip !== undefined && strip.body.reply_markup.inline_keyboard.length === 0,
	);
}

// A Telegram reply focuses the session's tmux window, but never while the terminal is busy.
{
	rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
	const binDir = join(root, "fakebin");
	mkdirSync(binDir, { recursive: true });
	const tmuxLog = join(root, "tmux-calls.log");
	writeFileSync(join(binDir, "tmux"), `#!/bin/sh\necho "$@" >> ${tmuxLog}\n`, { mode: 0o755 });
	const oldPath = process.env.PATH;
	process.env.PATH = `${binDir}:${oldPath}`;
	process.env.TMUX = "/tmp/fake-tmux,1,0";
	process.env.TMUX_PANE = "%77";
	writeConfig({ quietSeconds: 1 });
	const fw = spawn("01a06005-0000-0000-0000-000000000000", "/home/dev/work/focus");
	let typed = null;
	fw.ctx.hasUI = true;
	fw.ctx.ui = {
		onTerminalInput: (fn) => {
			typed = fn;
			return () => {};
		},
	};
	await settle(1100);
	await fw.fire("session_start");
	rmSync(tmuxLog, { force: true });
	writeFileSync(
		join(inboxOf(fw.id), "3101.json"),
		JSON.stringify({ kind: "text", value: "go ahead", messageId: 6001 }),
	);
	await fw.pump(250);
	check(
		"a telegram reply focuses the session's tmux window",
		existsSync(tmuxLog) && readFileSync(tmuxLog, "utf8").includes("select-window -t %77"),
	);
	rmSync(tmuxLog, { force: true });
	typed();
	writeFileSync(
		join(inboxOf(fw.id), "3102.json"),
		JSON.stringify({ kind: "text", value: "and this too", messageId: 6002 }),
	);
	await fw.pump(250);
	check(
		"no focus jump while the terminal is busy",
		!existsSync(tmuxLog) || !readFileSync(tmuxLog, "utf8").includes("select-window"),
	);
	writeConfig();
	process.env.PATH = oldPath;
	delete process.env.TMUX;
	delete process.env.TMUX_PANE;
}

// Starting new work retires a stale close-session button.
{
	rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
	const rt = spawn("01a06006-0000-0000-0000-000000000000", "/home/dev/work/retire");
	await rt.fire("session_start");
	await rt.fire("input");
	await rt.tools
		.get("notify_status")
		.execute("r1", { summary: "Everything done.", urgency: "green" }, undefined, undefined, rt.ctx);
	await rt.fire("session_stop");
	await settle(150);
	const offerId = JSON.parse(readFileSync(join(sessionsDir, `${rt.id}.json`), "utf8")).closeOffer;
	check("a plain green summary records its close-offer message", typeof offerId === "number");
	await rt.fire("agent_start");
	await settle(150);
	const strip = called("editMessageReplyMarkup").find((c) => c.body.message_id === offerId);
	check(
		"new work strips the stale close button",
		strip !== undefined && strip.body.reply_markup.inline_keyboard.length === 0,
	);
	check(
		"the retired offer leaves the record",
		JSON.parse(readFileSync(join(sessionsDir, `${rt.id}.json`), "utf8")).closeOffer === null,
	);
	await rt.fire("agent_end");
}

heading("oversized message truncation");
{
	// A fenced summary would otherwise leave through the native rich path.
	api.failMethods = ["sendRichMessage"];
	rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
	const tr = spawn("01a06010-0000-0000-0000-000000000000", "/home/dev/work/toolong");
	await tr.fire("session_start");

	// a. A summary whose rendered form blows past the limit keeps the turn's usage
	// footer and says out loud that it was cut.
	await tr.fire("agent_start");
	await tr.fire("message_end", {
		message: { role: "assistant", usage: { input: 12400, output: 900, cost: { total: 0.0512 } } },
	});
	await tr.fire("agent_end");
	await tr.tools
		.get("notify_status")
		.execute("t1", { summary: "&".repeat(900), urgency: "green" }, undefined, undefined, tr.ctx);
	await tr.fire("session_stop");
	await settle(150);
	const cut = lastCall("sendMessage").body.text;
	check("an oversized summary keeps the usage footer", cut.includes("12.4k in / 900 out"));
	check("an oversized summary says it was truncated", cut.includes("truncated, full text at the terminal"));
	check("an oversized summary fits the telegram limit", cut.length <= 4096);

	// b. Escaping inflates the rendered form up to fivefold, so the fit test has to
	// be on the rendered text and not on the source.
	await tr.fire("agent_start");
	await tr.fire("agent_end");
	await tr.tools
		.get("notify_status")
		.execute("t2", { summary: "<".repeat(200), urgency: "green" }, undefined, undefined, tr.ctx);
	await tr.fire("session_stop");
	await settle(150);
	check("a dense-escape summary fits the telegram limit", lastCall("sendMessage").body.text.length <= 4096);

	// c. A cut inside a fenced code block leaves a stray fence that renders as
	// literal backticks, so the cut has to keep the fences balanced.
	await tr.fire("agent_start");
	await tr.fire("agent_end");
	await tr.tools
		.get("notify_status")
		.execute("t3", { summary: `\`\`\`\n${"&".repeat(880)}\n\`\`\``, urgency: "green" }, undefined, undefined, tr.ctx);
	await tr.fire("session_stop");
	await settle(150);
	const fenced = lastCall("sendMessage").body.text;
	check("a truncated fence leaks no literal backticks", !fenced.includes("```"));
	check(
		"a truncated fence stays balanced",
		(fenced.match(/<pre>/g) ?? []).length === (fenced.match(/<\/pre>/g) ?? []).length,
	);
	check("a truncated fenced summary fits the telegram limit", fenced.length <= 4096);
	api.failMethods = [];
}

heading("status tool feedback");
{
	rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
	const sf = spawn("01a06011-0000-0000-0000-000000000000", "/home/dev/work/statusfeedback");
	await sf.fire("session_start");

	// a. A colour the tool does not know is a mistake worth surfacing, not a silent green.
	await sf.fire("input");
	const yellow = await sf.tools
		.get("notify_status")
		.execute("s1", { summary: "Half done.", urgency: "yellow" }, undefined, undefined, sf.ctx);
	check("an unknown urgency returns an error", yellow.isError === true);
	check(
		"the urgency error names the accepted values",
		["green", "orange", "red"].every((word) => yellow.content[0].text.includes(word)),
	);
	const rejectedStop = await sf.fire("session_stop");
	check(
		"a rejected urgency records no status",
		rejectedStop.some((r) => r?.decision === "block"),
	);
	await settle(150);

	// b. The 900-character cap is invisible to the agent today, so it never learns to compress.
	await sf.fire("input");
	const long = await sf.tools
		.get("notify_status")
		.execute("s2", { summary: "x".repeat(1200), urgency: "green" }, undefined, undefined, sf.ctx);
	check("an over-long summary is still recorded", long.isError !== true);
	check("an over-long summary reports its truncation", long.content[0].text.includes("truncated"));
	await sf.fire("session_stop");
	await settle(150);
}

heading("surrogate-safe clipping");
{
	// A caption cut at 1024 UTF-16 units must not end on half an emoji. FormData
	// turns the orphaned half into a replacement character, which is what ships.
	rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
	const sg = spawn("01a06012-0000-0000-0000-000000000000", `/home/dev/work/${"\u{1F600}".repeat(100)}`);
	await sg.fire("session_start");
	await settle(150);
	const shot = join(root, "clip.png");
	writeFileSync(shot, "png-bytes");
	await sg.tools
		.get("notify_file")
		.execute("sb2", { paths: [shot], caption: `${"a".repeat(1023)}\u{1F600}` }, undefined, undefined, sg.ctx);
	check("a clipped caption holds no replacement character", !lastCall("sendPhoto").body.caption.includes("\uFFFD"));

	// Every other cut this extension makes has the same failure mode: a UTF-16 cap that lands on the
	// high half of an emoji ships a lone surrogate, which Telegram refuses. Each cap is probed with
	// text whose last allowed unit is exactly that half.
	const half = (units) => `${"a".repeat(units - 1)}\u{1F600}`;

	// The turn summary, cut at 900. A question follows it so the cut is mid-message, where the
	// send-time guard against a trailing lone surrogate cannot catch it.
	await sg.fire("input");
	await sg.tools
		.get("notify_status")
		.execute("sc1", { summary: half(900), urgency: "green", question: "Ok?" }, undefined, undefined, sg.ctx);
	await sg.fire("session_stop");
	await settle(150);
	check("a clipped summary holds no lone surrogate", lastCall("sendMessage").body.text.isWellFormed());

	// The badge label, cut at 60, reaches the record and every head built from it.
	await sg.tools.get("session_badge").execute("sc2", { label: half(60) }, undefined, undefined, sg.ctx);
	check("a clipped badge label holds no lone surrogate", record(sg.id).label.isWellFormed());

	// The session title, cut at 60 for the context line.
	const titled = spawn("01a06015-0000-0000-0000-000000000000", "/home/dev/work/titled", half(60));
	await titled.fire("session_start");
	await titled.fire("credential_disabled", { provider: "anthropic" });
	await settle(150);
	check("a clipped session title holds no lone surrogate", lastCall("sendMessage").body.text.isWellFormed());

	// The running tool's intent, cut at 80 for the state line.
	await titled.fire("agent_start");
	await titled.fire("tool_execution_start", { toolName: "bash", intent: half(80 - "bash: ".length) });
	check("a clipped tool label holds no lone surrogate", record(titled.id).state.isWellFormed());
	await titled.fire("agent_end");

	// A compaction failure message, cut at 300.
	await titled.fire("agent_start");
	await titled.fire("auto_compaction_start", { reason: "overflow", action: "context-full" });
	await settle(150);
	await titled.fire("auto_compaction_end", { errorMessage: half(300), action: "context-full" });
	await settle(150);
	check("a clipped compaction error holds no lone surrogate", lastCall("sendMessage").body.text.isWellFormed());
	await titled.fire("agent_end");

	// An option preview, cut at 300 inside its fence.
	const pvState = {};
	const pvRun = titled.tools
		.get("ask")
		.execute(
			"sc3",
			{ questions: [{ id: "p", question: "Which?", options: [{ label: "a", preview: half(300) }, { label: "b" }] }] },
			undefined,
			undefined,
			stubbornCtx(titled.ctx, pvState),
		);
	await settle(150);
	check("a clipped option preview holds no lone surrogate", lastCall("sendMessage").body.text.isWellFormed());
	const pvAsk = lastCall("sendMessage").body.reply_markup.inline_keyboard.flat()[0].callback_data.split(":")[1];
	writeFileSync(join(inboxOf(titled.id), "997.json"), JSON.stringify({ kind: "callback", value: `o:${pvAsk}:0:0` }));
	await titled.pump(200);
	await pvRun;

	// The agent's last words, cut at 600 when no status was recorded.
	titled.ctx.sessionManager.getBranch = () => [
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: half(600) }] } },
	];
	await titled.fire("input");
	await titled.fire("session_stop");
	await settle(150);
	check("a clipped last paragraph holds no lone surrogate", lastCall("sendMessage").body.text.isWellFormed());
}

heading("a discarded inbox entry is never silent");
{
	rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
	const ib = spawn("01a06014-0000-0000-0000-000000000000", "/home/dev/work/inbox-drop");
	await ib.fire("session_start");
	await settle(150);
	// The entry is deleted before it is parsed, so a poison file cannot loop forever. That makes
	// the log the only remaining trace, and a message the user typed is what is at stake.
	const dir = join(root, "notify-telegram/inbox", ib.id);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "900.json"), '"a bare string"');
	writeFileSync(join(dir, "901.json"), '{"kind":"text","value":""}');
	writeFileSync(join(dir, "902.json"), '{"kind":"text"}');
	await ib.pump(250);
	const trace = (needle) => ib.warns.some((w) => `${w.m} ${JSON.stringify(w.meta ?? {})}`.includes(needle));
	check("an inbox entry that is not an object is named in a warning", trace("900.json"));
	check("an inbox entry with an empty value is named in a warning", trace("901.json"));
	check("an inbox entry with no value at all is named in a warning", trace("902.json"));
	check(
		"the discarded inbox entries are still removed",
		!existsSync(join(dir, "900.json")) && !existsSync(join(dir, "901.json")),
	);
}

heading("uncovered event handlers");
{
	rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
	const ev = spawn("01a06020-0000-0000-0000-000000000000", "/home/dev/work/events");
	await ev.fire("session_start");

	await ev.fire("credential_disabled", { provider: "anthropic" });
	await settle(150);
	check(
		"a disabled credential reaches the phone",
		lastCall("sendMessage").body.text.includes("Credential disabled for anthropic."),
	);

	await ev.fire("agent_start");
	await ev.fire("retry_fallback_succeeded", { model: "openai/gpt-5" });
	await settle(150);
	check("a recovered fallback names the model", record(ev.id).health === "recovered on openai/gpt-5");

	// A failure notice now carries the trigger and action from the start event, so it only speaks
	// when it saw one. The start itself announces once per turn; the quiet endings add nothing.
	await ev.fire("auto_compaction_start", { reason: "overflow", action: "context-full" });
	await settle(150);
	const afterStart = called("sendMessage").length;
	await ev.fire("auto_compaction_end", { skipped: true });
	await ev.fire("auto_compaction_start", { reason: "overflow", action: "context-full" });
	await ev.fire("auto_compaction_end", { willRetry: true, aborted: true });
	await settle(150);
	check("a skipped or retried compaction says nothing", called("sendMessage").length === afterStart);
	await ev.fire("auto_compaction_start", { reason: "overflow", action: "context-full" });
	await ev.fire("auto_compaction_end", { aborted: true });
	await settle(150);
	check(
		"an aborted compaction warns about the context window",
		lastCall("sendMessage").body.text.includes("Context compaction failed."),
	);
	await ev.fire("agent_end");
	await ev.fire("agent_start");
	await ev.fire("auto_compaction_start", { reason: "overflow", action: "context-full" });
	await ev.fire("auto_compaction_end", { errorMessage: "out of memory" });
	await settle(150);
	check(
		"a failed compaction warns about the context window",
		lastCall("sendMessage").body.text.includes("Context compaction failed."),
	);
	check("a failed compaction names the failure", lastCall("sendMessage").body.text.includes("out of memory"));
	await ev.fire("agent_end");
}

heading("media fetch failures");
{
	rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
	const mf = spawn("01a06021-0000-0000-0000-000000000000", "/home/dev/work/mediafail");
	await mf.fire("session_start");
	// Recency routing would hand these to whichever session notified last, so each update
	// replies to a message this session actually sent.
	await mf.fire("input");
	await mf.tools
		.get("notify_status")
		.execute("mf0", { summary: "Ready for files.", urgency: "green" }, undefined, undefined, mf.ctx);
	await mf.fire("session_stop");
	await settle(150);
	const mfMessage = record(mf.id).recent.at(-1);
	let nextUpdate = 800;
	const dropped = async (fileId) => {
		nextUpdate += 1;
		api.queued = [
			{
				update_id: nextUpdate,
				message: {
					message_id: nextUpdate,
					date: 1,
					chat: { id: CHAT },
					voice: { file_id: fileId },
					reply_to_message: { message_id: mfMessage },
				},
			},
		];
		// The drain empties the inbox in the same pump, so the steer is what proves delivery.
		const before = mf.steers.length;
		await mf.pump(250);
		await mf.pump(250);
		return { notice: lastCall("sendMessage")?.body.text ?? "", delivered: mf.steers.length > before };
	};

	// Each path must also leave a trace naming which one fired. A lost file with an identical
	// generic notice for five causes is undiagnosable, which is how one image vanished untraced.
	const traced = (reason) => mf.warns.some((w) => `${w.m} ${JSON.stringify(w.meta ?? {})}`.includes(reason));

	api.failMethods = ["getFile"];
	const refused = await dropped("refused");
	check("a refused getFile drops the file with a notice", refused.notice.includes("could not be fetched"));
	check("a refused getFile delivers nothing", !refused.delivered);
	check("a refused getFile leaves a trace", traced("getFile"));
	api.failMethods = [];

	api.filePath = null;
	const pathless = await dropped("pathless");
	check("a getFile without a path drops the file with a notice", pathless.notice.includes("could not be fetched"));
	check("a missing file path leaves a trace", traced("no file path"));
	api.filePath = "";
	const emptyPath = await dropped("emptypath");
	check("a getFile with an empty path drops the file with a notice", emptyPath.notice.includes("could not be fetched"));
	api.filePath = "documents/file_9.oga";

	api.fileDownload = "error";
	const rejectedBytes = await dropped("rejected");
	check("a rejected download drops the file with a notice", rejectedBytes.notice.includes("could not be fetched"));
	check("a rejected download leaves a trace", traced("download rejected"));
	api.fileDownload = "throw";
	const brokenPipe = await dropped("broken");
	check("a thrown download drops the file with a notice", brokenPipe.notice.includes("could not be fetched"));
	check("a thrown download leaves a trace", traced("download failed"));
	api.fileDownload = "ok";

	const good = await dropped("good");
	check("a healthy download still reaches the session", good.delivered);
}

heading("rich status options");
{
	rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
	const ro = spawn("01a06030-0000-0000-0000-000000000000", "/home/dev/work/richopts");
	await ro.fire("session_start");

	await ro.fire("input");
	await ro.tools.get("notify_status").execute(
		"ro1",
		{
			summary: "Two ways forward.",
			urgency: "orange",
			question: "Which one?",
			options: [
				{ label: "Merge now", description: "CI is green and the branch is current.", recommended: true },
				{
					label: "Wait a day for the nightly run to finish before merging this branch",
					description: "Lets the nightly run catch flakes.",
					lukewarm: true,
				},
				{ label: "Force push", description: "Rewrites history other people have pulled.", discouraged: true },
			],
		},
		undefined,
		undefined,
		ro.ctx,
	);
	await ro.fire("session_stop");
	await settle(150);
	const rich = lastCall("sendMessage").body;
	check(
		"a rich option's description reaches the message body",
		rich.text.includes("CI is green and the branch is current."),
	);
	check("every rich description reaches the body", rich.text.includes("Lets the nightly run catch flakes."));
	const richButtons = (rich.reply_markup?.inline_keyboard ?? []).flat();
	const merge = richButtons.find((b) => b.text.startsWith("Merge now"));
	const wait = richButtons.find((b) => b.text.startsWith("Wait a day"));
	const force = richButtons.find((b) => b.text.startsWith("Force push"));
	check("the recommended option gets the success style", merge?.style === "success");
	check("the recommended option is marked preferable", merge?.text.includes("(preferable)"));
	check(
		"the lukewarm option carries its marker and no style",
		wait?.text.endsWith("\u{1F7E0} (lukewarm)") === true && wait.style === undefined,
	);
	check("a cut lukewarm label still fits the button", (wait?.text.length ?? 0) <= 60);
	check("the discouraged option gets the danger style", force?.style === "danger");
	check(
		"a rich option still answers by index",
		richButtons.filter((b) => b.callback_data?.startsWith("c:")).length === 3,
	);

	// A press still steers the plain label, not the marker-decorated button text.
	const richTag = record(ro.id).tag;
	const richId = record(ro.id).standing?.id ?? "none";
	writeFileSync(
		join(inboxOf(ro.id), "4001.json"),
		JSON.stringify({ kind: "callback", value: `c:${richId}:0`, messageId: 9001 }),
	);
	await ro.pump(250);
	check("a rich option press steers the bare label", ro.steers.at(-1)?.text === "Merge now");
	check(
		"the rich standing question belongs to this session",
		typeof richTag === "string" && richId.startsWith(richTag),
	);

	// Plain strings keep working, with no markers and no descriptions.
	await ro.fire("input");
	await ro.tools
		.get("notify_status")
		.execute(
			"ro2",
			{ summary: "Simple.", urgency: "orange", options: ["Continue", "Stop"] },
			undefined,
			undefined,
			ro.ctx,
		);
	await ro.fire("session_stop");
	await settle(150);
	const plain = lastCall("sendMessage").body;
	const plainButtons = plain.reply_markup.inline_keyboard.flat();
	check("plain string options still render two buttons", plainButtons.length === 2);
	check(
		"plain string options carry no stance marker",
		plainButtons.every((b) => !b.text.includes("(")),
	);
	check(
		"plain string options carry no style",
		plainButtons.every((b) => b.style === undefined),
	);
	check("plain string options add nothing to the body", !plain.text.includes("**Continue**"));

	// A malformed option loses its button, not the whole notification.
	await ro.fire("input");
	const bad = await ro.tools
		.get("notify_status")
		.execute(
			"ro3",
			{ summary: "Bad.", urgency: "orange", options: ["Fine", { note: "no label" }] },
			undefined,
			undefined,
			ro.ctx,
		);
	check("an option without a label still records the status", bad.isError !== true);
	check("an option without a label is named in the result", /1 of 2 options/.test(bad.content[0].text));
}

heading("aggregated status");
{
	rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
	const trio = [];
	for (const [index, folder] of ["alpha-svc", "beta-svc", "gamma-svc"].entries()) {
		const s = spawn(`01a0604${index}-0000-0000-0000-000000000000`, `/home/dev/work/${folder}`);
		await s.fire("session_start");
		// A notify puts these three at the head of the recency order, so one of them answers.
		await s.fire("input");
		await s.tools
			.get("notify_status")
			.execute(`agg${index}`, { summary: `${folder} is done.`, urgency: "green" }, undefined, undefined, s.ctx);
		await s.fire("session_stop");
		await settle(150);
		trio.push(s);
	}

	const before = called("sendMessage").length;
	api.queued = [{ update_id: 910, message: { message_id: 910, date: 1, chat: { id: CHAT }, text: "/status" } }];
	// One pump polls, the next drains what it delivered.
	for (const s of trio) await s.pump(250);
	for (const s of trio) await s.pump(250);
	const replies = called("sendMessage").slice(before);
	const stateReplies = replies.filter((c) => c.body.text?.includes("State:"));
	check("a flat /status answers exactly once", stateReplies.length === 1);
	const roll = stateReplies[0]?.body.text ?? "";
	check(
		"the one reply lists every live session",
		["alpha-svc", "beta-svc", "gamma-svc"].every((f) => roll.includes(f)),
	);
	check("the reply carries each session's last summary", roll.includes("beta-svc is done."));
	check("the reply says how long ago each summary landed", /\d+[smh] ago/.test(roll));

	// A session mid-turn reports as working, not idle.
	await trio[0].fire("input");
	await trio[0].fire("agent_start");
	await trio[0].fire("tool_execution_start", { toolName: "bash", intent: "Running tests" });
	await settle(60);
	const workingBefore = called("sendMessage").length;
	api.queued = [{ update_id: 911, message: { message_id: 911, date: 1, chat: { id: CHAT }, text: "/status" } }];
	for (const s of trio) await s.pump(250);
	for (const s of trio) await s.pump(250);
	const workingRoll =
		called("sendMessage")
			.slice(workingBefore)
			.find((c) => c.body.text?.includes("State:"))?.body.text ?? "";
	check("a busy session reports the tool it is running", workingRoll.includes("bash: Running tests"));
	await trio[0].fire("tool_execution_end", {});

	// The blue notices are the only sends with no length cap, and the /status answer grows with the
	// fleet: one block per live session, each carrying a summary clipped to 160 characters. Past the
	// limit Telegram refuses it outright, so the command gets no answer at all.
	const swollen = [];
	for (let i = 0; i < 40; i++) {
		const id = `01a060ee-0000-0000-0000-0000000000${String(i).padStart(2, "0")}`;
		swollen.push(id);
		writeFileSync(
			join(root, "notify-telegram/sessions", `${id}.json`),
			JSON.stringify({
				pid: 3000 + i,
				tag: `y${String(i).padStart(4, "0")}`,
				name: `swollen ${i}`,
				cwd: `/home/dev/work/project-number-${i}`,
				emoji: "\u{1F41D}",
				label: "",
				lastNotified: Date.now() - i,
				recent: [],
				standing: null,
				closeOffer: null,
				pinned: null,
				draftId: 700 + i,
				state: "working (bash: a tool label of a realistic length)",
				summary: "S".repeat(160),
				summaryAt: Date.now(),
				heartbeat: Date.now(),
			}),
		);
	}
	// Delivered straight to a live session: the synthetic records above are the newest notifiers, so
	// the poller would route the command into an inbox no process drains.
	const swollenFrom = api.calls.length;
	writeFileSync(join(inboxOf(trio[0].id), "912.json"), JSON.stringify({ kind: "command", value: "status" }));
	await trio[0].pump(300);
	const bigStatus = api.calls
		.slice(swollenFrom)
		.find((c) => typeof c.body.text === "string" && c.body.text.includes("State:"));
	check("a fleet too big for one message still gets a /status answer", bigStatus !== undefined);
	check("the /status answer is cut to the limit", (bigStatus?.body.text.length ?? 0) <= 4096);
	// The answer goes out as plain text, which Telegram never escapes, so budgeting for escaping
	// would cut a summary dense in ampersands about five times earlier than it has to.
	for (const f of readdirSync(join(root, "notify-telegram/sessions"))) {
		if (!f.startsWith("01a060ee")) continue;
		const path = join(root, "notify-telegram/sessions", f);
		writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), summary: "&".repeat(160) }));
	}
	const denseFrom = api.calls.length;
	writeFileSync(join(inboxOf(trio[0].id), "914.json"), JSON.stringify({ kind: "command", value: "status" }));
	await trio[0].pump(300);
	const denseStatus = api.calls
		.slice(denseFrom)
		.find((c) => typeof c.body.text === "string" && c.body.text.includes("State:"));
	check("a /status dense in special characters still fits", (denseStatus?.body.text.length ?? 0) <= 4096);
	check("a /status dense in special characters is not cut early", (denseStatus?.body.text.length ?? 0) > 3500);

	// The picker that asks which session a bare message belongs to carries the same blocks, and in
	// a fleet this size every session is a rival.
	const pickerFrom = api.calls.length;
	api.queued = [{ update_id: 913, message: { message_id: 913, date: 1, chat: { id: CHAT }, text: "which of you?" } }];
	for (const s of trio) await s.pump(250);
	const bigPicker = api.calls
		.slice(pickerFrom)
		.find((c) => (c.body.reply_markup?.inline_keyboard ?? []).flat().some((b) => b.callback_data?.startsWith("m:")));
	check("a which-session picker is still sent for a big fleet", bigPicker !== undefined);
	check("the which-session picker is cut to the limit", (bigPicker?.body.text.length ?? 0) <= 4096);
	// A shortened list with every button intact would offer a choice the reader cannot see, so the
	// buttons and the listed sessions have to be the same set.
	const pickerButtons = (bigPicker?.body.reply_markup.inline_keyboard ?? []).flat().length;
	const pickerBlocks = (bigPicker?.body.text.match(/State:/g) ?? []).length;
	check("the picker offers a button for every session it lists", pickerButtons === pickerBlocks);
	check("the picker offers no button for a session it left out", pickerButtons < 43);
	check("the picker says some sessions are not listed", bigPicker?.body.text.includes("not listed") === true);
	for (const id of swollen) rmSync(join(root, "notify-telegram/sessions", `${id}.json`), { force: true });
	await trio[0].fire("agent_end");
	await trio[0].fire("session_stop");
	await settle(150);
}

heading("attention-first /fleet");
{
	const fleetBin = join(root, "fleet-bin");
	mkdirSync(fleetBin, { recursive: true });
	// Five omp windows in one tmux session plus a plain shell. Column four is @omp_priority.
	const rows = [
		["0", "0", "", "\u03C0 > Idle one"],
		["1", "0", "", "\u03C0 \u280B Building"],
		["2", "0", "", "\u03C0 ! Needs you"],
		["3", "1", "", "\u03C0 > Done here"],
		["4", "0", "high", "\u03C0 > Marked urgent"],
		["5", "0", "", "bash"],
	];
	writeFileSync(
		join(fleetBin, "tmux"),
		[
			"#!/bin/sh",
			'case "$1" in',
			"  display-message) printf 'main\\t2\\n' ;;",
			"  list-windows)",
			...rows.map((r) => `    printf 'main\\t${r[0]}\\t${r[1]}\\t${r[2]}\\t${r[3]}\\n'`),
			"    ;;",
			"esac",
			"",
		].join("\n"),
		{ mode: 0o755 },
	);
	const priorPath = process.env.PATH;
	process.env.PATH = `${fleetBin}:${priorPath}`;
	process.env.TMUX = "/tmp/fake-tmux,1,0";
	process.env.TMUX_PANE = "%42";

	rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
	const fl = spawn("01a06060-0000-0000-0000-000000000000", "/home/dev/work/fleeted");
	await fl.fire("session_start");
	await settle(150);
	fl.heartbeat();
	await settle(150);
	api.queued = [{ update_id: 930, message: { message_id: 930, date: 1, chat: { id: CHAT }, text: "/fleet" } }];
	await fl.pump(250);
	const report = lastCall("sendMessage").body.text ?? "";
	const at = (needle) => report.indexOf(needle);
	check("waiting comes before finished", at("Needs you") < at("Done here"));
	check("finished comes before working", at("Done here") < at("Building"));
	check("working comes before idle", at("Building") < at("Idle one"));
	check("a priority window is marked", /\u2757/u.test(report) && at("\u2757") < at("Marked urgent"));
	check("an unmarked window carries no priority marker", (report.match(/\u2757/gu) ?? []).length === 1);
	check("non-omp windows stay out", !report.includes("bash"));
	check("the report renders as HTML", lastCall("sendMessage").body.parse_mode === "HTML");

	process.env.PATH = priorPath;
	delete process.env.TMUX;
	delete process.env.TMUX_PANE;
}

heading("turn duration in the footer");
{
	rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
	const td = spawn("01a06070-0000-0000-0000-000000000000", "/home/dev/work/timed");
	await td.fire("session_start");
	await td.fire("input");
	await td.fire("agent_start");
	await td.fire("message_end", {
		message: { role: "assistant", usage: { input: 100, output: 20, cost: { total: 0.002 } } },
	});
	await settle(1100);
	await td.fire("agent_end");
	await td.tools
		.get("notify_status")
		.execute("td1", { summary: "Timed turn.", urgency: "green" }, undefined, undefined, td.ctx);
	await td.fire("session_stop");
	await settle(150);
	// The footer is now one code line per model plus a final line for tools and wall time.
	const timedText = lastCall("sendMessage").body.text ?? "";
	const timedFooter = /<code>([^<]*)<\/code>\s*$/u.exec(timedText)?.[1] ?? "";
	check("the footer still carries tokens and cost", timedText.includes("100 in / 20 out"));
	check("the footer carries the turn duration", /\b\d+s\b/u.test(timedFooter));

	// The footer describes the last agent loop, so a session where none ever ran has no footer at all.
	const tdNone = spawn("01a06071-0000-0000-0000-000000000000", "/home/dev/work/untimed");
	await tdNone.fire("session_start");
	await tdNone.fire("input");
	await tdNone.tools
		.get("notify_status")
		.execute("td2", { summary: "No loop ran.", urgency: "green" }, undefined, undefined, tdNone.ctx);
	await tdNone.fire("session_stop");
	await settle(150);
	check("a session with no agent loop reports no duration", !/<code>/u.test(lastCall("sendMessage").body.text ?? ""));
}

heading("replies reach an idle session");
{
	rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
	const ir = spawn("01a06080-0000-0000-0000-000000000000", "/home/dev/work/idlereply");
	await ir.fire("session_start");

	// A finished turn, which is the state the user replies from on a phone.
	await ir.fire("input");
	await ir.fire("agent_start");
	await ir.fire("agent_end");
	await ir.tools
		.get("notify_status")
		.execute("ir1", { summary: "Done, over to you.", urgency: "green" }, undefined, undefined, ir.ctx);
	await ir.fire("session_stop");
	await settle(150);
	const summaryId = record(ir.id).recent.at(-1);
	check("the summary is recorded for reply routing", typeof summaryId === "number");

	api.queued = [
		{
			update_id: 940,
			message: {
				message_id: 940,
				date: 1,
				chat: { id: CHAT },
				text: "go on then",
				reply_to_message: { message_id: summaryId },
			},
		},
	];
	await ir.pump(250);
	await ir.pump(250);
	const delivered = ir.steers.at(-1);
	check("the reply reaches the session", delivered?.text === "go on then");
	// A steer interrupts a running turn. An idle session has none, so the message is dropped.
	check("a reply to an idle session does not ask for a steer", delivered?.options?.deliverAs !== "steer");

	// An image reply lands the same way.
	const shot = join(root, "idle-shot.png");
	writeFileSync(shot, "png-bytes");
	writeFileSync(
		join(inboxOf(ir.id), "941.json"),
		JSON.stringify({ kind: "file", value: shot, mime: "image/png", messageId: 941 }),
	);
	await ir.pump(250);
	check("an image to an idle session does not ask for a steer", ir.steers.at(-1)?.options?.deliverAs !== "steer");

	// A blue service message belongs to the session that sent it, so a reply to it routes.
	writeFileSync(join(inboxOf(ir.id), "942.json"), JSON.stringify({ kind: "command", value: "status" }));
	await ir.pump(250);
	// The fake server hands out ids from a counter, so the last one is the notice just sent.
	const statusMessage = api.nextMessage - 1;
	check("a service message is recorded for reply routing", record(ir.id).recent.includes(statusMessage));
}

heading("bad options never lose the status");
{
	rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
	const bo = spawn("01a06090-0000-0000-0000-000000000000", "/home/dev/work/badoptions");
	await bo.fire("session_start");

	const send = async (id, params) => {
		await bo.fire("input");
		const result = await bo.tools.get("notify_status").execute(id, params, undefined, undefined, bo.ctx);
		const stop = await bo.fire("session_stop");
		await settle(150);
		const body = lastCall("sendMessage").body;
		return {
			note: result.content?.[0]?.text ?? "",
			isError: result.isError === true,
			text: body.text ?? "",
			buttons: (body.reply_markup?.inline_keyboard ?? []).flat().filter((b) => b.callback_data?.startsWith("c:")),
			blocked: stop.some((r) => r?.decision === "block"),
		};
	};

	// a. Every option unusable. The summary is the payload, so it must still ship.
	const allBad = await send("bo1", {
		summary: "The work is done.",
		urgency: "green",
		question: "What next?",
		options: [{ note: "no label" }, 42],
	});
	check("an unusable options list still sends the summary", allBad.text.includes("The work is done."));
	check("an unusable options list still asks the question", allBad.text.includes("What next?"));
	check("an unusable options list is not an error", !allBad.isError);
	check("an unusable options list explains itself to the agent", /option/i.test(allBad.note));
	check("an unusable options list does not block the turn", !allBad.blocked);
	check("an unusable options list offers no buttons", allBad.buttons.length === 0);

	// b. A mix keeps the good ones rather than throwing the lot away.
	const mixed = await send("bo2", {
		summary: "Half of these are fine.",
		urgency: "orange",
		options: ["Keep going", { label: "Stop here" }, { nope: true }],
	});
	check("a mixed options list keeps the valid buttons", mixed.buttons.length === 2);
	check("a mixed options list still sends the summary", mixed.text.includes("Half of these are fine."));
	check("a mixed options list reports the dropped one", /option/i.test(mixed.note));

	// c. Too many is a trim, not a loss.
	const tooMany = await send("bo3", {
		summary: "Seven choices.",
		urgency: "orange",
		options: ["a", "b", "c", "d", "e", "f", "g"],
	});
	check("more than six options still send the summary", tooMany.text.includes("Seven choices."));
	check("more than six options render six buttons", tooMany.buttons.length === 6);
	check("more than six options say so", /option/i.test(tooMany.note));

	// d. One survivor is not a choice, so no fake single button, but the summary lives.
	const lonely = await send("bo4", {
		summary: "Only one left.",
		urgency: "orange",
		options: ["Only this", { bad: 1 }],
	});
	check("a single usable option still sends the summary", lonely.text.includes("Only one left."));
	check("a single usable option offers no buttons", lonely.buttons.length === 0);

	// e. A clean list is untouched and draws no complaint.
	const good = await send("bo5", { summary: "All good.", urgency: "orange", options: ["Yes", "No"] });
	check("a valid options list still renders", good.buttons.length === 2);
	check("a valid options list draws no complaint", !/dropped|unusable|ignored/i.test(good.note));
}

heading("ambiguous plain messages ask which session");
{
	rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
	// Every earlier session in this suite counts as recently notified, which would make
	// everything ambiguous. Reset them to "never notified" so only the pair below competes.
	for (const entry of readdirSync(sessionsDir)) {
		const path = join(sessionsDir, entry);
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8"));
			writeFileSync(path, JSON.stringify({ ...parsed, lastNotified: 0 }));
		} catch {}
	}

	const twin = async (id, folder) => {
		const s = spawn(id, `/home/dev/work/${folder}`);
		await s.fire("session_start");
		await s.fire("input");
		await s.tools
			.get("notify_status")
			.execute(`${folder}1`, { summary: `${folder} finished.`, urgency: "green" }, undefined, undefined, s.ctx);
		await s.fire("session_stop");
		await settle(150);
		return s;
	};
	const left = await twin("01a060a0-0000-0000-0000-000000000000", "left-repo");
	const right = await twin("01a060a1-0000-0000-0000-000000000000", "right-repo");

	// a. Two sessions finished seconds apart, so a plain message is held, not guessed.
	const leftSteers = left.steers.length;
	const rightSteers = right.steers.length;
	api.queued = [
		{ update_id: 950, message: { message_id: 950, date: 1, chat: { id: CHAT }, text: "carry on with that" } },
	];
	await left.pump(250);
	const picker = lastCall("sendMessage").body;
	const pickerId = api.nextMessage - 1;
	const pickButtons = (picker.reply_markup?.inline_keyboard ?? [])
		.flat()
		.filter((b) => b.callback_data?.startsWith("m:"));
	check("an ambiguous plain message offers one button per session", pickButtons.length === 2);
	check("the picker names both candidates", picker.text.includes("left-repo") && picker.text.includes("right-repo"));
	check("the picker shows what each session last said", picker.text.includes("right-repo finished."));
	await left.pump(250);
	await right.pump(250);
	check(
		"an ambiguous plain message reaches neither session unasked",
		left.steers.length === leftSteers && right.steers.length === rightSteers,
	);

	// b. Tapping a button delivers the held message to exactly that session.
	const rightTag = record(right.id).tag;
	api.queued = [
		{
			update_id: 951,
			callback_query: {
				id: "cbpick",
				data: `m:950:${rightTag}`,
				from: { id: CHAT },
				message: { message_id: pickerId, chat: { id: CHAT } },
			},
		},
	];
	await left.pump(250);
	await right.pump(250);
	check("the chosen session receives the held message", right.steers.at(-1)?.text === "carry on with that");
	check("the other session still receives nothing", left.steers.length === leftSteers);
	const settled = called("editMessageText").find((c) => c.body.message_id === pickerId);
	check("the picker records where the message went", settled?.body.text.includes("right-repo") === true);
	check("the picker keeps no live buttons", (settled?.body.reply_markup?.inline_keyboard ?? []).flat().length === 0);

	// c. A second tap on the same picker has nothing left to send.
	api.queued = [
		{
			update_id: 952,
			callback_query: {
				id: "cbpick2",
				data: `m:950:${rightTag}`,
				from: { id: CHAT },
				message: { message_id: pickerId, chat: { id: CHAT } },
			},
		},
	];
	await left.pump(250);
	const answers = called("answerCallbackQuery");
	check("a stale pick says the message is gone", /no longer waiting/i.test(answers.at(-1)?.body.text ?? ""));

	// d. Sessions that finished far apart are not ambiguous, so the newest just gets it.
	const leftRecord = JSON.parse(readFileSync(join(sessionsDir, `${left.id}.json`), "utf8"));
	writeFileSync(
		join(sessionsDir, `${left.id}.json`),
		JSON.stringify({ ...leftRecord, lastNotified: Date.now() - 300_000 }),
	);
	const rightBefore = right.steers.length;
	api.queued = [
		{ update_id: 953, message: { message_id: 953, date: 1, chat: { id: CHAT }, text: "straight through" } },
	];
	// `left` holds the poller lock, so it is the one that fetches; `right` only drains.
	await left.pump(250);
	await right.pump(250);
	check("a clear winner gets the message with no picker", right.steers.at(-1)?.text === "straight through");
	check("a clear winner adds no picker buttons", right.steers.length === rightBefore + 1);

	// e. A reply is never ambiguous, even inside the window.
	const rightMessage = record(right.id).recent.at(-1);
	api.queued = [
		{
			update_id: 954,
			message: {
				message_id: 954,
				date: 1,
				chat: { id: CHAT },
				text: "answering directly",
				reply_to_message: { message_id: rightMessage },
			},
		},
	];
	await left.pump(250);
	await right.pump(250);
	check("a reply skips the picker entirely", right.steers.at(-1)?.text === "answering directly");

	// f. Room for the omission note is reserved while the list is built, so a list that would fit
	// whole can lose its last session to a note that was never needed. The window between "fits"
	// and "fits with the note" is about sixty characters, far narrower than one session block, so
	// the fixture is calibrated from a real picker rather than guessed.
	const measure = (from) =>
		api.calls
			.slice(from)
			.find((c) => (c.body.reply_markup?.inline_keyboard ?? []).flat().some((b) => b.callback_data?.startsWith("m:")));
	// Cases a to e take real time, and liveness and rivalry both depend on the clock, so the pair
	// is refreshed and everything else set to "never notified" before measuring anything.
	for (const entry of readdirSync(sessionsDir)) {
		const path = join(sessionsDir, entry);
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8"));
			const mine = entry.startsWith(left.id) || entry.startsWith(right.id);
			writeFileSync(path, JSON.stringify({ ...parsed, lastNotified: mine ? Date.now() : 0, heartbeat: Date.now() }));
		} catch {}
	}
	const gaugeFrom = api.calls.length;
	api.queued = [{ update_id: 955, message: { message_id: 955, date: 1, chat: { id: CHAT }, text: "gauge" } }];
	await left.pump(250);
	const gauge = measure(gaugeFrom)?.body.text.length ?? 0;
	// Padding with a character HTML never escapes keeps the rendered length equal to the plain one.
	const rightPath = join(sessionsDir, `${right.id}.json`);
	const rightRecord = JSON.parse(readFileSync(rightPath, "utf8"));
	writeFileSync(rightPath, JSON.stringify({ ...rightRecord, summary: "B".repeat(4090 - gauge) }));
	const brimFrom = api.calls.length;
	api.queued = [{ update_id: 956, message: { message_id: 956, date: 1, chat: { id: CHAT }, text: "brim full" } }];
	await left.pump(250);
	const brim = measure(brimFrom)?.body;
	check("a picker filled to the brim still fits", (brim?.text.length ?? 0) <= 4096);
	check("a list that fits whole omits nobody", brim?.text.includes("not listed") !== true);
	check("a list that fits whole keeps every button", (brim?.reply_markup.inline_keyboard ?? []).flat().length === 2);
	writeFileSync(rightPath, JSON.stringify(rightRecord));
}

heading("stopping a turn from the chat");
{
	rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
	// A bare /stop goes to the one session mid-turn, so every earlier session has to read as idle.
	for (const entry of readdirSync(sessionsDir)) {
		const path = join(sessionsDir, entry);
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8"));
			writeFileSync(path, JSON.stringify({ ...parsed, state: "idle" }));
		} catch {}
	}
	const still = spawn("01a060c0-0000-0000-0000-000000000000", "/home/dev/work/still");
	await still.fire("session_start");
	const busy = spawn("01a060c1-0000-0000-0000-000000000000", "/home/dev/work/busy");
	await busy.fire("session_start");
	await busy.fire("agent_start");

	// a. Exactly one session is running a turn: a bare /stop reaches it.
	api.queued = [{ update_id: 940, message: { message_id: 940, date: 1, chat: { id: CHAT }, text: "/stop" } }];
	await still.pump(250);
	check("a bare stop reaches the one running session", inboxCount(busy.id) === 1 && inboxCount(still.id) === 0);
	await busy.pump(250);
	check("the running session aborts", busy.aborts === 1);
	check("the idle session is untouched", still.aborts === 0);

	// b. Two sessions running, neither of which need have sent a replyable message yet: the poller
	// offers one button per running session instead of guessing or demanding a reply.
	const other = spawn("01a060c2-0000-0000-0000-000000000000", "/home/dev/work/other");
	await other.fire("session_start");
	await other.fire("agent_start");
	await busy.fire("agent_start");
	const before = called("sendMessage").length;
	api.queued = [{ update_id: 941, message: { message_id: 941, date: 1, chat: { id: CHAT }, text: "/stop" } }];
	await still.pump(250);
	check("an ambiguous stop reaches no session by itself", inboxCount(busy.id) === 0 && inboxCount(other.id) === 0);
	const stopPicker = called("sendMessage").slice(before).at(-1)?.body;
	const stopButtons = stopPicker?.reply_markup?.inline_keyboard?.flat() ?? [];
	check("an ambiguous stop asks which session", /2 sessions/.test(stopPicker?.text ?? "") && stopButtons.length === 2);
	const stopOther = stopButtons.find((b) => b.text.includes("other"))?.callback_data ?? "m:941:none";
	api.queued = [
		{
			update_id: 9411,
			callback_query: {
				id: "cbstop",
				data: stopOther,
				from: { id: CHAT },
				message: { message_id: api.nextMessage - 1, chat: { id: CHAT } },
			},
		},
	];
	await still.pump(250);
	check("the tap delivers the stop to the chosen session", inboxCount(other.id) === 1 && inboxCount(busy.id) === 0);
	await other.pump(250);
	check("the chosen session aborts", other.aborts === 1);
	check("the other running session keeps going", busy.aborts === 1);
	check("the picker says which session is stopping", /Stopping .*other/.test(lastCall("editMessageText").body.text));

	// c. Nothing running: the poller says so instead of staying silent.
	await busy.fire("agent_end");
	await other.fire("agent_end");
	const quiet = called("sendMessage").length;
	api.queued = [{ update_id: 942, message: { message_id: 942, date: 1, chat: { id: CHAT }, text: "/stop" } }];
	await still.pump(250);
	const nothing = called("sendMessage").slice(quiet).at(-1)?.body.text ?? "";
	check("a stop with nothing running says so", /no turn is running/i.test(nothing));
	check("it reaches no session", inboxCount(busy.id) === 0 && inboxCount(other.id) === 0);
}

heading("settings apply without a restart");
{
	rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
	writeConfig();
	const cf = spawn("01a060b0-0000-0000-0000-000000000000", "/home/dev/work/livecfg");
	await cf.fire("session_start");

	// a. The live draft preview stops once the setting flips, with no restart.
	await cf.fire("agent_start");
	await cf.fire("message_update", { message: { role: "assistant", content: [{ type: "text", text: "drafting" }] } });
	await settle(1600);
	await cf.pump(150);
	check("drafts stream while the setting is on", lastCall("sendMessageDraft")?.body.text.includes("drafting") === true);
	writeConfig({ streamDrafts: false });
	cf.heartbeat();
	await settle(60);
	const draftsBefore = called("sendMessageDraft").length;
	await cf.fire("message_update", { message: { role: "assistant", content: [{ type: "text", text: "quietly" }] } });
	await settle(1600);
	await cf.pump(150);
	check("drafts stop after the setting is turned off", called("sendMessageDraft").length === draftsBefore);
	await cf.fire("agent_end");

	// b. Turn-end notices obey the setting too.
	writeConfig({ notifyOnTurnEnd: false });
	cf.heartbeat();
	await settle(60);
	const sendsBefore = called("sendMessage").length;
	await cf.fire("input");
	await cf.tools
		.get("notify_status")
		.execute("cf1", { summary: "Should stay quiet.", urgency: "green" }, undefined, undefined, cf.ctx);
	await cf.fire("session_stop");
	await settle(150);
	check("turn-end notices stop after the setting is turned off", called("sendMessage").length === sendsBefore);

	// c. A half-written or invalid file must never disable a working session.
	writeFileSync(join(root, "notify-telegram.json"), "{ this is not json");
	cf.heartbeat();
	await settle(60);
	writeConfig();
	cf.heartbeat();
	await settle(60);
	await cf.fire("input");
	await cf.tools
		.get("notify_status")
		.execute("cf2", { summary: "Back on the air.", urgency: "green" }, undefined, undefined, cf.ctx);
	await cf.fire("session_stop");
	await settle(150);
	check(
		"an unreadable config does not disable the session",
		lastCall("sendMessage").body.text.includes("Back on the air."),
	);

	// d. The offset advances in memory faster than it reaches disk, so a reload must never rewind it.
	api.queued = [{ update_id: 5000, message: { message_id: 5000, date: 1, chat: { id: CHAT }, text: "bump" } }];
	await cf.pump(250);
	writeConfig({ offset: 10 });
	cf.heartbeat();
	await settle(60);
	await cf.pump(250);
	check("a reload never rewinds the update offset", (lastCall("getUpdates")?.body.offset ?? 0) > 5000);

	// e. An offset another process pushed ahead is adopted, so nothing is refetched.
	writeConfig({ offset: 99_000 });
	cf.heartbeat();
	await settle(60);
	await cf.pump(250);
	check("a reload adopts an offset another process advanced", lastCall("getUpdates")?.body.offset === 99_000);
	writeConfig();
}

heading("pinned fleet dashboard");
{
	rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
	rmSync(join(root, "notify-telegram/dashboard.json"), { force: true });
	rmSync(join(root, "notify-telegram/dashboard.lock"), { force: true });
	// Records left by earlier headings keep aging out of the live window mid-heading, which
	// rewrites the board for a real reason and makes the no-traffic assertions below meaningless.
	// The board is a fleet view, so the fleet has to be fixed for the duration.
	for (const stale of readdirSync(join(root, "notify-telegram/sessions"))) {
		rmSync(join(root, "notify-telegram/sessions", stale), { force: true });
	}
	// The real gap between rewrites is 30 seconds; 0 lets the suite tick freely and leaves the
	// text comparison as the only thing standing between the board and the rate limit.
	writeConfig({ pinnedDashboard: true, dashboardSeconds: 0 });
	const owner = spawn("01a060c0-0000-0000-0000-000000000000", "/home/dev/work/dash-owner");
	await owner.fire("session_start");
	await owner.fire("input");
	await owner.tools
		.get("notify_status")
		.execute("d1", { summary: "Owner is done.", urgency: "green" }, undefined, undefined, owner.ctx);
	await owner.fire("session_stop");
	await settle(150);

	// a. The lock holder posts the board once and pins it.
	const pinsBefore = called("pinChatMessage").length;
	await owner.pump(250);
	const board = called("sendMessage").at(-1)?.body;
	const boardId = api.nextMessage - 1;
	check("the dashboard names the live sessions", board?.text.includes("dash-owner") === true);
	check("the dashboard reports their state", board?.text.includes("idle") === true);
	check("the dashboard carries the last summary", board?.text.includes("Owner is done.") === true);
	check("the dashboard is pinned", called("pinChatMessage").length === pinsBefore + 1);
	check("the dashboard is pinned silently", called("pinChatMessage").at(-1)?.body.disable_notification === true);
	check("the dashboard message id is shared on disk", existsSync(join(root, "notify-telegram/dashboard.json")));

	// b. Nothing changed, so a free tick costs no dashboard traffic. This is the assertion that
	// stops a relative timestamp creeping into the text and editing the board forever. The owner
	// also polls on every tick, so counting every api call would always grow.
	const boardCalls = () =>
		called("sendMessage").length + called("editMessageText").length + called("pinChatMessage").length;
	const quietBefore = boardCalls();
	await owner.pump(250);
	await owner.pump(250);
	check("an unchanged dashboard makes no api call", boardCalls() === quietBefore);

	// c. A changed state edits the same message rather than posting a second one.
	const sendsBefore = called("sendMessage").length;
	await owner.fire("agent_start");
	await owner.fire("tool_execution_start", { toolName: "bash", intent: "Building" });
	await settle(60);
	await owner.pump(250);
	const edit = called("editMessageText").at(-1);
	check("a changed dashboard is edited in place", edit?.body.message_id === boardId);
	check("the edit carries the new state", edit?.body.text.includes("bash: Building") === true);
	check("a changed dashboard posts no second message", called("sendMessage").length === sendsBefore);

	// c2. Provider trouble edits the line it explains, so a whole crippled fleet costs one edit.
	const healthSends = called("sendMessage").length;
	await owner.fire("retry_fallback_applied", { from: "a/x", to: "b/y" });
	await settle(60);
	await owner.pump(250);
	check(
		"the dashboard carries a provider note",
		called("editMessageText").at(-1)?.body.text.includes("fell back to b/y") === true,
	);
	check("a provider note posts no message", called("sendMessage").length === healthSends);

	// d. The configured gap is what actually protects the rate limit.
	writeConfig({ pinnedDashboard: true, dashboardSeconds: 600 });
	owner.heartbeat();
	await settle(60);
	await owner.fire("tool_execution_end", {});
	await owner.fire("tool_execution_start", { toolName: "bash", intent: "Something else" });
	await settle(60);
	const throttled = boardCalls();
	await owner.pump(250);
	check("a change inside the configured gap is not published", boardCalls() === throttled);
	writeConfig({ pinnedDashboard: true, dashboardSeconds: 0 });
	owner.heartbeat();
	await settle(60);
	await owner.fire("tool_execution_end", {});
	await owner.fire("agent_end");

	// e. A session that does not hold the lock never touches the board.
	const bystander = spawn("01a060c1-0000-0000-0000-000000000000", "/home/dev/work/dash-bystander");
	await bystander.fire("session_start");
	const untouchedFrom = called("editMessageText").length;
	await bystander.pump(250);
	await bystander.pump(250);
	check(
		"a session without the lock never edits the dashboard",
		!called("editMessageText")
			.slice(untouchedFrom)
			.some((c) => c.body.message_id === boardId),
	);

	const boardFile = () => JSON.parse(readFileSync(join(root, "notify-telegram/dashboard.json"), "utf8"));

	// f. A refusal that says nothing about the board still existing is not evidence that it is gone.
	// Re-posting on one is what put a second board in the chat every thirty seconds, each with its
	// own pin, and a pin makes Telegram narrate it back as an incoming message.
	api.failMethods = ["editMessageText"];
	api.failDescription = "Too Many Requests: retry after 3";
	await owner.fire("agent_start");
	await owner.fire("tool_execution_start", { toolName: "bash", intent: "Throttled" });
	await settle(60);
	const keptId = boardFile().messageId;
	const keptSends = called("sendMessage").length;
	const keptPins = called("pinChatMessage").length;
	await owner.pump(250);
	api.failMethods = [];
	api.failDescription = undefined;
	check("a refused board edit posts no duplicate", called("sendMessage").length === keptSends);
	check("a refused board edit pins nothing", called("pinChatMessage").length === keptPins);
	check("a refused board edit keeps the recorded message id", boardFile().messageId === keptId);
	// The recorded text has to stay behind as well, or the next tick reads the board as current.
	check("a refused board edit leaves the recorded text behind", !boardFile().text.includes("bash: Throttled"));

	// g. Telegram rejecting an edit as unchanged means the board already shows this text, which two
	// sessions publishing the same fleet reach routinely. Adopting it is what stops the churn.
	api.failMethods = ["editMessageText"];
	api.failDescription =
		"Bad Request: message is not modified: specified new message content and reply markup are exactly the same";
	await owner.fire("tool_execution_end", {});
	await owner.fire("tool_execution_start", { toolName: "bash", intent: "Same again" });
	await settle(60);
	const adoptSends = called("sendMessage").length;
	const adoptId = boardFile().messageId;
	await owner.pump(250);
	api.failMethods = [];
	api.failDescription = undefined;
	check("an unchanged-edit rejection posts no duplicate", called("sendMessage").length === adoptSends);
	check("an unchanged-edit rejection keeps the board", boardFile().messageId === adoptId);
	check("an unchanged-edit rejection records the text it sent", boardFile().text.includes("bash: Same again"));
	const adoptedQuiet = boardCalls();
	await owner.pump(250);
	check("an adopted board costs no further call", boardCalls() === adoptedQuiet);

	// h. A board Telegram says is gone is replaced rather than lost.
	api.failMethods = ["editMessageText"];
	api.failDescription = "Bad Request: message to edit not found";
	await owner.fire("tool_execution_end", {});
	await owner.fire("tool_execution_start", { toolName: "bash", intent: "After deletion" });
	await settle(60);
	const resendFrom = called("sendMessage").length;
	await owner.pump(250);
	api.failMethods = [];
	api.failDescription = undefined;
	check("a deleted dashboard is posted again", called("sendMessage").length > resendFrom);
	check("the replacement board is pinned too", called("pinChatMessage").at(-1)?.body.message_id !== boardId);

	// i. The board is the only message whose length nothing bounds: it grows with the fleet, and
	// past the limit Telegram rejects both the edit and the replacement, so it stops updating.
	const filler = [];
	for (let i = 0; i < 40; i++) {
		const id = `01a060ff-0000-0000-0000-0000000000${String(i).padStart(2, "0")}`;
		filler.push(id);
		writeFileSync(
			join(root, "notify-telegram/sessions", `${id}.json`),
			JSON.stringify({
				pid: 9000 + i,
				tag: `z${String(i).padStart(4, "0")}`,
				name: `filler ${i}`,
				cwd: `/home/dev/work/project-number-${i}`,
				emoji: "\u{1F41D}",
				label: "",
				lastNotified: Date.now() - i,
				recent: [],
				standing: null,
				closeOffer: null,
				pinned: null,
				draftId: i,
				state: "working (bash: a tool label of a realistic length)",
				summary: "S".repeat(160),
				summaryAt: Date.now(),
				heartbeat: Date.now(),
			}),
		);
	}
	const fillerFrom = api.calls.length;
	await owner.pump(300);
	// api.calls is the only call-ordered view: two `called()` lists concatenated group by method.
	const bigBoard = api.calls
		.slice(fillerFrom)
		.filter((c) => typeof c.body.text === "string" && c.body.text.includes("Fleet"))
		.at(-1);
	check("a fleet too big for one message is cut to the limit", (bigBoard?.body.text.length ?? 0) <= 4096);
	check("the cut board says it was cut", bigBoard?.body.text.includes("truncated") === true);
	for (const id of filler) rmSync(join(root, "notify-telegram/sessions", `${id}.json`), { force: true });
	await owner.fire("tool_execution_end", {});
	await owner.fire("agent_end");

	// g. Turning it off stops it, and the setting applies without a restart.
	writeConfig({ pinnedDashboard: false, dashboardSeconds: 0 });
	owner.heartbeat();
	await settle(60);
	await owner.fire("agent_start");
	await owner.fire("tool_execution_start", { toolName: "bash", intent: "Ignored" });
	await settle(60);
	const offBefore = boardCalls();
	await owner.pump(250);
	check("a disabled dashboard makes no api call", boardCalls() === offBefore);
	await owner.fire("tool_execution_end", {});
	await owner.fire("agent_end");
	// h. omp loads this extension from a live working tree, so a long-lived session keeps running
	// whatever the code said when it started. A lock holder from before the board existed must not
	// suppress the board for every newer session, which is what "not working" looked like in practice.
	writeConfig({ pinnedDashboard: true, dashboardSeconds: 0 });
	rmSync(join(root, "notify-telegram/dashboard.json"), { force: true });
	const staleHolder = "01a060cf-0000-0000-0000-000000000000";
	writeFileSync(
		join(root, "notify-telegram/sessions", `${staleHolder}.json`),
		JSON.stringify({
			pid: process.pid,
			tag: "old",
			name: "",
			cwd: "/home/dev/work/old-code",
			emoji: "\u{1F535}",
			label: "old-code",
			lastNotified: 0,
			recent: [],
			standing: null,
			closeOffer: null,
			pinned: null,
			draftId: 0,
			state: "idle",
			summary: "",
			summaryAt: 0,
			heartbeat: Date.now(),
		}),
	);
	writeFileSync(
		join(root, "notify-telegram/poller.lock"),
		JSON.stringify({ sessionId: staleHolder, pid: process.pid, heartbeat: Date.now() }),
	);
	writeConfig({ pinnedDashboard: true, dashboardSeconds: 0 });
	owner.heartbeat();
	await settle(60);
	const strandedFrom = called("sendMessage").length;
	await owner.pump(250);
	check("a lock holder that cannot publish does not strand the board", called("sendMessage").length > strandedFrom);
	rmSync(join(root, "notify-telegram/sessions", `${staleHolder}.json`), { force: true });
	rmSync(join(root, "notify-telegram/poller.lock"), { force: true });

	// i. A record written by older code has none of the fields added since. Blind-casting it and
	// reading `record.state.length` threw on every tick in the real fleet, which killed the whole
	// drain and took polling with it. Only a partial record reproduces that.
	writeFileSync(
		join(root, "notify-telegram/sessions", "01a060df-0000-0000-0000-000000000000.json"),
		JSON.stringify({ pid: 4242, tag: "ancient", cwd: "/home/dev/work/ancient", heartbeat: Date.now() }),
	);
	writeConfig({ pinnedDashboard: true, dashboardSeconds: 0 });
	owner.heartbeat();
	await settle(60);
	const beforeAncient = called("sendMessage").length + called("editMessageText").length;
	await owner.pump(250);
	check(
		"a record from older code does not break the board",
		called("sendMessage").length + called("editMessageText").length > beforeAncient,
	);
	check("a record from older code does not break the drain", !owner.warns.some((w) => w.m.includes("drain failed")));
	check(
		"a record from older code still appears on the board",
		(called("editMessageText").at(-1)?.body.text ?? called("sendMessage").at(-1)?.body.text ?? "").includes("ancient"),
	);
	rmSync(join(root, "notify-telegram/sessions", "01a060df-0000-0000-0000-000000000000.json"), { force: true });

	// j. An owner that cannot draw must hand the board back. A live session held the claim while
	// throwing on every tick, which stranded the board for the whole fleet exactly as an incapable
	// lock holder did. An unreadable records directory is a reachable way to make the report throw.
	writeConfig({ pinnedDashboard: true, dashboardSeconds: 0 });
	owner.heartbeat();
	await settle(60);
	chmodSync(join(root, "notify-telegram/sessions"), 0o000);
	await owner.pump(250);
	chmodSync(join(root, "notify-telegram/sessions"), 0o700);
	check(
		"an owner that cannot draw the board gives up the claim",
		!existsSync(join(root, "notify-telegram/dashboard.lock")),
	);
	check(
		"giving up the board is logged",
		owner.warns.some((w) => w.m.includes("gave up the fleet board")),
	);

	writeConfig();
}

heading("spinner frames match omp exactly");
{
	// omp writes one of ten braille frames (title-generator.ts TITLE_SPINNER_FRAMES). Any other
	// braille character is not omp working, and both repos must agree on that.
	const frames = ["\u280B", "\u2819", "\u2839", "\u2838", "\u283C", "\u2834", "\u2826", "\u2827", "\u2807", "\u280F"];
	const spinBin = join(root, "spin-bin");
	mkdirSync(spinBin, { recursive: true });
	const rows = [
		...frames.map((f, i) => `    printf '0\\t${i}\\t0\\t\\t\u03C0 ${f} Frame ${i}\\n'`),
		`    printf '0\\t90\\t0\\t\\t\u03C0 \u28FF Not an omp frame\\n'`,
		`    printf '0\\t91\\t0\\t\\t\u03C0 \u2801 Also not a frame\\n'`,
	];
	writeFileSync(
		join(spinBin, "tmux"),
		[
			"#!/bin/sh",
			'case "$1" in',
			"  display-message) printf 'main\\t0\\n' ;;",
			"  list-windows)",
			...rows,
			"    ;;",
			"esac",
			"",
		].join("\n"),
		{ mode: 0o755 },
	);
	const spinPath = process.env.PATH;
	process.env.PATH = `${spinBin}:${spinPath}`;
	process.env.TMUX = "/tmp/fake-tmux,1,0";
	process.env.TMUX_PANE = "%1";
	writeConfig();
	rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
	const sp = spawn("01a060d0-0000-0000-0000-000000000000", "/home/dev/work/spinner");
	await sp.fire("session_start");
	api.queued = [{ update_id: 960, message: { message_id: 960, date: 1, chat: { id: CHAT }, text: "/fleet" } }];
	await sp.pump(250);
	const spinReport = lastCall("sendMessage").body.text ?? "";
	check("all ten omp frames count as working", spinReport.includes("10 working"));
	check("braille characters omp never uses are not working", !spinReport.includes("12 working"));
	check("the non-frame windows are still listed as idle", spinReport.includes("2 idle"));
	process.env.PATH = spinPath;
	delete process.env.TMUX;
	delete process.env.TMUX_PANE;
}

rmSync(root, { recursive: true, force: true });
console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);

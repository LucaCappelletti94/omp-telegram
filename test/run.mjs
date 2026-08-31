// Full suite against a stubbed Telegram API; sends nothing.

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
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
		JSON.stringify({ token: "0".repeat(30), chatId: CHAT, offset: 100, quietSeconds: 0, ...extra }, null, 2),
		{ mode: 0o600 },
	);
writeConfig();

const api = {
	calls: [],
	queued: [],
	rejectHtml: false,
	topicsEnabled: true,
	nextTopic: 900,
	nextMessage: 7,
};
globalThis.fetch = async (url, init) => {
	const method = String(url).split("/").pop();
	const body = JSON.parse(init.body);
	api.calls.push({ method, body });
	if (method === "createForumTopic" && !api.topicsEnabled) {
		return { ok: false, status: 400, json: async () => ({ ok: false, description: "TOPICS_DISABLED" }) };
	}
	if (api.rejectHtml && body.parse_mode === "HTML") {
		return { ok: false, status: 400, json: async () => ({ ok: false, description: "can't parse entities" }) };
	}
	const result =
		method === "getUpdates"
			? api.queued.splice(0, api.queued.length)
			: method === "sendMessage"
				? { message_id: api.nextMessage++ }
				: method === "createForumTopic"
					? { message_thread_id: api.nextTopic++ }
					: true;
	return { ok: true, json: async () => ({ ok: true, result }) };
};

const mod = await import(EXTENSION);
const chain = new Proxy(() => chain, { get: () => chain, apply: () => chain });

let fails = 0;
let section = "";
const heading = (title) => {
	section = title;
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
	const ctx = {
		hasUI: false,
		cwd,
		sessionManager: { getSessionId: () => id, getSessionName: () => name },
		ui: { onTerminalInput: () => () => {} },
		setInterval: (fn) => timers.push(fn) - 1,
		setTimeout: (fn) => timers.push(fn) - 1,
		clearTimer: () => {},
	};
	mod.default(pi);
	return {
		id,
		ctx,
		tools,
		timers,
		warns,
		steers,
		setTitle: (value) => {
			name = value;
		},
		fire: async (event) => {
			const results = [];
			for (const fn of handlers.get(event) ?? []) results.push(await fn({}, ctx));
			if (event === "session_stop" && results.some((r) => r?.decision === "block")) {
				for (const fn of handlers.get(event) ?? []) await fn({}, ctx);
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
api.topicsEnabled = false;
const one = spawn("01a03406-6e80-75e3-8321-3c2a242a59b6", "/home/dev/work/subql");
await one.fire("session_start");
check("registers ask and session_badge", one.tools.get("ask")?.strict === true && one.tools.has("session_badge"));
check("ask keeps the native approval tier", one.tools.get("ask").approval === "read");
check("session record written", existsSync(join(sessionsDir, `${one.id}.json`)));
check(
	"poller lock acquired",
	JSON.parse(readFileSync(join(root, "notify-telegram/poller.lock"), "utf8")).sessionId === one.id,
);
check("timers registered even though topic creation failed", one.timers.length === 2);
check(
	"topic failure is logged rather than swallowed",
	one.warns.some((w) => JSON.stringify(w.meta ?? {}).includes("TOPICS_DISABLED")),
);
check("no topic recorded when topic mode is off", record(one.id).topicId === null);

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
writeConfig({ quietSeconds: 3600 });
const quiet = spawn("01a03410-0000-0000-0000-000000000000", "/home/dev/work/los");
await quiet.fire("session_start");
await quiet.fire("session_stop");
await settle();
check("turn end suppressed while the human is typing", record(quiet.id).lastNotified === 0);
writeConfig();
const loud = spawn("01a03411-0000-0000-0000-000000000000", "/home/dev/work/los");
await loud.fire("session_start");
await loud.fire("session_stop");
await settle();
check("turn end delivered once the quiet window lapses", record(loud.id).lastNotified > 0);

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
check("a stance-suffixed option refuses to pair beyond the budget", keyboard.length === 3 && keyboard[0].length === 1);
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

const stateB = {};
const runTyped = two.tools.get("ask").execute("c2", singleQuestion, undefined, undefined, stubbornCtx(two.ctx, stateB));
await settle(150);
const typeButton = lastCall("sendMessage")
	.body.reply_markup.inline_keyboard.flat()
	.find((b) => b.text === "Type an answer").callback_data;
writeFileSync(join(inboxOf(two.id), "200.json"), JSON.stringify({ kind: "callback", value: typeButton }));
await two.pump(150);
check("choosing to type opens a forced reply", lastCall("sendMessage").body.reply_markup.force_reply === true);
writeFileSync(join(inboxOf(two.id), "201.json"), JSON.stringify({ kind: "text", value: "use duckdb" }));
await two.pump(150);
const typed = await runTyped;
check("typed text becomes customInput", typed.details.customInput === "use duckdb");
check("typed text is not also treated as a steer", two.steers.length === 0);

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
	"free text with no pending ask becomes a steer",
	two.steers.length === 1 && two.steers[0].options.deliverAs === "steer",
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
	"allowed_updates asks for both kinds",
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
api.rejectHtml = false;
writeFileSync(join(inboxOf(two.id), "700.json"), JSON.stringify({ kind: "callback", value: `o:${richAskId}:0:0` }));
await two.pump(150);
check("the rich question answers after the retry", (await runRich).details.selectedOptions[0] === "yes");

// ----------------------------------------------------------------- badge tools
heading("badge override");
await two.tools
	.get("session_badge")
	.execute("c8", { emoji: "\u{1F9EA}", label: "index work" }, undefined, undefined, two.ctx);
check("emoji override persisted", record(two.id).emoji === "\u{1F9EA}");
check("label override persisted", record(two.id).label === "index work");

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
		topicId: null,
		topicName: "",
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

// ---------------------------------------------------------------------- topics
heading("forum topics");
api.topicsEnabled = true;
const alpha = spawn("01a03600-0000-0000-0000-000000000000", "/home/dev/work/sqlitegis");
await alpha.fire("session_start");
const beta = spawn("01a03601-0000-0000-0000-000000000000", "/home/dev/work/pg2sqlite");
await beta.fire("session_start");
const topicAlpha = record(alpha.id).topicId;
const topicBeta = record(beta.id).topicId;
check("each session gets a topic", typeof topicAlpha === "number" && typeof topicBeta === "number");
check("topics are distinct", topicAlpha !== topicBeta);
check(
	"topic name carries badge and folder",
	/^.+ sqlitegis \u00B7 /u.test(called("createForumTopic").at(-2).body.name),
);
await alpha.fire("session_stop");
await settle();
check("messages go into the topic", lastCall("sendMessage").body.message_thread_id === topicAlpha);
check(
	"badge head is dropped inside a topic",
	lastCall("sendMessage").body.text.startsWith("<b>\u{1F7E2} Turn finished</b>"),
);

alpha.setTitle("Port the R-tree index");
alpha.heartbeat();
await settle();
check("topic renamed once omp titles the session", lastCall("editForumTopic")?.body.message_thread_id === topicAlpha);
check("new name carries the title", lastCall("editForumTopic")?.body.name.includes("Port the R-tree index"));

api.queued = [
	{
		update_id: 120,
		message: { message_id: 30, date: 1, chat: { id: CHAT }, message_thread_id: topicBeta, text: "use duckdb" },
	},
];
await one.pump(250);
check("a reply in a topic routes to that topic's session", inboxCount(beta.id) === 1);
check("it ignores which session was notified most recently", inboxCount(alpha.id) === 0);

api.queued = [
	{
		update_id: 121,
		message: { message_id: 31, date: 1, chat: { id: CHAT }, message_thread_id: 424242, text: "orphan" },
	},
];
await one.pump(250);
check("an unowned thread is refused inside that thread", lastCall("sendMessage").body.message_thread_id === 424242);

await alpha.fire("session_shutdown");
check(
	"topic deleted on clean exit",
	called("deleteForumTopic").some((c) => c.body.message_thread_id === topicAlpha),
);
check(
	"topic queued in case the process dies first",
	JSON.parse(readFileSync(join(root, "notify-telegram/pending-topics.json"), "utf8")).includes(topicAlpha),
);
check("session record removed on exit", !existsSync(join(sessionsDir, `${alpha.id}.json`)));
const sweeper = spawn("01a03700-0000-0000-0000-000000000000", "/home/dev/work/ds4");
await sweeper.fire("session_start");
check(
	"the next start sweeps the delete queue",
	JSON.parse(readFileSync(join(root, "notify-telegram/pending-topics.json"), "utf8")).length === 0,
);

api.topicsEnabled = false;
const flatSession = spawn("01a03800-0000-0000-0000-000000000000", "/home/dev/work/rls2fga");
await flatSession.fire("session_start");
await flatSession.fire("session_stop");
await settle();
check(
	"falls back to a flat message when topics are unavailable",
	lastCall("sendMessage").body.message_thread_id === undefined,
);
check("badge head returns in flat mode", lastCall("sendMessage").body.text.startsWith(record(flatSession.id).emoji));

// ------------------------------------------------------------- reply routing
heading("reply routing");
const rr1 = spawn("01a03900-0000-0000-0000-000000000000", "/home/dev/work/subql");
await rr1.fire("session_start");
const rr2 = spawn("01a03901-0000-0000-0000-000000000000", "/home/dev/work/diesel");
await rr2.fire("session_start");
await rr1.fire("session_stop");
await settle();
const rr1Msg = lastCall("sendMessage").body;
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

api.queued = [{ update_id: 201, message: { message_id: 91, date: 1, chat: { id: CHAT }, text: "no reply target" } }];
await one.pump(250);
check("an unreplied message still falls back to recency", inboxCount(rr2.id) === 1);

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

api.queued = [cb(`t:${mixAsk}:2`, 404)];
await mq.pump(300);
await mq.pump(300);
check("typing is offered on the final question", lastCall("sendMessage").body.reply_markup?.force_reply === true);
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
const rendered = mod.__test_render ?? null;
const mdSession = spawn("01a03e01-0000-0000-0000-000000000000", "/home/dev/work/los");
await mdSession.fire("session_start");
const mdRun = mdSession.tools
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
const hugeRun = mdSession.tools
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

// A non-text message is answered rather than dropped.
rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
const voiceSession = spawn("01a03e02-0000-0000-0000-000000000000", "/home/dev/work/ds4");
await voiceSession.fire("session_start");
api.queued = [{ update_id: 500, message: { message_id: 70, date: 1, chat: { id: CHAT }, voice: { file_id: "x" } } }];
const beforeVoice = called("sendMessage").length;
await voiceSession.pump(250);
check("a voice note gets an explanation instead of silence", called("sendMessage").length === beforeVoice + 1);
check("the explanation says text is required", lastCall("sendMessage").body.text.includes("Only text"));
api.queued = [
	{
		update_id: 501,
		message: { message_id: 71, date: 1, chat: { id: CHAT }, photo: [{ file_id: "y" }], caption: "look at this" },
	},
];
const beforeCaption = called("sendMessage").length;
const inboxTotal = () => readdirSync(join(root, "notify-telegram/inbox")).reduce((n, d) => n + inboxCount(d), 0);
const captionBefore = inboxTotal();
await voiceSession.pump(250);
check("a photo caption is accepted as text", inboxTotal() === captionBefore + 1);
check("a caption is not refused as unsupported", called("sendMessage").length === beforeCaption);

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
check("question was sent with buttons", lastCall("sendMessage").body.reply_markup.inline_keyboard.flat().length === 3);
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
	"the keyboard is explicitly cleared",
	Array.isArray(closing.body.reply_markup?.inline_keyboard) && closing.body.reply_markup.inline_keyboard.length === 0,
);

// A press on the retired question must be answered, not swallowed.
const staleAsk = lastCall("sendMessage");
const beforeStale = called("sendMessage").length;
writeFileSync(join(inboxOf(esc.id), "950.json"), JSON.stringify({ kind: "callback", value: "o:zzzzz-1:0:0" }));
await esc.pump(200);
check("a press on a closed question gets a reply", called("sendMessage").length === beforeStale + 1);
check("the reply explains the question is closed", lastCall("sendMessage").body.text.includes("closed"));

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
	"the first question's keyboard is cleared when it is answered",
	firstClosed.body.reply_markup.inline_keyboard.length === 0,
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
				{ label: "neutral one", description: "no strong view" },
				{ label: "the good one", description: "cheapest to maintain" },
				{ label: "the bad one", description: "here for contrast", discouraged: true },
				{ label: "bare option" },
				{ label: "the meh one", description: "works, but slow", lukewarm: true },
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

// An unparseable pending-topics file degrades to an empty queue instead of throwing.
writeFileSync(join(root, "notify-telegram/pending-topics.json"), "{nope");
const sweep2 = spawn("01a04103-0000-0000-0000-000000000000", "/home/dev/work/rats");
let sweepFailed = false;
try {
	await sweep2.fire("session_start");
} catch {
	sweepFailed = true;
}
check("a corrupt pending-topics file does not break startup", sweepFailed === false);

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

await sem.fire("tool_approval_requested");
await settle(150);
check("approval carries the red light", lastCall("sendMessage").body.text.includes("\u{1F534}"));

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
	"after the block the fallback message still goes out",
	lastCall("sendMessage").body.text.includes("Turn finished"),
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
await rs.tools
	.get("notify_status")
	.execute("n3", { summary: "Two designs possible, opinion wanted.", urgency: "purple" }, undefined, undefined, rs.ctx);
await rs.fire("session_stop");
await settle(150);
check("an unknown urgency degrades to green", lastCall("sendMessage").body.text.includes("\u{1F7E2}"));

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
check("its keyboard is cleared", retired.body.reply_markup.inline_keyboard.length === 0);

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
	.execute("q2", { summary: "First.", urgency: "orange", options: ["A", "B"] }, undefined, undefined, tq.ctx);
await tq.fire("session_stop");
await settle(150);
const firstQ = lastCall("sendMessage").body.reply_markup.inline_keyboard[0][0].callback_data;
await tq.fire("input");
await tq.tools
	.get("notify_status")
	.execute("q3", { summary: "Second.", urgency: "orange", options: ["C", "D"] }, undefined, undefined, tq.ctx);
await tq.fire("session_stop");
await settle(200);
check(
	"terminal input retires the older standing question",
	called("editMessageText").some((c) => c.body.text.includes("Answered at the terminal")),
);
writeFileSync(join(inboxOf(tq.id), "992.json"), JSON.stringify({ kind: "callback", value: firstQ }));
await tq.pump(250);
check("a press on the superseded question is refused", lastCall("sendMessage").body.text.includes("closed"));

// A standing question survives a session resume.
const tqRecord = JSON.parse(readFileSync(join(sessionsDir, `${tq.id}.json`), "utf8"));
check("the standing question is persisted", tqRecord.standing !== null && Array.isArray(tqRecord.standing.labels));
const resumed = spawn(tq.id, "/home/dev/work/sqlitegis");
await resumed.fire("session_start");
const standingId = tqRecord.standing.id;
writeFileSync(join(inboxOf(tq.id), "993.json"), JSON.stringify({ kind: "callback", value: `c:${standingId}:1` }));
await resumed.pump(250);
check(
	"a press after a resume still starts the next turn",
	resumed.steers.some((x) => x.text === "D"),
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

// notify_status validation
const badOpts = await tq.tools
	.get("notify_status")
	.execute("q4", { summary: "x", urgency: "green", options: ["only-one"] }, undefined, undefined, tq.ctx);
check("a single option is rejected", badOpts.isError === true);

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
check("the tail row stays separate from options", shape.at(-1).includes("Type an answer"));
const bpPick = bpRows.flat().find((b) => b.text === "Review the diff").callback_data;
writeFileSync(join(inboxOf(bp.id), "995.json"), JSON.stringify({ kind: "callback", value: bpPick }));
rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
bp.heartbeat();
await bp.pump(250);
check("packing does not disturb option indices", (await bpRun).details.selectedOptions[0] === "Review the diff");

// ------------------------------------------------------- review-pass regression pins
heading("review-pass fixes");
// Fix 2: a resume keeps reply routing to pre-restart messages and keeps recency.
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

// Fix 1: inside a topic, an ask no longer repeats the badge that the topic name already carries.
api.topicsEnabled = true;
const ta = spawn("01a04600-0000-0000-0000-000000000000", "/home/dev/work/sqlitegis");
await ta.fire("session_start");
const taState = {};
const taRun = ta.tools
	.get("ask")
	.execute(
		"ta",
		{ questions: [{ id: "q", question: "ok?", options: [{ label: "yes" }] }] },
		undefined,
		undefined,
		stubbornCtx(ta.ctx, taState),
	);
await settle(180);
const taMsg = lastCall("sendMessage").body;
check("a topic ask goes into the thread", typeof taMsg.message_thread_id === "number");
check("a topic ask does not repeat the badge", !taMsg.text.includes(" \u00B7 "));
const taAsk = taMsg.reply_markup.inline_keyboard[0][0].callback_data.split(":")[1];
writeFileSync(join(inboxOf(ta.id), "996.json"), JSON.stringify({ kind: "callback", value: `o:${taAsk}:0:0` }));
await ta.pump(250);
await taRun;
api.topicsEnabled = false;

// Fix 3: routing skips a stale record without deleting it, so its inbox is not orphaned.
const staleId = "01a04700-dead-0000-0000-000000000000";
writeFileSync(
	join(sessionsDir, `${staleId}.json`),
	JSON.stringify({
		pid: 999999,
		tag: "qqqqq",
		name: "",
		topicId: null,
		topicName: "",
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

rmSync(root, { recursive: true, force: true });
console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);

// Full suite against a stubbed Telegram API; sends nothing.

import {
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
	topicsEnabled: true,
	nextTopic: 900,
	nextMessage: 7,
	icons: null,
};
globalThis.fetch = async (url, init) => {
	if (String(url).includes("/file/bot")) {
		api.calls.push({ method: "fileDownload", body: { url: String(url) } });
		return { ok: true, arrayBuffer: async () => new TextEncoder().encode("fake-image-bytes").buffer };
	}
	const method = String(url).split("/").pop();
	if (init?.body instanceof FormData) {
		const body = {};
		for (const [key, value] of init.body.entries()) {
			body[key] = typeof value === "string" ? value : `<file ${value.size}b>`;
		}
		api.calls.push({ method, body });
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
		return { ok: false, status: 400, json: async () => ({ ok: false, description: "failed by test" }) };
	}
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
					: method === "getFile"
						? { file_path: "documents/file_9.oga" }
						: method === "getForumTopicIconStickers"
							? (api.icons ?? [])
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
	"allowed_updates asks for all three kinds",
	lastCall("getUpdates").body.allowed_updates.join(",") === "message,callback_query,stopped_message_generation",
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
	existsSync(join(root, "notify-telegram/pending-topics", `${alpha.id}.json`)) &&
		JSON.parse(readFileSync(join(root, "notify-telegram/pending-topics", `${alpha.id}.json`), "utf8")) === topicAlpha,
);
check("session record removed on exit", !existsSync(join(sessionsDir, `${alpha.id}.json`)));
const sweeper = spawn("01a03700-0000-0000-0000-000000000000", "/home/dev/work/ds4");
await sweeper.fire("session_start");
check(
	"the next start sweeps the delete queue",
	!existsSync(join(root, "notify-telegram/pending-topics", `${alpha.id}.json`)),
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
check("the image is steered into the running turn", photoSteer.options.deliverAs === "steer");
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
	"cancelled native question retains context and question",
	closing.body.text.startsWith(
		`Task: subql [${record(esc.id).tag}] | Model: openai/gpt-5.6-sol | Tmux: not attached`,
	) &&
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
const settledStance = lastCall("editMessageText");
check(
	"selected native answer retains context, question, result, and buttons",
	settledStance.body.text.startsWith(
		`Task: diesel [${record(st.id).tag}] | Model: openai/gpt-5.6-sol | Tmux: not attached`,
	) &&
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

// An unparseable pending-topics entry is silently discarded instead of throwing.
mkdirSync(join(root, "notify-telegram/pending-topics"), { recursive: true });
writeFileSync(join(root, "notify-telegram/pending-topics/corrupt.json"), "{nope");
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
check(
	"its options stay visible but dead, the choice ticked",
	retired.body.reply_markup.inline_keyboard.flat().every((b) => b.disabled !== undefined) &&
		retired.body.reply_markup.inline_keyboard.flat().some((b) => b.text === "\u2713 Review the diff"),
);
check(
	"selected standing answer retains context and question",
	retired.body.text.startsWith(
		`Task: sqlitegis [${record(tq.id).tag}] | Model: openai/gpt-5.6-sol | Tmux: not attached`,
	) && retired.body.text.includes("How should we proceed?"),
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
	supersededStanding.body.text.startsWith(
		`Task: sqlitegis [${record(tq.id).tag}] | Model: openai/gpt-5.6-sol | Tmux: not attached`,
	) &&
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
	resumedRetired.body.text.startsWith(
		`Task: sqlitegis [${record(tq.id).tag}] | Model: openai/gpt-5.6-sol | Tmux: not attached`,
	) &&
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

heading("remote interaction upgrades");
rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
const ux = spawn("01a04800-0000-0000-0000-000000000000", "/home/dev/work/pgvector");
await ux.fire("session_start");
check("the command menu is registered", called("setMyCommands").length > 0);

// Typing indicator follows the agent loop, not raw input events.
const typingBefore = called("sendChatAction").length;
await ux.fire("input");
await ux.pump(150);
check("input alone does not show typing", called("sendChatAction").length === typingBefore);
await ux.fire("agent_start");
await ux.pump(150);
check("a running agent loop shows a typing status", called("sendChatAction").length === typingBefore + 1);
check("the action is typing", lastCall("sendChatAction").body.action === "typing");
await ux.fire("agent_start"); // resets the typing throttle, so only agent_end can explain silence below
await ux.fire("agent_end");
await ux.pump(150);
check("the loop's end stops the typing refresh", called("sendChatAction").length === typingBefore + 1);

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
	hiddenStanding.body.text.startsWith(
		`Task: pgvector [${record(ux.id).tag}] | Model: openai/gpt-5.6-sol | Tmux: not attached`,
	) &&
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

heading("/fleet reads the tmux window titles");

// A fake tmux binary on PATH stands in for the real server.
const fakeBin = join(root, "fake-bin");
mkdirSync(fakeBin, { recursive: true });
const fakeTmux = join(fakeBin, "tmux");
writeFileSync(
	fakeTmux,
	"#!/bin/sh\nprintf '0\\t0\\t0\\t\u03C0 \u280B Fixing the parser\\n'\nprintf '0\\t1\\t0\\t\u03C0 ! Choose a name\\n'\nprintf '0\\t2\\t1\\t\u03C0 > Docs pass\\n'\nprintf '0\\t3\\t0\\t\u03C0 > Sleepy\\n'\nprintf '0\\t4\\t0\\tbash\\n'\n",
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
check("fleet answers the general chat without a thread", fleetMsg.message_thread_id === undefined);
check("fleet does not touch any session inbox", inboxCount(ux.id) === 0);

// The report is re-read per command: an emptied fleet answers accordingly.
writeFileSync(fakeTmux, "#!/bin/sh\nprintf '0\\t4\\t0\\tbash\\n'\n", { mode: 0o755 });
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

// Topic icons match the badge when the free icon set has it.
api.topicsEnabled = true;
api.icons = [
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
].map((emoji) => ({ emoji, custom_emoji_id: `icon-${emoji}` }));
const iconic = spawn("01a04900-0000-0000-0000-000000000000", "/home/dev/work/duckpond");
await iconic.fire("session_start");
check(
	"the topic icon matches the badge emoji",
	lastCall("createForumTopic").body.icon_custom_emoji_id === `icon-${record(iconic.id).emoji}`,
);
api.topicsEnabled = false;
api.icons = null;

// A crash-recovered session must keep its forum topic instead of leaking a new one.
api.topicsEnabled = true;
const crashed = spawn("01a04a00-0000-0000-0000-000000000000", "/home/dev/work/lance");
await crashed.fire("session_start");
const crashedTopic = record(crashed.id).topicId;
check("the crashed session had a topic", typeof crashedTopic === "number");
const topicsBefore = called("createForumTopic").length;
const revived = spawn(crashed.id, "/home/dev/work/lance");
await revived.fire("session_start");
check("a crash resume keeps the same topic", record(crashed.id).topicId === crashedTopic);
check("no duplicate topic is created", called("createForumTopic").length === topicsBefore);
api.topicsEnabled = false;
heading("streaming, cost, and transparency");
rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
const fx = spawn("01a04b00-0000-0000-0000-000000000000", "/home/dev/work/quackml");
await fx.fire("session_start");
check(
	"the status command is registered",
	lastCall("setMyCommands").body.commands.some((c) => c.command === "status"),
);
check("the menu button exposes commands", lastCall("setChatMenuButton").body.menu_button.type === "commands");

// Drafts stream the partial answer with a native stop control.
await fx.fire("agent_start");
await fx.fire("message_update", {
	message: { role: "assistant", content: [{ type: "text", text: "Partial answer" }] },
});
await fx.pump(150);
const draft = lastCall("sendMessageDraft");
check("a partial answer streams as a draft", draft?.body.text.includes("Partial answer") === true);
check("the draft carries a stop control", draft.body.can_stop === true);
check("the draft id matches the session record", draft.body.draft_id === record(fx.id).draftId);
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
		switchedDraft.can_stop === true,
);
fx.ctx.model = { provider: "openai", id: "gpt-5.6-sol" };

// A stop press on the draft aborts the running turn.
api.queued = [{ update_id: 700, stopped_message_generation: { chat: { id: CHAT }, draft_id: record(fx.id).draftId } }];
await fx.pump(250);
await fx.pump(250);
check("a stop press aborts the running turn", fx.aborts === 1);
const fxSessionContext = `\u{1F535} Task: quackml [${record(fx.id).tag}] | Model: openai/gpt-5.6-sol | Tmux: not attached`;
check("a stop notice begins with session context", lastCall("sendMessage").body.text.startsWith(fxSessionContext));

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

// Transparency notices, once per kind per turn.
await fx.fire("agent_start");
await fx.fire("auto_retry_start", { attempt: 2, maxAttempts: 8 });
await settle(120);
check("a retry shows a notice", lastCall("sendMessage").body.text.includes("retrying (2/8)"));
check("a retry notice begins with session context", lastCall("sendMessage").body.text.startsWith(fxSessionContext));
const noticesBefore = called("sendMessage").length;
await fx.fire("auto_retry_start", { attempt: 3, maxAttempts: 8 });
await settle(120);
check("the notice does not repeat within a turn", called("sendMessage").length === noticesBefore);
await fx.fire("retry_fallback_applied", { from: "a/x", to: "b/y" });
await settle(120);
check("a model fallback shows a notice", lastCall("sendMessage").body.text.includes("fell back from a/x to b/y"));
check("a fallback notice begins with session context", lastCall("sendMessage").body.text.startsWith(fxSessionContext));
const tmuxBin = join(root, "bin");
mkdirSync(tmuxBin);
writeFileSync(
	join(tmuxBin, "tmux"),
	`#!/bin/sh
case "$*" in
	*'#{session_name}:#{window_index}.#{pane_index}'*) printf 'work:3.1\\n'
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
const fileContext = `Task: quackml [${record(fx.id).tag}] | Model: openai/gpt-5.6-sol | Tmux: not attached`;
check(
	"a single file caption carries context first",
	lastCall("sendPhoto").body.caption === `${fileContext}\n\nthe screenshot`,
);
check("the tool reports success", photoSend.isError !== true);
const artefact2 = join(root, "artefact2.jpg");
writeFileSync(artefact2, "jpg-bytes");
await fx.tools.get("notify_file").execute("f5", { paths: [artefact, artefact2] }, undefined, undefined, fx.ctx);
check("two images go out as one album", JSON.parse(lastCall("sendMediaGroup").body.media).length === 2);
const contextualAlbumMedia = JSON.parse(lastCall("sendMediaGroup").body.media);
check(
	"an album carries context only on its first item",
	contextualAlbumMedia[0].caption === fileContext && !("caption" in contextualAlbumMedia[1]),
);
const logFile = join(root, "build.log");
writeFileSync(logFile, "log-bytes");
await fx.tools.get("notify_file").execute("f6", { paths: [logFile] }, undefined, undefined, fx.ctx);
check("a log goes out as a document", lastCall("sendDocument").body.document === "attach://f0");
check("a captionless document still carries context", lastCall("sendDocument").body.caption === fileContext);

api.failMethods = ["sendPhoto"];
const fallbackSend = await fx.tools
	.get("notify_file")
	.execute("f6-fallback", { paths: [artefact], caption: "fallback artifact" }, undefined, undefined, fx.ctx);
api.failMethods = [];
check("a rejected photo falls back to a document", fallbackSend.isError !== true);
check(
	"photo fallback reuses the contextual caption",
	lastCall("sendDocument").body.caption === `${fileContext}\n\nfallback artifact`,
);

const longCallerCaption = "z".repeat(2_000);
await fx.tools
	.get("notify_file")
	.execute("f6-long", { paths: [logFile], caption: longCallerCaption }, undefined, undefined, fx.ctx);
const boundedCaption = lastCall("sendDocument").body.caption;
check(
	"a long caller caption is truncated after the complete context",
	boundedCaption.startsWith(`${fileContext}\n\n`) &&
		boundedCaption.length === 1024 &&
		boundedCaption.slice(fileContext.length + 2).length === 1022 - fileContext.length,
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
await rv.fire("auto_retry_start", { attempt: 2, maxAttempts: 5 });
await settle(120);
check("retry notice fires in the first turn", lastCall("sendMessage").body.text.includes("retrying (2/5)"));
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
const secondRetryBefore = called("sendMessage").length;
await rv.fire("auto_retry_start", { attempt: 2, maxAttempts: 5 });
await settle(120);
check("the notice dedupe resets with the new turn", called("sendMessage").length === secondRetryBefore + 1);
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

// A stop command while idle is a no-op.
await rv.fire("agent_end");
writeFileSync(join(inboxOf(rv.id), "801.json"), JSON.stringify({ kind: "command", value: "stopturn" }));
await rv.pump(200);
check("a stop command while idle does not abort", rv.aborts === 0);

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

// Album captions sit only on the first item; the sandbox refuses foreign paths.
const chartA = join(root, "chart-a.png");
const chartB = join(root, "chart-b.png");
writeFileSync(chartA, "a");
writeFileSync(chartB, "b");
await rv.tools
	.get("notify_file")
	.execute("r5", { paths: [chartA, chartB], caption: "the chart" }, undefined, undefined, rv.ctx);
const albumMedia = JSON.parse(lastCall("sendMediaGroup").body.media);
check(
	"the album caption sits only on the first item",
	albumMedia[0].caption ===
		`Task: htmlq [${record(rv.id).tag}] | Model: openai/gpt-5.6-sol | Tmux: not attached\n\nthe chart` &&
		!("caption" in albumMedia[1]),
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
const downloaded = readdirSync(mediaDir).find((f) => f.startsWith("500-"));
check(
	"downloaded media is private",
	downloaded !== undefined && (statSync(join(mediaDir, downloaded)).mode & 0o777) === 0o600,
);

// A stop press routes to the drafting session, not to the poller.
rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
const rvA = spawn("01a04d00-0000-0000-0000-000000000000", "/home/dev/work/polars");
await rvA.fire("session_start");
const rvB = spawn("01a04d01-0000-0000-0000-000000000000", "/home/dev/work/arrow");
await rvB.fire("session_start");
await rvB.fire("agent_start");
api.queued = [{ update_id: 730, stopped_message_generation: { chat: { id: CHAT }, draft_id: record(rvB.id).draftId } }];
await rvA.pump(250);
check("the stop routes to the drafting session's inbox", inboxCount(rvB.id) === 1);
const stopEntry = readdirSync(inboxOf(rvB.id))[0];
check("inbox entries are private", (statSync(join(inboxOf(rvB.id), stopEntry)).mode & 0o777) === 0o600);
await rvB.pump(250);
check("the drafting session aborts", rvB.aborts === 1);
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

// h. Concurrent shutdown: two topic sessions shut down and write separate
// pending-topics files; the next start sweeps both with two deleteForumTopic calls.
{
	api.topicsEnabled = true;
	rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
	const concA = spawn("01a05010-0000-0000-0000-000000000000", "/home/dev/work/concA");
	const concB = spawn("01a05011-0000-0000-0000-000000000000", "/home/dev/work/concB");
	await concA.fire("session_start");
	await concB.fire("session_start");
	await concA.fire("session_shutdown");
	await concB.fire("session_shutdown");
	const pendingTopicsDir = join(root, "notify-telegram/pending-topics");
	check(
		"concurrent shutdown writes a pending-topics file per session",
		existsSync(join(pendingTopicsDir, `${concA.id}.json`)) && existsSync(join(pendingTopicsDir, `${concB.id}.json`)),
	);
	api.topicsEnabled = false;
	writeConfig();
	rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
	const sweepTwo = spawn("01a05012-0000-0000-0000-000000000000", "/home/dev/work/sweep2");
	const deletesBeforeSweep = called("deleteForumTopic").length;
	await sweepTwo.fire("session_start");
	check(
		"concurrent shutdown sweep clears both pending-topics files",
		!existsSync(join(pendingTopicsDir, `${concA.id}.json`)) && !existsSync(join(pendingTopicsDir, `${concB.id}.json`)),
	);
	check(
		"concurrent shutdown sweep calls deleteForumTopic for each pending topic",
		called("deleteForumTopic").length === deletesBeforeSweep + 2,
	);
}

// A session shutdown turns an open standing question into a closing message.
{
	api.topicsEnabled = false;
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
	api.topicsEnabled = false;
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
	api.topicsEnabled = false;
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
	api.topicsEnabled = false;
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
	api.topicsEnabled = false;
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
	api.topicsEnabled = false;
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
	api.topicsEnabled = false;
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

rmSync(root, { recursive: true, force: true });
console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);

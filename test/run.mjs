// Full suite against a stubbed Telegram API; sends nothing.

import { spawn as startProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs, {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
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
	sendMessageGate: null,
	editMessageGate: null,
	uploadGate: null,
	pinMessageGate: null,
	unpinMessageGate: null,
	pinned: new Set(),
};
globalThis.fetch = async (url, init) => {
	if (String(url).includes("/file/bot")) {
		api.calls.push({ method: "fileDownload", body: { url: String(url) } });
		if (api.fileDownload === "throw") throw new TypeError("fetch failed");
		if (api.fileDownload === "error") return { ok: false, status: 500 };
		if (api.fileDownload === "forbidden") return { ok: false, status: 403 };
		if (api.fileDownload === "huge") return { ok: true, arrayBuffer: async () => new ArrayBuffer(21 * 1024 * 1024) };
		return { ok: true, arrayBuffer: async () => new TextEncoder().encode("fake-image-bytes").buffer };
	}
	const method = String(url).split("/").pop();
	if (method === "getFile" && api.getFileThrows === true) throw new TypeError("fetch failed");
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
		api.calls.push({ method, body, files, bytes, at: Date.now() });
		if (api.uploadGate !== null) await api.uploadGate;
		if ((api.failMethods ?? []).includes(method)) {
			return { ok: false, status: 400, json: async () => ({ ok: false, description: "failed by test" }) };
		}
		const result =
			method === "sendMediaGroup" ? [{ message_id: api.nextMessage++ }] : { message_id: api.nextMessage++ };
		return { ok: true, json: async () => ({ ok: true, result }) };
	}
	const body = JSON.parse(init.body);
	api.calls.push({ method, body, at: Date.now() });
	// A broken connection rejects the fetch, so no status line is ever read.
	if ((api.fetchThrows ?? []).includes(method)) throw new TypeError("fetch failed");
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
	// A per-message refusal for deletions, so a partial clear can be proven without failing every delete.
	if (
		(method === "deleteMessage" && (api.deleteRefusals ?? []).includes(body.message_id)) ||
		(method === "deleteMessages" && body.message_ids.some((id) => (api.deleteRefusals ?? []).includes(id)))
	) {
		return { ok: false, status: 400, json: async () => ({ ok: false, description: "message to delete not found" }) };
	}
	if (api.rejectHtml && body.parse_mode === "HTML") {
		return { ok: false, status: 400, json: async () => ({ ok: false, description: "can't parse entities" }) };
	}
	// A refusal only the plain retry sees, so a send refused twice reports the second refusal.
	if (api.plainStatus !== undefined && method === "sendMessage" && body.parse_mode !== "HTML") {
		return {
			ok: false,
			status: api.plainStatus,
			json: async () => ({
				ok: false,
				description: api.plainDescription ?? "failed by test",
				...(api.plainRetryAfter === undefined ? {} : { parameters: { retry_after: api.plainRetryAfter } }),
			}),
		};
	}
	// A per-message refusal for edits, so a deleted card's replacement can be proven without failing every edit.
	if (method === "editMessageText" && (api.editRefusals ?? []).includes(body.message_id)) {
		return { ok: false, status: 400, json: async () => ({ ok: false, description: "message to edit not found" }) };
	}
	if (method === "sendMessage" && api.sendMessageGate !== null) await api.sendMessageGate;
	if (method === "editMessageText" && api.editMessageGate !== null) await api.editMessageGate;
	if (method === "pinChatMessage") {
		if (api.pinMessageGate !== null) await api.pinMessageGate;
		api.pinned.add(body.message_id);
	}
	if (method === "unpinChatMessage") {
		if (api.unpinMessageGate !== null) await api.unpinMessageGate;
		api.pinned.delete(body.message_id);
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
/** Walks the clock the extension reads, forward only: a stamp from the future would read as fresh. */
const baseNow = Date.now;
let clockSkew = 0;
Date.now = () => baseNow() + clockSkew;
const jump = (ms) => {
	clockSkew += ms;
};
const called = (method) => api.calls.filter((c) => c.method === method);
/** What the user wrote in a steered message, which follows the reference block a reply carries. */
const steerText = (steer) => (typeof steer?.text === "string" ? steer.text : (steer?.text?.at(-1)?.text ?? ""));
/** The reference block a reply carries ahead of the user's text, empty for a message that replies to nothing. */
const referenceOf = (steer) => (Array.isArray(steer?.text) && steer.text.length > 1 ? (steer.text[0]?.text ?? "") : "");
const lastCall = (method) => called(method).at(-1);
const sessionsDir = join(root, "notify-telegram/sessions");
const inboxOf = (id) => join(root, "notify-telegram/inbox", id);
const record = (id) => JSON.parse(readFileSync(join(sessionsDir, `${id}.json`), "utf8"));
/** The head every live and settled session message opens with; a session past the palette has no emoji. */
const badgeHead = (id, folder) => {
	const { emoji } = record(id);
	return `${emoji.length > 0 ? `${emoji} ` : ""}${folder} \u00B7 `;
};
/**
 * What Telegram counts: the text left once its entities are parsed, so tags and escapes are free.
 * Walked rather than stripped with a regex, which reads as HTML sanitisation and is not one.
 */
const wireLength = (html) => {
	let count = 0;
	let inTag = false;
	for (let i = 0; i < html.length; i++) {
		const ch = html[i];
		if (inTag) {
			if (ch === ">") inTag = false;
			continue;
		}
		if (ch === "<") {
			inTag = true;
			continue;
		}
		if (ch === "&") {
			const end = html.indexOf(";", i);
			if (end > i && end - i <= 8) i = end;
		}
		count += 1;
	}
	return count;
};
/** The badge line as the session writes it: emoji, working folder, then its label or its tag. */
const badgeLineOf = (id) => {
	const own = record(id);
	const folder = own.cwd
		.split("/")
		.filter((part) => part.length > 0)
		.pop();
	const code = own.code ?? "";
	const coded = code.length > 0 ? `${code}: ${own.label}` : own.label;
	const named = own.label.length > 0 ? coded : own.name.length > 0 ? own.name : code;
	const detail = named.startsWith(`${own.emoji} `)
		? named.slice(own.emoji.length + 1)
		: named.length > 0
			? named
			: own.tag;
	return `${own.emoji.length > 0 ? `${own.emoji} ` : ""}${folder} \u00B7 ${detail}`;
};
/** notify_status refuses an option with no description; most tests do not care what it says. */
const opts = (...labels) => labels.map((label) => ({ label, description: `what "${label}" does` }));
/** ask refuses an option with no description either; most tests do not care what it says. */
const askOpt = (label) => ({ label, description: `what "${label}" does` });
const askOpts = (...labels) => labels.map(askOpt);
const inboxCount = (id) =>
	existsSync(inboxOf(id)) ? readdirSync(inboxOf(id)).filter((f) => f.endsWith(".json")).length : 0;
const sentRecordFile = (id) => JSON.parse(readFileSync(join(root, `notify-telegram/sent/${id}.json`), "utf8"));
const incomingRecordFile = (id) => JSON.parse(readFileSync(join(root, `notify-telegram/incoming/${id}.json`), "utf8"));
/** A pid that no longer runs. */
const deadPid = await new Promise((resolve) => {
	const child = startProcess(process.execPath, ["-e", ""]);
	child.on("exit", () => resolve(child.pid));
});
/**
 * Every spawned session shares this process's pid, so a resume after a kill rewrites the record's pid. The
 * heartbeat stays fresh and only the process is gone, which is what a killed omp leaves behind.
 */
const killProcessOf = (id) =>
	writeFileSync(join(sessionsDir, `${id}.json`), JSON.stringify({ ...record(id), pid: deadPid }));

const spawn = (id, cwd, title = "") => {
	const handlers = new Map();
	const timers = [];
	const tools = new Map();
	const warns = [];
	const steers = [];
	const customs = [];
	let name = title;
	// omp moves a session to a continuation id when its file is open in another process.
	let current = id;
	const renames = [];
	let renameFailure = null;
	const pi = {
		zod: chain,
		logger: { debug() {}, info() {}, warn: (m, meta) => warns.push({ m, meta }), error() {} },
		on: (event, fn) => handlers.set(event, [...(handlers.get(event) ?? []), fn]),
		registerTool: (def) => tools.set(def.name, def),
		sendUserMessage: (text, options) => steers.push({ text, options }),
		sendMessage: (message, options) => customs.push({ message, options }),
		setSessionName: async (value) => {
			if (renameFailure !== null) throw renameFailure;
			renames.push(value);
			name = value;
		},
	};
	let aborts = 0;
	const ctx = {
		hasUI: false,
		cwd,
		// omp reports an unnamed session as undefined, never as an empty string.
		sessionManager: { getSessionId: () => current, getSessionName: () => (name === "" ? undefined : name) },
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
		get id() {
			return current;
		},
		move: (next) => {
			current = next;
		},
		ctx,
		tools,
		timers,
		warns,
		steers,
		customs,
		renames,
		failRenames: (error) => {
			renameFailure = error;
		},
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
		if (typeof params.html !== "string") throw new TypeError("Native ask requires an HTML form");
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
			options: askOpts("SQLite", "Postgres"),
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
	.execute("q1", { summary: "Quietly done.", urgency: "green", effect: "none" }, undefined, undefined, quiet.ctx);
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
			options: askOpts("linux", "macos", "windows"),
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
		{ id: "q1", question: "First?", options: askOpts("yes", "no") },
		{ id: "q2", question: "Second?", options: askOpts("alpha", "beta") },
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
	"allowed_updates asks for messages, button presses and reactions",
	lastCall("getUpdates").body.allowed_updates.join(",") === "message,callback_query,message_reaction",
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
// it declines and hands the refusal up. Nothing is sent again before retry_after has passed, since
// that adds a request to the thing already refusing them, and formatting that was never at fault stays.
api.failMethods = ["sendMessage"];
api.failStatus = 429;
api.failRetryAfter = 60;
api.failDescription = "Too Many Requests: retry after 60";
const beforeThrottled = called("sendMessage").length;
await two.fire("input");
await two.tools
	.get("notify_status")
	.execute(
		"thr1",
		{ summary: "A throttled summary.", urgency: "green", effect: "none" },
		undefined,
		undefined,
		two.ctx,
	);
await two.fire("session_stop");
await settle(200);
api.failMethods = [];
api.failStatus = undefined;
api.failRetryAfter = undefined;
api.failDescription = undefined;
const throttledAttempts = called("sendMessage").slice(beforeThrottled);
check("a rate-limited send is not re-sent before its retry_after", throttledAttempts.length === 1);
check("a rate-limited send keeps its formatting", throttledAttempts[0]?.body.parse_mode === "HTML");
check(
	"a rate-limited send is logged with what Telegram actually said",
	two.warns.some((w) => JSON.stringify(w.meta ?? {}).includes("Too Many Requests")),
);
// The 60 seconds Telegram asked for would now hold back every later send in this file, so they count as passed.
rmSync(join(root, "notify-telegram/throttle.json"), { force: true });

// A complaint about the buttons also says "parse", but the plain retry keeps the same buttons, so
// re-sending repeats the identical malformed request.
api.failMethods = ["sendMessage"];
api.failDescription = "Bad Request: can't parse reply markup JSON object";
const beforeMarkup = called("sendMessage").length;
await two.fire("input");
await two.tools
	.get("notify_status")
	.execute(
		"mk1",
		{ summary: "A summary with a button.", urgency: "green", effect: "none" },
		undefined,
		undefined,
		two.ctx,
	);
await two.fire("session_stop");
await settle(200);
api.failMethods = [];
api.failDescription = undefined;
const markupAttempts = called("sendMessage").slice(beforeMarkup);
check("a rejected keyboard is not re-sent unchanged", markupAttempts.length === 1);

// A 429 over 30 s is refused instead of retried in flight, so the card must wait it out and still land.
api.plainStatus = 429;
api.plainRetryAfter = 31;
api.plainDescription = "Too Many Requests: retry after 31";
const rp = spawn("01a06009-0000-0000-0000-000000000009", "/home/dev/work/refused-plain");
await rp.fire("session_start");
const rpState = {};
void rp.tools.get("ask").execute("rp1", singleQuestion, undefined, undefined, stubbornCtx(rp.ctx, rpState));
const rpFrom = called("sendMessage").length;
const rpNext = api.nextMessage;
await settle(400);
check("the card is not delivered while its plain retry is throttled", api.nextMessage === rpNext);
api.plainStatus = undefined;
api.plainRetryAfter = undefined;
api.plainDescription = undefined;
// A 32s jump reads as a machine wake and refreshes heartbeats, so the pre-jump ages come back.
const skewBefore = clockSkew;
const preJumpHeartbeats = new Map(
	readdirSync(sessionsDir)
		.filter((entry) => entry.endsWith(".json"))
		.map((entry) => [entry, JSON.parse(readFileSync(join(sessionsDir, entry), "utf8")).heartbeat ?? 0]),
);
jump(32_000);
// The retry wakes in 250ms real-time slices, so allow several before the card lands.
await settle(2500);
const rpCard = called("sendMessage")
	.slice(rpFrom)
	.filter((c) => c.body.parse_mode === undefined && (c.body.text ?? "").includes("Which backend?"))
	.at(-1);
check(
	"a card whose plain retry was throttled lands after the retry_after",
	rpCard !== undefined && api.nextMessage === rpNext + 1,
);
check(
	"the record points at the delivered card",
	rpCard !== undefined && api.nextMessage === rpNext + 1 && record(rp.id).question === rpNext,
);
rmSync(join(root, "notify-telegram/throttle.json"), { force: true });
// A text answer closes the question so a later bare message is never held for it.
writeFileSync(join(inboxOf(rp.id), "701.json"), JSON.stringify({ kind: "text", value: "SQLite" }));
await rp.pump(150);
for (const entry of readdirSync(sessionsDir)) {
	if (!entry.endsWith(".json")) continue;
	const path = join(sessionsDir, entry);
	const pre = preJumpHeartbeats.get(entry);
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		if (pre === undefined || parsed.heartbeat === pre) continue;
		writeFileSync(path, JSON.stringify({ ...parsed, heartbeat: pre }));
	} catch {}
}
// The suite's late rewind would otherwise leave this jump's skew in every stamp it wrote.
clockSkew = skewBefore;
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
const codeless = await two.fire("before_agent_start", { prompt: "onwards" });
check(
	"a chosen emoji without a code is still asked for the code",
	codeless.some((r) => /\bcode\b/.test(r?.message?.content ?? "") && /tmux/.test(r?.message?.content ?? "")),
);
await two.tools.get("session_badge").execute("c8b", { code: "rat" }, undefined, undefined, two.ctx);
check("a lowercase code is stored in capitals", record(two.id).code === "RAT");
const afterChoice = await two.fire("before_agent_start", { prompt: "onwards" });
check(
	"a chosen emoji and code end the asking",
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

// A resumed session keeps the emoji its agent picked, and is not asked again. The resume follows the end
// of the first process, because omp moves a second process to a continuation id while the first one runs.
await two.fire("session_shutdown");
const rebadged = spawn(two.id, "/home/dev/work/diesel");
const rebadgedAsk = await rebadged
	.fire("session_start")
	.then(() => rebadged.fire("before_agent_start", { prompt: "x" }));
check("a resume keeps the chosen emoji", record(two.id).emoji === "\u{1F430}");
check("a resume keeps the chosen code", record(two.id).code === "RAT");
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

heading("the omp session name follows the badge");
{
	const freezing = "\u{1F976}";
	const flamingo = "\u{1F9A9}";
	const jellyfish = "\u{1FABC}";
	const badgeOn = (s, args) => s.tools.get("session_badge").execute("nb", args, undefined, undefined, s.ctx);

	const titled = spawn(
		"01a034a0-0000-0000-0000-000000000000",
		"/home/dev/work/titled",
		"\u26D3\uFE0F CHAIN: Raise message chain length limit",
	);
	await titled.fire("session_start");
	await titled.fire("agent_end");
	check("a placeholder badge never renames the omp session", titled.renames.length === 0);
	const labelled = await badgeOn(titled, { emoji: freezing, label: "tmux freeze and emoji mismatch" });
	check(
		"a badge with a label renames the omp session to that emoji and label",
		titled.renames.at(-1) === `${freezing} tmux freeze and emoji mismatch`,
	);
	check(
		"the session record carries the new name",
		record(titled.id).name === `${freezing} tmux freeze and emoji mismatch`,
	);
	check(
		"the Telegram badge line shows the emoji once",
		labelled.details.badge === `${freezing} titled \u00B7 tmux freeze and emoji mismatch`,
	);
	const renamedOnce = titled.renames.length;
	await titled.fire("agent_end");
	check("a turn end leaves a name that already shows the badge", titled.renames.length === renamedOnce);

	const iconOnly = spawn(
		"01a034a1-0000-0000-0000-000000000000",
		"/home/dev/work/icononly",
		"\u{1F522} SEQ: Track CREATE SEQUENCE",
	);
	await iconOnly.fire("session_start");
	const swapped = await badgeOn(iconOnly, { emoji: flamingo });
	check(
		"a badge without a label swaps only the omp title's icon",
		iconOnly.renames.at(-1) === `${flamingo} SEQ: Track CREATE SEQUENCE`,
	);
	check(
		"a badge without a label still shows its emoji once in Telegram",
		swapped.details.badge === `${flamingo} icononly \u00B7 SEQ: Track CREATE SEQUENCE`,
	);

	const untitled = spawn("01a034a2-0000-0000-0000-000000000000", "/home/dev/work/untitled");
	await untitled.fire("session_start");
	await badgeOn(untitled, { emoji: jellyfish });
	check("an unnamed session is not given a bare emoji, so omp can still title it", untitled.renames.length === 0);
	untitled.setTitle("\u{1F4C2} POST: Open PRs for each remaining phase");
	await untitled.fire("agent_end");
	check(
		"omp's later auto-title takes the badge at the turn end",
		untitled.renames.at(-1) === `${jellyfish} POST: Open PRs for each remaining phase`,
	);
	untitled.setTitle("My own name for it");
	await untitled.fire("agent_end");
	check(
		"a name the user typed keeps its words behind the badge",
		untitled.renames.at(-1) === `${jellyfish} My own name for it`,
	);

	const before = titled.renames.length;
	await badgeOn(titled, { emoji: jellyfish, label: "stolen" });
	check("a refused badge renames nothing", titled.renames.length === before);

	const coded = await badgeOn(titled, { code: "FREEZE" });
	check(
		"a code heads the omp session name in omp's card form",
		titled.renames.at(-1) === `${freezing} FREEZE: tmux freeze and emoji mismatch`,
	);
	check(
		"the code heads the Telegram badge line too",
		coded.details.badge === `${freezing} titled \u00B7 FREEZE: tmux freeze and emoji mismatch`,
	);
	await badgeOn(iconOnly, { code: "SEQ2" });
	check(
		"a code replaces the code omp's card carried and keeps its words",
		iconOnly.renames.at(-1) === `${flamingo} SEQ2: Track CREATE SEQUENCE`,
	);
	await badgeOn(untitled, { code: "OWN" });
	check("a code heads a name the user typed", untitled.renames.at(-1) === `${jellyfish} OWN: My own name for it`);
	untitled.setTitle("Plan R2: the next phase");
	await untitled.fire("agent_end");
	check(
		"a typed name with a word before its colon keeps every word behind the code",
		untitled.renames.at(-1) === `${jellyfish} OWN: Plan R2: the next phase`,
	);

	const held = await badgeOn(untitled, { code: "FREEZE" });
	check(
		"a code another live session's badge holds is refused",
		held.details.applied === false && record(untitled.id).code === "OWN",
	);
	check(
		"the code refusal lists the codes in use",
		/FREEZE/.test(held.content[0].text) && /in use/i.test(held.content[0].text),
	);
	const carded = spawn(
		"01a034a3-0000-0000-0000-000000000000",
		"/home/dev/work/carded",
		"\u{1F9EA} FLAKY: Fix flaky park tests",
	);
	await carded.fire("session_start");
	const echoed = await badgeOn(untitled, { code: "FLAKY" });
	check("a code heading another live session's omp title is refused", echoed.details.applied === false);
	for (const bad of ["TOOLONG", "R-89", "TWO WORDS"]) {
		const refused = await badgeOn(untitled, { code: bad });
		check(
			`a malformed code (${bad}) is refused with the rule`,
			refused.details.applied === false && /1 to 6/.test(refused.content[0].text) && record(untitled.id).code === "OWN",
		);
	}

	const thread = "\u{1F9F5}";
	const blank = spawn("01a034a4-0000-0000-0000-000000000000", "/home/dev/work/blank");
	await blank.fire("session_start");
	await badgeOn(blank, { emoji: thread, code: "BLANK" });
	check("a code alone does not name a session omp has not titled yet", blank.renames.length === 0);
	blank.setTitle("\u{1F4C2} POST: Open PRs for each remaining phase");
	await blank.fire("agent_end");
	check(
		"the badge code replaces omp's code once omp titles the session",
		blank.renames.at(-1) === `${thread} BLANK: Open PRs for each remaining phase`,
	);
	for (const s of [carded, blank]) await s.fire("session_shutdown");

	titled.failRenames(new Error("session released"));
	const failed = await badgeOn(titled, { emoji: "\u{1F9CA}", label: "ice" });
	check(
		"a failed rename still applies the badge",
		failed.details.applied === true && record(titled.id).emoji === "\u{1F9CA}",
	);
	check(
		"a failed rename is logged with its error",
		titled.warns.some((w) => /rename/.test(w.m) && w.meta?.error === "session released"),
	);
	titled.failRenames("handle closed");
	await badgeOn(titled, { label: "melting" });
	check(
		"a rename refused with a bare value logs that value",
		titled.warns.some((w) => /rename/.test(w.m) && w.meta?.error === "handle closed"),
	);
	for (const s of [titled, iconOnly, untitled]) await s.fire("session_shutdown");
}

// ---------------------------------------------------------------------- reaper
heading("stale session reaping");
const dead = "01a03000-dead-0000-0000-000000000000";
mkdirSync(inboxOf(dead), { recursive: true });
writeFileSync(join(inboxOf(dead), "1.json"), JSON.stringify({ kind: "redo", value: "retry dead work" }));
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
const staleReapNotices = called("sendMessage").length;
const reaper = spawn("01a03500-0000-0000-0000-000000000000", "/home/dev/work/rats");
await reaper.fire("session_start");
await settle(50);
check("stale record reaped", !existsSync(join(sessionsDir, `${dead}.json`)));
check("stale inbox reaped", !existsSync(inboxOf(dead)));
check("live records survive", existsSync(join(sessionsDir, `${one.id}.json`)));
check(
	"reaping a queued redo reports that its session ended",
	called("sendMessage").length === staleReapNotices + 1 && lastCall("sendMessage").body.text.includes("session ended"),
);

// A stale closing fence a killed shutdown leaves behind must not stop the reaper from claiming the route.
const deadFenced = "01a03001-dead-0000-0000-000000000000";
writeFileSync(
	join(sessionsDir, `${deadFenced}.json`),
	JSON.stringify({
		pid: deadPid,
		tag: "deadf",
		name: "",
		cwd: "/x",
		emoji: "\u{1F480}",
		label: "",
		lastNotified: 0,
		heartbeat: Date.now() - 120_000,
	}),
);
const deadFencedLocks = join(root, "notify-telegram/reaction-route-locks");
mkdirSync(deadFencedLocks, { recursive: true });
const deadFencedClosing = join(deadFencedLocks, `${deadFenced}.closing`);
writeFileSync(deadFencedClosing, "dead-shutdown-token");
const deadFencedAge = (Date.now() - 60_000) / 1000;
utimesSync(deadFencedClosing, deadFencedAge, deadFencedAge);
const fencedReaper = spawn("01a03501-0000-0000-0000-000000000000", "/home/dev/work/fenced");
await fencedReaper.fire("session_start");
await settle(50);
check(
	"a stale closing fence does not block the dead-session reaper",
	!existsSync(join(sessionsDir, `${deadFenced}.json`)) &&
		existsSync(join(root, "notify-telegram/crashed", `${deadFenced}.json`)) &&
		!existsSync(deadFencedClosing),
);
// Delete its fresh record so it cannot hold a palette badge into the crash section's badge re-solve.
rmSync(join(sessionsDir, `${fencedReaper.id}.json`), { force: true });

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

// omp gives a resumed session a continuation id on its first write when another omp process still has the
// file open, and raises no extension event for it. Until then both processes report the same id.
heading("a session resumed while another omp holds it");
{
	const lockFile = join(root, "notify-telegram/poller.lock");
	const heldId = "01a03950-0000-0000-0000-000000000000";
	const holder = spawn(heldId, "/home/dev/work/connetto");
	await holder.fire("session_start");
	// The holder has saved a turn since it started, so omp keeps the session file for it.
	await holder.fire("message_end", { message: { role: "assistant", content: [] } });
	await holder.fire("session_stop");
	await settle();
	const holderMessage = api.nextMessage - 1;
	const holderTag = record(heldId).tag;
	const holderEmoji = record(heldId).emoji;
	const holderBytes = readFileSync(join(sessionsDir, `${heldId}.json`), "utf8");

	const resumed = spawn(heldId, "/home/dev/work/connetto");
	await resumed.fire("session_start");
	resumed.heartbeat();
	await resumed.pump(60);
	check(
		"a second instance on a held id leaves the holder's record alone",
		readFileSync(join(sessionsDir, `${heldId}.json`), "utf8") === holderBytes,
	);
	writeFileSync(join(inboxOf(heldId), "3300.json"), JSON.stringify({ kind: "text", value: "for the holder" }));
	await resumed.pump(120);
	check(
		"the waiting instance does not drain the holder's inbox",
		inboxCount(heldId) === 1 && resumed.steers.length === 0,
	);
	await holder.pump(120);
	check(
		"the holder still drains its own inbox",
		holder.steers.some((s) => s.text.includes("for the holder")),
	);

	rmSync(lockFile, { force: true });
	holder.heartbeat();
	const pollsBefore = called("getUpdates").length;
	await resumed.pump(60);
	check("the waiting instance does not poll on the holder's lock", called("getUpdates").length === pollsBefore);
	const waitingSend = await resumed.tools
		.get("session_message")
		.execute("sm-wait", { to: record(heldId).tag, text: "hello" }, undefined, undefined, resumed.ctx);
	check(
		"a waiting instance refuses to message, since a reply would reach the holder",
		waitingSend.isError === true && waitingSend.details.sent === false,
	);

	// A machine waking from sleep finds every heartbeat old, the live holder's included. The waiting
	// instance must not take the holder for dead and answer the card the holder sent before the sleep.
	const beforeSleep = clockSkew;
	const holderInstance = record(heldId).instance;
	const sleptAsk = holder.tools
		.get("ask")
		.execute("slept-ask", singleQuestion, undefined, undefined, stubbornCtx(holder.ctx, {}));
	await settle(150);
	const sleptPick = lastCall("sendMessage")
		.body.reply_markup.inline_keyboard.flat()
		.find((b) => b.text.startsWith("Postgres")).callback_data;
	const closedBeforeSleep = called("sendMessage").filter((c) =>
		String(c.body.text).includes("That question is closed"),
	).length;
	jump(10 * 60_000);
	await resumed.pump(120);
	check(
		"after a sleep, the waiting instance leaves the live holder's record alone",
		record(heldId).instance === holderInstance,
	);
	api.queued = [
		{
			update_id: 3299,
			callback_query: {
				id: "cb-slept",
				data: sleptPick,
				from: { id: CHAT },
				message: { message_id: api.nextMessage - 1, chat: { id: CHAT } },
			},
		},
	];
	await holder.pump(250);
	await resumed.pump(120);
	await holder.pump(150);
	const sleptAnswer = await Promise.race([sleptAsk, settle(500).then(() => null)]);
	check(
		"after a sleep, a press on the holder's card still reaches the holder",
		sleptAnswer?.details.selectedOptions[0] === "Postgres",
	);
	check(
		"and the waiting instance does not answer it as a closed question",
		called("sendMessage").filter((c) => String(c.body.text).includes("That question is closed")).length ===
			closedBeforeSleep,
	);
	// A holder that stops writing while the waiting instance stays awake is hung, and is taken over.
	for (let step = 0; step < 13; step++) {
		jump(4_000);
		await resumed.pump(20);
	}
	check(
		"a holder silent through the waiting instance's waking hours is taken over",
		record(heldId).instance !== holderInstance,
	);
	holder.heartbeat();
	await resumed.pump(60);
	check("the leased holder takes its record back once it runs again", record(heldId).instance === holderInstance);
	clockSkew = beforeSleep;

	const continuationId = "01a03951-0000-0000-0000-000000000000";
	resumed.move(continuationId);
	await resumed.pump(150);
	check("the continuation registers under its own id", existsSync(join(sessionsDir, `${continuationId}.json`)));
	check(
		"the continuation's tag and badge differ from the holder's",
		record(continuationId).tag !== holderTag && record(continuationId).emoji !== holderEmoji,
	);
	await resumed.fire("session_stop");
	await settle();
	const resumedMessage = api.nextMessage - 1;
	holder.heartbeat();
	resumed.heartbeat();
	check(
		"each instance's record routes only its own messages",
		record(heldId).recent.includes(holderMessage) &&
			!record(heldId).recent.includes(resumedMessage) &&
			record(continuationId).recent.includes(resumedMessage) &&
			!record(continuationId).recent.includes(holderMessage),
	);
	api.queued = [
		{
			update_id: 3301,
			message: {
				message_id: 3301,
				date: 1,
				chat: { id: CHAT },
				text: "for the continuation",
				reply_to_message: { message_id: resumedMessage },
			},
		},
	];
	await holder.pump(250);
	check("a reply to the continuation's message reaches the continuation", inboxCount(continuationId) === 1);
	check("and not the holder", inboxCount(heldId) === 0);
	await resumed.pump(120);
	check(
		"the continuation reads it",
		resumed.steers.some((s) => steerText(s).includes("for the continuation")),
	);
	// A card the holder sends is answered by the holder, whichever of the two drains first.
	const heldAskState = {};
	const heldAsk = holder.tools
		.get("ask")
		.execute("held-ask", singleQuestion, undefined, undefined, stubbornCtx(holder.ctx, heldAskState));
	await settle(150);
	const heldPick = lastCall("sendMessage")
		.body.reply_markup.inline_keyboard.flat()
		.find((b) => b.text.startsWith("Postgres")).callback_data;
	const closedNotices = () =>
		called("sendMessage").filter((c) => String(c.body.text).includes("That question is closed")).length;
	const closedBefore = closedNotices();
	api.queued = [
		{
			update_id: 3302,
			callback_query: {
				id: "cb-held",
				data: heldPick,
				from: { id: CHAT },
				message: { message_id: api.nextMessage - 1, chat: { id: CHAT } },
			},
		},
	];
	await holder.pump(250);
	await resumed.pump(120);
	await holder.pump(150);
	const heldAnswer = await Promise.race([heldAsk, settle(500).then(() => null)]);
	check(
		"a press on the holder's card reaches the holder, not the continuation",
		heldAnswer?.details.selectedOptions[0] === "Postgres",
	);
	await holder.tools
		.get("notify_status")
		.execute(
			"held-choice",
			{ summary: "Pick one.", urgency: "orange", options: opts("Go", "Wait") },
			undefined,
			undefined,
			holder.ctx,
		);
	await holder.fire("session_stop");
	await settle();
	const heldGo = lastCall("sendMessage")
		.body.reply_markup.inline_keyboard.flat()
		.find((b) => b.text.startsWith("Go")).callback_data;
	const holderSteers = holder.steers.length;
	api.queued = [
		{
			update_id: 3304,
			callback_query: {
				id: "cb-held-choice",
				data: heldGo,
				from: { id: CHAT },
				message: { message_id: api.nextMessage - 1, chat: { id: CHAT } },
			},
		},
	];
	await holder.pump(250);
	await resumed.pump(120);
	await holder.pump(150);
	check(
		"a press on the holder's turn-end choice reaches the holder",
		holder.steers.slice(holderSteers).some((s) => s.text === "Go") && !resumed.steers.some((s) => s.text === "Go"),
	);
	check("neither press is answered as a closed question", closedNotices() === closedBefore);
	await resumed.fire("session_shutdown");
	await holder.fire("session_shutdown");

	// A waiting instance whose holder ends takes the session over as an ordinary resume.
	const handedId = "01a03952-0000-0000-0000-000000000000";
	const first = spawn(handedId, "/home/dev/work/connetto");
	await first.fire("session_start");
	await first.fire("message_end", { message: { role: "assistant", content: [] } });
	await first.fire("session_stop");
	await settle();
	const firstMessage = api.nextMessage - 1;
	const firstTag = record(handedId).tag;
	const second = spawn(handedId, "/home/dev/work/connetto");
	await second.fire("session_start");
	await first.fire("session_shutdown");
	second.heartbeat();
	await second.pump(150);
	check(
		"once the holder ends, the waiting instance adopts its record",
		record(handedId).heartbeat > 0 &&
			record(handedId).tag === firstTag &&
			record(handedId).recent.includes(firstMessage),
	);
	await second.fire("session_shutdown");

	// omp keeps the session for the process that saves first and moves the other at its next save. A
	// waiting instance whose turn saved without a move holds the lease and continues the conversation.
	const racedId = "01a03955-0000-0000-0000-000000000000";
	const idle = spawn(racedId, "/home/dev/work/connetto");
	await idle.fire("session_start");
	await idle.fire("session_stop");
	await settle();
	const idleMessage = api.nextMessage - 1;
	const racedTag = record(racedId).tag;
	const active = spawn(racedId, "/home/dev/work/connetto");
	await active.fire("session_start");
	await active.fire("message_end", { message: { role: "assistant", content: [] } });
	idle.heartbeat();
	await settle();
	api.queued = [
		{
			update_id: 3303,
			message: {
				message_id: 3303,
				date: 1,
				chat: { id: CHAT },
				text: "for the lease holder",
				reply_to_message: { message_id: idleMessage },
			},
		},
	];
	rmSync(lockFile, { force: true });
	active.heartbeat();
	await active.pump(250);
	await active.pump(120);
	await idle.pump(120);
	check(
		"the instance that saved first takes over the conversation's routing",
		active.steers.some((s) => steerText(s).includes("for the lease holder")) &&
			!idle.steers.some((s) => steerText(s).includes("for the lease holder")),
	);
	check("it keeps the conversation's tag", record(racedId).tag === racedTag);
	const forkedId = "01a03956-0000-0000-0000-000000000000";
	idle.move(forkedId);
	await idle.pump(150);
	check(
		"the instance omp moves later registers its continuation without the conversation's routing",
		record(forkedId).tag !== racedTag && !record(forkedId).recent.includes(idleMessage),
	);
	await idle.fire("session_shutdown");
	await active.fire("session_shutdown");

	// A registered session that omp moves takes its routing to the new id.
	const leftId = "01a03953-0000-0000-0000-000000000000";
	const mover = spawn(leftId, "/home/dev/work/connetto");
	await mover.fire("session_start");
	await mover.fire("session_stop");
	await settle();
	const moverMessage = api.nextMessage - 1;
	const moverTag = record(leftId).tag;
	rmSync(lockFile, { force: true });
	mover.heartbeat();
	api.queued = [
		{
			update_id: 3302,
			message: {
				message_id: 3302,
				date: 1,
				chat: { id: CHAT },
				text: "queued before the move",
				reply_to_message: { message_id: moverMessage },
			},
		},
	];
	await mover.pump(250);
	const heldForLeft = join(root, "notify-telegram/graph/pending", leftId);
	mkdirSync(heldForLeft, { recursive: true });
	writeFileSync(
		join(heldForLeft, "o-01a03957-merged.json"),
		JSON.stringify({
			kind: "outcome",
			at: Date.now(),
			source: "01a03957-0000-0000-0000-000000000000",
			outcome: "merged",
			title: "held across the move",
			place: "widget",
			edge: "waits-on",
		}),
	);
	const reachedId = "01a03954-0000-0000-0000-000000000000";
	mover.move(reachedId);
	await mover.pump(150);
	check("the left id's record is gone", !existsSync(join(sessionsDir, `${leftId}.json`)));
	check(
		"the new record keeps the tag and the routing",
		record(reachedId).tag === moverTag && record(reachedId).recent.includes(moverMessage),
	);
	check(
		"an entry queued for the left id still arrives",
		mover.steers.some((s) => steerText(s).includes("queued before the move")),
	);
	check(
		"an update held for the left id still arrives",
		mover.customs.some((c) => String(c.message.content).includes("held across the move")),
	);
	check("its sent messages belong to the new id", sentRecordFile(moverMessage).session.id === reachedId);
	check("the reply it received belongs to the new id", incomingRecordFile(3302).session.id === reachedId);
	await mover.fire("session_shutdown");
	rmSync(lockFile, { force: true });
	one.heartbeat();
}
{
	// After a sleep the poller can route a press before the session it targets has run since the wake, so that
	// session's heartbeat is still old. A record whose process runs takes the press, and a dead one does not.
	const wakeClock = clockSkew;
	const tapFor = (updateId, data, messageId) => ({
		update_id: updateId,
		callback_query: {
			id: `cb-${updateId}`,
			data,
			from: { id: CHAT },
			message: { message_id: messageId, chat: { id: CHAT } },
		},
	});
	const target = spawn("01a03960-0000-0000-0000-000000000000", "/home/dev/work/wake-target");
	await target.fire("session_start");
	let wakeAnswer = null;
	target.tools
		.get("ask")
		.execute("wake-ask", singleQuestion, undefined, undefined, stubbornCtx(target.ctx, {}))
		.then((result) => {
			wakeAnswer = result;
		});
	await settle(150);
	const wakeQuestion = api.nextMessage - 1;
	const wakePick = lastCall("sendMessage")
		.body.reply_markup.inline_keyboard.flat()
		.find((b) => b.text.startsWith("Postgres")).callback_data;
	jump(10 * 60_000);
	api.queued = [tapFor(3310, wakePick, wakeQuestion)];
	await one.pump(250);
	check(
		"after a sleep, a press reaches a live session that has not run since the wake",
		inboxCount(target.id) === 1 && !lastCall("answerCallbackQuery").body.text.includes("gone"),
	);
	await target.pump(250);
	check("and that session takes it as the answer", wakeAnswer?.details.selectedOptions[0] === "Postgres");
	const deadRecordFile = join(sessionsDir, "01a03961-0000-0000-0000-000000000000.json");
	writeFileSync(
		deadRecordFile,
		JSON.stringify({
			...record(target.id),
			instance: "dead-instance",
			pid: deadPid,
			tag: "dedw1",
			heartbeat: Date.now() - 10 * 60_000,
		}),
	);
	api.queued = [tapFor(3311, "o:dedw1-1:0:0", wakeQuestion)];
	await one.pump(250);
	check(
		"after a sleep, a press for a session whose process is gone is still refused",
		lastCall("answerCallbackQuery").body.text.includes("gone"),
	);
	rmSync(deadRecordFile, { force: true });
	await target.fire("session_shutdown");
	clockSkew = wakeClock;
}

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
		{ id: "a", question: "Rebuild now?", options: askOpts("yes", "no") },
		{ id: "b", question: "Notify on completion?", options: askOpts("yes", "no") },
	],
};
const ctxRun = ctxSession.tools.get("ask").execute("cx", ctxAsk, undefined, undefined, withCapture);
await settle(150);
check("the terminal form includes the shared context", seen.params.html.includes("The rebuild takes 40 minutes"));
check("the terminal form includes the first question", seen.params.html.includes("Rebuild now?"));
check("the terminal form includes later questions", seen.params.html.includes("Notify on completion?"));
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
const askDoc = ctxSession.tools.get("ask").description;
check(
	"tool description demands the option that is best once the work is finished",
	askDoc.includes("best once the work is finished"),
);
check(
	"tool description forbids effort as a reason to prefer or demote an option",
	askDoc.includes("Effort, edit count and churn are never grounds") && askDoc.includes("many call sites"),
);
check(
	"tool description confines a partial option to a named blocker and states its cost",
	askDoc.includes("named concrete blocker") && askDoc.includes("what the deferral costs"),
);
check(
	"tool description says to act rather than ask when one path is plainly better",
	askDoc.includes("matter of the user's taste"),
);
check(
	"tool description states that an undescribed option is refused",
	askDoc.includes("an option without one is refused"),
);

// --------------------------------------------------- an option nobody explained
heading("an undescribed ask option");
const nakedAsk = await ctxSession.tools.get("ask").execute(
	"bare1",
	{
		questions: [
			{
				id: "split",
				question: "Split the enum?",
				options: [
					{ label: "Split it now", description: "Two disjoint types, 700 call sites touched once." },
					{ label: "Keep one enum" },
				],
			},
		],
	},
	undefined,
	undefined,
	ctxSession.ctx,
);
check("an option with no description is refused", nakedAsk.isError === true);
const nakedText = nakedAsk.content[0].text;
check(
	"the refusal names the question and the option",
	nakedText.includes("split") && nakedText.includes("Keep one enum"),
);
check(
	"the refusal explains why a description is mandatory",
	nakedText.includes("the label alone is what arrives") && nakedText.includes("cannot judge"),
);
check(
	"the refusal says exactly what to send instead",
	nakedText.includes("what choosing it does or costs") && nakedText.includes("call ask again"),
);
check("the refusal reaches no chat", lastCall("sendMessage").body.text.includes("Split the enum?") === false);
// An id and a label are both allowed to be empty by the schema, and the refusal still has to point somewhere.
const namelessAsk = await ctxSession.tools.get("ask").execute(
	"bare2",
	{
		questions: [
			{
				id: "  ",
				question: "Which one?",
				options: [askOpt("Keep it"), { label: "  " }],
			},
			{ id: "second", question: "And then?", options: [askOpt("Stop")] },
		],
	},
	undefined,
	undefined,
	ctxSession.ctx,
);
check(
	"a nameless question and a nameless option are still located",
	namelessAsk.content[0].text.includes("the question offers option 2 with no description"),
);
check("a described question alongside it is not blamed", namelessAsk.content[0].text.includes("second") === false);

// ------------------------------------------------ an option that says I or you
heading("an ask option voiced in the first or second person");
const voicedAsk = await ctxSession.tools.get("ask").execute(
	"voice1",
	{
		questions: [
			{
				id: "rebase",
				question: "How should the branch land?",
				options: [
					{ label: "I'll rebase onto main", description: "Rewrites the branch history before the merge." },
					{ label: "Merge as is", description: "You review the merge commit afterwards." },
					{ label: "Squash", description: "One commit, the history is lost." },
				],
			},
		],
	},
	undefined,
	undefined,
	ctxSession.ctx,
);
check("an option saying I or you is refused", voicedAsk.isError === true);
const voicedText = voicedAsk.content[0].text;
check(
	"the refusal names each voiced option and the word it used",
	voicedText.includes('"I" in "I\'ll rebase onto main"') && voicedText.includes('"You" in "Merge as is"'),
);
check("a third-person option alongside them is not blamed", voicedText.includes("Squash") === false);
check(
	"the refusal says why a pronoun leaves the actor unclear",
	voicedText.includes("could mean the agent or the user"),
);
check(
	"with no known name the refusal asks for Agent and User",
	voicedText.includes('"Agent will') && voicedText.includes('"User will') && voicedText.includes("if you know it"),
);
check(
	"the voiced refusal reaches no chat",
	lastCall("sendMessage").body.text.includes("How should the branch land?") === false,
);
// Code spans, I/O and the US are not pronouns, and a list with one real fault reports only that fault.
const lookalikeAsk = await ctxSession.tools.get("ask").execute(
	"voice2",
	{
		questions: [
			{
				id: "suite",
				question: "Which suite?",
				options: [
					{ label: "Run the I/O suite", description: "Touches `my_config` and `we` only, in the US region." },
					{ label: "Skip" },
				],
			},
		],
	},
	undefined,
	undefined,
	ctxSession.ctx,
);
const lookalikeText = lookalikeAsk.content[0].text;
check(
	"lookalikes of pronouns are not refused",
	lookalikeText.includes('"Skip" with no description') && lookalikeText.includes("could mean") === false,
);
// I/O is the one slash pair that is not people, so a pronoun on either side of any other slash still counts.
const slashAsk = await ctxSession.tools.get("ask").execute(
	"voice2b",
	{
		questions: [
			{
				id: "owner",
				question: "Who owns the migration?",
				options: [{ label: "Split it", description: "Divide the work between you/me by ownership." }],
			},
		],
	},
	undefined,
	undefined,
	ctxSession.ctx,
);
check(
	"a pronoun beside a slash is still refused",
	slashAsk.isError === true && slashAsk.content[0].text.includes('"you", "me" in "Split it"'),
);
// Both faults in one list come back in one refusal, so a single retry can fix both.
const bothAsk = await ctxSession.tools
	.get("ask")
	.execute(
		"voice3",
		{ questions: [{ id: "both", question: "Go?", options: [{ label: "We ship it" }, askOpt("Hold")] }] },
		undefined,
		undefined,
		ctxSession.ctx,
	);
check(
	"one refusal carries both the missing description and the pronoun",
	bothAsk.content[0].text.includes("with no description") && bothAsk.content[0].text.includes('"We" in "We ship it"'),
);
check(
	"tool description asks for the actor by name instead of I or you",
	askDoc.includes('"Agent will') && askDoc.includes('"User will') && askDoc.includes("never I, me, you"),
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

// Placed by rename, as the extension writes it, so no reader ever sees a half-written lock.
const placeLock = (lock) => {
	writeFileSync(`${lockPath}.test.tmp`, JSON.stringify(lock));
	renameSync(`${lockPath}.test.tmp`, lockPath);
};
// A fresh heartbeat proves nothing once its process is gone, so a drain tick takes the lock at once.
placeLock({ sessionId: "dead-holder", pid: deadPid, heartbeat: Date.now() });
const taker = contenders[0];
const deadPollsBefore = called("getUpdates").length;
taker.timers[1]();
await settle(40);
check("a drain tick takes a dead holder's fresh lock", owner().sessionId === taker.id);
taker.timers[1]();
await settle(40);
check("the successor polls on the next drain tick", called("getUpdates").length > deadPollsBefore);
// Only a gone process frees the lock, so a fresh heartbeat from a live process keeps it.
placeLock({ sessionId: "live-holder", pid: process.pid, heartbeat: Date.now() });
const nonTaker = contenders[1];
nonTaker.timers[1]();
await settle(40);
check("a drain tick leaves a live holder's fresh lock", owner().sessionId === "live-holder");
// A lock written without a pid is judged by its heartbeat alone, so a fresh one keeps its holder.
placeLock({ sessionId: "pidless-holder", heartbeat: Date.now() });
nonTaker.timers[0]();
await settle(40);
check("a heartbeat leaves a fresh lock that names no pid", owner().sessionId === "pidless-holder");

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

// The user's name comes from Telegram, and a name already in the config file is theirs to keep.
heading("the user's name");
rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
const nm = spawn("01a07a00-0000-0000-0000-000000000000", "/home/dev/work/naming");
await nm.fire("session_start");
const configName = () => JSON.parse(readFileSync(join(root, "notify-telegram.json"), "utf8")).userName;
api.queued = [
	{ update_id: 7100, message: { message_id: 7100, date: 1, chat: { id: CHAT, first_name: "Ada" }, text: "hello" } },
];
await nm.pump(250);
check("the first name of the chat is learned", configName() === "Ada");
const namedAsk = await nm.tools.get("ask").execute(
	"voice4",
	{
		questions: [{ id: "q", question: "Who reviews?", options: [{ label: "You review", description: "Takes a day." }] }],
	},
	undefined,
	undefined,
	nm.ctx,
);
check(
	"a known name replaces User in the refusal",
	namedAsk.content[0].text.includes('"Ada will') && namedAsk.content[0].text.includes('"User will') === false,
);
// The session forgets Ada with the file, then the user writes a name by hand while it runs.
writeConfig();
nm.heartbeat();
await settle(60);
writeConfig({ userName: "Luca" });
api.queued = [
	{
		update_id: 7101,
		callback_query: {
			id: "cbname",
			data: "x",
			from: { id: CHAT, first_name: "Ada" },
			message: { message_id: 7, chat: { id: CHAT } },
		},
	},
	{ update_id: 7102, message: { message_id: 7102, date: 1, chat: { id: CHAT, first_name: "Ada" }, text: "again" } },
];
await nm.pump(250);
check("a name written in the config file is not overwritten", configName() === "Luca");
writeConfig();
nm.heartbeat();
await settle(60);
api.queued = [
	{
		update_id: 7103,
		callback_query: {
			id: "cbname2",
			data: "x",
			from: { id: CHAT, first_name: "Grace" },
			message: { message_id: 7, chat: { id: CHAT } },
		},
	},
];
await nm.pump(250);
check("a button press teaches the name too", configName() === "Grace");
writeConfig();

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
		{ id: "one", question: "Q1?", options: askOpts("a1", "b1") },
		{ id: "two", question: "Q2?", options: askOpts("a2", "b2") },
		{ id: "three", question: "Q3?", options: askOpts("a3", "b3") },
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
		{ id: "first", question: "Pick one?", options: askOpts("x", "y") },
		{ id: "middle", question: "Pick many?", multi: true, options: askOpts("p", "q", "r") },
		{ id: "last", question: "Free form?", options: askOpts("preset") },
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
// Sends stay paced for 30 s after a 429, which would slow every later check in this file.
rmSync(join(root, "notify-telegram/throttle.json"), { force: true });

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
		{ context: md, questions: [{ id: "q", question: "ok?", options: askOpts("yes") }] },
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

// Escaping costs nothing on the wire, so a body dense in angle brackets is not cut early.
const huge = "<".repeat(3500);
mdSession.tools
	.get("ask")
	.execute(
		"hg",
		{ context: huge, questions: [{ id: "q", question: "ok?", options: askOpts("yes") }] },
		undefined,
		undefined,
		stubbornCtx(mdSession.ctx, {}),
	);
await settle(200);
check(
	"a body dense in escapes is sent whole",
	!lastCall("sendMessage").body.text.includes("truncated, full text at the terminal"),
);

// A body over the real ceiling must still be sent, shrunk to fit.
mdSession.tools
	.get("ask")
	.execute(
		"hg2",
		{ context: "x".repeat(5000), questions: [{ id: "q", question: "ok?", options: askOpts("yes") }] },
		undefined,
		undefined,
		stubbornCtx(mdSession.ctx, {}),
	);
await settle(200);
check(
	"an oversized message is shrunk below the telegram ceiling",
	wireLength(lastCall("sendMessage").body.text) <= 4096 &&
		lastCall("sendMessage").body.text.includes("truncated, full text at the terminal"),
);

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
const escAsk = { questions: [{ id: "q", question: "Proceed?", options: askOpts("yes", "no") }] };

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
	"cancelled native question retains context and question",
	closing.body.text.startsWith(
		`${badgeLineOf(esc.id)}\nTask: subql [${record(esc.id).tag}] | Model: openai/gpt-5.6-sol | Tmux: not attached`,
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
		`\u{1F535} ${badgeLineOf(esc.id)}\nTask: subql [${record(esc.id).tag}] | Model: openai/gpt-5.6-sol | Tmux: not attached`,
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
			{ id: "a", question: "First?", options: askOpts("x", "y") },
			{ id: "b", question: "Second?", options: askOpts("p") },
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
				{ label: "another neutral", description: "also no strong view" },
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
check(
	"every option gets its own section in the body",
	stBody.text.includes("<b>another neutral</b>\nalso no strong view"),
);
check("the terminal sees the discouraged marker too", stanceParams.params.html.includes("(discouraged)"));
check("the terminal sees the lukewarm marker too", stanceParams.params.html.includes("\u{1F7E0} (lukewarm)"));
check(
	"an unmarked option reaches the native tool with its description untouched",
	stanceParams.params.html.includes("also no strong view"),
);
check("neutral descriptions are untouched", stanceParams.params.html.includes("no strong view"));
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
		`${badgeLineOf(st.id)}\nTask: diesel [${record(st.id).tag}] | Model: openai/gpt-5.6-sol | Tmux: not attached`,
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
				options: [askOpt("take this"), { ...askOpt("avoid this"), discouraged: true }],
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

// A turn that ends on a question the user can only see in the terminal is blocked once, and the
// block names the two channels that reach Telegram instead of letting the question slip past.
rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
const qs = spawn("01a04250-0000-0000-0000-000000000000", "/home/dev/work/sqlitegis");
qs.ctx.sessionManager.getBranch = () => [
	{
		type: "message",
		message: { role: "assistant", content: [{ type: "text", text: "So, should I rename the column or keep it?" }] },
	},
];
await qs.fire("session_start");
const qsStop = await qs.fire("session_stop");
await settle(150);
const qsBlock = qsStop.find((r) => r?.decision === "block");
check("a turn ending on a bare terminal question is blocked", qsBlock !== undefined);
check(
	"the block points at the ask tool and notify_status",
	qsBlock?.reason.includes("ask tool") && qsBlock?.reason.includes("notify_status"),
);
check("the block forbids answering your own question", qsBlock?.reason.includes("Do not answer your own question"));
check(
	"after the block the question still reaches Telegram as a reply-wanted notice",
	lastCall("sendMessage").body.text.includes("\u{1F7E0}") &&
		lastCall("sendMessage").body.text.includes("rename the column"),
);

// A question the agent already answered itself in the same paragraph does not end on a question, so
// it must not trip the gate and prompt the agent to re-ask a settled decision.
const qa = spawn("01a04260-0000-0000-0000-000000000000", "/home/dev/work/sqlitegis");
qa.ctx.sessionManager.getBranch = () => [
	{
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "Should I rename the column?\nOn reflection I kept it and moved on." }],
		},
	},
];
await qa.fire("session_start");
const qaStop = await qa.fire("session_stop");
await settle(150);
const qaBlock = qaStop.find((r) => r?.decision === "block");
check(
	"a self-answered question does not trip the question gate",
	qaBlock !== undefined && !qaBlock.reason.includes("Do not answer your own question"),
);
check(
	"a self-answered question gets the ordinary green finish",
	lastCall("sendMessage").body.text.includes("\u{1F7E2}") && lastCall("sendMessage").body.text.includes("moved on"),
);

// A long final paragraph is truncated for display, but the question that ends it must still trip the
// gate: detection runs on the raw tail, truncation only shapes the message body.
const lq = spawn("01a04270-0000-0000-0000-000000000000", "/home/dev/work/sqlitegis");
const longQuestion = `${"context ".repeat(120)}so, should I proceed?`;
lq.ctx.sessionManager.getBranch = () => [
	{ type: "message", message: { role: "assistant", content: [{ type: "text", text: longQuestion }] } },
];
await lq.fire("session_start");
const lqStop = await lq.fire("session_stop");
await settle(150);
const lqBlock = lqStop.find((r) => r?.decision === "block");
check(
	"a long question past the display cap still trips the gate",
	lqBlock?.reason.includes("Do not answer your own question"),
);
check(
	"the truncated reply-wanted body keeps the light and retains the trailing question",
	lastCall("sendMessage").body.text.includes("\u{1F7E0}") &&
		lastCall("sendMessage").body.text.includes("...") &&
		lastCall("sendMessage").body.text.includes("proceed?"),
);

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
		{ questions: [{ id: "q", question: "ok?", options: askOpts("yes") }] },
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
const blockReason = firstStop.find((r) => r?.decision === "block").reason;
check(
	"the block requires self-contained phone choices",
	blockReason.includes("answerable from a phone") &&
		blockReason.includes("what choosing it does or costs") &&
		blockReason.includes("an option with no description is refused") &&
		blockReason.includes("Never use only a phase number or letter"),
);
check(
	"notify_status requires self-contained phone choices",
	rs.tools.get("notify_status").description.includes("answerable from a phone") &&
		rs.tools.get("notify_status").description.includes("what choosing it does or costs") &&
		rs.tools.get("notify_status").description.includes("an option with no description is refused") &&
		rs.tools.get("notify_status").description.includes("Never use only a phase number or letter"),
);
check(
	"the block and notify_status both ask for the actor by name instead of I or you",
	blockReason.includes('"Agent will') &&
		blockReason.includes("never I, me, you") &&
		rs.tools.get("notify_status").description.includes('"Agent will') &&
		rs.tools.get("notify_status").description.includes("never I, me, you"),
);
check(
	"the block holds next steps to the long-term standard",
	blockReason.includes("finishes the work properly") &&
		blockReason.includes("effort is never a reason") &&
		blockReason.includes("leaves a known defect"),
);
check(
	"notify_status carries the same long-term standard",
	rs.tools.get("notify_status").description.includes("finishes the work properly") &&
		rs.tools.get("notify_status").description.includes("effort is never a reason") &&
		rs.tools.get("notify_status").description.includes("leaves a known defect"),
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
		{ summary: "Migration rewritten and **all 14 tests pass**. Nothing pending.", urgency: "green", effect: "none" },
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
	.execute("n4", { summary: "   ", urgency: "green", effect: "none" }, undefined, undefined, rs.ctx);
check("an empty summary is rejected", empty.isError === true);
const blockedAgain = await rs.fire("session_stop");
check(
	"a new turn requires a new summary",
	blockedAgain.some((r) => r?.decision === "block"),
);

heading("turn ends that wait on a background job");
const JOB_WAIT = { willContinue: true, awaitingAsyncWork: true };
{
	rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
	const bj = spawn("01a04450-0000-7000-8000-000000000000", "/home/dev/work/ciwatch");
	await bj.fire("session_start");

	await bj.fire("input");
	await bj.tools
		.get("notify_status")
		.execute(
			"bj1",
			{ summary: "Pushed, CI still running.", urgency: "green", effect: "none" },
			undefined,
			undefined,
			bj.ctx,
		);
	const sentBefore = called("sendMessage").length;
	await bj.fire("agent_end", JOB_WAIT);
	await settle(150);
	const waitMsg = lastCall("sendMessage").body;
	check(
		"a turn that ends waiting on a background job sends its recorded status at once",
		called("sendMessage").length === sentBefore + 1 && waitMsg.text.includes("CI still running"),
	);
	check("the message says the session waits on a background job", waitMsg.text.includes("waits on a background job"));
	check(
		"a green status sent while a job runs offers no Close buttons",
		waitMsg.text.includes("CI still running") && (waitMsg.reply_markup?.inline_keyboard ?? []).flat().length === 0,
	);
	await bj.fire("agent_start");
	await bj.fire("session_stop");
	await settle(150);
	check(
		"the stop after the job wakes the session does not send the status twice",
		!called("sendMessage")
			.slice(sentBefore + 1)
			.some((c) => String(c.body.text).includes("CI still running")),
	);

	await bj.fire("input");
	await bj.tools.get("notify_status").execute(
		"bj2",
		{
			summary: "Pushed, CI running.",
			urgency: "orange",
			question: "Reword the commit?",
			options: opts("Reword", "Leave it"),
		},
		undefined,
		undefined,
		bj.ctx,
	);
	await bj.fire("agent_end", JOB_WAIT);
	await settle(150);
	const choiceMsg = lastCall("sendMessage").body;
	check(
		"a recorded choice goes out as a question when the turn ends waiting on a job",
		choiceMsg.text.includes("Reword the commit?") &&
			choiceMsg.text.includes("waits on a background job") &&
			choiceMsg.reply_markup.inline_keyboard.flat().length === 2,
	);

	await bj.fire("input");
	await bj.tools.get("notify_status").execute(
		"bj3",
		{
			summary: "All green, nothing left.",
			urgency: "green",
			effect: "none",
			question: "Anything else?",
			options: opts("Stop", "Go on"),
		},
		undefined,
		undefined,
		bj.ctx,
	);
	await bj.fire("agent_end", JOB_WAIT);
	await settle(150);
	check(
		"a green choice sent while a job runs offers no Close buttons",
		lastCall("sendMessage").body.text.includes("All green, nothing left") &&
			lastCall("sendMessage").body.reply_markup.inline_keyboard.flat().length === 2,
	);

	await bj.fire("input");
	const silentBefore = called("sendMessage").length;
	const ends = await bj.fire("agent_end", JOB_WAIT);
	await settle(150);
	const fallback = lastCall("sendMessage").body.text;
	check(
		"a turn waiting on a job with nothing recorded sends the fallback message",
		!ends.some((r) => r?.decision === "block") &&
			called("sendMessage").length === silentBefore + 1 &&
			fallback.includes("Turn finished") &&
			fallback.includes("waits on a background job"),
	);
	const laterStop = await bj.fire("session_stop");
	check(
		"the terminal stop after a job wait still asks for a status",
		laterStop.some((r) => r?.decision === "block"),
	);

	await bj.fire("input");
	await bj.tools
		.get("notify_status")
		.execute(
			"bj4",
			{ summary: "Continuing on my own.", urgency: "green", effect: "none" },
			undefined,
			undefined,
			bj.ctx,
		);
	const continueBefore = called("sendMessage").length;
	await bj.fire("agent_end", { willContinue: true });
	await settle(150);
	check(
		"an automatic continuation sends nothing and keeps the status for its stop",
		called("sendMessage").length === continueBefore,
	);
	await bj.fire("session_stop");
	await settle(150);
	check("the kept status goes out at the stop", lastCall("sendMessage").body.text.includes("Continuing on my own"));

	await bj.fire("input");
	const plainBefore = called("sendMessage").length;
	await bj.fire("agent_end");
	await settle(150);
	check("a plain agent end sends nothing by itself", called("sendMessage").length === plainBefore);
	await bj.fire("session_shutdown");
}

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
		options: opts("Continue", "Review the diff", "Stop here"),
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
		`${badgeLineOf(tq.id)}\nTask: sqlitegis [${record(tq.id).tag}] | Model: openai/gpt-5.6-sol | Tmux: not attached`,
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
		{ summary: "First.", urgency: "orange", question: "Use the first choice?", options: opts("A", "B") },
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
		{ summary: "Second.", urgency: "orange", question: "Use the second choice?", options: opts("C", "D") },
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
		`${badgeLineOf(tq.id)}\nTask: sqlitegis [${record(tq.id).tag}] | Model: openai/gpt-5.6-sol | Tmux: not attached`,
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
killProcessOf(tq.id);
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
		`${badgeLineOf(tq.id)}\nTask: sqlitegis [${record(tq.id).tag}] | Model: openai/gpt-5.6-sol | Tmux: not attached`,
	) &&
		resumedRetired.body.text.includes("Use the second choice?") &&
		resumedRetired.body.text.includes("Chosen:") &&
		resumedRetired.body.text.includes("D"),
);
await resumed.fire("session_shutdown");

// A terminal reply while a choice question stands on Telegram must close it.
await tq.fire("input");
await tq.tools
	.get("notify_status")
	.execute(
		"q5",
		{ summary: "Choose.", urgency: "orange", options: opts("Go on", "Halt") },
		undefined,
		undefined,
		tq.ctx,
	);
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

// A press whose option index cannot be read closes the question without starting a turn.
await tq.fire("input");
await tq.tools
	.get("notify_status")
	.execute(
		"q5b",
		{ summary: "Choose once more.", urgency: "orange", options: opts("Keep", "Drop") },
		undefined,
		undefined,
		tq.ctx,
	);
await tq.fire("session_stop");
await settle(150);
const unreadableStanding = record(tq.id).standing;
const steersBeforeUnreadable = tq.steers.length;
writeFileSync(
	join(inboxOf(tq.id), "996.json"),
	JSON.stringify({ kind: "callback", value: `c:${unreadableStanding.id}:9` }),
);
await tq.pump(250);
check(
	"a press with an unreadable option closes the question and starts no turn",
	tq.steers.length === steersBeforeUnreadable &&
		record(tq.id).standing === null &&
		called("editMessageText").some(
			(c) => c.body.message_id === unreadableStanding.messageId && c.body.text.includes("This question is closed."),
		),
);

await tq.tools
	.get("notify_status")
	.execute(
		"q6",
		{ summary: "Choose again.", urgency: "orange", options: opts("Proceed", "Wait") },
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
	.execute(
		"q4",
		{ summary: "x", urgency: "green", effect: "none", options: opts("only-one") },
		undefined,
		undefined,
		tq.ctx,
	);
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
				options: askOpts(
					"Yes",
					"No",
					"Skip",
					"Continue",
					"Review the diff",
					"A very long deliberate label that needs its own row",
				),
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
killProcessOf(rr1.id);
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

heading("durable pin retirement");
{
	const stateDir = join(root, "notify-telegram");
	const crashDir = join(stateDir, "crashed");
	const start = async () => {
		rmSync(join(stateDir, "poller.lock"), { force: true });
		const session = spawn(crypto.randomUUID(), "/home/dev/work/durable-pin");
		await session.fire("session_start");
		return session;
	};
	const red = async (session) => {
		await session.tools
			.get("notify_status")
			.execute(
				"durable-red",
				{ summary: "Decision needed.", urgency: "red", options: opts("Agent will proceed", "Agent will wait") },
				undefined,
				undefined,
				session.ctx,
			);
		await session.fire("session_stop");
		await settle();
		return record(session.id).pinned;
	};
	const abandon = (session, heartbeat) =>
		writeFileSync(
			join(sessionsDir, `${session.id}.json`),
			JSON.stringify({ ...record(session.id), heartbeat, boot: "previous-machine-boot" }),
		);
	for (const recovery of ["replacement", "restart"]) {
		const session = await start();
		const oldId = await red(session);
		api.failMethods = ["unpinChatMessage"];
		api.failStatus = 429;
		await session.fire("agent_start");
		await settle();
		if (recovery === "restart") await session.fire("session_shutdown");
		api.failMethods = [];
		api.failStatus = undefined;
		const owner = recovery === "restart" ? await start() : session;
		const currentId = await red(owner);
		owner.heartbeat();
		await settle(150);
		check(
			`a refused status unpin recovers across ${recovery} without unpinning current work`,
			!api.pinned.has(oldId) && api.pinned.has(currentId),
		);
		await owner.fire("session_shutdown");
	}
	{
		const session = await start();
		const id = await red(session);
		abandon(session, 0);
		const owner = await start();
		await settle(150);
		check(
			"reaping interrupted shutdown retires its pin before losing ownership",
			!existsSync(join(sessionsDir, `${session.id}.json`)) && !api.pinned.has(id),
		);
		await owner.fire("session_shutdown");
	}
	{
		const session = await start();
		const id = await red(session);
		abandon(session, Date.now() - 60_000);
		const owner = await start();
		const crashPath = join(crashDir, `${session.id}.json`);
		const crash = JSON.parse(readFileSync(crashPath, "utf8"));
		owner.heartbeat();
		await settle();
		const batch = JSON.parse(readFileSync(join(crashDir, "batches", `${crash.batch}.json`), "utf8"));
		api.failMethods = ["unpinChatMessage"];
		api.failStatus = 429;
		api.queued = [
			{
				update_id: 88001,
				callback_query: {
					id: "durable-dismiss",
					from: { id: CHAT },
					message: { message_id: batch.messageId, chat: { id: CHAT } },
					data: `kd:${crash.batch}`,
				},
			},
		];
		await owner.pump(150);
		await owner.fire("session_shutdown");
		api.failMethods = [];
		api.failStatus = undefined;
		const successor = await start();
		successor.heartbeat();
		await settle(150);
		check(
			"a refused crash-dismissal unpin recovers after owner replacement",
			JSON.parse(readFileSync(crashPath, "utf8")).dismissed && !api.pinned.has(id),
		);
		await successor.fire("session_shutdown");
	}
	{
		const session = await start();
		const gate = Promise.withResolvers();
		api.pinMessageGate = gate.promise;
		await session.tools
			.get("notify_status")
			.execute("delayed-pin", { summary: "Delayed decision.", urgency: "red" }, undefined, undefined, session.ctx);
		await session.fire("session_stop");
		await settle();
		const id = record(session.id).pinned;
		await session.fire("agent_start");
		api.failMethods = ["unpinChatMessage"];
		api.failStatus = 429;
		api.pinMessageGate = null;
		gate.resolve();
		await settle();
		await session.fire("session_shutdown");
		api.failMethods = [];
		api.failStatus = undefined;
		const successor = await start();
		await settle(150);
		check("a refused stale-pin compensation survives shutdown", !api.pinned.has(id));
		await successor.fire("session_shutdown");
	}
	{
		const fixtureClock = clockSkew;
		const session = await start();
		const id = await red(session);
		abandon(session, 0);
		writeFileSync(
			join(sessionsDir, `${session.id}.json`),
			JSON.stringify({ ...record(session.id), pinPendingUntil: Date.now() + 60_000 }),
		);
		const owner = await start();
		await settle();
		check("an unsettled pin request fences recovered retirement", api.pinned.has(id));
		jump(61_000);
		owner.heartbeat();
		await settle(150);
		check("the recovered retirement runs after the pin request deadline", !api.pinned.has(id));
		await owner.fire("session_shutdown");
		clockSkew = fixtureClock;
	}
	{
		const session = await start();
		const id = await red(session);
		const callback = lastCall("sendMessage").body.reply_markup.inline_keyboard[0][0].callback_data;
		const fetchBefore = globalThis.fetch;
		globalThis.fetch = async (url, init) => {
			if (String(url).endsWith("/unpinChatMessage")) throw new TypeError("fetch failed");
			return await fetchBefore(url, init);
		};
		writeFileSync(
			join(inboxOf(session.id), "transport-answer.json"),
			JSON.stringify({ kind: "callback", value: callback }),
		);
		await session.pump(150);
		globalThis.fetch = fetchBefore;
		check(
			"an unpin transport error does not swallow the chosen answer",
			session.steers.some((entry) => entry.text === "Agent will proceed") &&
				called("editMessageText").some((entry) => entry.body.message_id === id && entry.body.text.includes("Chosen:")),
		);
		session.heartbeat();
		await settle(150);
		check("cleanup recovers after the unpin transport error", !api.pinned.has(id));
		await session.fire("session_shutdown");
	}
	{
		// A refusal that is neither a throttle nor a server error would come back word for word, so the
		// journal gives the unpin up after one attempt instead of repeating it on every heartbeat.
		const session = await start();
		const id = await red(session);
		api.failMethods = ["unpinChatMessage"];
		api.failDescription = "Bad Request: not enough rights to manage pinned messages in the chat";
		await session.fire("agent_start");
		await settle();
		const attempts = () => called("unpinChatMessage").filter((c) => c.body.message_id === id).length;
		const afterFirst = attempts();
		session.heartbeat();
		await settle(150);
		session.heartbeat();
		await settle(150);
		api.failMethods = [];
		api.failDescription = undefined;
		check("an unpin refused for good is attempted once and given up", afterFirst >= 1 && attempts() === afterFirst);
		await session.fire("session_shutdown");
	}
	for (const restored of [false, true]) {
		const session = await start();
		const id = await red(session);
		abandon(session, Date.now() - 60_000);
		const owner = await start();
		await owner.fire("session_shutdown");
		let adopted = null;
		if (restored) {
			adopted = spawn(session.id, session.ctx.cwd);
			await adopted.fire("session_start");
		}
		const crashPath = join(crashDir, `${session.id}.json`);
		const expired = new Date(Date.now() - 8 * 24 * 3_600_000);
		utimesSync(crashPath, expired, expired);
		const successor = await start();
		await settle(150);
		check(
			`crash expiry ${restored ? "preserves an adopted" : "retires an abandoned"} pin`,
			!existsSync(crashPath) && api.pinned.has(id) === restored,
		);
		if (adopted !== null) await adopted.fire("session_shutdown");
		await successor.fire("session_shutdown");
	}
}

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
// A turn lasts minutes; typing promises a message in seconds, so the claim after a reply is bounded.
jump(31_000);
await ux.pump(150);
check("a turn running on past the grace stops typing", called("sendChatAction").length === typingBefore + 1);
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
// A message actually going out is the honest case, turn or no turn.
jump(31_000);
const slowSend = Promise.withResolvers();
api.sendMessageGate = slowSend.promise;
writeFileSync(join(inboxOf(ux.id), "6150.json"), JSON.stringify({ kind: "command", value: "status" }));
await ux.pump(150);
await ux.pump(150);
check("a message still going out types", called("sendChatAction").length === typingBefore + 4);
slowSend.resolve();
api.sendMessageGate = null;
await settle(150);
jump(6_000);
await ux.pump(150);
check("typing stops once the message has landed", called("sendChatAction").length === typingBefore + 4);
writeFileSync(join(inboxOf(ux.id), "6151.json"), JSON.stringify({ kind: "command", value: "status" }));
await ux.pump(150);
await ux.pump(150);
check("a send that lands inside the tick never flickers typing", called("sendChatAction").length === typingBefore + 4);

// A text reply to the question message answers it, no button needed.
const uxState = {};
const uxRun = ux.tools
	.get("ask")
	.execute(
		"ux1",
		{ questions: [{ id: "q", question: "Deploy how?", options: askOpts("Canary", "Full") }] },
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
	.execute(
		"ux2",
		{ summary: "Pick one.", urgency: "orange", options: opts("Go", "Stop") },
		undefined,
		undefined,
		ux.ctx,
	);
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
		{ id: "d1", question: "First?", options: askOpts("yes", "no") },
		{ id: "d2", question: "Second?", options: askOpts("alpha", "beta") },
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

// An ask card still in flight when its process dies never reaches the record, so the reaper
// never closes it, and the first tap on the dead card is where it is retired.
{
	// The jumps in this section aged the poller lock past its stale window, so a fresh heartbeat
	// keeps it with the live session rather than handing it to the one that spawns next.
	ux.heartbeat();
	const orphan = spawn("01a04801-0000-0000-0000-0000-000000000000", "/home/dev/work/orphan-card");
	await orphan.fire("session_start");
	void orphan.tools.get("ask").execute("orphan-ask", singleQuestion, undefined, undefined, stubbornCtx(orphan.ctx, {}));
	await settle(150);
	const orphanCardId = api.nextMessage - 1;
	const orphanTap = lastCall("sendMessage").body.reply_markup.inline_keyboard[0][0].callback_data;
	rmSync(join(sessionsDir, `${orphan.id}.json`), { force: true });
	const liveStrips = () =>
		called("editMessageReplyMarkup").filter(
			(c) => c.body.message_id === 7 && c.body.reply_markup.inline_keyboard.length === 0,
		).length;
	const liveStripsBefore = liveStrips();
	api.queued = [
		{
			update_id: 6125,
			callback_query: {
				id: "cborphan",
				data: orphanTap,
				from: { id: CHAT },
				message: { message_id: orphanCardId, chat: { id: CHAT } },
			},
		},
		{
			update_id: 6126,
			callback_query: {
				id: "cblive",
				data: `o:${record(ux.id).tag}-n2:0`,
				from: { id: CHAT },
				message: { message_id: 7, chat: { id: CHAT } },
			},
		},
	];
	await ux.pump(250);
	await ux.pump(250);
	const orphanToast = called("answerCallbackQuery").find((c) => c.body.callback_query_id === "cborphan");
	check("a tap on a dead card says the session is gone", orphanToast?.body.text === "That question's session is gone.");
	check(
		"the dead card loses its buttons at first touch",
		called("editMessageReplyMarkup").some(
			(c) => c.body.message_id === orphanCardId && c.body.reply_markup.inline_keyboard.length === 0,
		),
	);
	const liveToast = called("answerCallbackQuery").find((c) => c.body.callback_query_id === "cblive");
	check("a tap on a live card still answers as sent", liveToast?.body.text === "Sent to that session.");
	check("and it keeps its buttons", liveStrips() === liveStripsBefore);
}

// hidequestions closes the open buttons.
await ux.fire("input");
await ux.tools
	.get("notify_status")
	.execute(
		"ux3",
		{ summary: "Choose.", urgency: "orange", question: "Which hidden choice?", options: opts("A", "B") },
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
		`\u{1F535} ${badgeLineOf(ux.id)}\nTask: pgvector [${record(ux.id).tag}] | Model: openai/gpt-5.6-sol | Tmux: not attached`,
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
		`${badgeLineOf(ux.id)}\nTask: pgvector [${record(ux.id).tag}] | Model: openai/gpt-5.6-sol | Tmux: not attached`,
	) &&
		hiddenStanding.body.text.includes("Which hidden choice?") &&
		hiddenStanding.body.text.includes("Question hidden"),
);

await ux.tools
	.get("notify_status")
	.execute("ux-hide", { summary: "Done.", urgency: "green", effect: "none" }, undefined, undefined, ux.ctx);
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
		{ questions: [{ id: "h", question: "Hide me?", options: askOpts("yes", "no") }] },
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

// Several omp sessions split into one window must each appear; a window-centric read hides all but the active pane.
{
	writeFileSync(
		fakeTmux,
		`#!/bin/sh\nif [ "$1" = list-panes ]; then\n\tprintf 'work\\t3\\t0\\t\\t\u03C0 \u280B Session A\\n'\n\tprintf 'work\\t3\\t0\\t\\t\u03C0 ! Session B\\n'\nelif [ "$1" = list-windows ]; then\n\tprintf 'work\\t3\\t0\\t\\t\u03C0 \u280B Session A\\n'\nfi\n`,
		{ mode: 0o755 },
	);
	process.env.PATH = `${fakeBin}:${realPath}`;
	process.env.TMUX = "/tmp/fake-tmux,1,0";
	api.queued = [{ update_id: 615, message: { message_id: 86, date: 1, chat: { id: CHAT }, text: "/fleet" } }];
	await ux.pump(250);
	const cohab = lastCall("sendMessage").body;
	check(
		"fleet lists every co-located omp pane, not just the window's active one",
		typeof cohab.text === "string" &&
			cohab.text.includes("Session A") &&
			cohab.text.includes("Session B") &&
			cohab.text.includes("1 working, 1 waiting for you"),
	);
	delete process.env.TMUX;
	process.env.PATH = realPath;
}

// A window-level bell must not mark every co-located pane finished; only a lone pane in a belled window is finished.
{
	writeFileSync(
		fakeTmux,
		`#!/bin/sh\nif [ "$1" = list-panes ]; then\n\tprintf 'work\\t3\\t1\\t\\t\u03C0 > Session C\\n'\n\tprintf 'work\\t3\\t1\\t\\t\u03C0 > Session D\\n'\n\tprintf 'work\\t4\\t1\\t\\t\u03C0 > Session E\\n'\nfi\n`,
		{ mode: 0o755 },
	);
	process.env.PATH = `${fakeBin}:${realPath}`;
	process.env.TMUX = "/tmp/fake-tmux,1,0";
	api.queued = [{ update_id: 616, message: { message_id: 87, date: 1, chat: { id: CHAT }, text: "/fleet" } }];
	await ux.pump(250);
	const belled = lastCall("sendMessage").body;
	check(
		"a shared window's bell finishes only its lone pane, leaving co-located panes idle",
		typeof belled.text === "string" &&
			belled.text.includes("1 finished, 2 idle") &&
			!belled.text.includes("3 finished"),
	);
	delete process.env.TMUX;
	process.env.PATH = realPath;
}
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

heading("standing publication generations");
rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
// A late standing send may only retire its own message. The standing slot and the red pin belong to the newest turn end.
{
	const session = spawn(crypto.randomUUID(), "/home/dev/work/standing-late-success");
	await session.fire("session_start");
	const gate = Promise.withResolvers();
	api.sendMessageGate = gate.promise;
	await session.tools
		.get("notify_status")
		.execute(
			"stand-late-success",
			{ summary: "First decision.", urgency: "red", options: opts("Agent will continue", "Agent will wait") },
			undefined,
			undefined,
			session.ctx,
		);
	await session.fire("session_stop");
	await settle();
	await session.fire("agent_start");
	api.sendMessageGate = null;
	await session.tools
		.get("notify_status")
		.execute(
			"stand-late-success-new",
			{ summary: "Latest decision.", urgency: "red", options: opts("Agent will proceed", "Agent will pause") },
			undefined,
			undefined,
			session.ctx,
		);
	const q2 = api.nextMessage;
	await session.fire("session_stop");
	await settle();
	const press = lastCall("sendMessage").body.reply_markup.inline_keyboard[0][0].callback_data;
	const q1 = api.nextMessage;
	gate.resolve();
	await settle(150);
	check("a late standing send leaves the newer question standing", record(session.id).standing?.messageId === q2);
	check(
		"a late standing send leaves the newer red pin in place",
		api.pinned.has(q2) && !api.pinned.has(q1) && record(session.id).pinned === q2,
	);
	const retired = called("editMessageText").findLast((c) => c.body.message_id === q1);
	check(
		"a late standing message is retired under its own head without buttons",
		retired?.body.text.includes("Superseded by a newer question.") &&
			retired.body.reply_markup.inline_keyboard.length === 0,
	);
	writeFileSync(join(inboxOf(session.id), "1101.json"), JSON.stringify({ kind: "callback", value: press }));
	await session.pump(250);
	check(
		"the newer question is answerable and its answer unpins its own message",
		!api.pinned.has(q2) &&
			record(session.id).pinned === null &&
			record(session.id).standing === null &&
			session.steers.some((s) => s.text === "Agent will proceed"),
	);
	await session.fire("session_shutdown");
}
{
	const session = spawn(crypto.randomUUID(), "/home/dev/work/standing-late-refusal");
	await session.fire("session_start");
	api.failMethods = ["sendMessage"];
	api.failStatus = 429;
	api.failRetryAfter = 1;
	await session.tools
		.get("notify_status")
		.execute(
			"stand-late-refusal",
			{ summary: "First decision.", urgency: "red", options: opts("Agent will continue", "Agent will wait") },
			undefined,
			undefined,
			session.ctx,
		);
	await session.fire("session_stop");
	await settle();
	// The older send waits out its rate-limit retry while the replacement turn lands first. This case is about a
	// refusal arriving after its replacement, so the shared deadline the first 429 wrote counts as passed.
	api.failMethods = [];
	api.failStatus = undefined;
	api.failRetryAfter = undefined;
	rmSync(join(root, "notify-telegram/throttle.json"), { force: true });
	await session.fire("agent_start");
	await session.tools
		.get("notify_status")
		.execute(
			"stand-late-refusal-new",
			{ summary: "Latest decision.", urgency: "red", options: opts("Agent will proceed", "Agent will pause") },
			undefined,
			undefined,
			session.ctx,
		);
	const q2 = api.nextMessage;
	await session.fire("session_stop");
	await settle();
	const press = lastCall("sendMessage").body.reply_markup.inline_keyboard[0][0].callback_data;
	check(
		"a replacement question is published while the older send retries",
		record(session.id).standing?.messageId === q2 && api.pinned.has(q2),
	);
	api.failMethods = ["sendMessage"];
	await settle(1600);
	api.failMethods = [];
	await settle(50);
	check(
		"a late standing refusal leaves the newer question standing",
		record(session.id).standing?.messageId === q2 && record(session.id).pinned === q2 && api.pinned.has(q2),
	);
	writeFileSync(join(inboxOf(session.id), "1102.json"), JSON.stringify({ kind: "callback", value: press }));
	await session.pump(250);
	check(
		"the newer question is answerable after the late refusal",
		!api.pinned.has(q2) &&
			record(session.id).pinned === null &&
			record(session.id).standing === null &&
			session.steers.some((s) => s.text === "Agent will proceed"),
	);
	await session.fire("session_shutdown");
}
{
	// A turn-end question Telegram throttles past the one retry the call layer makes is sent again once the
	// throttle passes, because it is the only message saying the turn ended and what it asks.
	const session = spawn(crypto.randomUUID(), "/home/dev/work/standing-throttled");
	await session.fire("session_start");
	api.failMethods = ["sendMessage"];
	api.failStatus = 429;
	api.failRetryAfter = 1;
	api.failDescription = "Too Many Requests: retry after 1";
	await session.tools
		.get("notify_status")
		.execute(
			"stand-throttled",
			{ summary: "Throttled decision.", urgency: "orange", options: opts("Agent will ship", "Agent will wait") },
			undefined,
			undefined,
			session.ctx,
		);
	await session.fire("session_stop");
	// Past the call layer's own retry at 1.5 s, so only a later attempt can still deliver it.
	await settle(2000);
	api.failMethods = [];
	api.failStatus = undefined;
	api.failRetryAfter = undefined;
	api.failDescription = undefined;
	await settle(1500);
	const delivered = called("sendMessage").filter((c) => String(c.body.text).includes("Throttled decision."));
	check(
		"a throttled turn-end question is delivered once the throttle passes",
		delivered.length >= 3 && record(session.id).standing?.messageId === api.nextMessage - 1,
	);
	await session.fire("session_shutdown");
	rmSync(join(root, "notify-telegram/throttle.json"), { force: true });
}
{
	// A throttled status gives way to the user moving on, and is never sent after it.
	const session = spawn(crypto.randomUUID(), "/home/dev/work/status-throttled-input");
	await session.fire("session_start");
	api.failMethods = ["sendMessage"];
	api.failStatus = 429;
	api.failRetryAfter = 1;
	api.failDescription = "Too Many Requests: retry after 1";
	await session.tools
		.get("notify_status")
		.execute(
			"status-throttled",
			{ summary: "Superseded status.", urgency: "green", effect: "none" },
			undefined,
			undefined,
			session.ctx,
		);
	await session.fire("session_stop");
	await settle(2000);
	await session.fire("input");
	api.failMethods = [];
	api.failStatus = undefined;
	api.failRetryAfter = undefined;
	api.failDescription = undefined;
	const attemptsAtInput = called("sendMessage").filter((c) =>
		String(c.body.text).includes("Superseded status."),
	).length;
	await settle(1500);
	check(
		"a throttled status is not sent after the user moves on",
		called("sendMessage").filter((c) => String(c.body.text).includes("Superseded status.")).length === attemptsAtInput,
	);
	await session.fire("session_shutdown");
	rmSync(join(root, "notify-telegram/throttle.json"), { force: true });
}
{
	// A refusal that is not a throttle or a server error would be repeated word for word, so it is final.
	const session = spawn(crypto.randomUUID(), "/home/dev/work/status-refused");
	await session.fire("session_start");
	api.failMethods = ["sendMessage"];
	api.failStatus = 400;
	api.failDescription = "Bad Request: chat not found";
	await session.tools
		.get("notify_status")
		.execute(
			"status-refused",
			{ summary: "Refused status.", urgency: "green", effect: "none" },
			undefined,
			undefined,
			session.ctx,
		);
	await session.fire("session_stop");
	await settle(2500);
	api.failMethods = [];
	api.failStatus = undefined;
	api.failDescription = undefined;
	check(
		"a status refused for good is not sent again",
		called("sendMessage").filter((c) => String(c.body.text).includes("Refused status.")).length === 1,
	);
	await session.fire("session_shutdown");
}
{
	const session = spawn(crypto.randomUUID(), "/home/dev/work/standing-late-input");
	await session.fire("session_start");
	const gate = Promise.withResolvers();
	api.sendMessageGate = gate.promise;
	await session.tools
		.get("notify_status")
		.execute(
			"stand-late-input",
			{ summary: "Decision needed.", urgency: "red", options: opts("Agent will continue", "Agent will wait") },
			undefined,
			undefined,
			session.ctx,
		);
	const q1 = api.nextMessage;
	await session.fire("session_stop");
	await settle();
	await session.fire("input");
	await settle();
	gate.resolve();
	await settle(150);
	check("input while the standing send is pending leaves no standing question", record(session.id).standing === null);
	const retired = called("editMessageText").findLast((c) => c.body.message_id === q1);
	check(
		"the late standing message is retired as no longer active",
		retired?.body.text.includes("This question is no longer active.") &&
			retired.body.reply_markup.inline_keyboard.length === 0,
	);
	check("a lifecycle retirement pins nothing", !api.pinned.has(q1) && record(session.id).pinned === null);
	await session.fire("session_shutdown");
}
{
	const session = spawn(crypto.randomUUID(), "/home/dev/work/standing-late-shutdown");
	await session.fire("session_start");
	const gate = Promise.withResolvers();
	api.sendMessageGate = gate.promise;
	await session.tools
		.get("notify_status")
		.execute(
			"stand-late-shutdown",
			{ summary: "Decision needed.", urgency: "red", options: opts("Agent will continue", "Agent will wait") },
			undefined,
			undefined,
			session.ctx,
		);
	const q1 = api.nextMessage;
	await session.fire("session_stop");
	await settle();
	let shutdownFinished = false;
	const shutdown = session.fire("session_shutdown").then(() => {
		shutdownFinished = true;
	});
	await settle();
	check("shutdown is not held by a standing send that is still in flight", shutdownFinished === true);
	gate.resolve();
	await shutdown;
	await settle(150);
	check(
		"shutdown while the standing send is pending leaves no standing question",
		record(session.id).standing === null,
	);
	const retired = called("editMessageText").findLast((c) => c.body.message_id === q1);
	check(
		"the late standing message is retired as no longer active",
		retired?.body.text.includes("This question is no longer active.") &&
			retired.body.reply_markup.inline_keyboard.length === 0,
	);
	check("a shutdown retirement pins nothing", !api.pinned.has(q1) && record(session.id).pinned === null);
}

heading("retired status pins");
for (const withOptions of [false, true]) {
	for (const delay of ["send", "pin"]) {
		for (const event of ["input", "agent_start", "session_shutdown"]) {
			const session = spawn(crypto.randomUUID(), "/home/dev/work/pin-retirement");
			await session.fire("session_start");
			const gate = Promise.withResolvers();
			if (delay === "send") api.sendMessageGate = gate.promise;
			else api.pinMessageGate = gate.promise;
			const firstMessage = api.nextMessage;
			await session.tools.get("notify_status").execute(
				`pin-${event}-${delay}`,
				{
					summary: "Waiting for a decision.",
					urgency: "red",
					...(withOptions ? { options: opts("Agent will continue", "Agent will wait") } : {}),
				},
				undefined,
				undefined,
				session.ctx,
			);
			await session.fire("session_stop");
			await settle();
			let retirementFinished = false;
			const retirement = session.fire(event).then(() => {
				retirementFinished = true;
			});
			await settle();
			if (event === "session_shutdown" && delay === "pin") {
				check(
					`shutdown waits for the pending ${withOptions ? "standing" : "plain"} pin to be retired`,
					!retirementFinished,
				);
			}
			api.sendMessageGate = null;
			api.pinMessageGate = null;
			gate.resolve();
			await retirement;
			await settle(150);
			check(
				`${event} leaves no ${withOptions ? "standing" : "plain"} red pin after a delayed ${delay}`,
				!api.pinned.has(firstMessage) && record(session.id).pinned === null,
			);
			if (event !== "session_shutdown") await session.fire("session_shutdown");
		}
	}
}

for (const urgency of ["orange", "red"]) {
	const session = spawn(crypto.randomUUID(), "/home/dev/work/pin-replacement");
	await session.fire("session_start");
	const gate = Promise.withResolvers();
	api.pinMessageGate = gate.promise;
	await session.tools
		.get("notify_status")
		.execute(
			"old-pin",
			{ summary: "First decision.", urgency: "red", options: opts("Agent will continue", "Agent will wait") },
			undefined,
			undefined,
			session.ctx,
		);
	await session.fire("session_stop");
	await settle();
	const oldMessage = record(session.id).standing.messageId;
	api.pinMessageGate = null;
	await session.tools
		.get("notify_status")
		.execute(
			"replacement-pin",
			{ summary: "Latest decision.", urgency, options: opts("Agent will proceed", "Agent will pause") },
			undefined,
			undefined,
			session.ctx,
		);
	await session.fire("session_stop");
	await settle();
	const latestMessage = record(session.id).standing.messageId;
	gate.resolve();
	await settle(150);
	check(
		`${urgency} replacement retires the older pin even when its request finishes last`,
		!api.pinned.has(oldMessage) &&
			api.pinned.has(latestMessage) === (urgency === "red") &&
			record(session.id).pinned === (urgency === "red" ? latestMessage : null),
	);
	await session.fire("session_shutdown");
}

{
	const session = spawn(crypto.randomUUID(), "/home/dev/work/pin-answer");
	await session.fire("session_start");
	await session.tools
		.get("notify_status")
		.execute(
			"answered-pin",
			{ summary: "Decision needed.", urgency: "red", options: opts("Agent will continue", "Agent will wait") },
			undefined,
			undefined,
			session.ctx,
		);
	await session.fire("session_stop");
	await settle();
	const messageId = record(session.id).pinned;
	const callback = lastCall("sendMessage").body.reply_markup.inline_keyboard[0][0].callback_data;
	writeFileSync(join(inboxOf(session.id), "pin-answer.json"), JSON.stringify({ kind: "callback", value: callback }));
	await session.pump(150);
	check(
		"answering a red standing question unpins its settled message",
		!api.pinned.has(messageId) && record(session.id).pinned === null,
	);
	await session.fire("session_shutdown");
}

for (const withOptions of [false, true]) {
	const session = spawn(crypto.randomUUID(), "/home/dev/work/shutdown-unpin");
	await session.fire("session_start");
	await session.tools.get("notify_status").execute(
		"shutdown-unpin",
		{
			summary: "Decision needed.",
			urgency: "red",
			...(withOptions ? { options: opts("Agent will continue", "Agent will wait") } : {}),
		},
		undefined,
		undefined,
		session.ctx,
	);
	await session.fire("session_stop");
	await settle();
	const messageId = record(session.id).pinned;
	const gate = Promise.withResolvers();
	api.unpinMessageGate = gate.promise;
	let shutdownFinished = false;
	const shutdown = session.fire("session_shutdown").then(() => {
		shutdownFinished = true;
	});
	await settle();
	check(
		`shutdown waits for the ${withOptions ? "standing" : "plain"} status to be unpinned`,
		!shutdownFinished && api.pinned.has(messageId),
	);
	api.unpinMessageGate = null;
	gate.resolve();
	await shutdown;
	await settle();
	check(
		`shutdown finishes with the ${withOptions ? "standing" : "plain"} status unpinned`,
		!api.pinned.has(messageId) && record(session.id).pinned === null,
	);
}

// A green status plays the effect the agent chose for how the turn went, or none at all.
await ux.tools
	.get("notify_status")
	.execute(
		"ux5",
		{ summary: "All 14 tests pass, nothing remains.", urgency: "green", effect: "fire" },
		undefined,
		undefined,
		ux.ctx,
	);
await ux.fire("session_stop");
await settle(150);
const green = called("sendMessage").findLast(
	(c) => typeof c.body.text === "string" && c.body.text.includes("nothing remains"),
);
check("a green status plays the effect the agent chose", green?.body.message_effect_id === "5104841245755180586");
await ux.tools
	.get("notify_status")
	.execute(
		"ux6",
		{ summary: "The benchmark regressed and nothing more fits here.", urgency: "green", effect: "none" },
		undefined,
		undefined,
		ux.ctx,
	);
await ux.fire("session_stop");
await settle(150);
const sober = called("sendMessage").findLast(
	(c) => typeof c.body.text === "string" && c.body.text.includes("benchmark regressed"),
);
check("a green status with effect none plays nothing", sober !== undefined && !("message_effect_id" in sober.body));
await ux.fire("input");
const effectless = await ux.tools
	.get("notify_status")
	.execute("ux7", { summary: "Done.", urgency: "green" }, undefined, undefined, ux.ctx);
check(
	"a green status without an effect is refused, naming every choice",
	effectless.isError === true &&
		["party", "fire", "thumbs_up", "heart", "thumbs_down", "poop", "none"].every((name) =>
			effectless.content[0].text.includes(`\`${name}\``),
		),
);
const unknownEffect = await ux.tools
	.get("notify_status")
	.execute("ux8", { summary: "Done.", urgency: "green", effect: "confetti" }, undefined, undefined, ux.ctx);
check(
	"an effect Telegram does not have is refused by name",
	unknownEffect.isError === true && unknownEffect.content[0].text.includes('"confetti"'),
);
const orangeEffect = await ux.tools
	.get("notify_status")
	.execute("ux9", { summary: "Which design?", urgency: "orange", effect: "party" }, undefined, undefined, ux.ctx);
check(
	"an effect on a status that is not green is refused",
	orangeEffect.isError === true && orangeEffect.content[0].text.includes("green"),
);
const refusedStop = await ux.fire("session_stop");
check(
	"a refused effect records no status",
	refusedStop.some((r) => r?.decision === "block"),
);

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
const draftContext = `${badgeLineOf(fx.id)}\nTask: quackml [${record(fx.id).tag}] | Model: openai/gpt-5.6-sol | Tmux: not attached`;
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
		`${badgeLineOf(fx.id)}\nTask: quackml [${record(fx.id).tag}] | Model: anthropic/claude-sonnet-4-6 | Tmux: not attached`,
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
await fx.tools
	.get("notify_status")
	.execute("f1", { summary: "Done.", urgency: "green", effect: "none" }, undefined, undefined, fx.ctx);
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
	.execute(
		"usage-fallback",
		{ summary: "Fallback done.", urgency: "green", effect: "none" },
		undefined,
		undefined,
		fx.ctx,
	);
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
	.execute("usage-reset", { summary: "Next turn.", urgency: "green", effect: "none" }, undefined, undefined, fx.ctx);
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
const titleContext = compactionMsg.split("\n").slice(0, 2).join("\n");
check("compaction shows a notice", compactionMsg.includes("compacted (overflow)"));
check(
	"session title supplies the context task",
	titleContext ===
		`\u{1F535} ${badgeLineOf(fx.id)}\nTask: Tune the quack model | Model: openai/gpt-5.6-sol | Tmux: work:3.1`,
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
	lastCall("sendMessage").body.text.split("\n").slice(0, 2).join("\n") ===
		`\u{1F535} ${badgeLineOf(fx.id)}\nTask: Pinned task | Model: openai/gpt-5.6-sol | Tmux: work:3.1`,
);

await fx.tools.get("session_badge").execute("identity-clear", { label: "" }, undefined, undefined, fx.ctx);
fx.setTitle("");
await fx.fire("agent_start");
await fx.fire("auto_compaction_start", { reason: "overflow", action: "context-full" });
await settle(120);
check(
	"folder and session tag supply the unnamed task",
	lastCall("sendMessage").body.text.split("\n").slice(0, 2).join("\n") ===
		`\u{1F535} ${badgeLineOf(fx.id)}\nTask: quackml [${record(fx.id).tag}] | Model: openai/gpt-5.6-sol | Tmux: work:3.1`,
);

delete process.env.TMUX;
delete process.env.TMUX_PANE;
fx.ctx.model = undefined;
await fx.fire("agent_start");
await fx.fire("auto_compaction_start", { reason: "overflow", action: "context-full" });
await settle(120);
check(
	"absent model and tmux have explicit context values",
	lastCall("sendMessage").body.text.split("\n").slice(0, 2).join("\n") ===
		`\u{1F535} ${badgeLineOf(fx.id)}\nTask: quackml [${record(fx.id).tag}] | Model: unavailable | Tmux: not attached`,
);
fx.ctx.model = { provider: "openai", id: "gpt-5.6-sol" };
process.env.PATH = pathBeforeTmuxTest;
await fx.fire("agent_end");

const fxSessionContext = `\u{1F535} ${badgeLineOf(fx.id)}\nTask: quackml [${record(fx.id).tag}] | Model: openai/gpt-5.6-sol | Tmux: not attached`;
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
		{ summary: "Results:\n\n| step | state |\n| --- | --- |\n| build | ok |", urgency: "green", effect: "none" },
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
	.execute(
		"f3",
		{ summary: "Again:\n\n| a | b |\n| - | - |", urgency: "green", effect: "none" },
		undefined,
		undefined,
		fx.ctx,
	);
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
const fileContext = `${badgeLineOf(fx.id)}\nTask: quackml [${record(fx.id).tag}] | Model: openai/gpt-5.6-sol | Tmux: not attached`;
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
const fallbackRecordId = record(fx.id).recent.at(-1);
const fallbackRecord = JSON.parse(readFileSync(join(root, "notify-telegram/sent", `${fallbackRecordId}.json`), "utf8"));
check(
	"photo fallback records the caption Telegram accepted",
	fallbackRecord.text === lastCall("sendDocument").body.caption,
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
await rv.tools
	.get("notify_status")
	.execute("r1", { summary: "One.", urgency: "green", effect: "none" }, undefined, undefined, rv.ctx);
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
await rv.tools
	.get("notify_status")
	.execute("r2", { summary: "Two.", urgency: "green", effect: "none" }, undefined, undefined, rv.ctx);
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
	.execute(
		"r3",
		{ summary: "Plain sentence, nothing structured.", urgency: "green", effect: "none" },
		undefined,
		undefined,
		rv.ctx,
	);
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
		{ questions: [{ id: "q", question: "Q?", options: askOpts("a", "b") }] },
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
		`\u{1F535} ${badgeLineOf(rv.id)}\nTask: htmlq [${record(rv.id).tag}] | Model: openai/gpt-5.6-sol | Tmux: not attached`,
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
		`${badgeLineOf(rv.id)}\nTask: htmlq [${record(rv.id).tag}] | Model: openai/gpt-5.6-sol | Tmux: not attached\n\nthe chart\n\n${albumFiles.f0}` &&
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
	.execute("rvb1", { summary: "Arrow round done.", urgency: "green", effect: "none" }, undefined, undefined, rvB.ctx);
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

// A /stop or a file replying to a message no live session owns reaches nobody, and the user is told so.
const abortsBeforeUnowned = rvA.aborts + rvB.aborts;
api.queued = [
	{
		update_id: 731,
		message: { message_id: 731, date: 1, chat: { id: CHAT }, text: "/stop", reply_to_message: { message_id: 1 } },
	},
];
await rvA.pump(250);
check(
	"a /stop replying to an unowned message stops nothing and says so",
	rvA.aborts + rvB.aborts === abortsBeforeUnowned &&
		(lastCall("sendMessage")?.body.text ?? "").includes("nothing was stopped"),
);
const fetchesBeforeUnowned = called("getFile").length;
api.queued = [
	{
		update_id: 732,
		message: {
			message_id: 732,
			date: 1,
			chat: { id: CHAT },
			voice: { file_id: "unowned" },
			reply_to_message: { message_id: 1 },
		},
	},
];
await rvA.pump(250);
check(
	"a file replying to an unowned message is dropped unfetched and the user is told",
	called("getFile").length === fetchesBeforeUnowned &&
		(lastCall("sendMessage")?.body.text ?? "").includes("so it was dropped"),
);

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
		{ summary: 'See [the docs](https://example.com/"quoted"/path).', urgency: "green", effect: "none" },
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
		{ summary: "Before \u00000\u0000 after and `real code` end.", urgency: "green", effect: "none" },
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
	.execute(
		"nb3",
		{ summary: "\uD83D\uDE00".repeat(2501), urgency: "green", effect: "none" },
		undefined,
		undefined,
		nbSess.ctx,
	);
await nbSess.fire("session_stop");
await settle(150);
const surrogateText = lastCall("sendMessage").body.text;
const lastCodeUnit = surrogateText.charCodeAt(surrogateText.length - 1);
check(
	"surrogate-pair truncation: last code unit is not a lone high surrogate",
	lastCodeUnit < 0xd800 || lastCodeUnit > 0xdbff,
);

// d. Persisting the offset must not lower one another process already advanced past.
writeConfig({ offset: 100 });
rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
const noRwSess = spawn("01a05000-0000-0000-0000-000000000000", "/home/dev/work/norewind");
await noRwSess.fire("session_start");
// Simulate another poller advancing the on-disk offset past what this session knows.
writeConfig({ offset: 500 });
api.queued = [{ update_id: 150, message: { message_id: 1, date: 1, chat: { id: CHAT }, text: "late" } }];
await noRwSess.pump(250);
check(
	"persisting the offset does not lower one already advanced by another process",
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
				{ id: "a", question: "First?", options: askOpts("x") },
				{ id: "b", question: "Second?", options: askOpts("y") },
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
			{ summary: "Round done.", urgency: "orange", options: opts("Continue", "Stop") },
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
	check(
		"the ask preview carries the session badge exactly once, from the draft head",
		partial.body.text.split(badgeLineOf(qp.id)).length === 2,
	);
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
		.execute("g1", { summary: "All done.", urgency: "green", effect: "none" }, undefined, undefined, cs.ctx);
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
			{ summary: "Done, pick.", urgency: "green", effect: "thumbs_up", options: opts("Merge", "Wait") },
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
	check(
		"a green standing question plays the chosen effect",
		lastCall("sendMessage").body.message_effect_id === "5107584321108051014",
	);
	const offer = record(cs.id).closeOffer;
	check("a green standing question is itself the live close offer", offer !== null);
	writeFileSync(
		join(inboxOf(cs.id), "3001.json"),
		JSON.stringify({ kind: "callback", value: `k:${record(cs.id).tag}`, messageId: offer }),
	);
	await cs.pump(250);
	check("a close press on the live offer shuts the session down", shutdowns === 1);
	check(
		"close-only keeps the chat history",
		sentRecordFile(offer) !== null && sentRecordFile(offer).session.id === cs.id,
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
	check(
		"the reply also focuses the session's own pane, not just the window",
		existsSync(tmuxLog) && readFileSync(tmuxLog, "utf8").includes("select-pane -t %77"),
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

// Closing from Telegram kills only this session's pane, never the whole window with its siblings.
{
	rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
	const binDir = join(root, "fakebin-kill");
	mkdirSync(binDir, { recursive: true });
	const killLog = join(root, "tmux-kill.log");
	rmSync(killLog, { force: true });
	writeFileSync(
		join(binDir, "tmux"),
		`#!/bin/sh\necho "$@" >> ${killLog}\nif [ "$1" = display-message ]; then echo "@1"; fi\n`,
		{ mode: 0o755 },
	);
	const oldPath = process.env.PATH;
	process.env.PATH = `${binDir}:${oldPath}`;
	process.env.TMUX = "/tmp/fake-tmux,1,0";
	process.env.TMUX_PANE = "%77";
	writeConfig();
	const kc = spawn("01a06007-0000-0000-0000-000000000000", "/home/dev/work/paneclose");
	await kc.fire("session_start");
	await kc.fire("input");
	await kc.tools
		.get("notify_status")
		.execute("k1", { summary: "All done.", urgency: "green", effect: "none" }, undefined, undefined, kc.ctx);
	await kc.fire("session_stop");
	await settle(150);
	const kcOffer = record(kc.id).closeOffer;
	writeFileSync(
		join(inboxOf(kc.id), "3201.json"),
		JSON.stringify({ kind: "callback", value: `k:${record(kc.id).tag}`, messageId: kcOffer }),
	);
	await kc.pump(250);
	await settle(2300);
	const killed = existsSync(killLog) ? readFileSync(killLog, "utf8") : "";
	check("closing kills this session's own pane", killed.includes("kill-pane -t %77"));
	check("closing never kills the shared window", !killed.includes("kill-window"));
	writeConfig();
	process.env.PATH = oldPath;
	delete process.env.TMUX;
	delete process.env.TMUX_PANE;
}

// A close press must shut the session down even when the pane id is unusable, and never issue a kill at a bad target.
{
	rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
	const binDir = join(root, "fakebin-badpane");
	mkdirSync(binDir, { recursive: true });
	const killLog = join(root, "tmux-badpane.log");
	rmSync(killLog, { force: true });
	writeFileSync(join(binDir, "tmux"), `#!/bin/sh\necho "$@" >> ${killLog}\n`, { mode: 0o755 });
	const oldPath = process.env.PATH;
	process.env.PATH = `${binDir}:${oldPath}`;
	process.env.TMUX = "/tmp/fake-tmux,1,0";
	process.env.TMUX_PANE = "not-a-pane";
	writeConfig();
	const bp = spawn("01a06008-0000-0000-0000-000000000000", "/home/dev/work/badpane");
	let shutdowns = 0;
	bp.ctx.shutdown = () => {
		shutdowns += 1;
	};
	await bp.fire("session_start");
	await bp.fire("input");
	await bp.tools
		.get("notify_status")
		.execute("b1", { summary: "All done.", urgency: "green", effect: "none" }, undefined, undefined, bp.ctx);
	await bp.fire("session_stop");
	await settle(150);
	const bpOffer = record(bp.id).closeOffer;
	writeFileSync(
		join(inboxOf(bp.id), "3301.json"),
		JSON.stringify({ kind: "callback", value: `k:${record(bp.id).tag}`, messageId: bpOffer }),
	);
	await bp.pump(250);
	await settle(2300);
	check("a close still shuts the session down when the pane id is unusable", shutdowns === 1);
	const killed = existsSync(killLog) ? readFileSync(killLog, "utf8") : "";
	check("an unusable pane id schedules no kill at all", !killed.includes("kill-pane"));
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
		.execute("r1", { summary: "Everything done.", urgency: "green", effect: "none" }, undefined, undefined, rt.ctx);
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

// The green close offer also carries the close-and-clear button beside the plain close.
{
	rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
	const cl = spawn("c1ea000a-0000-0000-0000-000000000000", "/home/dev/work/clearboth");
	await cl.fire("session_start");
	await cl.fire("input");
	await cl.tools
		.get("notify_status")
		.execute("cb1", { summary: "All done.", urgency: "green", effect: "none" }, undefined, undefined, cl.ctx);
	await cl.fire("session_stop");
	await settle(150);
	const plainRow = (lastCall("sendMessage").body.reply_markup?.inline_keyboard ?? []).flat();
	check(
		"a plain green summary offers the close button and the clear button",
		plainRow.some((b) => b.callback_data?.startsWith("k:")) &&
			plainRow.some((b) => b.callback_data?.startsWith("x:") && b.style === "danger"),
	);
	await cl.fire("input");
	await cl.tools
		.get("notify_status")
		.execute(
			"cb2",
			{ summary: "Pick one.", urgency: "orange", options: opts("Go", "Wait") },
			undefined,
			undefined,
			cl.ctx,
		);
	await cl.fire("session_stop");
	await settle(150);
	check(
		"an orange standing question offers neither close button",
		(lastCall("sendMessage").body.reply_markup?.inline_keyboard ?? [])
			.flat()
			.every((b) => b.callback_data?.startsWith("k:") !== true && b.callback_data?.startsWith("x:") !== true),
	);
	await cl.fire("input");
	await cl.tools
		.get("notify_status")
		.execute(
			"cb3",
			{ summary: "Done, pick.", urgency: "green", effect: "none", options: opts("Merge", "Wait") },
			undefined,
			undefined,
			cl.ctx,
		);
	await cl.fire("session_stop");
	await settle(150);
	const standingRow = lastCall("sendMessage").body.reply_markup.inline_keyboard.flat();
	check(
		"a green standing question offers the close button and the clear button",
		standingRow.some((b) => b.callback_data?.startsWith("k:")) &&
			standingRow.some((b) => b.callback_data?.startsWith("x:")),
	);
}

// Close and clear removes this session's outgoing records and its uniquely routed replies, then closes.
{
	rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
	const cc = spawn("c1ea000b-0000-0000-0000-000000000000", "/home/dev/work/clearchat");
	const other = spawn("c1ea000c-0000-0000-0000-000000000000", "/home/dev/work/otherkeep");
	let shutdowns = 0;
	cc.ctx.shutdown = () => {
		shutdowns += 1;
	};
	await cc.fire("session_start");
	await other.fire("session_start");
	await cc.fire("input");
	await cc.tools
		.get("notify_status")
		.execute("cl1", { summary: "First note.", urgency: "orange" }, undefined, undefined, cc.ctx);
	await cc.fire("session_stop");
	await settle(150);
	const first = record(cc.id).recent.at(-1);
	api.queued = [
		{
			update_id: 6100,
			message: {
				message_id: 6100,
				date: 1,
				chat: { id: CHAT },
				text: "keep going",
				reply_to_message: { message_id: first },
			},
		},
	];
	await cc.pump(250);
	await cc.pump(250);
	check(
		"a reply routed to a session is kept as a routed incoming record",
		incomingRecordFile(6100).session.id === cc.id,
	);
	await other.fire("input");
	await other.tools
		.get("notify_status")
		.execute("cl2", { summary: "Other note.", urgency: "orange" }, undefined, undefined, other.ctx);
	await other.fire("session_stop");
	await settle(150);
	const otherMsg = record(other.id).recent.at(-1);
	api.queued = [
		{
			update_id: 6101,
			message: {
				message_id: 6101,
				date: 1,
				chat: { id: CHAT },
				text: "over to you",
				reply_to_message: { message_id: otherMsg },
			},
		},
	];
	await cc.pump(250);
	await other.pump(250);
	await cc.fire("input");
	await cc.tools
		.get("notify_status")
		.execute("cl3", { summary: "All done.", urgency: "green", effect: "none" }, undefined, undefined, cc.ctx);
	await cc.fire("session_stop");
	await settle(150);
	const offer = record(cc.id).closeOffer;
	const deletesBefore = called("deleteMessages").length;
	writeFileSync(
		join(inboxOf(cc.id), "6102.json"),
		JSON.stringify({ kind: "callback", value: `x:${record(cc.id).tag}`, messageId: offer }),
	);
	await cc.pump(500);
	check("close and clear shuts the session down once", shutdowns === 1);
	const deleted = called("deleteMessages")
		.slice(deletesBefore)
		.flatMap((c) => c.body.message_ids);
	check(
		"close and clear asks Telegram to delete every owned message",
		[first, offer, 6100].every((id) => deleted.includes(id)),
	);
	check(
		"close and clear leaves the other session's messages untouched",
		[otherMsg, 6101].every((id) => !deleted.includes(id)),
	);
	check("cleared outgoing records are tombstoned", sentRecordFile(first) === null && sentRecordFile(offer) === null);
	check("cleared incoming records are tombstoned", incomingRecordFile(6100) === null);
	check(
		"the other session's records survive the clear",
		sentRecordFile(otherMsg).session.id === other.id && incomingRecordFile(6101).session.id === other.id,
	);
	check("a successful clear leaves no extra chat message", lastCall("sendMessage").body.text.includes("All done."));
	check("the close offer is gone from the record", record(cc.id).closeOffer === null);
	const callsBeforeShutdown = api.calls.length;
	await cc.fire("session_shutdown");
	await settle(150);
	check(
		"shutdown rewrites nothing the clear already removed",
		api.calls
			.slice(callsBeforeShutdown)
			.every((c) => c.body.message_id !== first && c.body.message_id !== offer && c.body.message_id !== 6100),
	);
}

// Telegram refuses some deletions, and the clear reports the remainder and still closes.
{
	rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
	const pr = spawn("c1ea000d-0000-0000-0000-000000000000", "/home/dev/work/partialclear");
	let shutdowns = 0;
	pr.ctx.shutdown = () => {
		shutdowns += 1;
	};
	await pr.fire("session_start");
	await pr.fire("input");
	await pr.tools
		.get("notify_status")
		.execute("pc1", { summary: "All done.", urgency: "green", effect: "none" }, undefined, undefined, pr.ctx);
	await pr.fire("session_stop");
	await settle(150);
	const firstOffer = record(pr.id).closeOffer;
	api.queued = [
		{
			update_id: 6200,
			message: {
				message_id: 6200,
				date: 1,
				chat: { id: CHAT },
				text: "a reply",
				reply_to_message: { message_id: firstOffer },
			},
		},
	];
	await pr.pump(250);
	await pr.pump(250);
	await pr.tools
		.get("notify_status")
		.execute("pc2", { summary: "Complete.", urgency: "green", effect: "none" }, undefined, undefined, pr.ctx);
	await pr.fire("session_stop");
	await settle(150);
	const offer = record(pr.id).closeOffer;
	api.deleteRefusals = [6200];
	writeFileSync(
		join(inboxOf(pr.id), "6201.json"),
		JSON.stringify({ kind: "callback", value: `x:${record(pr.id).tag}`, messageId: offer }),
	);
	await pr.pump(500);
	api.deleteRefusals = [];
	check("a refused deletion still closes the session", shutdowns === 1);
	check("accepted outgoing deletions are forgotten despite an incoming refusal", sentRecordFile(offer) === null);
	check("a refused incoming record stays on file", incomingRecordFile(6200).session.id === pr.id);
	const report = lastCall("sendMessage").body.text ?? "";
	check(
		"the refusal is reported with the 48h horizon",
		report.includes("Could not remove") && report.includes("48 hours"),
	);
	check("a partial clear never claims a full one", !report.includes("Cleared all"));
}

// A network failure mid-clear must still shut the session down, and the clear reports what stays in the chat.
{
	rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
	const ct = spawn("c1ea0017-0000-0000-0000-000000000000", "/home/dev/work/clearthrow");
	let shutdowns = 0;
	ct.ctx.shutdown = () => {
		shutdowns += 1;
	};
	await ct.fire("session_start");
	await ct.fire("input");
	await ct.tools
		.get("notify_status")
		.execute("ct1", { summary: "All done.", urgency: "green", effect: "none" }, undefined, undefined, ct.ctx);
	await ct.fire("session_stop");
	await settle(150);
	const offer = record(ct.id).closeOffer;
	api.fetchThrows = ["deleteMessages"];
	writeFileSync(
		join(inboxOf(ct.id), "6710.json"),
		JSON.stringify({ kind: "callback", value: `x:${record(ct.id).tag}`, messageId: offer }),
	);
	await ct.pump(500);
	api.fetchThrows = [];
	check("a clear whose send dies on the network still shuts the session down", shutdowns === 1);
	const deadReport = lastCall("sendMessage").body.text ?? "";
	check(
		"the dead clear reports the messages left in the chat",
		deadReport.includes("Could not remove") && deadReport.includes("tracked messages"),
	);
}

// A network failure while stripping the close button must not leave the pane alive.
{
	rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
	const st = spawn("c1ea0018-0000-0000-0000-000000000000", "/home/dev/work/stripthrow");
	let shutdowns = 0;
	st.ctx.shutdown = () => {
		shutdowns += 1;
	};
	await st.fire("session_start");
	await st.fire("input");
	await st.tools
		.get("notify_status")
		.execute("st1", { summary: "All done.", urgency: "green", effect: "none" }, undefined, undefined, st.ctx);
	await st.fire("session_stop");
	await settle(150);
	const offer = record(st.id).closeOffer;
	api.fetchThrows = ["editMessageReplyMarkup"];
	writeFileSync(
		join(inboxOf(st.id), "6711.json"),
		JSON.stringify({ kind: "callback", value: `k:${record(st.id).tag}`, messageId: offer }),
	);
	await st.pump(250);
	api.fetchThrows = [];
	check("a close whose strip dies on the network still shuts the session down", shutdowns === 1);
}

// A clear tapped on a green standing question deletes the question and never rewrites it at shutdown.
{
	rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
	const sg = spawn("c1ea000e-0000-0000-0000-000000000000", "/home/dev/work/standclear");
	let shutdowns = 0;
	sg.ctx.shutdown = () => {
		shutdowns += 1;
	};
	await sg.fire("session_start");
	await sg.fire("input");
	await sg.tools
		.get("notify_status")
		.execute(
			"sg1",
			{ summary: "Done, pick.", urgency: "green", effect: "none", options: opts("Merge", "Wait") },
			undefined,
			undefined,
			sg.ctx,
		);
	await sg.fire("session_stop");
	await settle(150);
	const standing = record(sg.id).standing.messageId;
	writeFileSync(
		join(inboxOf(sg.id), "6250.json"),
		JSON.stringify({ kind: "callback", value: `x:${record(sg.id).tag}`, messageId: standing }),
	);
	await sg.pump(500);
	check("a clear on the standing question closes the session", shutdowns === 1);
	check(
		"the standing question message was deleted",
		called("deleteMessages").some((c) => c.body.message_ids.includes(standing)) && sentRecordFile(standing) === null,
	);
	await sg.fire("session_shutdown");
	await settle(150);
	check(
		"shutdown never rewrites the deleted standing question",
		!called("editMessageText").some((c) => c.body.message_id === standing),
	);
}

// Only the live offer answers a close or clear tap. Stale, queued and duplicated taps are ignored.
{
	rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
	const st = spawn("c1ea000f-0000-0000-0000-000000000000", "/home/dev/work/staleclear");
	let shutdowns = 0;
	st.ctx.shutdown = () => {
		shutdowns += 1;
	};
	await st.fire("session_start");
	await st.fire("input");
	await st.tools
		.get("notify_status")
		.execute("sc1", { summary: "All done.", urgency: "green", effect: "none" }, undefined, undefined, st.ctx);
	await st.fire("session_stop");
	await settle(150);
	const offer = record(st.id).closeOffer;
	const deletesBefore = called("deleteMessages").length;
	await st.fire("agent_start");
	await settle(150);
	writeFileSync(
		join(inboxOf(st.id), "6301.json"),
		JSON.stringify({ kind: "callback", value: `x:${record(st.id).tag}`, messageId: offer }),
	);
	await st.pump(250);
	check("a clear tap queued behind new work does not shut the session down", shutdowns === 0);
	check("a stale clear tap deletes nothing", called("deleteMessages").length === deletesBefore);
	check(
		"a stale tap gets an explanation instead",
		(lastCall("sendMessage").body.text ?? "").includes("no longer current"),
	);
	await st.fire("agent_end");
	await st.fire("input");
	await st.tools
		.get("notify_status")
		.execute("sc2", { summary: "Again done.", urgency: "green", effect: "none" }, undefined, undefined, st.ctx);
	await st.fire("session_stop");
	await settle(150);
	const offer2 = record(st.id).closeOffer;
	writeFileSync(
		join(inboxOf(st.id), "6302.json"),
		JSON.stringify({ kind: "callback", value: `k:${record(st.id).tag}`, messageId: offer2 }),
	);
	await st.pump(250);
	writeFileSync(
		join(inboxOf(st.id), "6303.json"),
		JSON.stringify({ kind: "callback", value: `x:${record(st.id).tag}`, messageId: offer2 }),
	);
	await st.pump(250);
	check("the first close tap wins and the duplicate is ignored", shutdowns === 1);
}

for (const withChoices of [false, true]) {
	rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
	const late = spawn(`c1ea002${withChoices ? "1" : "0"}-0000-0000-0000-000000000000`, "/home/dev/work/late-summary");
	let shutdowns = 0;
	late.ctx.shutdown = () => shutdowns++;
	await late.fire("session_start");
	await late.fire("input");
	await late.tools.get("notify_status").execute(
		"late-summary",
		{
			summary: "Completed before new work.",
			urgency: "green",
			effect: "none",
			...(withChoices ? { options: opts("Proceed", "Wait") } : {}),
		},
		undefined,
		undefined,
		late.ctx,
	);
	const release = Promise.withResolvers();
	api.sendMessageGate = release.promise;
	await late.fire("session_stop");
	await late.fire("agent_start");
	release.resolve();
	api.sendMessageGate = null;
	await settle(150);
	const sentId = record(late.id).recent.at(-1);
	check("a completion delivered during new work has no live close offer", record(late.id).closeOffer === null);
	writeFileSync(
		join(inboxOf(late.id), "6350.json"),
		JSON.stringify({ kind: "callback", value: `x:${record(late.id).tag}`, messageId: sentId }),
	);
	await late.pump(250);
	check("a delayed completion cannot close a running turn", shutdowns === 0);
	await late.fire("agent_end");
	await late.fire("session_shutdown");
}

// An answer to a standing question queued before a clear tap retires the offer the tap would act on.
{
	rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
	const qx = spawn("c1ea0011-0000-0000-0000-000000000000", "/home/dev/work/queuedclear");
	let shutdowns = 0;
	qx.ctx.shutdown = () => {
		shutdowns += 1;
	};
	await qx.fire("session_start");
	await qx.fire("input");
	await qx.tools
		.get("notify_status")
		.execute(
			"qx1",
			{ summary: "Done, pick.", urgency: "green", effect: "none", options: opts("Merge", "Wait") },
			undefined,
			undefined,
			qx.ctx,
		);
	await qx.fire("session_stop");
	await settle(150);
	const standing = record(qx.id).standing.messageId;
	const deletesBefore = called("deleteMessages").length;
	writeFileSync(
		join(inboxOf(qx.id), "6401.json"),
		JSON.stringify({ kind: "callback", value: `c:${record(qx.id).tag}-n1:0`, messageId: standing }),
	);
	await qx.pump(250);
	writeFileSync(
		join(inboxOf(qx.id), "6402.json"),
		JSON.stringify({ kind: "callback", value: `x:${record(qx.id).tag}`, messageId: standing }),
	);
	await qx.pump(250);
	check("an answer queued before a clear tap retires the offer", shutdowns === 0);
	check("the queued clear tap deleted nothing", called("deleteMessages").length === deletesBefore);
	check(
		"the queued clear tap gets the stale explanation",
		(lastCall("sendMessage").body.text ?? "").includes("no longer current"),
	);
	check(
		"the standing answer was delivered as new work",
		qx.steers.some((s) => s.text === "Merge"),
	);
}

// Only uniquely routed replies, media and commands are kept for a later clear.
{
	rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
	const in1 = spawn("c1ea0012-0000-0000-0000-000000000000", "/home/dev/work/inone");
	const in2 = spawn("c1ea0013-0000-0000-0000-000000000000", "/home/dev/work/intwo");
	await in1.fire("session_start");
	await in2.fire("session_start");
	await in1.fire("input");
	await in1.tools
		.get("notify_status")
		.execute("it1", { summary: "A note.", urgency: "orange" }, undefined, undefined, in1.ctx);
	await in1.fire("session_stop");
	await settle(150);
	const note = record(in1.id).recent.at(-1);
	api.queued = [
		{
			update_id: 6500,
			message: {
				message_id: 6500,
				date: 1,
				chat: { id: CHAT },
				text: "a reply",
				reply_to_message: { message_id: note },
			},
		},
	];
	await in1.pump(250);
	await in1.pump(250);
	check("a text reply is tracked under the session it answered", incomingRecordFile(6500).session.id === in1.id);
	api.queued = [
		{
			update_id: 6501,
			message: {
				message_id: 6501,
				date: 1,
				chat: { id: CHAT },
				photo: [{ file_id: "p1", file_size: 10 }],
				reply_to_message: { message_id: note },
			},
		},
	];
	await in1.pump(250);
	await in1.pump(250);
	check("a photo reply is tracked under the same session", incomingRecordFile(6501).session.id === in1.id);
	// A bare /stop goes to the one session mid-turn, so every earlier session has to read as idle.
	for (const entry of readdirSync(sessionsDir)) {
		const path = join(sessionsDir, entry);
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8"));
			writeFileSync(path, JSON.stringify({ ...parsed, state: "idle" }));
		} catch {}
	}
	await in2.fire("agent_start");
	api.queued = [{ update_id: 6502, message: { message_id: 6502, date: 1, chat: { id: CHAT }, text: "/stop" } }];
	await in1.pump(250);
	check("a bare stop to the one running session is tracked under it", incomingRecordFile(6502).session.id === in2.id);
	await in2.pump(250);
	api.queued = [
		{ update_id: 6503, message: { message_id: 6503, date: 1, chat: { id: CHAT }, text: "/hidequestions" } },
	];
	await in1.pump(250);
	await in2.pump(250);
	check(
		"a fleet-wide command is not tracked under any session",
		!existsSync(join(root, "notify-telegram/incoming/6503.json")),
	);
	await in2.tools
		.get("notify_status")
		.execute("it2", { summary: "Another note.", urgency: "orange" }, undefined, undefined, in2.ctx);
	await in2.fire("session_stop");
	await settle(150);
	for (const entry of readdirSync(sessionsDir)) {
		const path = join(sessionsDir, entry);
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8"));
			const mine = entry.startsWith(in1.id) || entry.startsWith(in2.id);
			writeFileSync(
				path,
				JSON.stringify({ ...parsed, lastNotified: mine ? Date.now() : 0, heartbeat: mine ? Date.now() : 0 }),
			);
		} catch {}
	}
	api.queued = [
		{ update_id: 6504, message: { message_id: 6504, date: 1, chat: { id: CHAT }, text: "who is this for" } },
	];
	await in1.pump(250);
	check("an ambiguous message is held, not tracked", !existsSync(join(root, "notify-telegram/incoming/6504.json")));
	const pickerRow = (lastCall("sendMessage").body.reply_markup?.inline_keyboard ?? []).flat();
	const pickerId = api.nextMessage - 1;
	check(
		"the picker offers a press for the second session",
		pickerRow.some((b) => b.callback_data === `m:6504:${record(in2.id).tag}`),
	);
	api.queued = [
		{
			update_id: 6505,
			callback_query: {
				id: "cbhold",
				data: `m:6504:${record(in2.id).tag}`,
				from: { id: CHAT },
				message: { message_id: pickerId, chat: { id: CHAT } },
			},
		},
	];
	await in1.pump(250);
	check("a chosen held message is tracked under the chosen session", incomingRecordFile(6504).session.id === in2.id);
	check("the held message reached the chosen session", inboxCount(in2.id) === 1);
	const assignedMessages = await in2.tools
		.get("notify_message")
		.execute("assigned-picker", { action: "list" }, undefined, undefined, in2.ctx);
	check(
		"a settled picker belongs to the selected session's message history",
		assignedMessages.details.messages.some((message) => message.id === pickerId),
	);
}

// A restarted session clears from the ledgers on disk, not from memory.
{
	rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
	const rs = "c1ea0014-0000-0000-0000-000000000000";
	const r1 = spawn(rs, "/home/dev/work/restart");
	await r1.fire("session_start");
	await r1.fire("input");
	await r1.tools
		.get("notify_status")
		.execute("rs1", { summary: "All done.", urgency: "green", effect: "none" }, undefined, undefined, r1.ctx);
	await r1.fire("session_stop");
	await settle(150);
	const oldOffer = record(r1.id).closeOffer;
	api.queued = [
		{
			update_id: 6600,
			message: {
				message_id: 6600,
				date: 1,
				chat: { id: CHAT },
				text: "a reply",
				reply_to_message: { message_id: oldOffer },
			},
		},
	];
	await r1.pump(250);
	await r1.pump(250);
	await r1.tools
		.get("notify_status")
		.execute("rs2", { summary: "Complete.", urgency: "green", effect: "none" }, undefined, undefined, r1.ctx);
	await r1.fire("session_stop");
	await settle(150);
	const resumedOffer = record(r1.id).closeOffer;
	killProcessOf(rs);
	const r2 = spawn(rs, "/home/dev/work/restart");
	let shutdowns = 0;
	r2.ctx.shutdown = () => {
		shutdowns += 1;
	};
	await r2.fire("session_start");
	check("a restart keeps the close offer it can act on", record(rs).closeOffer === resumedOffer);
	const deletesBefore = called("deleteMessages").length;
	writeFileSync(
		join(inboxOf(rs), "6601.json"),
		JSON.stringify({ kind: "callback", value: `x:${record(rs).tag}`, messageId: resumedOffer }),
	);
	await r2.pump(500);
	check(
		"a restarted session still clears its history from disk",
		shutdowns === 1 &&
			called("deleteMessages")
				.slice(deletesBefore)
				.flatMap((c) => c.body.message_ids)
				.includes(oldOffer),
	);
	check(
		"a restarted clear tombstones the resumed records",
		sentRecordFile(oldOffer) === null && incomingRecordFile(6600) === null,
	);
}

// The clear walks the on-disk ledger, so a long-lived session loses nothing to the recent cap.
{
	rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
	const bs = spawn("c1ea0015-0000-0000-0000-000000000000", "/home/dev/work/bulkclear");
	let shutdowns = 0;
	bs.ctx.shutdown = () => {
		shutdowns += 1;
	};
	await bs.fire("session_start");
	await bs.fire("input");
	await bs.tools
		.get("notify_status")
		.execute("bs1", { summary: "All done.", urgency: "green", effect: "none" }, undefined, undefined, bs.ctx);
	await bs.fire("session_stop");
	await settle(150);
	const bsRec = record(bs.id);
	for (let i = 0; i < 120; i++) {
		writeFileSync(
			join(root, `notify-telegram/sent/${70000 + i}.json`),
			JSON.stringify({
				version: 1,
				id: 70000 + i,
				at: Date.now() - (i + 1) * 1000,
				kind: "status",
				text: `old note ${i}`,
				session: { id: bs.id, tag: bsRec.tag, emoji: bsRec.emoji, name: "bulk", cwd: "/home/dev/work/bulkclear" },
			}),
			{ mode: 0o600 },
		);
	}
	const offer = record(bs.id).closeOffer;
	const deletesBefore = called("deleteMessages").length;
	writeFileSync(
		join(inboxOf(bs.id), "6701.json"),
		JSON.stringify({ kind: "callback", value: `x:${bsRec.tag}`, messageId: offer }),
	);
	await bs.pump(700);
	const batches = called("deleteMessages").slice(deletesBefore);
	check(
		"deletion spans multiple Telegram batches without losing ledger history",
		batches.length === 2 &&
			batches.every((batch) => batch.body.message_ids.length <= 100) &&
			batches.flatMap((batch) => batch.body.message_ids).length === 121 &&
			sentRecordFile(70000) === null &&
			sentRecordFile(70119) === null,
	);
	check("a bulk clear still closes the session", shutdowns === 1);
}

// A clear press routed through the poller names its own action and reaches the session.
{
	rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
	const rp = spawn("c1ea0016-0000-0000-0000-000000000000", "/home/dev/work/routedclear");
	let shutdowns = 0;
	rp.ctx.shutdown = () => {
		shutdowns += 1;
	};
	await rp.fire("session_start");
	await rp.fire("input");
	await rp.tools
		.get("notify_status")
		.execute("rp1", { summary: "All done.", urgency: "green", effect: "none" }, undefined, undefined, rp.ctx);
	await rp.fire("session_stop");
	await settle(150);
	const offer = record(rp.id).closeOffer;
	const toastsBefore = called("answerCallbackQuery").length;
	api.queued = [
		{
			update_id: 6800,
			callback_query: {
				id: "cbx1",
				data: `x:${record(rp.id).tag}`,
				from: { id: CHAT },
				message: { message_id: offer, chat: { id: CHAT } },
			},
		},
	];
	await rp.pump(250);
	await rp.pump(500);
	check(
		"a routed clear press toasts its own action",
		(called("answerCallbackQuery").slice(toastsBefore).at(-1)?.body.text ?? "") ===
			"Closing the session and clearing its messages.",
	);
	check(
		"a routed clear press closes and clears",
		shutdowns === 1 && called("deleteMessages").some((c) => c.body.message_ids.includes(offer)),
	);
}

heading("oversized message truncation");
{
	// A fenced summary would otherwise leave through the native rich path.
	api.failMethods = ["sendRichMessage"];
	rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
	const tr = spawn("01a06010-0000-0000-0000-000000000000", "/home/dev/work/toolong");
	await tr.fire("session_start");

	// a. Escaping is free on the wire, so a summary at the tool's own cap goes out whole, footer
	// and every ampersand included.
	await tr.fire("agent_start");
	await tr.fire("message_end", {
		message: { role: "assistant", usage: { input: 12400, output: 900, cost: { total: 0.0512 } } },
	});
	await tr.fire("agent_end");
	await tr.tools
		.get("notify_status")
		.execute("t1", { summary: "&".repeat(900), urgency: "green", effect: "none" }, undefined, undefined, tr.ctx);
	await tr.fire("session_stop");
	await settle(150);
	const whole = lastCall("sendMessage").body.text;
	check("a summary dense in escapes keeps the usage footer", whole.includes("12.4k in / 900 out"));
	check("a summary dense in escapes is not cut", !whole.includes("truncated, full text at the terminal"));
	check("a summary dense in escapes keeps every ampersand", (whole.match(/&amp;/g) ?? []).length === 900);

	// b. A body past the real ceiling is cut, says so, and fits.
	const trAsk = { id: "q", question: "ok?", options: askOpts("yes") };
	tr.tools
		.get("ask")
		.execute("t2", { context: "x".repeat(5000), questions: [trAsk] }, undefined, undefined, stubbornCtx(tr.ctx, {}));
	await settle(200);
	const cut = lastCall("sendMessage").body.text;
	check("an oversized body says it was truncated", cut.includes("truncated, full text at the terminal"));
	check("an oversized body fits the telegram limit", wireLength(cut) <= 4096);

	// c. A cut inside a fenced code block leaves a stray fence that renders as
	// literal backticks, so the cut has to keep the fences balanced.
	tr.tools
		.get("ask")
		.execute(
			"t3",
			{ context: `\`\`\`\n${"x".repeat(5000)}\n\`\`\``, questions: [trAsk] },
			undefined,
			undefined,
			stubbornCtx(tr.ctx, {}),
		);
	await settle(200);
	const fenced = lastCall("sendMessage").body.text;
	check("a truncated fence leaks no literal backticks", !fenced.includes("```"));
	check(
		"a truncated fence stays balanced",
		(fenced.match(/<pre>/g) ?? []).length === (fenced.match(/<\/pre>/g) ?? []).length,
	);
	check("a truncated fenced body fits the telegram limit", wireLength(fenced) <= 4096);
	// Both questions stay open otherwise, and a session waiting on one outranks recency in routing.
	let trEntry = 8800;
	const answerLast = async () => {
		const press = (lastCall("sendMessage").body.reply_markup?.inline_keyboard ?? [])
			.flat()
			.find((b) => b.callback_data?.startsWith("o:"));
		trEntry += 1;
		writeFileSync(
			join(inboxOf(tr.id), `${trEntry}.json`),
			JSON.stringify({ kind: "callback", value: press.callback_data }),
		);
		await tr.pump(250);
	};
	await answerLast();
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
		.execute("s2", { summary: "x".repeat(1200), urgency: "green", effect: "none" }, undefined, undefined, sf.ctx);
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
		.execute(
			"sc1",
			{ summary: half(900), urgency: "green", effect: "none", question: "Ok?" },
			undefined,
			undefined,
			sg.ctx,
		);
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
			{ questions: [{ id: "p", question: "Which?", options: [{ ...askOpt("a"), preview: half(300) }, askOpt("b")] }] },
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

heading("shared Telegram throttle");
{
	const throttleFile = join(root, "notify-telegram/throttle.json");
	const statusSends = (summary) => called("sendMessage").filter((c) => String(c.body.text).includes(summary)).length;
	/** The shared deadline as written, or 0 when there is none, read without checking first that the file exists. */
	const sharedUntil = () => {
		try {
			return JSON.parse(readFileSync(throttleFile, "utf8")).until;
		} catch {
			return 0;
		}
	};
	const turnEnd = async (session, summary) => {
		await session.fire("input");
		await session.tools
			.get("notify_status")
			.execute(`thr-${summary}`, { summary, urgency: "green", effect: "none" }, undefined, undefined, session.ctx);
		await session.fire("session_stop");
	};
	rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
	const ta = spawn("01a06022-0000-0000-0000-000000000000", "/home/dev/work/throttle-a");
	await ta.fire("session_start");
	const tb = spawn("01a06023-0000-0000-0000-000000000000", "/home/dev/work/throttle-b");
	await tb.fire("session_start");

	// A 429 one session gets is written down for every omp process to obey.
	api.failMethods = ["sendMessage"];
	api.failStatus = 429;
	api.failRetryAfter = 40;
	api.failDescription = "Too Many Requests: retry after 40";
	await turnEnd(ta, "Throttle seed.");
	await settle(200);
	api.failMethods = [];
	api.failStatus = undefined;
	api.failRetryAfter = undefined;
	api.failDescription = undefined;
	check("a 429 is shared with every process through the state directory", sharedUntil() > Date.now() + 30_000);

	// A tool the agent is blocked on refuses at once rather than freezing the agent for 40 seconds.
	const sendsBefore = called("sendMessage").length;
	const startedAt = Date.now();
	const snippet = await tb.tools
		.get("notify_snippet")
		.execute("thr-snippet", { purpose: "a command", text: "ls" }, undefined, undefined, tb.ctx);
	check(
		"a tool call refuses at once during a long shared throttle and says how long it lasts",
		snippet.isError === true &&
			/throttling this bot for \d+ more seconds?/.test(JSON.stringify(snippet.content)) &&
			Date.now() - startedAt < 1000 &&
			called("sendMessage").length === sendsBefore,
	);

	// A toast has its own short deadline and is never held back.
	api.queued = [
		{
			update_id: 6690,
			callback_query: {
				id: "thr-toast",
				data: "o:nobody-1:0:0",
				from: { id: CHAT },
				message: { message_id: 1, chat: { id: CHAT } },
			},
		},
	];
	const toastsBefore = called("answerCallbackQuery").length;
	await ta.pump(250);
	await tb.pump(250);
	check("a toast is answered during the shared throttle", called("answerCallbackQuery").length > toastsBefore);

	// A toast Telegram throttles is tried once more after its retry_after, since it is never held back.
	api.failMethods = ["answerCallbackQuery"];
	api.failStatus = 429;
	api.failRetryAfter = 1;
	api.failDescription = "Too Many Requests: retry after 1";
	api.queued = [
		{
			update_id: 6691,
			callback_query: {
				id: "thr-toast-429",
				data: "o:nobody-1:0:0",
				from: { id: CHAT },
				message: { message_id: 1, chat: { id: CHAT } },
			},
		},
	];
	await ta.pump(250);
	await tb.pump(250);
	await settle(1_600);
	api.failMethods = [];
	api.failStatus = undefined;
	api.failRetryAfter = undefined;
	api.failDescription = undefined;
	const toastTries = called("answerCallbackQuery").filter((c) => c.body.callback_query_id === "thr-toast-429");
	check(
		"a throttled toast is tried once more after its retry_after",
		toastTries.length === 2 && toastTries[1].at - toastTries[0].at >= 1_000,
	);

	// A detached send waits the throttle out, then goes.
	writeFileSync(throttleFile, JSON.stringify({ until: Date.now() + 1500 }));
	await turnEnd(tb, "Waited status.");
	await settle(300);
	const heldBack = statusSends("Waited status.") === 0;
	await settle(2000);
	check(
		"a detached send waits out the shared throttle and is then sent",
		heldBack && statusSends("Waited status.") === 1,
	);

	// Shutdown ends a wait, so no throttle keeps a closing session alive.
	writeFileSync(throttleFile, JSON.stringify({ until: Date.now() + 60_000 }));
	await turnEnd(ta, "Never sent.");
	await settle(300);
	await ta.fire("session_shutdown");
	await settle(600);
	check(
		"shutdown releases a send waiting on the shared throttle without sending it",
		statusSends("Never sent.") === 0 && ta.warns.some((w) => JSON.stringify(w.meta ?? {}).includes("held back")),
	);
	rmSync(throttleFile, { force: true });
	await tb.fire("session_shutdown");
}

heading("paced release after a throttle");
{
	const readJsonFileSafe = (path) => {
		try {
			return JSON.parse(readFileSync(path, "utf8"));
		} catch {
			return null;
		}
	};
	const throttleFile = join(root, "notify-telegram/throttle.json");
	const sentAt = (summary) => called("sendMessage").find((c) => String(c.body.text).includes(summary))?.at;
	const turnEnd = async (session, summary) => {
		await session.fire("input");
		await session.tools
			.get("notify_status")
			.execute(`paced-${summary}`, { summary, urgency: "green", effect: "none" }, undefined, undefined, session.ctx);
		await session.fire("session_stop");
	};
	rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
	const peers = [];
	for (const index of [0, 1, 2]) {
		const peer = spawn(`01a06031-000${index}-0000-0000-000000000000`, `/home/dev/work/paced-${index}`);
		await peer.fire("session_start");
		peers.push(peer);
	}

	// Telegram has not objected, so turn ends ending together are sent together.
	await turnEnd(peers[0], "Unpaced first.");
	await turnEnd(peers[1], "Unpaced second.");
	await settle(300);
	check(
		"sends are not paced while Telegram has not throttled the bot",
		Math.abs((sentAt("Unpaced first.") ?? 0) - (sentAt("Unpaced second.") ?? Number.POSITIVE_INFINITY)) < 250,
	);

	// Every send that waited out the deadline would fire in the same tick and earn the next 429. They go one
	// per second instead, the seed's own retry included.
	api.failMethods = ["sendMessage"];
	api.failStatus = 429;
	api.failRetryAfter = 1;
	api.failDescription = "Too Many Requests: retry after 1";
	await turnEnd(peers[0], "Paced seed.");
	await settle(100);
	api.failMethods = [];
	api.failStatus = undefined;
	api.failRetryAfter = undefined;
	api.failDescription = undefined;
	await turnEnd(peers[1], "Paced one.");
	await turnEnd(peers[2], "Paced two.");
	await settle(4500);
	const released = ["Paced seed.", "Paced one.", "Paced two."].map(sentAt);
	const ordered = released.filter((at) => at !== undefined).sort((a, b) => a - b);
	check(
		"sends released by a passing throttle go out one per second",
		ordered.length === 3 && ordered[1] - ordered[0] >= 900 && ordered[2] - ordered[1] >= 900,
	);

	// A process that died holding the throttle lock would stall every paced send of every process, so a lock that
	// old is broken.
	const throttleLock = join(root, "notify-telegram/throttle.lock");
	writeFileSync(throttleFile, JSON.stringify({ until: 0, paceUntil: Date.now() + 30_000, next: 0 }));
	writeFileSync(throttleLock, "");
	const deadHolder = (baseNow() - 5_000) / 1000;
	utimesSync(throttleLock, deadHolder, deadHolder);
	await turnEnd(peers[1], "Past a dead lock.");
	await settle(300);
	check(
		"a throttle lock left by a dead process is broken, so paced sends go on",
		sentAt("Past a dead lock.") !== undefined && !existsSync(throttleLock),
	);

	// A board edit nobody waits on yields to a turn end that arrives after it while sends are paced. The pacing is
	// seeded only once the board is posted, with a slot already booked 1.5 s ahead.
	rmSync(throttleFile, { force: true });
	writeConfig({ pinnedDashboard: true, dashboardSeconds: 0 });
	const board = spawn("01a06031-0004-0000-0000-000000000000", "/home/dev/work/paced-board");
	await board.fire("session_start");
	await turnEnd(board, "Board owner done.");
	await settle(150);
	await board.pump(250);
	const boardId = readJsonFileSafe(join(root, "notify-telegram/dashboard.json"))?.messageId;
	writeFileSync(throttleFile, JSON.stringify({ until: 0, paceUntil: Date.now() + 30_000, next: Date.now() + 1500 }));
	await board.fire("agent_start");
	await board.fire("tool_execution_start", { toolName: "bash", intent: "Paced build" });
	await settle(60);
	await board.pump(300);
	await turnEnd(peers[2], "Ahead of the board.");
	// Every foreground send booked meanwhile goes first, so the edit lands only once the slots ahead are spent.
	const boardEdit = () =>
		called("editMessageText").find((c) => c.body.message_id === boardId && String(c.body.text).includes("Paced build"))
			?.at;
	const boardDeadline = Date.now() + 10_000;
	while (boardEdit() === undefined && Date.now() < boardDeadline) await settle(100);
	const boardEditAt = boardEdit();
	check(
		"a background board edit waits behind a turn end booked after it",
		boardId !== undefined &&
			boardEditAt !== undefined &&
			(sentAt("Ahead of the board.") ?? Number.POSITIVE_INFINITY) < boardEditAt,
	);
	await board.fire("session_shutdown");
	rmSync(join(root, "notify-telegram/dashboard.json"), { force: true });
	writeConfig();

	// A state directory the lock cannot be created in fails the send instead of spinning on the lock forever, and
	// the turn end goes once the directory is writable again.
	const stateDir = join(root, "notify-telegram");
	writeFileSync(throttleFile, JSON.stringify({ until: 0, paceUntil: Date.now() + 30_000, next: 0 }));
	chmodSync(stateDir, 0o500);
	await turnEnd(peers[1], "Past a locked directory.");
	await settle(300);
	const failedWhileLocked = sentAt("Past a locked directory.") === undefined;
	chmodSync(stateDir, 0o700);
	await settle(2_500);
	check(
		"a lock that cannot be created fails the send, which goes once the state directory is writable",
		failedWhileLocked &&
			peers[1].warns.some((w) => /send.*failed/.test(w.m)) &&
			sentAt("Past a locked directory.") !== undefined,
	);

	// A late 429 with a shorter retry_after never shortens the deadline another process was given.
	rmSync(throttleFile, { force: true });
	let releaseLate;
	const lateResponse = new Promise((resolve) => {
		releaseLate = resolve;
	});
	const realFetch = globalThis.fetch;
	globalThis.fetch = async (url, init) => {
		if (String(url).endsWith("/sendMessage") && String(init.body).includes("Late refusal.")) {
			await lateResponse;
			return {
				ok: false,
				status: 429,
				json: async () => ({
					ok: false,
					description: "Too Many Requests: retry after 1",
					parameters: { retry_after: 1 },
				}),
			};
		}
		return realFetch(url, init);
	};
	await turnEnd(peers[0], "Late refusal.");
	await settle(100);
	const longDeadline = Date.now() + 40_000;
	writeFileSync(throttleFile, JSON.stringify({ until: longDeadline, paceUntil: longDeadline + 30_000, next: 0 }));
	releaseLate();
	await settle(100);
	globalThis.fetch = realFetch;
	check(
		"a late 429 with a shorter retry_after keeps the longer shared deadline",
		readJsonFileSafe(throttleFile)?.until === longDeadline,
	);

	// A tool the agent is blocked on refuses at once when the slot it would get is more than 30 s away.
	writeFileSync(throttleFile, JSON.stringify({ until: 0, paceUntil: Date.now() + 120_000, next: Date.now() + 60_000 }));
	const snippetStart = Date.now();
	const pacedSnippet = await peers[0].tools
		.get("notify_snippet")
		.execute("paced-snippet", { purpose: "a command", text: "ls" }, undefined, undefined, peers[0].ctx);
	check(
		"a tool call refuses at once when its paced slot is over 30 s away, and says how long",
		pacedSnippet.isError === true &&
			/throttling this bot for \d+ more seconds/.test(JSON.stringify(pacedSnippet.content)) &&
			Date.now() - snippetStart < 1000,
	);

	// A lock that vanishes between the failed create and the age check is taken on the next pass.
	writeFileSync(throttleFile, JSON.stringify({ until: 0, paceUntil: Date.now() + 30_000, next: 0 }));
	writeFileSync(throttleLock, "");
	const realStat = fs.statSync;
	fs.statSync = (path, options) => {
		if (String(path).endsWith("throttle.lock")) rmSync(path, { force: true });
		return realStat(path, options);
	};
	syncBuiltinESMExports();
	await turnEnd(peers[1], "Past a vanished lock.");
	await settle(300);
	fs.statSync = realStat;
	syncBuiltinESMExports();
	check(
		"a lock that vanishes while its age is read is taken on the next pass",
		sentAt("Past a vanished lock.") !== undefined,
	);

	// Shutdown never waits for a paced slot, since omp gives the handler two seconds.
	writeFileSync(throttleFile, JSON.stringify({ until: 0, paceUntil: Date.now() + 30_000, next: Date.now() + 3_000 }));
	const callsAtShutdown = api.calls.length;
	await turnEnd(peers[2], "Waiting for a slot.");
	await settle(100);
	for (const peer of peers) await peer.fire("session_shutdown");
	await settle(3_500);
	check(
		"shutdown refuses a send that would wait for a paced slot",
		peers.some((peer) => peer.warns.some((w) => JSON.stringify(w.meta ?? {}).includes("held back"))) &&
			api.calls.slice(callsAtShutdown).every((c) => c.method === "getUpdates"),
	);
	rmSync(throttleFile, { force: true });
}

heading("media fetch failures");
{
	rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
	const mediaClock = clockSkew;
	const mf = spawn("01a06021-0000-0000-0000-000000000000", "/home/dev/work/mediafail");
	await mf.fire("session_start");
	// Recency routing would hand these to whichever session notified last, so each update
	// replies to a message this session actually sent.
	await mf.fire("input");
	await mf.tools
		.get("notify_status")
		.execute("mf0", { summary: "Ready for files.", urgency: "green", effect: "none" }, undefined, undefined, mf.ctx);
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

	// A throttle, a server error or a broken connection says nothing about the file, whose id Telegram keeps for
	// good, so the download waits and is tried again instead of dropping what the user sent.
	const retried = async (fileId, fail, recover) => {
		fail();
		const queued = await dropped(fileId);
		recover();
		const before = mf.steers.length;
		jump(16_000);
		mf.heartbeat();
		await settle(150);
		await mf.pump(250);
		return { notice: queued.notice, queued: !queued.delivered, delivered: mf.steers.length > before };
	};
	const throttled = await retried(
		"throttled",
		() => {
			api.failMethods = ["getFile"];
			api.failStatus = 429;
		},
		() => {
			api.failMethods = [];
			api.failStatus = undefined;
		},
	);
	check(
		"a throttled getFile is queued with a notice that it will be tried again",
		throttled.queued && throttled.notice.includes("tried again") && !throttled.notice.includes("20 MB"),
	);
	check("a throttled getFile is delivered once Telegram hands the file over", throttled.delivered);
	const serverError = await retried(
		"rejected",
		() => {
			api.fileDownload = "error";
		},
		() => {
			api.fileDownload = "ok";
		},
	);
	check(
		"a download the server fails is queued, not dropped",
		serverError.queued && serverError.notice.includes("tried again"),
	);
	check("a download the server failed is delivered on a later attempt", serverError.delivered);
	check("a failed download leaves a trace", traced("download rejected"));
	const brokenPipe = await retried(
		"broken",
		() => {
			api.fileDownload = "throw";
		},
		() => {
			api.fileDownload = "ok";
		},
	);
	check(
		"a download whose connection broke is queued, not dropped",
		brokenPipe.queued && brokenPipe.notice.includes("tried again"),
	);
	check("a download whose connection broke is delivered on a later attempt", brokenPipe.delivered);
	check("a thrown download leaves a trace", traced("download failed"));
	check("a refused getFile does not blame the 20 MB ceiling", !refused.notice.includes("20 MB"));
	const thrownLookup = await retried(
		"lookup",
		() => {
			api.getFileThrows = true;
		},
		() => {
			api.getFileThrows = false;
		},
	);
	check(
		"a getFile whose request failed is queued and delivered later",
		thrownLookup.queued && thrownLookup.notice.includes("tried again") && thrownLookup.delivered,
	);

	api.fileDownload = "forbidden";
	const forbidden = await dropped("forbidden");
	api.fileDownload = "ok";
	check(
		"a download refused outright drops the file and names the status",
		!forbidden.delivered && forbidden.notice.includes("403"),
	);
	api.fileDownload = "huge";
	const huge = await dropped("huge");
	api.fileDownload = "ok";
	check("a file found over 20 MB once downloaded is dropped with the ceiling notice", huge.notice.includes("20 MB"));
	api.failMethods = ["getFile"];
	api.failDescription = "Bad Request: file is too big";
	const tooBig = await dropped("toobig");
	api.failMethods = [];
	api.failDescription = undefined;
	check("Telegram's own too-big refusal gets the ceiling notice", tooBig.notice.includes("20 MB"));

	// A deferred file that fails again waits longer, and one refused for good on a later try is dropped with
	// Telegram's reason.
	const retryDir = join(root, "notify-telegram/media-retry");
	const retryJobs = () =>
		readdirSync(retryDir)
			.filter((name) => name.endsWith(".json"))
			.map((name) => JSON.parse(readFileSync(join(retryDir, name), "utf8")));
	api.failMethods = ["getFile"];
	api.failStatus = 429;
	const stubborn = await dropped("stubborn");
	const lookupsQueued = called("getFile").length;
	mf.heartbeat();
	await settle(150);
	check("a deferred file is not tried before its wait is over", called("getFile").length === lookupsQueued);
	jump(16_000);
	mf.heartbeat();
	await settle(150);
	check(
		"a deferred file that fails again stays queued for a later try",
		!stubborn.delivered && retryJobs().length === 1 && retryJobs()[0].attempts === 2,
	);
	api.failStatus = 400;
	api.failDescription = "Bad Request: wrong file_id";
	jump(31_000);
	mf.heartbeat();
	await settle(150);
	api.failMethods = [];
	api.failStatus = undefined;
	api.failDescription = undefined;
	check(
		"a deferred file refused for good on a later try is dropped with that reason",
		retryJobs().length === 0 && lastCall("sendMessage").body.text.includes("wrong file_id"),
	);

	// A retry job torn by a crash mid-write is discarded rather than read again on every heartbeat.
	writeFileSync(join(retryDir, "99999.json"), "{");
	mf.heartbeat();
	await settle(150);
	check("a torn retry job is discarded", !existsSync(join(retryDir, "99999.json")));

	const good = await dropped("good");
	check("a healthy download still reaches the session", good.delivered);
	clockSkew = mediaClock;
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

	// An option with a description but no stance renders its section and an unstyled button.
	await ro.fire("input");
	await ro.tools
		.get("notify_status")
		.execute(
			"ro2",
			{ summary: "Simple.", urgency: "orange", options: opts("Continue", "Stop") },
			undefined,
			undefined,
			ro.ctx,
		);
	await ro.fire("session_stop");
	await settle(150);
	const plain = lastCall("sendMessage").body;
	const plainButtons = plain.reply_markup.inline_keyboard.flat();
	check("unmarked options still render two buttons", plainButtons.length === 2);
	check(
		"unmarked options carry no stance marker",
		plainButtons.every((b) => !b.text.includes("(")),
	);
	check(
		"unmarked options carry no style",
		plainButtons.every((b) => b.style === undefined),
	);
	check(
		"an unmarked option still explains itself in the body",
		plain.text.includes('<b>Continue</b>\nwhat "Continue" does'),
	);

	// A malformed option costs the whole notification a round trip, not a silent half-list.
	await ro.fire("input");
	const bad = await ro.tools
		.get("notify_status")
		.execute(
			"ro3",
			{ summary: "Bad.", urgency: "orange", options: [{ label: "Fine", description: "works" }, { note: "no label" }] },
			undefined,
			undefined,
			ro.ctx,
		);
	check("an option without a label is refused", bad.isError === true);
	check("an option without a label is counted in the refusal", /1 of 2 carry no label/.test(bad.content[0].text));
	await ro.fire("session_stop");
	await settle(150);
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
			.execute(
				`agg${index}`,
				{ summary: `${folder} is done.`, urgency: "green", effect: "none" },
				undefined,
				undefined,
				s.ctx,
			);
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
	check(
		"the reply stamps each summary with a client-rendered relative time",
		/<tg-time unix="\d+" format="r">\d\d:\d\d<\/tg-time>/.test(roll),
	);
	check("the reply goes out as HTML so the stamp is an entity", lastCall("sendMessage").body.parse_mode === "HTML");

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
	check("the /status answer is cut to the limit", wireLength(bigStatus?.body.text ?? "") <= 4096);
	// The answer goes out as HTML now, so the limit is what Telegram counts once entities are
	// parsed: an escaped ampersand costs one, and budgeting for the escape would cut a summary
	// dense in them about five times earlier than it has to.
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
	check("a /status dense in special characters still fits", wireLength(denseStatus?.body.text ?? "") <= 4096);
	check("a /status dense in special characters is not cut early", wireLength(denseStatus?.body.text ?? "") > 3500);

	// The picker that asks which session a bare message belongs to carries the same blocks, and in
	// a fleet this size every session is a rival.
	const pickerFrom = api.calls.length;
	api.queued = [{ update_id: 913, message: { message_id: 913, date: 1, chat: { id: CHAT }, text: "which of you?" } }];
	for (const s of trio) await s.pump(250);
	const bigPicker = api.calls
		.slice(pickerFrom)
		.find((c) => (c.body.reply_markup?.inline_keyboard ?? []).flat().some((b) => b.callback_data?.startsWith("m:")));
	check("a which-session picker is still sent for a big fleet", bigPicker !== undefined);
	check("the which-session picker is cut to the limit", wireLength(bigPicker?.body.text ?? "") <= 4096);
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
			"  list-panes)",
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
		.execute("td1", { summary: "Timed turn.", urgency: "green", effect: "none" }, undefined, undefined, td.ctx);
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
		.execute("td2", { summary: "No loop ran.", urgency: "green", effect: "none" }, undefined, undefined, tdNone.ctx);
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
		.execute("ir1", { summary: "Done, over to you.", urgency: "green", effect: "none" }, undefined, undefined, ir.ctx);
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
	check("the reply reaches the session", steerText(delivered) === "go on then");
	// A steer interrupts a running turn. An idle session has none, so the message is dropped.
	check("a reply to an idle session does not ask for a steer", delivered?.options?.deliverAs !== "steer");
	check(
		"a reply carries the whole message it answers, as this session sent it",
		referenceOf(delivered).includes("Done, over to you."),
	);
	const replyFrom = (updateId, text, extra) => ({
		update_id: updateId,
		message: {
			message_id: updateId,
			date: 1,
			chat: { id: CHAT },
			text,
			reply_to_message: { message_id: summaryId },
			...extra,
		},
	});
	api.queued = [replyFrom(943, "why this part?", { quote: { text: "over to you", position: 6 } })];
	await ir.pump(250);
	await ir.pump(250);
	const quoted = ir.steers.at(-1);
	check(
		"a reply that quotes part of the message carries only that part",
		referenceOf(quoted).includes("over to you") &&
			!referenceOf(quoted).includes("Done,") &&
			steerText(quoted) === "why this part?",
	);
	rmSync(join(root, "notify-telegram/sent", `${summaryId}.json`), { force: true });
	api.queued = [
		replyFrom(944, "and now?", { reply_to_message: { message_id: summaryId, text: "Rendered by Telegram" } }),
	];
	await ir.pump(250);
	await ir.pump(250);
	check(
		"without a sent record a reply carries Telegram's copy of the message",
		referenceOf(ir.steers.at(-1)).includes("Rendered by Telegram") && steerText(ir.steers.at(-1)) === "and now?",
	);
	// A reply to a message with no text anywhere, such as a photo without a caption, has nothing to show.
	api.queued = [replyFrom(945, "plain please")];
	await ir.pump(250);
	await ir.pump(250);
	check("a reply whose message has no text arrives as the plain text", ir.steers.at(-1)?.text === "plain please");
	const replyDoc = join(root, "idle-reply.pdf");
	writeFileSync(replyDoc, "pdf-bytes");
	writeFileSync(
		join(inboxOf(ir.id), "946.json"),
		JSON.stringify({
			kind: "file",
			value: replyDoc,
			mime: "application/pdf",
			messageId: 946,
			replyTo: summaryId,
			replyText: "Rendered by Telegram",
		}),
	);
	await ir.pump(250);
	check(
		"a file sent as a reply carries the message it answers",
		referenceOf(ir.steers.at(-1)).includes("Rendered by Telegram") &&
			steerText(ir.steers.at(-1)).includes("The user sent a file"),
	);

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

heading("a bad options list costs a retry, never the notification");
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

	// a. Nothing usable in the list. The status is refused whole, so the retry can carry buttons.
	const allBad = await send("bo1", {
		summary: "The work is done.",
		urgency: "green",
		effect: "none",
		question: "What next?",
		options: [{ note: "no label" }, 42],
	});
	check("an unusable options list is refused", allBad.isError);
	check("an unusable options list records no status", !allBad.text.includes("The work is done."));
	check("an unusable options list blocks the turn for a retry", allBad.blocked);
	check("an unusable options list explains itself to the agent", /carry no label/.test(allBad.note));

	// b. Both faults at once, each named, so one retry can fix the whole list.
	const mixed = await send("bo2", {
		summary: "Half of these are fine.",
		urgency: "orange",
		options: ["Keep going", { label: "Stop here" }, { nope: true }],
	});
	check("a half-described list is refused", mixed.isError);
	check(
		"a half-described list names the undescribed options",
		/"Keep going", "Stop here" carry no description/.test(mixed.note),
	);
	check("a half-described list also counts the unlabelled one", /1 of 3 carry no label/.test(mixed.note));

	// c. Too many is a trim, not a loss.
	const tooMany = await send("bo3", {
		summary: "Seven choices.",
		urgency: "orange",
		options: opts("a", "b", "c", "d", "e", "f", "g"),
	});
	check("more than six options still send the summary", tooMany.text.includes("Seven choices."));
	check("more than six options render six buttons", tooMany.buttons.length === 6);
	check("more than six options say so", /option/i.test(tooMany.note));

	// d. One option is not a choice, so no fake single button, but the summary lives.
	const lonely = await send("bo4", { summary: "Only one left.", urgency: "orange", options: opts("Only this") });
	check("a single option still sends the summary", lonely.text.includes("Only one left."));
	check("a single option offers no buttons", lonely.buttons.length === 0);

	// e. A clean list is untouched and draws no complaint.
	const good = await send("bo5", { summary: "All good.", urgency: "orange", options: opts("Yes", "No") });
	check("a valid options list still renders", good.buttons.length === 2);
	check("a valid options list draws no complaint", !/dropped|unusable|ignored|refused/i.test(good.note));

	// f. A tapped button starts the next turn as the user's own words, so I and you name nobody.
	const voiced = await send("bo6", {
		summary: "Ready to land.",
		urgency: "orange",
		options: [
			{ label: "I'll merge it", description: "Lands on main now." },
			{ label: "Hold", description: "You review the diff first." },
			{ label: "Close the PR", description: "The branch is dropped." },
		],
	});
	check("a voiced options list is refused", voiced.isError);
	check("a voiced options list records no status", !voiced.text.includes("Ready to land."));
	check("a voiced options list blocks the turn for a retry", voiced.blocked);
	check(
		"the refusal names each voiced option and the word it used",
		voiced.note.includes('"I" in "I\'ll merge it"') &&
			voiced.note.includes('"You" in "Hold"') &&
			!voiced.note.includes("Close the PR"),
	);
	check(
		"the refusal asks for Agent and the user by name",
		voiced.note.includes('"Agent will') && voiced.note.includes('"User will'),
	);
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
			.execute(
				`${folder}1`,
				{ summary: `${folder} finished.`, urgency: "green", effect: "none" },
				undefined,
				undefined,
				s.ctx,
			);
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

	// c2. A pick on a picker no session ever recorded closes it without making it a reply target.
	const unrecordedPicker = 959_001;
	api.queued = [
		{
			update_id: 957,
			callback_query: {
				id: "cbpick3",
				data: `m:958:${rightTag}`,
				from: { id: CHAT },
				message: { message_id: unrecordedPicker, chat: { id: CHAT } },
			},
		},
	];
	await left.pump(250);
	check(
		"a gone pick on an unrecorded picker closes it without recording it",
		/no longer waiting/i.test(
			called("editMessageText").find((c) => c.body.message_id === unrecordedPicker)?.body.text ?? "",
		) && !existsSync(join(root, `notify-telegram/sent/${unrecordedPicker}.json`)),
	);

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
	check("a reply skips the picker entirely", steerText(right.steers.at(-1)) === "answering directly");

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

	// g. The picker is the held message's only route, so a 5xx on its first send must not lose it.
	for (const entry of readdirSync(sessionsDir)) {
		const path = join(sessionsDir, entry);
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8"));
			const mine = entry.startsWith(left.id) || entry.startsWith(right.id);
			writeFileSync(
				path,
				JSON.stringify({ ...parsed, lastNotified: mine ? Date.now() - 10_000 : 0, heartbeat: Date.now() }),
			);
		} catch {}
	}
	api.failMethods = ["sendMessage"];
	api.failStatus = 500;
	const pickerFrom = api.calls.length;
	api.queued = [
		{ update_id: 964, message: { message_id: 964, date: 1, chat: { id: CHAT }, text: "which one of you" } },
	];
	await left.pump(300);
	const pickerAttempts = () =>
		api.calls
			.slice(pickerFrom)
			.filter(
				(c) =>
					c.method === "sendMessage" &&
					(c.body.reply_markup?.inline_keyboard ?? []).flat().some((b) => b.callback_data === `m:964:${rightTag}`),
			);
	api.failMethods = [];
	api.failStatus = undefined;
	jump(3_000);
	await left.pump(300);
	check("a picker whose first send hit a 5xx is sent again", pickerAttempts().length === 2);
	const pickedId = api.nextMessage - 1;
	api.queued = [
		{
			update_id: 965,
			callback_query: {
				id: "cbpickg",
				data: `m:964:${rightTag}`,
				from: { id: CHAT },
				message: { message_id: pickedId, chat: { id: CHAT } },
			},
		},
	];
	await left.pump(250);
	await right.pump(250);
	check("the held message still lands after the picker's retry", right.steers.at(-1)?.text === "which one of you");
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
		.execute("cf1", { summary: "Should stay quiet.", urgency: "green", effect: "none" }, undefined, undefined, cf.ctx);
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
		.execute("cf2", { summary: "Back on the air.", urgency: "green", effect: "none" }, undefined, undefined, cf.ctx);
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

heading("dashboard pin recovery");
{
	rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
	rmSync(join(root, "notify-telegram/dashboard.json"), { force: true });
	rmSync(join(root, "notify-telegram/dashboard.lock"), { force: true });
	// The fleet is fixed for the duration, so only the pin work under test can rewrite the board.
	mkdirSync(sessionsDir, { recursive: true });
	for (const stale of readdirSync(sessionsDir)) {
		rmSync(join(sessionsDir, stale), { force: true });
	}
	writeConfig({ pinnedDashboard: true, dashboardSeconds: 0 });
	const dash = spawn("01a07d00-0000-0000-0000-000000000000", "/home/dev/work/dash-pin");
	await dash.fire("session_start");
	const boardFile = () => JSON.parse(readFileSync(join(root, "notify-telegram/dashboard.json"), "utf8"));
	const boardSends = () =>
		api.calls.filter(
			(c) => c.method === "sendMessage" && typeof c.body.text === "string" && c.body.text.includes("Fleet"),
		);
	const boardEdits = () =>
		api.calls.filter(
			(c) => c.method === "editMessageText" && typeof c.body.text === "string" && c.body.text.includes("Fleet"),
		);
	const boardPins = (id) => called("pinChatMessage").filter((c) => c.body.message_id === id);

	// a. A red status pin must survive the board's own pin work.
	await dash.fire("input");
	await dash.tools
		.get("notify_status")
		.execute("dr-red", { summary: "Red and pinned.", urgency: "red" }, undefined, undefined, dash.ctx);
	await dash.fire("session_stop");
	await settle(150);
	const redId = record(dash.id).pinned;

	// b. A refused first pin is retried on the recorded message, never by a second post.
	const preB = boardSends().length;
	api.failMethods = ["pinChatMessage"];
	api.failDescription = "Too Many Requests: retry after 2";
	await dash.pump(250);
	api.failMethods = [];
	api.failDescription = undefined;
	const firstId = boardFile().messageId;
	const pinB = called("pinChatMessage").length;
	await dash.pump(250);
	await dash.pump(250);
	check(
		"a refused first pin is retried on the same message",
		called("pinChatMessage").at(-1)?.body.message_id === firstId && called("pinChatMessage").length === pinB + 1,
	);
	check("the retry lands the pin", api.pinned.has(firstId) === true);
	check("a refused first pin posts no duplicate board", boardSends().length === preB + 1);
	check(
		"the recovery leaves the red status pin alone",
		api.pinned.has(redId) === true && called("unpinChatMessage").every((c) => c.body.message_id !== redId),
	);

	// c. A refused edit must not lose the pin the board still owes.
	rmSync(join(root, "notify-telegram/dashboard.json"), { force: true });
	api.failMethods = ["pinChatMessage"];
	api.failDescription = "Too Many Requests: retry after 2";
	await dash.pump(250);
	api.failMethods = [];
	api.failDescription = undefined;
	const owedId = boardFile().messageId;
	const owedSends = boardSends().length;
	api.failMethods = ["editMessageText"];
	api.failDescription = "Too Many Requests: retry after 3";
	await dash.fire("agent_start");
	await dash.fire("tool_execution_start", { toolName: "bash", intent: "Owing a pin" });
	await settle(60);
	await dash.pump(250);
	api.failMethods = [];
	api.failDescription = undefined;
	check("a refused edit posts no duplicate", boardSends().length === owedSends);
	await dash.fire("tool_execution_end", {});
	await dash.fire("tool_execution_start", { toolName: "bash", intent: "Settling it" });
	await settle(60);
	await dash.pump(250);
	check(
		"a settled edit pins the message it still owes",
		boardPins(owedId).length === 2 && api.pinned.has(owedId) === true,
	);
	check("a settled edit posts no duplicate board", boardSends().length === owedSends);
	await dash.fire("tool_execution_end", {});
	await dash.fire("agent_end");
	await settle(60);

	// d. The confirmation lives in the shared record, so a new owner adopts it without a second post.
	rmSync(join(root, "notify-telegram/dashboard.json"), { force: true });
	api.failMethods = ["pinChatMessage"];
	api.failDescription = "Too Many Requests: retry after 2";
	dash.heartbeat();
	await settle(60);
	await dash.pump(250);
	api.failMethods = [];
	api.failDescription = undefined;
	const handedId = boardFile().messageId;
	writeFileSync(
		join(root, "notify-telegram/dashboard.lock"),
		JSON.stringify({
			sessionId: "01a07d99-0000-0000-0000-000000000000",
			pid: process.pid,
			heartbeat: Date.now() - 120_000,
		}),
	);
	const successor = spawn("01a07d01-0000-0000-0000-000000000000", "/home/dev/work/dash-pin-two");
	await successor.fire("session_start");
	// A stale successor stays out of the fleet view, so the board text is what the previous owner drew.
	writeFileSync(
		join(sessionsDir, `${successor.id}.json`),
		JSON.stringify({
			pid: process.pid,
			tag: "dashx",
			cwd: "/home/dev/work/dash-pin-two",
			heartbeat: Date.now() - 120_000,
		}),
	);
	const handSends = boardSends().length;
	const handEdits = boardEdits().length;
	const handPins = called("pinChatMessage").length;
	await successor.pump(250);
	check(
		"the successor takes the stale board claim",
		JSON.parse(readFileSync(join(root, "notify-telegram/dashboard.lock"), "utf8")).sessionId === successor.id,
	);
	check(
		"the successor pins the adopted board",
		called("pinChatMessage").at(-1)?.body.message_id === handedId &&
			called("pinChatMessage").length === handPins + 1 &&
			api.pinned.has(handedId) === true,
	);
	check("the successor posts no duplicate board", boardSends().length === handSends);
	check("the successor edits nothing when only the pin is owed", boardEdits().length === handEdits);

	// e. A record older than the confirmation field owes an idempotent re-pin, never a repost.
	const legacyText = boardFile().text;
	writeFileSync(
		join(root, "notify-telegram/dashboard.json"),
		JSON.stringify({ messageId: handedId, text: legacyText }),
	);
	const legacyPins = called("pinChatMessage").length;
	const legacySends = boardSends().length;
	await successor.pump(250);
	check(
		"a legacy board record is re-pinned, not reposted",
		called("pinChatMessage").at(-1)?.body.message_id === handedId && called("pinChatMessage").length === legacyPins + 1,
	);
	check(
		"the re-pin lands quietly",
		api.pinned.has(handedId) === true && lastCall("pinChatMessage").body.disable_notification === true,
	);
	check("a legacy board record posts no duplicate board", boardSends().length === legacySends);

	// f. A first post still in flight is the only one the owner owes.
	rmSync(join(root, "notify-telegram/dashboard.json"), { force: true });
	rmSync(join(root, "notify-telegram/dashboard.lock"), { force: true });
	const gate = Promise.withResolvers();
	api.sendMessageGate = gate.promise;
	const inflightSends = boardSends().length;
	dash.heartbeat();
	await settle(60);
	await dash.pump(250);
	await dash.pump(250);
	await dash.pump(250);
	gate.resolve();
	await settle(300);
	api.sendMessageGate = null;
	check("an in-flight first post is not followed by a second", boardSends().length === inflightSends + 1);
	check("the in-flight post lands pinned", api.pinned.has(boardFile().messageId) === true);

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
	const owner = spawn("01a060e8-0000-0000-0000-000000000000", "/home/dev/work/dash-owner");
	await owner.fire("session_start");
	await owner.fire("input");
	await owner.tools
		.get("notify_status")
		.execute("d1", { summary: "Owner is done.", urgency: "green", effect: "none" }, undefined, undefined, owner.ctx);
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
	// The time beside the summary is a date_time entity the phone renders relative to now, so the
	// text on the wire is fixed and the client keeps "4 minutes ago" current on its own.
	check(
		"the dashboard stamps the summary with a client-rendered relative time",
		/<tg-time unix="\d+" format="r">\d\d:\d\d<\/tg-time>/.test(board?.text ?? "") && board?.parse_mode === "HTML",
	);
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
	const bystander = spawn("01a060e9-0000-0000-0000-000000000000", "/home/dev/work/dash-bystander");
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
	check("a fleet too big for one message is cut to the limit", wireLength(bigBoard?.body.text ?? "") <= 4096);
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
			"  list-panes)",
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

heading("one standard message head");
{
	rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
	const hd = spawn("01a060e0-0000-0000-0000-000000000000", "/home/dev/work/headline");
	await hd.fire("session_start");
	const hdTag = record(hd.id).tag;
	const head = `${record(hd.id).emoji} headline \u00B7 ${hdTag}\nTask: headline [${hdTag}] | Model: openai/gpt-5.6-sol | Tmux: not attached`;

	// a. A plain turn-end summary.
	await hd.fire("input");
	await hd.tools
		.get("notify_status")
		.execute("hd1", { summary: "The suite is green.", urgency: "green", effect: "none" }, undefined, undefined, hd.ctx);
	await hd.fire("session_stop");
	await settle(150);
	check(
		"a turn-end summary opens with the standard head",
		lastCall("sendMessage").body.text.startsWith(`${head}\n\n<b>\u{1F7E2} Turn finished</b>`),
	);

	// b. A turn-end choice.
	await hd.fire("input");
	await hd.tools.get("notify_status").execute(
		"hd2",
		{
			summary: "Two ways.",
			urgency: "orange",
			question: "Which one?",
			options: [
				{ label: "First", description: "Takes the fast path." },
				{ label: "Second", description: "Takes the safe path." },
			],
		},
		undefined,
		undefined,
		hd.ctx,
	);
	await hd.fire("session_stop");
	await settle(150);
	check("a turn-end choice opens with the standard head", lastCall("sendMessage").body.text.startsWith(head));

	// c. An ask question.
	const hdState = {};
	const hdAsk = hd.tools
		.get("ask")
		.execute(
			"hd3",
			{ questions: [{ id: "q", question: "Ready?", options: askOpts("Yes", "No") }] },
			undefined,
			undefined,
			stubbornCtx(hd.ctx, hdState),
		);
	await settle(150);
	const hdAskBody = lastCall("sendMessage").body;
	check("an ask question opens with the standard head", hdAskBody.text.startsWith(head));
	check("an ask question no longer repeats the location in its title", !hdAskBody.text.includes("(tmux"));
	const hdAskId = hdAskBody.reply_markup.inline_keyboard[0][0].callback_data.split(":")[1];
	writeFileSync(join(inboxOf(hd.id), "5099.json"), JSON.stringify({ kind: "callback", value: `t:${hdAskId}:0` }));
	await hd.pump(250);
	check("the free-text prompt opens with the standard head", lastCall("sendMessage").body.text.startsWith(head));
	writeFileSync(join(inboxOf(hd.id), "5100.json"), JSON.stringify({ kind: "callback", value: `o:${hdAskId}:0:0` }));
	await hd.pump(250);
	await hdAsk;
	check("a settled ask keeps the standard head", lastCall("editMessageText").body.text.startsWith(head) === true);

	// d. An approval notice and its resolution.
	await hd.fire("tool_approval_requested", { toolCallId: "hdt1", toolName: "bash" });
	await settle(150);
	check("an approval notice opens with the standard head", lastCall("sendMessage").body.text.startsWith(head));
	await hd.fire("tool_approval_resolved", { toolCallId: "hdt1", approved: true });
	await settle(150);
	check("an approval resolution opens with the standard head", lastCall("editMessageText").body.text.startsWith(head));

	// e. A service reply this session composed.
	writeFileSync(join(inboxOf(hd.id), "5101.json"), JSON.stringify({ kind: "command", value: "status" }));
	await hd.pump(300);
	check(
		"a service reply opens with the standard head",
		lastCall("sendMessage").body.text.startsWith(`\u{1F535} ${head}`),
	);

	// f. A streamed draft.
	await hd.fire("agent_start");
	await hd.fire("message_update", {
		message: { role: "assistant", content: [{ type: "text", text: "Working on it" }] },
	});
	await hd.pump(200);
	check("a draft opens with the standard head", lastCall("sendMessageDraft").body.text.startsWith(head));

	// g. A file caption.
	const hdShot = join(root, "headline.png");
	writeFileSync(hdShot, "png-bytes");
	await hd.tools
		.get("notify_file")
		.execute("hd4", { paths: [hdShot], caption: "the chart" }, undefined, undefined, hd.ctx);
	const hdName = lastCall("sendPhoto").files.f0;
	check(
		"a file caption opens with the standard head",
		lastCall("sendPhoto").body.caption === `${head}\n\nthe chart\n\n${hdName}`,
	);

	// h. Attached to tmux, the location is in the head and nowhere else.
	const headBin = join(root, "head-bin");
	mkdirSync(headBin, { recursive: true });
	writeFileSync(join(headBin, "tmux"), "#!/bin/sh\nprintf 'work\\t3\\t1\\n'\n", { mode: 0o755 });
	const headPath = process.env.PATH;
	process.env.PATH = `${headBin}:${headPath}`;
	process.env.TMUX = "/tmp/fake-tmux,1,0";
	process.env.TMUX_PANE = "%1";
	await hd.fire("input");
	await hd.tools
		.get("notify_status")
		.execute("hd5", { summary: "Attached now.", urgency: "orange" }, undefined, undefined, hd.ctx);
	await hd.fire("session_stop");
	await settle(150);
	const hdAttached = lastCall("sendMessage").body.text;
	check("the head names the tmux pane", hdAttached.includes("Tmux: work:3.1"));
	check("the title does not repeat the tmux pane", !hdAttached.includes("(tmux "));
	process.env.PATH = headPath;
	delete process.env.TMUX;
	delete process.env.TMUX_PANE;
}

heading("every turn-end option explains itself");
{
	rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
	const od = spawn("01a060f0-0000-0000-0000-000000000000", "/home/dev/work/options");
	await od.fire("session_start");

	await od.fire("input");
	const bare = await od.tools
		.get("notify_status")
		.execute(
			"od1",
			{ summary: "Done.", urgency: "orange", question: "What next?", options: ["Continue", "Stop"] },
			undefined,
			undefined,
			od.ctx,
		);
	check("a bare label is refused", bare.isError === true);
	check(
		"the refusal names every option missing its description",
		/Continue/.test(bare.content[0].text) && /Stop/.test(bare.content[0].text),
	);
	const odStop = await od.fire("session_stop");
	check(
		"a refused status still blocks the turn for a retry",
		odStop.some((r) => r?.decision === "block"),
	);
	await settle(150);

	await od.fire("input");
	const described = await od.tools.get("notify_status").execute(
		"od2",
		{
			summary: "Done.",
			urgency: "orange",
			question: "What next?",
			options: [
				{ label: "Continue", description: "Runs the remaining migrations." },
				{ label: "Stop", description: "Leaves the branch as it is." },
			],
		},
		undefined,
		undefined,
		od.ctx,
	);
	check("a described list is accepted", described.isError !== true);
	await od.fire("session_stop");
	await settle(150);
	const odBody = lastCall("sendMessage").body;
	check(
		"every option gets its own section in the message",
		odBody.text.includes("<b>Continue</b>\nRuns the remaining migrations.") &&
			odBody.text.includes("<b>Stop</b>\nLeaves the branch as it is."),
	);
	check(
		"a described list still gets its buttons",
		(odBody.reply_markup?.inline_keyboard ?? []).flat().filter((b) => b.callback_data?.startsWith("c:")).length === 2,
	);

	await od.fire("input");
	const halfBad = await od.tools.get("notify_status").execute(
		"od3",
		{
			summary: "Half described.",
			urgency: "orange",
			options: [{ label: "Merge", description: "Lands the branch." }, { label: "Rebase" }],
		},
		undefined,
		undefined,
		od.ctx,
	);
	check("one bare option refuses the whole list", halfBad.isError === true);
	check(
		"the refusal names the bare option only",
		/Rebase/.test(halfBad.content[0].text) && !/Merge/.test(halfBad.content[0].text),
	);
	await od.fire("session_stop");
	await settle(150);
}

heading("a snippet arrives ready to copy");
{
	rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
	const sn = spawn("01a06100-0000-0000-0000-000000000000", "/home/dev/work/snippet");
	await sn.fire("session_start");
	const snHead = `${record(sn.id).emoji} snippet \u00B7 ${record(sn.id).tag}\n`;

	const posted = await sn.tools
		.get("notify_snippet")
		.execute("sn1", { purpose: "PR body for #9", text: "First line\n\nSecond line\n" }, undefined, undefined, sn.ctx);
	const snBody = lastCall("sendMessage").body;
	check("a snippet reports success", posted.isError !== true);
	check("a snippet opens with the standard head", snBody.text.startsWith(snHead));
	check("a snippet says where the text goes", snBody.text.includes("PR body for #9"));
	check("a snippet payload arrives in one block", snBody.text.includes("<pre>First line\n\nSecond line</pre>"));
	check("a snippet ends on its copyable block", snBody.text.endsWith("</pre>"));
	check("a snippet is replyable", record(sn.id).recent.length > 0);

	await sn.tools
		.get("notify_snippet")
		.execute("sn2", { purpose: "issue body", text: "Steps:\n\n```sh\nnpm test\n```\n" }, undefined, undefined, sn.ctx);
	check(
		"a payload with its own fence is not cut short",
		lastCall("sendMessage").body.text.includes("<pre>Steps:\n\n```sh\nnpm test\n```</pre>"),
	);

	// A fence run in the label would otherwise open a block that swallows the payload's own opener.
	await sn.tools
		.get("notify_snippet")
		.execute(
			"sn2b",
			{ purpose: "replacement for the ```yaml block", text: "steps:\n  - run: npm test" },
			undefined,
			undefined,
			sn.ctx,
		);
	const labelled = lastCall("sendMessage").body.text;
	check("a fence run in the purpose does not escape the label", labelled.includes("replacement for the yaml block"));
	check(
		"a fence run in the purpose leaves the payload copyable",
		labelled.includes("<pre>steps:\n  - run: npm test</pre>"),
	);

	await sn.tools
		.get("notify_snippet")
		.execute("sn3", { purpose: "the patch", language: "ts", text: "const x = 1;" }, undefined, undefined, sn.ctx);
	check(
		"a language tag reaches the block",
		lastCall("sendMessage").body.text.includes('<pre><code class="language-ts">const x = 1;</code></pre>'),
	);

	await sn.tools
		.get("notify_snippet")
		.execute("sn4", { purpose: "a note", text: "<b>bold</b> & **stars**" }, undefined, undefined, sn.ctx);
	check(
		"markup in the payload is shown, not applied",
		lastCall("sendMessage").body.text.includes("<pre>&lt;b&gt;bold&lt;/b&gt; &amp; **stars**</pre>"),
	);

	const snSends = called("sendMessage").length;
	const oversized = await sn.tools
		.get("notify_snippet")
		.execute("sn5", { purpose: "far too much", text: "x".repeat(4200) }, undefined, undefined, sn.ctx);
	check("an oversized snippet is refused", oversized.isError === true);
	check("an oversized snippet sends nothing", called("sendMessage").length === snSends);
	check("an oversized snippet names the room it needs", /4\d{3}/.test(oversized.content[0].text));
	check("an oversized snippet points at the file route", /notify_file/.test(oversized.content[0].text));

	const blank = await sn.tools
		.get("notify_snippet")
		.execute("sn6", { purpose: "nothing", text: "   \n" }, undefined, undefined, sn.ctx);
	check("an empty payload is refused", blank.isError === true);
	const unnamed = await sn.tools
		.get("notify_snippet")
		.execute("sn7", { purpose: " ", text: "something" }, undefined, undefined, sn.ctx);
	check("a snippet with no purpose is refused", unnamed.isError === true);
	const badLanguage = await sn.tools
		.get("notify_snippet")
		.execute(
			"sn8",
			{ purpose: "the patch", language: "ts and bash", text: "const x = 1;" },
			undefined,
			undefined,
			sn.ctx,
		);
	check("a snippet with a bogus fence tag is refused", badLanguage.isError === true);

	api.failMethods = ["sendMessage"];
	const refused = await sn.tools
		.get("notify_snippet")
		.execute("sn9", { purpose: "a note", text: "never arrives" }, undefined, undefined, sn.ctx);
	api.failMethods = [];
	check("a snippet Telegram refuses is reported as an error", refused.isError === true);

	// A session whose config never parsed has nowhere to send, and must say so.
	const heldConfig = readFileSync(join(root, "notify-telegram.json"), "utf8");
	writeFileSync(join(root, "notify-telegram.json"), "");
	const off = spawn("01a06101-0000-0000-0000-000000000000", "/home/dev/work/snippetoff");
	await off.fire("session_start");
	writeFileSync(join(root, "notify-telegram.json"), heldConfig);
	const unconfigured = await off.tools
		.get("notify_snippet")
		.execute("sn10", { purpose: "nowhere", text: "orphaned" }, undefined, undefined, off.ctx);
	check("a snippet from an unconfigured session is refused", unconfigured.isError === true);
}

heading("agents manage their own sent messages");
{
	rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
	const owner = spawn("01a06102-0000-0000-0000-000000000000", "/home/dev/work/messages");
	const peer = spawn("01a06103-0000-0000-0000-000000000000", "/home/dev/work/other-messages");
	await owner.fire("session_start");
	await peer.fire("session_start");
	const manage = owner.tools.get("notify_message");
	check("agents can manage sent messages", manage !== undefined);
	if (manage !== undefined) {
		const call = (params) => manage.execute("message-operation", params, undefined, undefined, owner.ctx);
		const post = async (session, text) =>
			(
				await session.tools
					.get("notify_snippet")
					.execute("message-source", { purpose: "copyable note", text }, undefined, undefined, session.ctx)
			).details.messageId;
		const sentPath = (id) => join(root, "notify-telegram/sent", `${id}.json`);
		const ownId = await post(owner, "Original note");
		const peerId = await post(peer, "Other session's note");
		const newerId = await post(owner, "Newer note");
		const listed = await call({ action: "list" });
		check(
			"listing returns own message IDs and source text",
			listed.details.messages.some((m) => m.id === ownId && m.text.includes("Original note")) &&
				listed.details.messages.every((m) => m.id !== peerId),
		);
		const first = await call({ action: "list", limit: 1 });
		const older = await call({ action: "list", before: first.details.messages[0].id });
		check(
			"message pages return older messages without repeating the boundary",
			first.details.messages[0].id === newerId &&
				older.details.messages.some((m) => m.id === ownId) &&
				older.details.messages.every((m) => m.id < newerId),
		);
		const foreignCalls = api.calls.length;
		for (const action of ["edit", "delete"]) {
			const refused = await call({ action, message_id: peerId, text: "Wrong owner" });
			check(`agents cannot ${action} another session's message`, refused.isError === true);
		}
		check("foreign message refusals never reach Telegram", api.calls.length === foreignCalls);
		for (const params of [
			{ action: "edit", message_id: -1, text: "Invalid" },
			{ action: "edit", message_id: 987654321, text: "Unknown" },
			{ action: "edit", message_id: ownId, text: " " },
			{ action: "edit", message_id: ownId, text: "x".repeat(4097) },
			{ action: "list", limit: 0 },
			{ action: "list", before: "../invalid" },
			{ action: "unknown" },
		]) {
			check("invalid message operations are refused", (await call(params)).isError === true);
		}
		const edited = await call({ action: "edit", message_id: ownId, text: "**Corrected** note" });
		const wire = lastCall("editMessageText").body;
		const snapshot = JSON.parse(readFileSync(sentPath(ownId), "utf8"));
		check(
			"editing replaces the owned message and keeps its session head",
			edited.isError !== true &&
				wire.message_id === ownId &&
				wire.text.startsWith(badgeLineOf(owner.id)) &&
				wire.text.includes("<b>Corrected</b> note") &&
				snapshot.text.includes("**Corrected** note") &&
				!snapshot.text.includes("Original note"),
		);
		api.rejectHtml = true;
		await call({ action: "edit", message_id: ownId, text: "Markup fallback" });
		api.rejectHtml = false;
		check(
			"message edits retry rejected markup as plain text",
			lastCall("editMessageText").body.parse_mode === undefined &&
				JSON.parse(readFileSync(sentPath(ownId), "utf8")).text.includes("Markup fallback"),
		);
		api.failMethods = ["editMessageText"];
		api.failDescription = "Bad Request: message is not modified";
		const unchanged = await call({ action: "edit", message_id: ownId, text: "Markup fallback" });
		api.failMethods = [];
		delete api.failDescription;
		check("repeating an accepted edit succeeds", unchanged.isError !== true);
		api.failMethods = ["editMessageText"];
		const rejectedEdit = await call({ action: "edit", message_id: ownId, text: "Rejected edit" });
		api.failMethods = [];
		check(
			"a rejected edit preserves the reaction snapshot",
			rejectedEdit.isError === true &&
				!JSON.parse(readFileSync(sentPath(ownId), "utf8")).text.includes("Rejected edit"),
		);
		const filePath = join(root, "message-caption.txt");
		writeFileSync(filePath, "Attachment");
		const file = await owner.tools
			.get("notify_file")
			.execute("message-file", { paths: [filePath] }, undefined, undefined, owner.ctx);
		const fileId = file.details.messageIds[0];
		const caption = await call({ action: "edit", message_id: fileId, text: "**Updated** attachment" });
		check(
			"file edits replace the caption without reuploading",
			caption.isError !== true &&
				lastCall("editMessageCaption").body.message_id === fileId &&
				lastCall("editMessageCaption").body.caption.includes("<b>Updated</b> attachment") &&
				JSON.parse(readFileSync(sentPath(fileId), "utf8")).text.includes("Updated"),
		);
		const beforeLongCaption = called("editMessageCaption").length;
		check(
			"oversized captions are refused whole",
			(await call({ action: "edit", message_id: fileId, text: "x".repeat(1025) })).isError === true &&
				called("editMessageCaption").length === beforeLongCaption,
		);
		const cancelQuestion = new AbortController();
		const active = owner.tools
			.get("ask")
			.execute(
				"message-question",
				{ questions: [{ id: "pending", question: "Which path?", options: askOpts("Proceed", "Wait") }] },
				cancelQuestion.signal,
				undefined,
				stubbornCtx(owner.ctx, {}),
			)
			.catch((error) => error);
		await settle(150);
		const questionId = record(owner.id).question;
		for (const action of ["edit", "delete"]) {
			check(
				`an active native question cannot be ${action}d`,
				(await call({ action, message_id: questionId, text: "Unreachable question" })).isError === true,
			);
		}
		cancelQuestion.abort();
		await active;
		api.failMethods = ["deleteMessage"];
		const rejectedDelete = await call({ action: "delete", message_id: ownId });
		api.failMethods = [];
		check(
			"a rejected deletion preserves ownership and reply routing",
			rejectedDelete.isError === true &&
				record(owner.id).recent.includes(ownId) &&
				JSON.parse(readFileSync(sentPath(ownId), "utf8")) !== null,
		);
		const deleted = await call({ action: "delete", message_id: ownId });
		check(
			"deleting an owned message clears its record and reply routing",
			deleted.isError !== true &&
				lastCall("deleteMessage").body.message_id === ownId &&
				!record(owner.id).recent.includes(ownId) &&
				!(await call({ action: "list" })).details.messages.some((m) => m.id === ownId),
		);
		check(
			"a deleted message cannot be edited again",
			(await call({ action: "edit", message_id: ownId, text: "Resurrected" })).isError === true,
		);
		await owner.tools
			.get("notify_status")
			.execute(
				"message-standing",
				{ summary: "Choose a next step.", urgency: "green", effect: "none", options: opts("Proceed", "Wait") },
				undefined,
				undefined,
				owner.ctx,
			);
		await owner.fire("session_stop");
		await settle(150);
		const standingId = record(owner.id).standing.messageId;
		await call({ action: "edit", message_id: standingId, text: "Choose the verified next step." });
		const preservedButtons = lastCall("editMessageText").body.reply_markup?.inline_keyboard.flat() ?? [];
		check(
			"editing a standing question keeps its choices and completion actions",
			preservedButtons.some((button) => button.text === "Proceed" && button.callback_data.startsWith("c:")) &&
				preservedButtons.some((button) => button.callback_data.startsWith("k:")) &&
				preservedButtons.some((button) => button.callback_data.startsWith("x:")),
		);
		check(
			"deleting a standing question clears the live choices",
			(await call({ action: "delete", message_id: standingId })).isError !== true && record(owner.id).standing === null,
		);
		await owner.fire("input");
		await owner.tools
			.get("notify_status")
			.execute(
				"message-close-offer",
				{ summary: "Complete.", urgency: "green", effect: "none" },
				undefined,
				undefined,
				owner.ctx,
			);
		await owner.fire("session_stop");
		await settle(150);
		const offerId = record(owner.id).closeOffer;
		check(
			"deleting a completion summary retires its close offer",
			(await call({ action: "delete", message_id: offerId })).isError !== true && record(owner.id).closeOffer === null,
		);
		await owner.fire("session_shutdown");
		await peer.fire("session_shutdown");
	}
}

heading("caller text kept whole inside its own quote");
{
	rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
	const cut = spawn("01a06110-0000-0000-0000-000000000000", "/home/dev/work/halfemoji");
	await cut.fire("session_start");

	// a. A preview carrying its own fence must stay inside the block that quotes it.
	const fencedState = {};
	const fencedAsk = cut.tools.get("ask").execute(
		"cut1",
		{
			questions: [
				{
					id: "q",
					question: "Apply it?",
					options: [{ label: "yes", description: "applies the patch", preview: "```sh\nnpm test\n```" }],
				},
			],
		},
		undefined,
		undefined,
		stubbornCtx(cut.ctx, fencedState),
	);
	await settle(150);
	const quoted = lastCall("sendMessage").body.text;
	check("a preview carrying its own fence stays in one block", quoted.includes("<pre>```sh\nnpm test\n```</pre>"));
	check("a quoted preview leaves exactly one block", (quoted.match(/<pre>/g) ?? []).length === 1);
	const press = (lastCall("sendMessage").body.reply_markup?.inline_keyboard ?? [])
		.flat()
		.find((b) => b.callback_data?.startsWith("o:"));
	writeFileSync(join(inboxOf(cut.id), "8901.json"), JSON.stringify({ kind: "callback", value: press.callback_data }));
	await cut.pump(250);
	await fencedAsk;

	// b. The snippet label is capped at 120, which must not land between two halves of an emoji.
	const numbered = await cut.tools
		.get("notify_snippet")
		.execute("cut3", { purpose: 42, text: "paste me" }, undefined, undefined, cut.ctx);
	check("a snippet label that is not text is refused", numbered.isError === true);
	await cut.tools
		.get("notify_snippet")
		.execute("cut2", { purpose: `${"z".repeat(119)}\u{1F600}tail`, text: "paste me" }, undefined, undefined, cut.ctx);
	check("a capped snippet label holds no lone surrogate", lastCall("sendMessage").body.text.isWellFormed());

	// c. An event without a tool name still labels the tool rather than saying undefined.
	await cut.fire("agent_start");
	await cut.fire("tool_execution_start", { intent: "Reading a file" });
	await settle(120);
	check("a nameless tool call is still labelled", record(cut.id).state === "working (tool: Reading a file)");
	await cut.fire("tool_execution_end");
	await cut.fire("agent_end");
}

heading("an external process asks and reads the answer");
// The channel a job outside omp uses: it sends its own question with `e:<key>:<choice>` buttons,
// and the poller, the only thing that can see the press, records the choice to a file the job polls.
rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
const extSess = spawn("01a06000-0000-0000-0000-000000000000", "/home/dev/work/cleanup");
await extSess.fire("session_start");
const answersDir = join(root, "notify-telegram/external/answers");
// The asker owns the channel directory, so the test creates it exactly as the asker would.
mkdirSync(answersDir, { recursive: true });
check("the asker's channel directory is honoured", existsSync(answersDir));
const extKey = "a1b2c3d4e5f60718";
const extButtons = [
	[{ text: "Delete tree", callback_data: `e:${extKey}:delete` }],
	[{ text: "Keep", callback_data: `e:${extKey}:keep` }],
];
api.queued = [
	{
		update_id: 900,
		callback_query: {
			id: "ext-cb-1",
			data: `e:${extKey}:delete`,
			from: { id: CHAT },
			message: {
				message_id: 42,
				chat: { id: CHAT },
				text: "PR merged, delete tree?",
				reply_markup: { inline_keyboard: extButtons },
			},
		},
	},
];
await extSess.pump(250);
const extAnswerPath = join(answersDir, `${extKey}.json`);
const extAnswer = JSON.parse(readFileSync(extAnswerPath, "utf8"));
check("the external answer is recorded to a file the asker polls", extAnswer.choice === "delete");
check("the recorded answer is timestamped", typeof extAnswer.at === "number" && extAnswer.at > 0);
check("the answer file is private", (statSync(extAnswerPath).mode & 0o777) === 0o600);
const extAck = called("answerCallbackQuery").find((c) => c.body.callback_query_id === "ext-cb-1");
check("the press is acknowledged", extAck?.body.text === "Recorded.");
const extSettle = called("editMessageReplyMarkup").at(-1);
check("only the keyboard is edited, leaving the question text intact", extSettle?.body.message_id === 42);
const settledRows = extSettle.body.reply_markup.inline_keyboard;
check(
	"every settled button is dead",
	settledRows.flat().every((b) => b.disabled !== undefined),
);
check(
	"the chosen option is ticked",
	settledRows.flat().some((b) => b.text.startsWith("\u2713 Delete tree")),
);
check(
	"an unchosen option is not ticked",
	settledRows.flat().some((b) => b.text === "Keep"),
);

// A key that tries to escape its directory writes nothing and says so.
const answersBefore = readdirSync(answersDir).length;
api.queued = [
	{
		update_id: 901,
		callback_query: {
			id: "ext-cb-2",
			data: "e:../escape:delete",
			from: { id: CHAT },
			message: { message_id: 43, chat: { id: CHAT } },
		},
	},
];
await extSess.pump(200);
check("a path-escaping key writes no answer file", readdirSync(answersDir).length === answersBefore);
check(
	"a malformed external key is refused with a toast",
	called("answerCallbackQuery").find((c) => c.body.callback_query_id === "ext-cb-2")?.body.text ===
		"That button is malformed.",
);
check(
	"the malformed key is logged",
	extSess.warns.some((w) => w.m.includes("malformed key")),
);

// A foreign sender's external press is dropped by the same origin gate every button passes.
const foreignBefore = readdirSync(answersDir).length;
api.queued = [
	{
		update_id: 902,
		callback_query: {
			id: "ext-cb-3",
			data: `e:${"f".repeat(16)}:delete`,
			from: { id: STRANGER },
			message: { message_id: 44, chat: { id: CHAT } },
		},
	},
];
await extSess.pump(200);
check("a foreign external press writes no answer", readdirSync(answersDir).length === foreignBefore);
check(
	"a foreign external press is not acknowledged",
	!called("answerCallbackQuery").some((c) => c.body.callback_query_id === "ext-cb-3"),
);

// A choice may legitimately contain colons; the parser keeps everything after the second one.
const colonKey = "c0c0c0c0c0c0c0c0";
api.queued = [
	{
		update_id: 903,
		callback_query: {
			id: "ext-cb-4",
			data: `e:${colonKey}:2026-09-07T10:30`,
			from: { id: CHAT },
			message: {
				message_id: 45,
				chat: { id: CHAT },
				reply_markup: { inline_keyboard: [[{ text: "At", callback_data: `e:${colonKey}:2026-09-07T10:30` }]] },
			},
		},
	},
];
await extSess.pump(200);
check(
	"a choice containing colons is recorded whole",
	JSON.parse(readFileSync(join(answersDir, `${colonKey}.json`), "utf8")).choice === "2026-09-07T10:30",
);

// A press on an external question whose message carries no keyboard records the choice and edits nothing.
const bareKey = "e0e0e0e0e0e0e0e0";
const editsBeforeBare = called("editMessageReplyMarkup").length;
api.queued = [
	{
		update_id: 908,
		callback_query: {
			id: "ext-cb-bare",
			data: `e:${bareKey}:keep`,
			from: { id: CHAT },
			message: { message_id: 47, chat: { id: CHAT } },
		},
	},
];
await extSess.pump(200);
check(
	"a press on a keyboardless external question is recorded without an edit",
	JSON.parse(readFileSync(join(answersDir, `${bareKey}.json`), "utf8")).choice === "keep" &&
		called("editMessageReplyMarkup").length === editsBeforeBare,
);

// The first press on a key wins: a later press in the same batch neither overwrites nor re-settles.
const raceKey = "d0d0d0d0d0d0d0d0";
const raceButtons = [
	[
		{ text: "Delete tree", callback_data: `e:${raceKey}:delete` },
		{ text: "Keep", callback_data: `e:${raceKey}:keep` },
	],
];
const raceMessage = { message_id: 46, chat: { id: CHAT }, reply_markup: { inline_keyboard: raceButtons } };
api.queued = [
	{
		update_id: 904,
		callback_query: { id: "ext-cb-5a", data: `e:${raceKey}:delete`, from: { id: CHAT }, message: raceMessage },
	},
	{
		update_id: 905,
		callback_query: { id: "ext-cb-5b", data: `e:${raceKey}:keep`, from: { id: CHAT }, message: raceMessage },
	},
];
await extSess.pump(250);
check(
	"the first press on a key wins",
	JSON.parse(readFileSync(join(answersDir, `${raceKey}.json`), "utf8")).choice === "delete",
);
check(
	"a later press is acknowledged as already recorded",
	called("answerCallbackQuery").find((c) => c.body.callback_query_id === "ext-cb-5b")?.body.text ===
		"Already recorded.",
);
check(
	"only the first press settles the keyboard",
	called("editMessageReplyMarkup").filter((c) => c.body.message_id === 46).length === 1,
);

// An asker that never created the answers directory still gets its answer recorded.
rmSync(answersDir, { recursive: true, force: true });
const missingKey = "m1ss1ng1answers";
const missingAnswerPath = join(answersDir, `${missingKey}.json`);
api.queued = [
	{
		update_id: 909,
		callback_query: {
			id: "ext-cb-missing",
			data: `e:${missingKey}:yes`,
			from: { id: CHAT },
			message: {
				message_id: 48,
				chat: { id: CHAT },
				reply_markup: { inline_keyboard: [[{ text: "Yes", callback_data: `e:${missingKey}:yes` }]] },
			},
		},
	},
];
await extSess.pump(250);
const missingAnswer = existsSync(missingAnswerPath) ? JSON.parse(readFileSync(missingAnswerPath, "utf8")) : null;
check(
	"a press is recorded when the answers directory does not exist yet",
	missingAnswer?.choice === "yes" &&
		called("answerCallbackQuery").find((c) => c.body.callback_query_id === "ext-cb-missing")?.body.text === "Recorded.",
);

// ------------------------------------------------------------ reactions
heading("reactions grade what the agent sent");
// A reaction carries only a message id, so its grade stores the sent-message record with it.
rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
const fb = spawn("01a07000-0000-0000-0000-000000000000", "/home/dev/work/lexer");
await fb.fire("session_start");
const sentDir = join(root, "notify-telegram/sent");
const feedbackFile = join(root, "notify-telegram/feedback.jsonl");
const feedbackLines = () =>
	existsSync(feedbackFile)
		? readFileSync(feedbackFile, "utf8")
				.split("\n")
				.filter((line) => line.length > 0)
				.map((line) => JSON.parse(line))
		: [];
const onRecord = (messageId) => JSON.parse(readFileSync(join(sentDir, `${messageId}.json`), "utf8"));
const react = (updateId, messageId, emoji, previous = [], from = CHAT) => ({
	update_id: updateId,
	message_reaction: {
		chat: { id: CHAT },
		message_id: messageId,
		user: { id: from },
		date: 1,
		old_reaction: previous.map((e) => ({ type: "emoji", emoji: e })),
		new_reaction: emoji.map((e) => ({ type: "emoji", emoji: e })),
	},
});
const answerButton = (updateId, messageId, data) => ({
	update_id: updateId,
	callback_query: {
		id: `fb-${updateId}`,
		data,
		from: { id: CHAT },
		message: { message_id: messageId, chat: { id: CHAT } },
	},
});
const replyTo = (updateId, messageId, text) => ({
	update_id: updateId,
	message: {
		message_id: 800_000 + updateId,
		date: 1,
		chat: { id: CHAT },
		text,
		reply_to_message: { message_id: messageId },
	},
});

await fb.fire("input");
await fb.tools
	.get("notify_status")
	.execute(
		"fb1",
		{ summary: "Lexer rewritten; tests green.", urgency: "green", effect: "none" },
		undefined,
		undefined,
		fb.ctx,
	);
await fb.fire("session_stop");
await settle(150);
const statusId = record(fb.id).recent.at(-1);
const statusRecord = onRecord(statusId);
check(
	"a sent status is on record with its kind, text and session",
	statusRecord.version === 1 &&
		statusRecord.kind === "status" &&
		statusRecord.text.includes("Lexer rewritten") &&
		statusRecord.session.tag === record(fb.id).tag &&
		statusRecord.session.id === fb.id &&
		statusRecord.session.cwd === "/home/dev/work/lexer",
);
check("the record keeps the structured call behind the message", statusRecord.payload.urgency === "green");
check("the record is private", (statSync(join(sentDir, `${statusId}.json`)).mode & 0o777) === 0o600);

// A thumbs up is a grade and nothing else.
const sendsBeforePraise = called("sendMessage").length;
api.queued = [react(9001, statusId, ["\u{1F44D}"])];
await fb.pump(200);
let lines = feedbackLines();
check(
	"a thumbs up is recorded with its grade and the message it graded",
	lines.length === 1 &&
		lines[0].version === 1 &&
		lines[0].at === 1000 &&
		lines[0].updateId === 9001 &&
		lines[0].grade === 2 &&
		lines[0].emoji.join() === "\u{1F44D}" &&
		lines[0].messageId === statusId &&
		lines[0].message.kind === "status" &&
		lines[0].redo === false,
);
check("a positive grade wakes nobody", inboxCount(fb.id) === 0 && called("sendMessage").length === sendsBeforePraise);
check("the feedback log is private", (statSync(feedbackFile).mode & 0o777) === 0o600);

// A private ledger file still cannot turn a session id into a path traversal.
const unsafeSessionId = "../escape";
const unsafeMessageId = 777_777;
const unsafeOwnerFile = join(root, "notify-telegram/escape.json");
const unsafeSentFile = join(sentDir, `${unsafeMessageId}.json`);
writeFileSync(
	unsafeOwnerFile,
	JSON.stringify({ ...record(fb.id), id: unsafeSessionId, heartbeat: Date.now(), question: null }),
);
writeFileSync(
	unsafeSentFile,
	JSON.stringify({
		...statusRecord,
		id: unsafeMessageId,
		session: { ...statusRecord.session, id: unsafeSessionId },
	}),
);
const feedbackBeforeUnsafeSession = feedbackLines().length;
api.queued = [react(8998, unsafeMessageId, ["\u{1F44E}"])];
await fb.pump(200);
check(
	"an unsafe ledger session id is rejected before inbox routing",
	feedbackLines().length === feedbackBeforeUnsafeSession &&
		!existsSync(join(root, "notify-telegram/escape/8998.json")) &&
		lastCall("sendMessage").body.text.includes("Reaction error"),
);
rmSync(unsafeOwnerFile, { force: true });
rmSync(unsafeSentFile, { force: true });
rmSync(join(root, "notify-telegram/escape"), { recursive: true, force: true });

// A thumbs down on a status makes the agent write it again.
api.queued = [react(9002, statusId, ["\u{1F44E}"], ["\u{1F44D}"])];
await fb.pump(200);
lines = feedbackLines();
check(
	"a changed reaction is recorded with what it replaced",
	lines.at(-1).grade === -2 && lines.at(-1).previous.join() === "\u{1F44D}" && lines.at(-1).redo === true,
);
check("a redo reaches the owning session", inboxCount(fb.id) === 1);
await fb.pump(150);
check(
	"the redo tells the agent which message to rewrite and through which tool",
	fb.steers.length === 1 && fb.steers[0].text.includes("\u{1F44E}") && fb.steers[0].text.includes("notify_status"),
);
const feedbackAfterFirstRedo = feedbackLines().length;
api.queued = [react(9002, statusId, ["\u{1F44E}"], ["\u{1F44D}"])];
await fb.pump(200);
check(
	"a redelivered reaction update is recorded and dispatched only once",
	feedbackLines().length === feedbackAfterFirstRedo && inboxCount(fb.id) === 0 && fb.steers.length === 1,
);

// A turn-end question without buttons gets the same phone-context correction as an ask.
await fb.fire("input");
await fb.tools
	.get("notify_status")
	.execute(
		"fb-question",
		{ summary: "Need one detail.", urgency: "orange", question: "Should the frobnicator stay enabled?" },
		undefined,
		undefined,
		fb.ctx,
	);
await fb.fire("session_stop");
await settle(150);
const statusQuestionId = record(fb.id).recent.at(-1);
api.queued = [react(9003, statusQuestionId, ["\u{1F44E}"])];
await fb.pump(200);
await fb.pump(150);
check(
	"a negative status question asks for a contextual restatement",
	fb.steers.at(-1).text.includes("restate") &&
		fb.steers.at(-1).text.includes("definitions") &&
		fb.steers.at(-1).text.includes("notify_status"),
);

// A strongly negative reaction on an open question answers it: restate, then ask again.
const fbState = {};
const fbAsk = fb.tools.get("ask").execute("fb2", singleQuestion, undefined, undefined, stubbornCtx(fb.ctx, fbState));
await settle(150);
const askMessageId = api.nextMessage - 1;
check(
	"a question is on record as one, with its options",
	onRecord(askMessageId).kind === "question" && onRecord(askMessageId).payload.question.options.length === 2,
);
check("the live session record names its open question", record(fb.id).question === askMessageId);
api.queued = [react(9004, askMessageId, ["\u{1F4A9}"])];
await fb.pump(200);
await fb.pump(150);
const redone = await fbAsk;
check(
	"a strongly negative reaction on an open question answers it with a request to restate",
	/restate/i.test(redone.details.customInput ?? "") && redone.details.selectedOptions.length === 0,
);
check("the terminal dialog is aborted", fbState.aborted === true);
check(
	"the question's grade is on file",
	feedbackLines().at(-1).grade === -3 && feedbackLines().at(-1).message.kind === "question",
);
check(
	"settling a question records the text now visible in Telegram",
	onRecord(askMessageId).text.includes(redone.details.customInput),
);
check("the session record clears its settled question", record(fb.id).question === null);

// An emoji outside the scale is recorded without a grade and the scale is shown.
api.queued = [react(9005, statusId, ["\u{1F34C}"])];
await fb.pump(200);
check(
	"an ungraded emoji records without a grade",
	feedbackLines().at(-1).grade === null && feedbackLines().at(-1).emoji.join() === "\u{1F34C}",
);
const scaleNotice = lastCall("sendMessage").body.text;
check(
	"and the chat returns an error with the graded set",
	scaleNotice.includes("Reaction error") &&
		scaleNotice.includes("\u{1F34C}") &&
		scaleNotice.includes("\u{1F44E}") &&
		scaleNotice.includes("\u{1F3C6}"),
);

// A mixed set is ungraded rather than partly interpreted.
const steersBeforeMixed = fb.steers.length;
api.queued = [react(9006, statusId, ["\u{1F44E}", "\u{1F34C}"])];
await fb.pump(200);
check("a set containing an unknown emoji has no grade", feedbackLines().at(-1).grade === null);
check("an ungraded set cannot trigger a redo", inboxCount(fb.id) === 0 && fb.steers.length === steersBeforeMixed);

// Taking a reaction back is recorded, silently.
const sendsBeforeRemoval = called("sendMessage").length;
api.queued = [react(9007, statusId, [], ["\u{1F44E}", "\u{1F34C}"])];
await fb.pump(200);
check(
	"removing a reaction records an empty set",
	feedbackLines().at(-1).emoji.length === 0 && feedbackLines().at(-1).grade === null,
);
check("silently", called("sendMessage").length === sendsBeforeRemoval && inboxCount(fb.id) === 0);

// A message not on record cannot be graded, and the chat says so.
const linesBeforeUnknown = feedbackLines().length;
api.queued = [react(9008, 1, ["\u{1F44D}"])];
await fb.pump(200);
check("a reaction to a message not on record is not recorded", feedbackLines().length === linesBeforeUnknown);
check("and the chat is told why", /not on record/.test(lastCall("sendMessage").body.text));

// A stranger's reaction passes the same origin gate every button passes.
api.queued = [react(9009, statusId, ["\u{1F44E}"], [], STRANGER)];
await fb.pump(200);
check("a stranger's reaction is dropped", feedbackLines().length === linesBeforeUnknown && inboxCount(fb.id) === 0);
check(
	"and logged",
	fb.warns.some((w) => w.m.includes("unexpected origin")),
);

// The bot's own words can be graded, but there is no agent message to redo.
writeFileSync(join(inboxOf(fb.id), "9100.json"), JSON.stringify({ kind: "command", value: "stop" }));
await fb.pump(200);
const noticeId = record(fb.id).recent.at(-1);
check("a session notice is on record as the bot's own", onRecord(noticeId).kind === "notice");
const steersBeforeNotice = fb.steers.length;
api.queued = [react(9010, noticeId, ["\u{1F44E}"])];
await fb.pump(200);
await fb.pump(150);
check(
	"a thumbs down on the bot's own words is recorded",
	feedbackLines().at(-1).message.kind === "notice" && feedbackLines().at(-1).redo === false,
);
check(
	"and redoes nothing",
	fb.steers.length === steersBeforeNotice && /nothing to redo/i.test(lastCall("sendMessage").body.text),
);

// A session that is gone cannot redo anything. The grade is still kept.
const gone = spawn("01a07001-0000-0000-0000-000000000000", "/home/dev/work/parser");
await gone.fire("session_start");
await gone.fire("input");
await gone.tools
	.get("notify_status")
	.execute("fb3", { summary: "Parser done.", urgency: "green", effect: "none" }, undefined, undefined, gone.ctx);
await gone.fire("session_stop");
await settle(150);
const goneId = record(gone.id).recent.at(-1);
await gone.fire("session_shutdown");
check("shutdown marks the session record dead immediately", record(gone.id).heartbeat === 0);
api.queued = [react(9011, goneId, ["\u{1F44E}"])];
await fb.pump(200);
check("a redo for a session that is gone is recorded as not done", feedbackLines().at(-1).redo === false);
check("the dead session receives no redo entry", inboxCount(gone.id) === 0);
check("and the chat is told", /session is gone/.test(lastCall("sendMessage").body.text));

// An unreadable record is refused instead of consuming a reaction without an explanation.
const malformedRecordId = 424243;
writeFileSync(join(sentDir, `${malformedRecordId}.json`), "{}");
const linesBeforeMalformed = feedbackLines().length;
api.queued = [react(9012, malformedRecordId, ["\u{1F44E}"])];
await fb.pump(200);
check("a malformed sent record produces no feedback", feedbackLines().length === linesBeforeMalformed);
check("and returns a reaction error", lastCall("sendMessage").body.text.includes("Reaction error"));

// Runtime Telegram JSON must not turn a string-shaped message id into a ledger path.
const traversalId = "../traversal";
const traversalRecord = join(root, "notify-telegram/traversal.json");
writeFileSync(
	traversalRecord,
	JSON.stringify({
		version: 1,
		id: traversalId,
		at: 1,
		kind: "status",
		text: "outside the sent ledger",
		session: { id: fb.id, tag: record(fb.id).tag, emoji: "", name: "", cwd: "" },
	}),
);
const linesBeforeTraversal = feedbackLines().length;
api.queued = [react(9013, traversalId, ["\u{1F44D}"])];
await fb.pump(200);
check("a traversal-shaped message id cannot escape the sent ledger", feedbackLines().length === linesBeforeTraversal);
unlinkSync(traversalRecord);

// Negative feedback remains recorded after settlement but cannot reopen the closed question.
const steersBeforeClosedQuestion = fb.steers.length;
api.queued = [react(9014, askMessageId, ["\u{1F44E}"])];
await fb.pump(200);
check(
	"a settled question keeps its negative grade without a redo",
	feedbackLines().at(-1).grade === -2 &&
		feedbackLines().at(-1).redo === false &&
		fb.steers.length === steersBeforeClosedQuestion,
);
check("the chat says the settled question stayed closed", /already closed/i.test(lastCall("sendMessage").body.text));

// A callback and reaction can share one poll batch. The callback settles first, so the queued redo is stale.
const racedState = {};
const racedAsk = fb.tools
	.get("ask")
	.execute("fb-race", singleQuestion, undefined, undefined, stubbornCtx(fb.ctx, racedState));
await settle(150);
const racedMessageId = api.nextMessage - 1;
const racedButton = lastCall("sendMessage")
	.body.reply_markup.inline_keyboard.flat()
	.find((button) => button.callback_data?.startsWith("o:"));
const steersBeforeRace = fb.steers.length;
const racedSends = called("sendMessage").length;
api.queued = [
	answerButton(9015, racedMessageId, racedButton.callback_data),
	react(9016, racedMessageId, ["\u{1F44E}"]),
];
await fb.pump(250);
await fb.pump(250);
const racedAnswer = await racedAsk;
check("the earlier callback still answers the question", racedAnswer.details.selectedOptions.join() === "SQLite");
check("the later queued redo cannot reopen it", fb.steers.length === steersBeforeRace);
await settle(150);
check(
	"a committed redo dropped because its question closed tells the user so",
	called("sendMessage")
		.slice(racedSends)
		.some((c) => (c.body.text ?? "").includes("grade was not turned into a redo")),
);

// Advancing a multi-question ask must publish the new message id before a prompt reaction arrives.
const advancedState = {};
const advancedAsk = fb.tools.get("ask").execute(
	"fb-advanced",
	{
		questions: [
			{ id: "first", question: "First choice?", options: askOpts("A", "B") },
			{ id: "second", question: "Second choice?", options: askOpts("C", "D") },
		],
	},
	undefined,
	undefined,
	stubbornCtx(fb.ctx, advancedState),
);
await settle(150);
const firstAdvancedMessage = api.nextMessage - 1;
const firstAdvancedButton = lastCall("sendMessage")
	.body.reply_markup.inline_keyboard.flat()
	.find((button) => button.callback_data?.startsWith("o:"));
api.queued = [answerButton(9017, firstAdvancedMessage, firstAdvancedButton.callback_data)];
await fb.pump(250);
await fb.pump(250);
const secondAdvancedMessage = api.nextMessage - 1;
const secondAdvancedButton = lastCall("sendMessage")
	.body.reply_markup.inline_keyboard.flat()
	.find((button) => button.callback_data?.startsWith("o:"));
check(
	"the session record names an advanced open question immediately",
	record(fb.id).question === secondAdvancedMessage,
);
api.queued = [react(9018, secondAdvancedMessage, ["\u{1F44E}"])];
await fb.pump(250);
await fb.pump(250);
const advancedGrade = feedbackLines().at(-1);
api.queued = [answerButton(9019, secondAdvancedMessage, secondAdvancedButton.callback_data)];
await fb.pump(250);
await fb.pump(250);
const advancedAnswer = await advancedAsk;
check(
	"a prompt negative reaction redoes an advanced question",
	advancedGrade.redo === true && /restate/i.test(advancedAnswer.details.results[1].customInput ?? ""),
);
// Replying to a buttonless status question closes it before any later reaction can redo it.
await fb.fire("input");
await fb.tools
	.get("notify_status")
	.execute(
		"fb-answered-status",
		{ summary: "Need a decision.", urgency: "orange", question: "Keep the compatibility path?" },
		undefined,
		undefined,
		fb.ctx,
	);
await fb.fire("session_stop");
await settle(150);
const answeredStatusId = record(fb.id).recent.at(-1);
check("the session record names its buttonless status question", record(fb.id).replyQuestion === answeredStatusId);
api.queued = [replyTo(9020, answeredStatusId, "Remove it")];
await fb.pump(250);
await fb.pump(250);
const steersAfterStatusAnswer = fb.steers.length;
check("a reply closes the buttonless status question", record(fb.id).replyQuestion === null);
api.queued = [react(9021, answeredStatusId, ["\u{1F44E}"])];
await fb.pump(250);
await fb.pump(250);
check("a reaction cannot reopen the answered status question", feedbackLines().at(-1).redo === false);
check("the answered status question receives no redo", fb.steers.length === steersAfterStatusAnswer);
// A media reply answers the same buttonless question just as text does.
await fb.fire("input");
await fb.tools
	.get("notify_status")
	.execute(
		"fb-media-status",
		{ summary: "Need a file decision.", urgency: "orange", question: "Use the attached recording?" },
		undefined,
		undefined,
		fb.ctx,
	);
await fb.fire("session_stop");
await settle(150);
const mediaStatusId = record(fb.id).recent.at(-1);
api.queued = [
	{
		update_id: 9022,
		message: {
			message_id: 809_022,
			date: 1,
			chat: { id: CHAT },
			voice: { file_id: "status-answer" },
			reply_to_message: { message_id: mediaStatusId },
		},
	},
];
await fb.pump(250);
await fb.pump(250);
const steersAfterMediaAnswer = fb.steers.length;
check("a media reply closes the buttonless status question", record(fb.id).replyQuestion === null);
api.queued = [react(9023, mediaStatusId, ["\u{1F44E}"])];
await fb.pump(250);
await fb.pump(250);
check("a reaction cannot reopen the media-answered question", feedbackLines().at(-1).redo === false);
check("the media-answered question receives no redo", fb.steers.length === steersAfterMediaAnswer);
// A reply to an older message must not answer the newer status question merely because it routes here.
await fb.fire("input");
await fb.tools
	.get("notify_status")
	.execute(
		"fb-other-reply",
		{ summary: "Still need a decision.", urgency: "orange", question: "Keep the newer path?" },
		undefined,
		undefined,
		fb.ctx,
	);
await fb.fire("session_stop");
await settle(150);
const newerStatusId = record(fb.id).recent.at(-1);
api.queued = [replyTo(9024, statusId, "An unrelated follow-up")];
await fb.pump(250);
await fb.pump(250);
check("a reply to an older message leaves the newer question open", record(fb.id).replyQuestion === newerStatusId);
// A poller in another process can observe the reaction as soon as Telegram accepts the send.
const ownershipPoller = spawn("01a07003-0000-0000-0000-000000000000", "/home/dev/work/poller");
await ownershipPoller.fire("session_start");
rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
ownershipPoller.heartbeat();
await fb.fire("input");
let releaseOwnedSend;
api.sendMessageGate = new Promise((resolve) => {
	releaseOwnedSend = resolve;
});
await fb.tools
	.get("notify_status")
	.execute(
		"fb-owned-status",
		{ summary: "Need an immediate decision.", urgency: "orange", question: "Keep ownership?" },
		undefined,
		undefined,
		fb.ctx,
	);
const ownedStatusId = api.nextMessage;
await fb.fire("session_stop");
await settle(50);
const ownedReaction = react(9025, ownedStatusId, ["\u{1F44E}"]);
const offsetBeforeOwnedReaction = JSON.parse(readFileSync(join(root, "notify-telegram.json"), "utf8")).offset;
api.queued = [ownedReaction];
await ownershipPoller.pump(250);
check(
	"a reaction awaiting its sent record does not advance the offset",
	JSON.parse(readFileSync(join(root, "notify-telegram.json"), "utf8")).offset === offsetBeforeOwnedReaction,
);
releaseOwnedSend();
api.sendMessageGate = null;
await settle(50);
api.queued = [ownedReaction];
await ownershipPoller.pump(250);
await fb.pump(250);
check("another poller sees a newly accepted status question as open", feedbackLines().at(-1).redo === true);

// A ledger observer stands in for another process polling at the exact publication boundary.
const nativePublishSession = spawn("01a07006-0000-0000-0000-000000000000", "/home/dev/work/native-publish");
await nativePublishSession.fire("session_start");
const nativePublishState = {};
const nativePublishMessageId = api.nextMessage;
let nativeOwnerAtPublish;
const realRenameSync = fs.renameSync;
fs.renameSync = (from, to) => {
	realRenameSync(from, to);
	if (String(to) === join(sentDir, `${nativePublishMessageId}.json`)) {
		nativeOwnerAtPublish = record(nativePublishSession.id).question;
	}
};
syncBuiltinESMExports();
const nativePublishAsk = nativePublishSession.tools
	.get("ask")
	.execute(
		"fb-native-publish",
		singleQuestion,
		undefined,
		undefined,
		stubbornCtx(nativePublishSession.ctx, nativePublishState),
	);
await settle(150);
fs.renameSync = realRenameSync;
syncBuiltinESMExports();
check(
	"native question ownership exists when its ledger record becomes visible",
	nativeOwnerAtPublish === nativePublishMessageId,
);

const nativePublishButton = lastCall("sendMessage").body.reply_markup.inline_keyboard[0][0];
let nativeStateBeforeMarkerRemoval;
const realRmSync = fs.rmSync;
fs.rmSync = (path, options) => {
	if (String(path).includes(`sent-in-flight/edit-${nativePublishMessageId}-`)) {
		nativeStateBeforeMarkerRemoval = {
			question: record(nativePublishSession.id).question,
			text: onRecord(nativePublishMessageId).text,
		};
	}
	return realRmSync(path, options);
};
syncBuiltinESMExports();
writeFileSync(
	join(inboxOf(nativePublishSession.id), "90260.json"),
	JSON.stringify({ kind: "callback", value: nativePublishButton.callback_data }),
);
await nativePublishSession.pump(300);
fs.rmSync = realRmSync;
syncBuiltinESMExports();
await nativePublishAsk;
check(
	"accepted settlement publishes closure before its edit marker disappears",
	nativeStateBeforeMarkerRemoval?.question === null && nativeStateBeforeMarkerRemoval.text.includes("Answered"),
);

const standingPublishSession = spawn("01a07007-0000-0000-0000-000000000000", "/home/dev/work/standing-publish");
await standingPublishSession.fire("session_start");
const standingPublishMessageId = api.nextMessage;
let standingOwnerAtPublish;
fs.renameSync = (from, to) => {
	realRenameSync(from, to);
	if (String(to) === join(sentDir, `${standingPublishMessageId}.json`)) {
		standingOwnerAtPublish = record(standingPublishSession.id).standing?.messageId;
	}
};
syncBuiltinESMExports();
await standingPublishSession.fire("input");
await standingPublishSession.tools
	.get("notify_status")
	.execute(
		"fb-standing-publish",
		{ summary: "Need a choice.", urgency: "orange", question: "Choose now?", options: opts("Choose", "Wait") },
		undefined,
		undefined,
		standingPublishSession.ctx,
	);
await standingPublishSession.fire("session_stop");
await settle(150);
fs.renameSync = realRenameSync;
syncBuiltinESMExports();
check(
	"standing question ownership exists when its ledger record becomes visible",
	standingOwnerAtPublish === standingPublishMessageId,
);
await standingPublishSession.fire("input");
await settle(150);

// The ledger records the fallback Telegram accepted, not rejected entity source.
api.rejectHtml = true;
await fb.fire("input");
await fb.tools
	.get("notify_status")
	.execute(
		"fb-plain-ledger",
		{ summary: 'Clock <tg-time unix="1" format="r">then</tg-time>.', urgency: "green", effect: "none" },
		undefined,
		undefined,
		fb.ctx,
	);
await fb.fire("session_stop");
await settle(150);
api.rejectHtml = false;
const plainStatusId = record(fb.id).recent.at(-1);
const acceptedPlainText = lastCall("sendMessage").body.text;
check(
	"the ledger keeps the plain fallback Telegram displayed",
	onRecord(plainStatusId).text === acceptedPlainText && !onRecord(plainStatusId).text.includes("<tg-time"),
);
api.queued = [react(9026, plainStatusId, ["\u{1F44D}"])];
await ownershipPoller.pump(250);
check("feedback embeds the displayed plain fallback", feedbackLines().at(-1).message.text === acceptedPlainText);
// A negative reaction before a native-question edit is accepted grades the visible record and still reaches the agent.
const preEditSession = spawn("01a0700a-0000-0000-0000-000000000000", "/home/dev/work/pre-edit");
await preEditSession.fire("session_start");
const preEditState = {};
const preEditAsk = preEditSession.tools
	.get("ask")
	.execute("fb-pre-edit", singleQuestion, undefined, undefined, stubbornCtx(preEditSession.ctx, preEditState));
await settle(150);
const editedQuestionId = record(preEditSession.id).question;
const preEditText = onRecord(editedQuestionId).text;
const preEditButton = lastCall("sendMessage").body.reply_markup.inline_keyboard[0][0];
let releaseEdit;
api.editMessageGate = new Promise((resolve) => {
	releaseEdit = resolve;
});
writeFileSync(
	join(inboxOf(preEditSession.id), "90270.json"),
	JSON.stringify({ kind: "callback", value: preEditButton.callback_data }),
);
const settlingPreEdit = preEditSession.pump(250);
await settle(50);
const editReaction = react(9027, editedQuestionId, ["\u{1F44E}"]);
const preEditSteers = preEditSession.steers.length;
api.queued = [editReaction];
await ownershipPoller.pump(250);
const preEditFeedback = feedbackLines().at(-1);
check(
	"a negative reaction before edit acceptance grades the previous question",
	preEditFeedback.updateId === 9027 &&
		preEditFeedback.message.text === preEditText &&
		preEditFeedback.grade === -2 &&
		preEditFeedback.redo === true,
);
releaseEdit();
api.editMessageGate = null;
await settlingPreEdit;
await settle(50);
await preEditAsk;
await preEditSession.pump(250);
check(
	"the pre-edit question redo reaches the agent after settlement",
	preEditSession.steers.length === preEditSteers + 1 && preEditSession.steers.at(-1).text.includes("reacted"),
);

// Media uploads hold the same publication marker until their sent records exist.
const uploadSession = spawn("01a07004-0000-0000-0000-000000000000", root);
await uploadSession.fire("session_start");
const reactionUpload = join(root, "reaction-upload.png");
writeFileSync(reactionUpload, "png-bytes");
let releaseUpload;
api.uploadGate = new Promise((resolve) => {
	releaseUpload = resolve;
});
const uploadedMessageId = api.nextMessage;
const uploadWork = uploadSession.tools
	.get("notify_file")
	.execute(
		"fb-upload-ledger",
		{ paths: [reactionUpload], caption: "Reaction upload" },
		undefined,
		undefined,
		uploadSession.ctx,
	);
await settle(50);
const uploadMarkerDir = join(root, "notify-telegram/sent-in-flight");
const uploadMarker = join(
	uploadMarkerDir,
	readdirSync(uploadMarkerDir).find((entry) => entry.startsWith("new-")),
);
utimesSync(uploadMarker, new Date(0), new Date(0));
await settle(16_000);
check("an active upload marker is refreshed", statSync(uploadMarker).mtimeMs > 0);
const unrelatedUploadReaction = react(9028, statusId, ["\u{1F44D}"]);
const offsetBeforeUnrelatedReaction = JSON.parse(readFileSync(join(root, "notify-telegram.json"), "utf8")).offset;
api.queued = [unrelatedUploadReaction];
await ownershipPoller.pump(250);
check(
	"an unrelated recorded message is graded during an upload",
	feedbackLines().at(-1).messageId === statusId &&
		JSON.parse(readFileSync(join(root, "notify-telegram.json"), "utf8")).offset > offsetBeforeUnrelatedReaction,
);
const uploadReaction = react(9029, uploadedMessageId, ["\u{1F44D}"]);
const offsetBeforeUploadReaction = JSON.parse(readFileSync(join(root, "notify-telegram.json"), "utf8")).offset;
api.queued = [uploadReaction];
await ownershipPoller.pump(250);
check(
	"a reaction awaiting an upload record does not advance the offset",

	JSON.parse(readFileSync(join(root, "notify-telegram.json"), "utf8")).offset === offsetBeforeUploadReaction,
);
releaseUpload();
api.uploadGate = null;
await uploadWork;
api.queued = [uploadReaction];
await ownershipPoller.pump(250);
check("feedback grades the accepted upload record", feedbackLines().at(-1).message.kind === "file");
// A tap or a typed answer reaches its question at once while Telegram refuses the edit that settles the card,
// because the user was already told it was sent. The edit is sent again until Telegram takes it.
const settleEdits = (messageId) =>
	called("editMessageText").filter((c) => c.body.message_id === messageId && String(c.body.text).includes("Answered"))
		.length;
const within = (promise, ms) => Promise.race([promise, settle(ms).then(() => null)]);
const failedEditSession = spawn("01a07005-0000-0000-0000-000000000000", "/home/dev/work/failed-edit");
await failedEditSession.fire("session_start");
const failedEditState = {};
const failedEditAsk = failedEditSession.tools
	.get("ask")
	.execute("fb-failed-edit", singleQuestion, undefined, undefined, stubbornCtx(failedEditSession.ctx, failedEditState));
await settle(150);
const failedEditQuestionId = api.nextMessage - 1;
const failedEditButton = lastCall("sendMessage").body.reply_markup.inline_keyboard[0][0];
api.failMethods = ["editMessageText"];
api.failStatus = 429;
api.queued = [answerButton(9030, failedEditQuestionId, failedEditButton.callback_data)];
await ownershipPoller.pump(250);
await failedEditSession.pump(250);
const failedEditResult = await within(failedEditAsk, 500);
check(
	"a tap answers its question while Telegram refuses the edit that settles the card",
	failedEditResult?.details.selectedOptions[0] === "SQLite" &&
		inboxCount(failedEditSession.id) === 0 &&
		record(failedEditSession.id).question === null,
);
const refusedTapEdits = settleEdits(failedEditQuestionId);
api.failMethods = [];
api.failStatus = undefined;
await settle(2500);
const takenTapEdits = settleEdits(failedEditQuestionId);
await settle(2500);
check(
	"a refused settlement edit is sent again until Telegram takes it, then no more",
	refusedTapEdits > 0 && takenTapEdits === refusedTapEdits + 1 && settleEdits(failedEditQuestionId) === takenTapEdits,
);
const failedTextSession = spawn("01a0700f-0000-0000-0000-000000000000", "/home/dev/work/failed-text");
await failedTextSession.fire("session_start");
const failedTextState = {};
const failedTextAsk = failedTextSession.tools
	.get("ask")
	.execute("fb-failed-text", singleQuestion, undefined, undefined, stubbornCtx(failedTextSession.ctx, failedTextState));
await settle(150);
const failedTextQuestionId = api.nextMessage - 1;
api.failMethods = ["editMessageText"];
api.failStatus = 429;
api.queued = [replyTo(9035, failedTextQuestionId, "Use the arena")];
await ownershipPoller.pump(250);
await failedTextSession.pump(250);
const failedTextResult = await within(failedTextAsk, 500);
check(
	"a typed answer reaches its question while Telegram refuses the edit that settles the card",
	failedTextResult?.details.customInput === "Use the arena" && inboxCount(failedTextSession.id) === 0,
);
const refusedTextEdits = settleEdits(failedTextQuestionId);
api.failMethods = [];
api.failStatus = undefined;
await settle(2500);
check(
	"the typed answer's settlement edit lands once Telegram takes it",
	settleEdits(failedTextQuestionId) === refusedTextEdits + 1,
);

// The checks above waited out retries for seconds, so the poller renews its lock before the next ones.
ownershipPoller.heartbeat();
// An ask card Telegram throttles is sent again until it lands, and the terminal shows the question meanwhile.
const throttledCardSession = spawn("01a07012-0000-0000-0000-000000000000", "/home/dev/work/throttled-card");
await throttledCardSession.fire("session_start");
const throttledCardState = {};
const cardSends = () =>
	called("sendMessage").filter((c) => String(c.body.text).includes("Which backend?") && c.at >= throttledCardStart)
		.length;
const throttledCardStart = Date.now();
api.failMethods = ["sendMessage"];
api.failStatus = 429;
api.failRetryAfter = 1;
api.failDescription = "Too Many Requests: retry after 1";
const throttledCardAsk = throttledCardSession.tools
	.get("ask")
	.execute(
		"fb-throttled-card",
		singleQuestion,
		undefined,
		undefined,
		stubbornCtx(throttledCardSession.ctx, throttledCardState),
	);
await settle(150);
check("the terminal asks at once while Telegram throttles the card", throttledCardState.params !== undefined);
await settle(2600);
const refusedCards = cardSends();
api.failMethods = [];
api.failStatus = undefined;
api.failRetryAfter = undefined;
api.failDescription = undefined;
await settle(2500);
const throttledCardId = api.nextMessage - 1;
check(
	"a throttled ask card is sent again until it lands, and the question owns it",
	refusedCards >= 2 &&
		cardSends() === refusedCards + 1 &&
		lastCall("sendMessage").body.text.includes("Which backend?") &&
		record(throttledCardSession.id).question === throttledCardId,
);
const throttledCardButton = lastCall("sendMessage").body.reply_markup.inline_keyboard[0][0];
api.queued = [answerButton(9060, throttledCardId, throttledCardButton.callback_data)];
await ownershipPoller.pump(250);
await throttledCardSession.pump(250);
check(
	"the late card's buttons answer the question",
	(await within(throttledCardAsk, 500))?.details.selectedOptions[0] === "SQLite",
);
rmSync(join(root, "notify-telegram/throttle.json"), { force: true });

// A notice the poller owes waits out a throttle without holding up the button presses queued behind it.
const blockedPollSession = spawn("01a07013-0000-0000-0000-000000000000", "/home/dev/work/blocked-poll");
await blockedPollSession.fire("session_start");
const blockedPollAsk = blockedPollSession.tools
	.get("ask")
	.execute("fb-blocked-poll", singleQuestion, undefined, undefined, stubbornCtx(blockedPollSession.ctx, {}));
await settle(150);
const blockedPollQuestionId = api.nextMessage - 1;
const blockedPollButton = lastCall("sendMessage").body.reply_markup.inline_keyboard[0][0];
writeFileSync(join(root, "notify-telegram/throttle.json"), JSON.stringify({ until: Date.now() + 60_000 }));
const toastsBeforeBlocked = called("answerCallbackQuery").length;
api.queued = [
	replyTo(9061, 1, "Where does this go?"),
	answerButton(9062, blockedPollQuestionId, blockedPollButton.callback_data),
];
await ownershipPoller.pump(250);
check(
	"a press behind a throttled poller notice is toasted and delivered",
	called("answerCallbackQuery").length > toastsBeforeBlocked && inboxCount(blockedPollSession.id) === 1,
);
rmSync(join(root, "notify-telegram/throttle.json"), { force: true });
await blockedPollSession.pump(250);
check(
	"the delivered press answers its question",
	(await within(blockedPollAsk, 500))?.details.selectedOptions[0] === "SQLite",
);
ownershipPoller.heartbeat();
// A tap on an earlier question of the ask or on an option that does not exist answers nothing, so it is
// discarded rather than kept, and the valid tap queued behind it still answers.
const staleTapSession = spawn("01a07011-0000-0000-0000-000000000000", "/home/dev/work/stale-tap");
await staleTapSession.fire("session_start");
let staleTapResult = null;
staleTapSession.tools
	.get("ask")
	.execute("fb-stale-tap", singleQuestion, undefined, undefined, stubbornCtx(staleTapSession.ctx, {}))
	.then((result) => {
		staleTapResult = result;
	});
await settle(150);
const staleTapQuestionId = api.nextMessage - 1;
const staleTapData = lastCall("sendMessage").body.reply_markup.inline_keyboard[0][0].callback_data;
const [staleAction, staleTag] = staleTapData.split(":");
api.queued = [
	answerButton(9070, staleTapQuestionId, `${staleAction}:${staleTag}:5:0`),
	answerButton(9071, staleTapQuestionId, `${staleAction}:${staleTag}:0:9`),
	answerButton(9072, staleTapQuestionId, `${staleAction}:${staleTag}`),
	answerButton(9073, staleTapQuestionId, staleTapData),
];
await ownershipPoller.pump(250);
await staleTapSession.pump(250);
check(
	"a stale or malformed tap is discarded without holding back the valid one behind it",
	inboxCount(staleTapSession.id) === 0 && staleTapResult?.details.selectedOptions[0] === "SQLite",
);
// Telegram refusing the edit for good, here because the card was deleted, cannot change on a retry, so
// the answer is taken instead of blocking every later entry behind it.
const goneCardSession = spawn("01a07010-0000-0000-0000-000000000000", "/home/dev/work/gone-card");
await goneCardSession.fire("session_start");
const goneCardState = {};
let goneCardResult = null;
const goneCardAsk = goneCardSession.tools
	.get("ask")
	.execute("fb-gone-card", singleQuestion, undefined, undefined, stubbornCtx(goneCardSession.ctx, goneCardState))
	.then((result) => {
		goneCardResult = result;
	});
await settle(150);
const goneCardQuestionId = api.nextMessage - 1;
api.failMethods = ["editMessageText"];
api.failDescription = "Bad Request: message to edit not found";
api.queued = [replyTo(9036, goneCardQuestionId, "Use the pool")];
await ownershipPoller.pump(250);
await goneCardSession.pump(250);
check(
	"an answer whose card Telegram reports deleted reaches the question without waiting",
	goneCardResult?.details.customInput === "Use the pool" && inboxCount(goneCardSession.id) === 0,
);
api.failMethods = [];
api.failDescription = undefined;
await goneCardSession.pump(250);
await goneCardAsk;

// A staged redo survives a feedback append failure, then commits exactly once on redelivery.
fb.heartbeat();
const interruptedReaction = react(9032, statusId, ["\u{1F44E}"], ["\u{1F44D}"]);
const interruptedOffset = JSON.parse(readFileSync(join(root, "notify-telegram.json"), "utf8")).offset;
const interruptedSteers = fb.steers.length;
const realAppendFileSync = fs.appendFileSync;
let rejectFeedbackAppend = true;
fs.appendFileSync = (path, data, options) => {
	if (rejectFeedbackAppend && String(path) === feedbackFile) {
		rejectFeedbackAppend = false;
		throw new Error("interrupted feedback append");
	}
	return realAppendFileSync(path, data, options);
};
syncBuiltinESMExports();
api.queued = [interruptedReaction];
await ownershipPoller.pump(250);
fs.appendFileSync = realAppendFileSync;
syncBuiltinESMExports();
check(
	"an uncommitted reaction leaves its update offset for retry",
	JSON.parse(readFileSync(join(root, "notify-telegram.json"), "utf8")).offset === interruptedOffset &&
		!feedbackLines().some((entry) => entry.updateId === 9032) &&
		inboxCount(fb.id) === 0,
);
api.queued = [interruptedReaction];
await ownershipPoller.pump(250);
await fb.pump(250);
check(
	"a retried reaction commits its feedback and redo together",
	feedbackLines().filter((entry) => entry.updateId === 9032).length === 1 && fb.steers.length === interruptedSteers + 1,
);
api.queued = [interruptedReaction];
await ownershipPoller.pump(250);
await fb.pump(250);
check(
	"a committed reaction redelivery produces no duplicate effects",
	feedbackLines().filter((entry) => entry.updateId === 9032).length === 1 && fb.steers.length === interruptedSteers + 1,
);

const interruptedPublish = react(9033, statusId, ["\u{1F44E}"], ["\u{1F44D}"]);
const publishOffset = JSON.parse(readFileSync(join(root, "notify-telegram.json"), "utf8")).offset;
const publishSteers = fb.steers.length;
const realTransactionRename = fs.renameSync;
let rejectTransactionPublish = true;
fs.renameSync = (from, to) => {
	if (
		rejectTransactionPublish &&
		String(from).endsWith("/reaction-pending/9033.json") &&
		String(to).endsWith(`${fb.id}/9033.json`)
	) {
		rejectTransactionPublish = false;
		throw new Error("interrupted redo publication");
	}
	return realTransactionRename(from, to);
};
syncBuiltinESMExports();
api.queued = [interruptedPublish];
await ownershipPoller.pump(250);
fs.renameSync = realTransactionRename;
syncBuiltinESMExports();
check(
	"a reaction committed before redo publication keeps its offset for retry",
	JSON.parse(readFileSync(join(root, "notify-telegram.json"), "utf8")).offset === publishOffset &&
		feedbackLines().filter((entry) => entry.updateId === 9033).length === 1 &&
		inboxCount(fb.id) === 0,
);
api.queued = [interruptedPublish];
await ownershipPoller.pump(250);
await fb.pump(250);
check(
	"redelivery publishes a committed pending redo without another feedback row",
	feedbackLines().filter((entry) => entry.updateId === 9033).length === 1 && fb.steers.length === publishSteers + 1,
);
api.queued = [interruptedPublish];
await ownershipPoller.pump(250);
await fb.pump(250);
check(
	"a published pending redo stays single on later redelivery",
	feedbackLines().filter((entry) => entry.updateId === 9033).length === 1 && fb.steers.length === publishSteers + 1,
);

// A redo answers the blocked ask while Telegram refuses the settlement edit, because the user cannot resend it.
const redoRetrySession = spawn("01a07008-0000-0000-0000-000000000000", "/home/dev/work/redo-retry");
await redoRetrySession.fire("session_start");
const redoRetryState = {};
const redoRetryAsk = redoRetrySession.tools
	.get("ask")
	.execute("fb-redo-retry", singleQuestion, undefined, undefined, stubbornCtx(redoRetrySession.ctx, redoRetryState));
await settle(150);
const redoRetryMessageId = api.nextMessage - 1;
api.queued = [react(9034, redoRetryMessageId, ["\u{1F44E}"])];
await ownershipPoller.pump(250);
api.failMethods = ["editMessageText"];
api.failStatus = 429;
await redoRetrySession.pump(250);
const redoRetryResult = await within(redoRetryAsk, 500);
check(
	"a redo answers the blocked ask while Telegram refuses the settlement edit",
	redoRetryResult?.details.customInput.includes("reacted") === true &&
		inboxCount(redoRetrySession.id) === 0 &&
		feedbackLines().filter((entry) => entry.updateId === 9034).length === 1,
);
api.failMethods = [];
api.failStatus = undefined;
await settle(2500);
// A new turn can begin while Telegram is still accepting the previous turn's question.
await fb.fire("input");
let releaseStatusSend;
api.sendMessageGate = new Promise((resolve) => {
	releaseStatusSend = resolve;
});
await fb.tools
	.get("notify_status")
	.execute(
		"fb-stale-status",
		{ summary: "Need a delayed decision.", urgency: "orange", question: "Keep waiting?" },
		undefined,
		undefined,
		fb.ctx,
	);
await fb.fire("session_stop");
await settle(50);
await fb.fire("input");
releaseStatusSend();
api.sendMessageGate = null;
await settle(150);
check("a late status send cannot reopen a superseded question", record(fb.id).replyQuestion === null);

// Detached sends retain the metadata that accompanied their outgoing text.
const metadataSession = spawn("01a07009-0000-0000-0000-000000000000", "/home/dev/work/metadata", "Before send");
await metadataSession.fire("session_start");
await metadataSession.fire("input");
await metadataSession.tools
	.get("notify_status")
	.execute(
		"fb-metadata",
		{ summary: "Metadata snapshot.", urgency: "green", effect: "none" },
		undefined,
		undefined,
		metadataSession.ctx,
	);
let releaseMetadataSend;
api.sendMessageGate = new Promise((resolve) => {
	releaseMetadataSend = resolve;
});
await metadataSession.fire("session_stop");
await settle(50);
metadataSession.setTitle("After send");
releaseMetadataSend();
api.sendMessageGate = null;
await settle(150);
const metadataMessageId = record(metadataSession.id).recent.at(-1);
check(
	"a sent record keeps the session metadata from before its network wait",
	onRecord(metadataMessageId).session.name === "Before send",
);

// An accepted edit marker covers the interval before its replacement ledger record is published.
const acceptedEditMarkerDir = join(root, "notify-telegram/sent-in-flight");
mkdirSync(acceptedEditMarkerDir, { recursive: true });
const acceptedEditMarker = join(acceptedEditMarkerDir, `edit-${editedQuestionId}-accepted-window`);
writeFileSync(acceptedEditMarker, "");
const acceptedEditReaction = react(9035, editedQuestionId, ["\u{1F44D}"]);
const offsetBeforeAcceptedEdit = JSON.parse(readFileSync(join(root, "notify-telegram.json"), "utf8")).offset;
const feedbackBeforeAcceptedEdit = feedbackLines().length;
api.queued = [acceptedEditReaction];
await ownershipPoller.pump(250);
check(
	"a reaction during accepted edit publication waits for the replacement record",
	JSON.parse(readFileSync(join(root, "notify-telegram.json"), "utf8")).offset === offsetBeforeAcceptedEdit &&
		feedbackLines().length === feedbackBeforeAcceptedEdit,
);
rmSync(acceptedEditMarker, { force: true });
api.queued = [acceptedEditReaction];
await ownershipPoller.pump(250);
check(
	"the deferred reaction grades the published replacement record",
	feedbackLines().at(-1).updateId === 9035 && feedbackLines().at(-1).message.text === onRecord(editedQuestionId).text,
);

// A staged transaction must carry a safe embedded owner before it can append feedback or route a redo.
const unsafePendingUpdate = 9036;
const unsafePendingFile = join(root, `notify-telegram/reaction-pending/${unsafePendingUpdate}.json`);
writeFileSync(
	unsafePendingFile,
	JSON.stringify({
		transaction: 1,
		updateId: unsafePendingUpdate,
		feedback: { updateId: unsafePendingUpdate, message: { session: { id: "../escape" } } },
		kind: "redo",
		value: "unsafe pending redo",
		messageId: statusId,
		targetKind: "status",
	}),
);
const unsafePendingOffset = JSON.parse(readFileSync(join(root, "notify-telegram.json"), "utf8")).offset;
const feedbackBeforeUnsafePending = feedbackLines().length;
api.queued = [react(unsafePendingUpdate, statusId, ["\u{1F44E}"])];
await ownershipPoller.pump(250);
check(
	"an unsafe staged transaction is rejected before feedback or inbox publication",
	JSON.parse(readFileSync(join(root, "notify-telegram.json"), "utf8")).offset === unsafePendingOffset &&
		feedbackLines().length === feedbackBeforeUnsafePending &&
		!existsSync(join(root, `notify-telegram/escape/${unsafePendingUpdate}.json`)),
);
rmSync(unsafePendingFile, { force: true });

// A redo already routed to a live session is delivered before shutdown publishes the dead owner state.
const shutdownRedoSession = spawn("01a0700b-0000-0000-0000-000000000000", "/home/dev/work/shutdown-redo");
await shutdownRedoSession.fire("session_start");
await shutdownRedoSession.fire("input");
await shutdownRedoSession.tools
	.get("notify_status")
	.execute(
		"fb-shutdown-redo",
		{ summary: "Ready to close after feedback.", urgency: "green", effect: "none" },
		undefined,
		undefined,
		shutdownRedoSession.ctx,
	);
await shutdownRedoSession.fire("session_stop");
await settle(150);
const shutdownRedoMessageId = record(shutdownRedoSession.id).recent.at(-1);
const shutdownRedoSteers = shutdownRedoSession.steers.length;
api.queued = [react(9037, shutdownRedoMessageId, ["\u{1F44E}"])];
await ownershipPoller.pump(250);
check(
	"a live owner has the redo queued before shutdown",
	feedbackLines().at(-1).updateId === 9037 &&
		feedbackLines().at(-1).redo === true &&
		inboxCount(shutdownRedoSession.id) === 1,
);
await shutdownRedoSession.fire("session_shutdown");
check(
	"shutdown reclassifies its queued redo before marking the owner dead",
	record(shutdownRedoSession.id).heartbeat === 0 &&
		inboxCount(shutdownRedoSession.id) === 0 &&
		shutdownRedoSession.steers.length === shutdownRedoSteers &&
		lastCall("sendMessage").body.text.includes("session ended"),
);

// A redo on a native question answers it at once, even while Telegram holds the settlement edit, so a shutdown
// right after has nothing left to reclassify.
const settlementRaceSession = spawn("01a0700e-0000-0000-0000-000000000000", "/home/dev/work/settlement-race");
await settlementRaceSession.fire("session_start");
const settlementRaceAsk = settlementRaceSession.tools
	.get("ask")
	.execute("fb-settlement-race", singleQuestion, undefined, undefined, stubbornCtx(settlementRaceSession.ctx, {}));
await settle(150);
const settlementRaceQuestionId = record(settlementRaceSession.id).question;
const settlementRaceInbox = inboxOf(settlementRaceSession.id);
const settlementRaceEntry = join(settlementRaceInbox, "90375.json");
writeFileSync(
	settlementRaceEntry,
	JSON.stringify({
		kind: "redo",
		value: "Restate the question after negative feedback.",
		messageId: settlementRaceQuestionId,
		targetKind: "question",
		targetQuestion: false,
		targetPreEdit: false,
	}),
);
const unreadableSettlementEntry = join(settlementRaceInbox, "unreadable.json");
mkdirSync(unreadableSettlementEntry);
let releaseSettlementEdit;
api.editMessageGate = new Promise((resolve) => {
	releaseSettlementEdit = resolve;
});
await settlementRaceSession.pump(250);
const settlementRaceResult = await within(settlementRaceAsk, 500);
await settlementRaceSession.fire("session_shutdown");
check(
	"a redo answers its question while the settlement edit is held, leaving shutdown nothing queued",
	settlementRaceResult?.details.customInput === "Restate the question after negative feedback." &&
		!existsSync(settlementRaceEntry) &&
		!existsSync(`${settlementRaceEntry}.processing`),
);
rmSync(unreadableSettlementEntry, { recursive: true, force: true });
releaseSettlementEdit();
api.editMessageGate = null;
await settle(50);

// Commit and shutdown serialize through the same owner lock, then a retry records the now-dead route honestly.
const routeRaceSession = spawn("01a0700c-0000-0000-0000-000000000000", "/home/dev/work/route-race");
const routeLockDir = join(root, "notify-telegram/reaction-route-locks");
mkdirSync(routeLockDir, { recursive: true });
const routeLockFile = join(routeLockDir, `${routeRaceSession.id}.lock`);
const routeClosingFile = join(routeLockDir, `${routeRaceSession.id}.closing`);
writeFileSync(routeLockFile, "orphan");
writeFileSync(routeClosingFile, "orphan");
await routeRaceSession.fire("session_start");
check(
	"session startup removes its own orphaned reaction route state",
	!existsSync(routeLockFile) && !existsSync(routeClosingFile),
);
await routeRaceSession.fire("input");
await routeRaceSession.tools
	.get("notify_status")
	.execute(
		"fb-route-race",
		{ summary: "Race the shutdown boundary.", urgency: "green", effect: "none" },
		undefined,
		undefined,
		routeRaceSession.ctx,
	);
await routeRaceSession.fire("session_stop");
await settle(150);
const routeRaceMessageId = record(routeRaceSession.id).recent.at(-1);
writeFileSync(routeLockFile, JSON.stringify({ token: "held", pid: process.pid }));
// The suite's clock runs ahead of the filesystem's, and a fence older than it reads as a dead process's.
utimesSync(routeLockFile, new Date(Date.now()), new Date(Date.now()));
const routeRaceReaction = react(9038, routeRaceMessageId, ["\u{1F44E}"]);
const routeRaceOffset = JSON.parse(readFileSync(join(root, "notify-telegram.json"), "utf8")).offset;
api.queued = [routeRaceReaction];
await ownershipPoller.pump(250);
check(
	"a held owner lock leaves the reaction transaction and offset pending",
	JSON.parse(readFileSync(routeLockFile, "utf8")).token === "held" &&
		existsSync(join(root, "notify-telegram/reaction-pending/9038.json")) &&
		JSON.parse(readFileSync(join(root, "notify-telegram.json"), "utf8")).offset === routeRaceOffset,
);
const pendingRetryWarnings = ownershipPoller.warns.length;
api.queued = [routeRaceReaction];
await ownershipPoller.pump(250);
check(
	"a locked persisted transaction remains retryable",
	existsSync(join(root, "notify-telegram/reaction-pending/9038.json")) &&
		ownershipPoller.warns.length === pendingRetryWarnings + 1 &&
		ownershipPoller.warns.at(-1).m.includes("finish a reaction transaction"),
);
const routeRaceShutdown = routeRaceSession.fire("session_shutdown");
await settle(50);
check("shutdown waits for the owner route lock before publishing death", record(routeRaceSession.id).heartbeat > 0);
rmSync(routeLockFile, { force: true });
await routeRaceShutdown;
api.queued = [routeRaceReaction];
await ownershipPoller.pump(250);
const routeRaceFeedback = feedbackLines().at(-1);
check(
	"a transaction retried after locked shutdown is recorded without a lost redo",
	routeRaceFeedback.updateId === 9038 &&
		routeRaceFeedback.redo === false &&
		!existsSync(join(root, "notify-telegram/reaction-pending/9038.json")) &&
		inboxCount(routeRaceSession.id) === 0 &&
		lastCall("sendMessage").body.text.includes("session ended"),
);
const fenceFailureSession = spawn("01a0700d-0000-0000-0000-000000000000", "/home/dev/work/fence-failure");
await fenceFailureSession.fire("session_start");
const fenceFailureLock = join(routeLockDir, `${fenceFailureSession.id}.lock`);
const fenceFailureClosing = join(routeLockDir, `${fenceFailureSession.id}.closing`);
const realRouteWrite = fs.writeFileSync;
fs.writeFileSync = (path, data, options) => {
	if (String(path) === fenceFailureLock) {
		jump(6_000);
		throw new Error("route lock unavailable");
	}
	return realRouteWrite(path, data, options);
};
syncBuiltinESMExports();
let fenceFailureThrown = false;
try {
	await fenceFailureSession.fire("session_shutdown");
} catch {
	fenceFailureThrown = true;
} finally {
	fs.writeFileSync = realRouteWrite;
	syncBuiltinESMExports();
}
check(
	"a failed forced route acquisition removes its shutdown fence",
	fenceFailureThrown && !existsSync(fenceFailureClosing) && record(fenceFailureSession.id).heartbeat > 0,
);
await fenceFailureSession.fire("session_shutdown");
const malformedStoredUpdate = 9039;
const malformedStoredFile = join(root, `notify-telegram/reaction-pending/${malformedStoredUpdate}.json`);
writeFileSync(
	malformedStoredFile,
	JSON.stringify({
		transaction: 1,
		updateId: malformedStoredUpdate,
		feedback: {
			updateId: malformedStoredUpdate,
			redo: true,
			message: onRecord(statusId),
		},
		kind: "redo",
		value: "forged pre-edit redo",
		messageId: statusId,
		targetKind: "status",
		targetQuestion: false,
		targetPreEdit: "yes",
	}),
);
const feedbackBeforeMalformedStored = feedbackLines().length;
api.queued = [react(malformedStoredUpdate, statusId, ["\u{1F44E}"])];
await ownershipPoller.pump(250);
check(
	"a malformed stored redo forges nothing and is dropped",
	feedbackLines().length === feedbackBeforeMalformedStored &&
		!existsSync(malformedStoredFile) &&
		inboxCount(fb.id) === 0,
);

const malformedRedoFile = join(inboxOf(fb.id), "9040.json");
const steersBeforeMalformedRedo = fb.steers.length;
writeFileSync(
	malformedRedoFile,
	JSON.stringify({
		kind: "redo",
		value: "legacy ambiguous redo",
		messageId: statusId,
		targetQuestion: false,
		targetPreEdit: false,
	}),
);
await fb.pump(150);
check(
	"a redo without a known target kind is discarded",
	!existsSync(malformedRedoFile) &&
		fb.steers.length === steersBeforeMalformedRedo &&
		fb.warns.at(-1).m.includes("malformed redo"),
);

const sentMarkerDir = join(root, "notify-telegram/sent-in-flight");
mkdirSync(sentMarkerDir, { recursive: true });
const staleEditMarker = join(sentMarkerDir, `edit-${statusId}-stale`);
writeFileSync(staleEditMarker, JSON.stringify(statusRecord));
const staleMarkerTime = (Date.now() - 3 * 60_000) / 1000;
utimesSync(staleEditMarker, staleMarkerTime, staleMarkerTime);
api.queued = [react(9041, statusId, ["\u{1F44D}"])];
await ownershipPoller.pump(250);
check(
	"a stale edit marker is removed before grading the current record",
	!existsSync(staleEditMarker) && feedbackLines().at(-1).updateId === 9041,
);

const corruptEditMarker = join(sentMarkerDir, `edit-${statusId}-corrupt`);
writeFileSync(corruptEditMarker, "{");
const corruptMarkerOffset = JSON.parse(readFileSync(join(root, "notify-telegram.json"), "utf8")).offset;
const feedbackBeforeCorruptMarker = feedbackLines().length;
api.queued = [react(9042, statusId, ["\u{1F44D}"])];
await ownershipPoller.pump(250);
check(
	"a corrupt active edit marker defers its reaction",
	JSON.parse(readFileSync(join(root, "notify-telegram.json"), "utf8")).offset === corruptMarkerOffset &&
		feedbackLines().length === feedbackBeforeCorruptMarker,
);
rmSync(corruptEditMarker, { force: true });

const nullEditMarker = join(sentMarkerDir, `edit-${statusId}-null`);
writeFileSync(nullEditMarker, "null");
api.queued = [react(9043, statusId, ["\u{1F44D}"])];
await ownershipPoller.pump(250);
check("a non-record edit marker also defers its reaction", feedbackLines().length === feedbackBeforeCorruptMarker);
rmSync(nullEditMarker, { force: true });

const feedbackBackup = `${feedbackFile}.coverage`;
renameSync(feedbackFile, feedbackBackup);
mkdirSync(feedbackFile);
const unreadableFeedbackOffset = JSON.parse(readFileSync(join(root, "notify-telegram.json"), "utf8")).offset;
const unreadableFeedbackWarnings = ownershipPoller.warns.length;
api.queued = [react(9044, statusId, ["\u{1F44D}"])];
await ownershipPoller.pump(250);
check(
	"an unreadable feedback log defers rather than duplicates a reaction",
	JSON.parse(readFileSync(join(root, "notify-telegram.json"), "utf8")).offset === unreadableFeedbackOffset &&
		ownershipPoller.warns.length === unreadableFeedbackWarnings + 1 &&
		ownershipPoller.warns.at(-1).m.includes("reaction history"),
);
rmSync(feedbackFile, { recursive: true, force: true });
renameSync(feedbackBackup, feedbackFile);

const invalidUpdateFeedback = feedbackLines().length;
api.queued = [react(0, statusId, ["\u{1F44D}"])];
await ownershipPoller.pump(250);
check(
	"an invalid reaction update id never reaches feedback storage",
	feedbackLines().length === invalidUpdateFeedback && ownershipPoller.warns.at(-1).m.includes("invalid update id"),
);

await fb.tools
	.get("notify_snippet")
	.execute("fb-snippet-redo", { purpose: "replacement query", text: "SELECT 1;" }, undefined, undefined, fb.ctx);
const reactionSnippetId = record(fb.id).recent.at(-1);
api.queued = [react(9045, reactionSnippetId, ["\u{1F44E}"])];
await ownershipPoller.pump(250);
await fb.pump(150);
check("negative snippet feedback requests notify_snippet", fb.steers.at(-1).text.includes("notify_snippet"));

const reactionFile = join(root, "reaction-feedback.log");
writeFileSync(reactionFile, "failure");
await fb.tools.get("notify_file").execute("fb-file-redo", { paths: [reactionFile] }, undefined, undefined, fb.ctx);
const reactionFileId = record(fb.id).recent.at(-1);
api.queued = [react(9046, reactionFileId, ["\u{1F44E}"])];
await ownershipPoller.pump(250);
await fb.pump(150);
check("negative file feedback requests notify_file", fb.steers.at(-1).text.includes("notify_file"));

const steersBeforeStableNegative = fb.steers.length;
api.queued = [react(9047, statusId, ["\u{1F44E}", "\u{1F44D}"], ["\u{1F44E}"])];
await ownershipPoller.pump(250);
await fb.pump(150);
check(
	"adding praise to an existing negative grade does not request another redo",
	feedbackLines().at(-1).updateId === 9047 &&
		feedbackLines().at(-1).grade === -2 &&
		feedbackLines().at(-1).redo === false &&
		fb.steers.length === steersBeforeStableNegative &&
		inboxCount(fb.id) === 0,
);

api.queued = [react(9048, statusId, ["\u{1F4A9}"], ["\u{1F44E}"])];
await ownershipPoller.pump(250);
await fb.pump(150);
check(
	"a more-negative grade requests a fresh redo",
	feedbackLines().at(-1).updateId === 9048 &&
		feedbackLines().at(-1).grade === -3 &&
		feedbackLines().at(-1).redo === true &&
		fb.steers.length === steersBeforeStableNegative + 1,
);

// A stale route fence a dead poller leaves behind must not stop the next redo to that session.
const staleFenceSession = spawn("01a07100-0000-0000-0000-000000000000", "/home/dev/work/stale-fence");
await staleFenceSession.fire("session_start");
await staleFenceSession.fire("input");
await staleFenceSession.tools
	.get("notify_status")
	.execute(
		"fb-stale-fence",
		{ summary: "Fence expiration audit.", urgency: "green", effect: "none" },
		undefined,
		undefined,
		staleFenceSession.ctx,
	);
await staleFenceSession.fire("session_stop");
await settle(150);
const staleFenceMessageId = record(staleFenceSession.id).recent.at(-1);
const pressTarget = spawn("01a07101-0000-0000-0000-000000000000", "/home/dev/work/press-target");
await pressTarget.fire("session_start");
const staleFenceLockFile = join(routeLockDir, `${staleFenceSession.id}.lock`);
writeFileSync(staleFenceLockFile, "dead-poller-token");
const staleFenceAge = (Date.now() - 60_000) / 1000;
utimesSync(staleFenceLockFile, staleFenceAge, staleFenceAge);
const staleFenceOffset = JSON.parse(readFileSync(join(root, "notify-telegram.json"), "utf8")).offset;
check("the fence batch sits above the current offset", staleFenceOffset === 9074);
const stalePressPath = join(inboxOf(pressTarget.id), "9076.json");
api.queued = [
	react(9075, staleFenceMessageId, ["\u{1F44E}"]),
	answerButton(9076, staleFenceMessageId, `k:${record(pressTarget.id).tag}-1:0`),
];
await ownershipPoller.pump(250);
const stalePress = existsSync(stalePressPath) ? JSON.parse(readFileSync(stalePressPath, "utf8")) : null;
check(
	"a stale route fence is taken over, letting the redo and the press behind it through",
	!existsSync(staleFenceLockFile) &&
		feedbackLines().at(-1)?.updateId === 9075 &&
		feedbackLines().at(-1)?.redo === true &&
		existsSync(join(inboxOf(staleFenceSession.id), "9075.json")) &&
		stalePress?.kind === "callback" &&
		JSON.parse(readFileSync(join(root, "notify-telegram.json"), "utf8")).offset === 9077,
);
rmSync(stalePressPath, { force: true });
rmSync(join(inboxOf(staleFenceSession.id), "9075.json"), { force: true });

// A malformed stored transaction must not hold the offset, so a press queued behind it still lands.
const malformedBehindFile = join(root, "notify-telegram/reaction-pending/9077.json");
writeFileSync(malformedBehindFile, JSON.stringify({ transaction: 1, updateId: 9077, feedback: { updateId: 9078 } }));
const malformedBehindFeedback = feedbackLines().length;
const malformedBehindPressPath = join(inboxOf(pressTarget.id), "9078.json");
api.queued = [
	react(9077, statusId, ["\u{1F44E}"]),
	answerButton(9078, statusId, `k:${record(pressTarget.id).tag}-1:0`),
];
await ownershipPoller.pump(250);
const malformedBehindPress = existsSync(malformedBehindPressPath)
	? JSON.parse(readFileSync(malformedBehindPressPath, "utf8"))
	: null;
check(
	"a press queued behind a malformed stored reaction is delivered and the offset passes both",
	feedbackLines().length === malformedBehindFeedback &&
		!existsSync(malformedBehindFile) &&
		malformedBehindPress?.kind === "callback" &&
		JSON.parse(readFileSync(join(root, "notify-telegram.json"), "utf8")).offset === 9079,
);
rmSync(malformedBehindPressPath, { force: true });
// Delete their fresh records so they cannot hold palette badges into the crash section's badge re-solve.
rmSync(join(sessionsDir, `${staleFenceSession.id}.json`), { force: true });
rmSync(join(sessionsDir, `${pressTarget.id}.json`), { force: true });

// Sent-message records have a longer retention period than downloaded media.
const staleRecord = join(sentDir, "1.json");
const freshRecord = join(sentDir, "2.json");
writeFileSync(staleRecord, "{}");
writeFileSync(freshRecord, "{}");
const ninetyOneDaysAgo = (Date.now() - 91 * 24 * 3600 * 1000) / 1000;
utimesSync(staleRecord, ninetyOneDaysAgo, ninetyOneDaysAgo);
const staleMedia = join(mediaDir, "stale-retention.bin");
const freshMedia = join(mediaDir, "fresh-retention.bin");

writeFileSync(staleMedia, "");
writeFileSync(freshMedia, "");
const eightDaysAgo = (Date.now() - 8 * 24 * 3600 * 1000) / 1000;
utimesSync(staleMedia, eightDaysAgo, eightDaysAgo);
const sweeper = spawn("01a07002-0000-0000-0000-000000000000", "/home/dev/work/sweeper");
await sweeper.fire("session_start");
check("a record older than ninety days is swept", !existsSync(staleRecord));
check("a younger record stays", existsSync(freshRecord));
check("downloaded media older than seven days is swept", !existsSync(staleMedia));
check("younger downloaded media stays", existsSync(freshMedia));

// A writer killed between the temp write and the rename leaves its temp behind, and the hourly sweep collects it.
jump(3_600_000 + 60_000);
const staleTmpSessions = join(sessionsDir, `${sweeper.id}.json.424242.deadbeef.tmp`);
const staleTmpRoot = join(root, "notify-telegram/poller.lock.424242.deadbeef.tmp");
writeFileSync(staleTmpSessions, "");
writeFileSync(staleTmpRoot, "");
const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000);
utimesSync(staleTmpSessions, twoHoursAgo, twoHoursAgo);
utimesSync(staleTmpRoot, twoHoursAgo, twoHoursAgo);
const freshTmp = join(sessionsDir, `${sweeper.id}.json.424242.feedface.tmp`);
writeFileSync(freshTmp, "");
utimesSync(freshTmp, new Date(Date.now()), new Date(Date.now()));
sweeper.heartbeat();
await settle(150);
check("a two-hour-old temp under sessions/ is swept", !existsSync(staleTmpSessions));
check("a two-hour-old temp in the state root is swept", !existsSync(staleTmpRoot));
check(
	"a fresh temp and the session record survive the sweep",
	existsSync(freshTmp) && existsSync(join(sessionsDir, `${sweeper.id}.json`)),
);

// ------------------------------------------------------------ upstream_launch
heading("upstream_launch");
{
	const upId = "01a070f0-0000-0000-0000-000000000000";
	const up2Id = "01a070f0-0000-0000-0000-000000000002";
	const noCfgId = "01a070f1-0000-0000-0000-000000000000";
	const upBin = join(root, "launch-bin");
	mkdirSync(upBin, { recursive: true });
	writeFileSync(
		join(upBin, "gh"),
		`#!/bin/sh
args="$*"
[ -n "$GH_LOG" ] && echo "$args" >> "$GH_LOG"
case "$args" in
  "api user "*)
    if [ -n "$GH_SLOW" ]; then sleep 1; fi
    if [ "$GH_NOLOGIN" = "1" ]; then exit 1; else echo "LucaCappelletti94"; fi ;;
  *"--method POST"*)
    if [ "$GH_FORKFAIL" = "1" ]; then echo "fork failed" 1>&2; exit 1
    elif [ -n "$GH_FORK_CREATED" ]; then echo "$GH_FORK_CREATED"
    else name=\${args#*repos/*/}; echo "LucaCappelletti94/\${name%%/*}"; fi ;;
  *graphql*)
    if [ "$GH_FORKSFAIL" = "1" ]; then echo "HTTP 502" 1>&2; exit 1
    elif [ -n "$GH_FORK_EXISTING" ]; then echo "$GH_FORK_EXISTING"; fi ;;
  *".permissions.push"*)
    if [ "$GH_NOREPO" = "1" ]; then echo "Not Found (HTTP 404)" 1>&2; exit 1
    elif [ "$GH_PUSH" = "1" ]; then echo true; else echo false; fi ;;
  *defaultBranchRef*) if [ "$GH_NODEFAULT" = "1" ]; then exit 1; else echo "main"; fi ;;
  *"pr list"*) echo "no pr" ;;
  *) echo "unhandled gh $args" 1>&2; exit 1 ;;
esac
`,
		{ mode: 0o755 },
	);
	writeFileSync(
		join(upBin, "git"),
		`#!/bin/sh
args="$*"
[ -n "$GIT_LOG" ] && echo "$args" >> "$GIT_LOG"
case "$args" in
  *"remote -v"*)
    if [ "$GIT_NOTREPO" = "1" ]; then echo "not a git repository" 1>&2; exit 128; fi
    printf '%s\\n' "$GIT_REMOTES" | tr ';' '\\n' | while read -r n u p; do
      if [ -n "$n" ]; then printf '%s\\t%s (fetch)\\n%s\\t%s (push)\\n' "$n" "$u" "$n" "\${p:-$u}"; fi
    done ;;
  *"show-ref"*) [ "$GIT_BRANCH_EXISTS" = "1" ] ;;
  *"remote add"*) if [ "$GIT_ADDFAIL" = "1" ]; then echo "add failed" 1>&2; exit 1; fi ;;
  *clone*)
    if [ "$GIT_CLONEFAIL" = "1" ]; then echo "clone failed" 1>&2; exit 1
    elif [ -n "$GIT_CLONE_FLAKY" ]; then
      if [ -f "$GIT_CLONE_FLAKY" ]; then exit 0; else : > "$GIT_CLONE_FLAKY"; echo "not ready" 1>&2; exit 1; fi
    else exit 0; fi ;;
  *fetch*) if [ "$GIT_FETCHFAIL" = "1" ]; then echo "fetch failed" 1>&2; exit 1; else exit 0; fi ;;
  *"worktree add"*) if [ "$GIT_WTFAIL" = "1" ]; then echo "wt failed" 1>&2; exit 1; else exit 0; fi ;;
  *"worktree remove"*) last=""; for a in $args; do last="$a"; done; rm -rf "$last" ;;
  *) exit 0 ;;
esac
`,
		{ mode: 0o755 },
	);
	writeFileSync(
		join(upBin, "tmux"),
		`#!/bin/sh
[ -n "$TMUX_LOG" ] && echo "$*" >> "$TMUX_LOG"
case "$1" in
  new-window) if [ "$TMUX_NEWWIN_FAIL" = "1" ]; then echo "nw failed" 1>&2; exit 1; else echo "@42"; fi ;;
  display-message) if [ "$TMUX_PLACE_FAIL" = "1" ]; then exit 1; fi; printf 'work\\t3\\t1\\n' ;;
  *) exit 0 ;;
esac
`,
		{ mode: 0o755 },
	);
	const ghLog = join(root, "launch-gh.log");
	const gitLog = join(root, "launch-git.log");
	const tmuxLog = join(root, "launch-tmux.log");
	const oldPath = process.env.PATH;
	const oldHome = process.env.HOME;
	process.env.PATH = `${upBin}:${oldPath}`;
	process.env.GH_LOG = ghLog;
	process.env.GIT_LOG = gitLog;
	process.env.TMUX_LOG = tmuxLog;
	const freshLogs = () => {
		for (const log of [ghLog, gitLog, tmuxLog]) writeFileSync(log, "");
	};
	freshLogs();
	process.env.HOME = root;
	process.env.TMUX = "/tmp/fake-tmux,1,0";
	process.env.TMUX_PANE = "%1";
	const requestsDir = join(root, "notify-telegram/graph/requests");
	const launchesDir = join(root, "notify-telegram/graph/launches");
	const nodesDir = join(root, "notify-telegram/graph/nodes");
	const ghText = () => readFileSync(ghLog, "utf8");
	const gitText = () => readFileSync(gitLog, "utf8");
	const tmuxText = () => readFileSync(tmuxLog, "utf8");
	const launchFiles = () =>
		existsSync(launchesDir) ? readdirSync(launchesDir).filter((f) => f.endsWith(".json")) : [];
	const requestOf = (id) => JSON.parse(readFileSync(join(requestsDir, `${id}.json`), "utf8"));
	const cardOf = (id) =>
		called("sendMessage")
			.map((c) => c.body)
			.find((b) => JSON.stringify(b).includes(`u:${id}:`));
	const lastEdit = (id) =>
		called("editMessageText")
			.map((c) => c.body)
			.filter((b) => b.message_id === id)
			.at(-1);
	const waitForEdit = async (id, predicate, timeout = 4_000) => {
		const until = Date.now() + timeout;
		while (Date.now() < until) {
			const edited = lastEdit(id);
			if (edited !== undefined && predicate(edited)) return edited;
			await settle(50);
		}
		return lastEdit(id);
	};
	const cardKeyboard = (id) => (lastEdit(id)?.reply_markup ?? cardOf(id).reply_markup).inline_keyboard;
	const toasts = () => called("answerCallbackQuery").map((c) => c.body.text ?? "");
	const told = (needle) => up.customs.some((c) => String(c.message.content).includes(needle));
	rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
	const workK = join(root, "work-L");
	mkdirSync(workK, { recursive: true });
	writeFileSync(join(workK, "req.md"), "# Problem\nThe parser rejects valid X.\n\n## Failure\nx\n\n## Corrected\ny\n");
	const up = spawn(upId, workK);
	await up.fire("session_start");
	up.heartbeat();
	await settle(100);
	check(
		"the poller lock is held by the requesting session",
		JSON.parse(readFileSync(join(root, "notify-telegram/poller.lock"), "utf8")).sessionId === up.id,
	);
	const launchTool = (tag, params) =>
		up.tools.get("upstream_launch").execute(tag, params, undefined, undefined, up.ctx);
	let tapSeq = 0;
	const tap = async (requestId, action) => {
		const seq = ++tapSeq;
		const cardId = requestOf(requestId).messageId;
		api.queued = [
			{
				update_id: 9_000_000 + seq,
				callback_query: {
					id: `ltap${seq}`,
					data: `u:${requestId}:${action}`,
					from: { id: CHAT },
					message: { message_id: cardId, chat: { id: CHAT } },
				},
			},
		];
		await up.pump(400);
	};
	const deliver = async () => {
		await up.pump(200);
		await up.pump(200);
	};
	const replyToCard = async (cardId, text) => {
		api.queued = [
			{
				update_id: 17000 + ++tapSeq,
				message: {
					message_id: 17000 + tapSeq,
					date: 1,
					chat: { id: CHAT },
					text,
					reply_to_message: { message_id: cardId },
				},
			},
		];
		await deliver();
	};

	// a. A request returns at once and holds its work until the card is answered.
	mkdirSync(join(root, "github", "dep", ".git", "info"), { recursive: true });
	process.env.GIT_REMOTES = "origin git@github.com:LucaCappelletti94/dep.git";
	const own = await launchTool("a", {
		repo: "LucaCappelletti94/dep",
		document: "req.md",
		problem: "It rejects valid X.",
	});
	const ownId = own.details?.id;
	check(
		"a request does not block on the launch",
		!own.isError && own.details?.requested === true && own.details?.state === "pending",
		own.content[0].text,
	);
	check(
		"a request tells the model the decision arrives as a message",
		own.content[0].text.includes("Nothing launched yet") && own.content[0].text.includes("arrive as messages"),
	);
	const ownReq = requestOf(ownId);
	check("the request file names the requester", ownReq.requester === upId);
	check("the request file holds the document", ownReq.doc === readFileSync(join(workK, "req.md"), "utf8"));
	check("the request file holds the requesting tmux session", ownReq.tmux === "work");
	check("the request file names the card", typeof ownReq.messageId === "number");
	check("the request file holds the requesting tmux window", ownReq.tmuxWindow === 3, String(ownReq.tmuxWindow));
	check(
		"the card names the repository and the problem",
		cardOf(ownId).text.includes("LucaCappelletti94/dep") && cardOf(ownId).text.includes("It rejects valid X."),
	);
	check(
		"the card carries the requester's head",
		cardOf(ownId).text.includes("Task:") && cardOf(ownId).text.includes("Model:"),
		cardOf(ownId).text,
	);
	check(
		"the card names the requester's tab",
		cardOf(ownId).text.includes("in tmux <code>work:3</code>. Nothing has launched yet."),
		cardOf(ownId).text,
	);
	check("the card offers Launch, Cancel and already started", cardKeyboard(ownId).flat().length === 3);
	freshLogs();
	await settle(300);
	check("nothing launches before the card is answered", ghText() === "" && gitText() === "" && tmuxText() === "");

	// a2. The Launch tap runs the launch in the poller and settles the card.
	await tap(ownId, "l");
	check("the Launch tap toasts at once", toasts().at(-1) === "Starting it.", toasts().join("|"));
	check(
		"the Launch tap does not answer with a text message",
		!called("sendMessage").some((c) => c.body.text === "Starting it."),
	);
	await settle(500);
	const ownDone = requestOf(ownId);
	check("the launch reaches the launched state", ownDone.state === "launched", ownDone.state);
	check(
		"the launch names the branch and the tab",
		ownDone.branch === "upstream/it-rejects-valid-x" && ownDone.tab === "@42",
		JSON.stringify(ownDone),
	);
	const ownCard = await waitForEdit(requestOf(ownId).messageId, (e) =>
		String(e.text).includes("upstream/it-rejects-valid-x"),
	);
	check("the settled card names the branch", ownCard !== undefined, ownCard?.text);
	check(
		"the settled card keeps the requester's head",
		String(ownCard?.text).includes("Task:") && String(ownCard?.text).includes("Model:"),
		ownCard?.text,
	);
	check("the settled card carries no buttons", ownCard?.reply_markup.inline_keyboard.length === 0);
	await deliver();
	check("the requester is told the outcome", told("upstream/it-rejects-valid-x"));
	const launchOutcome = up.customs.find((c) => String(c.message.content).includes("opened branch"));
	check(
		"the launch outcome reaches the requester written by no one",
		launchOutcome !== undefined &&
			launchOutcome.message.customType === "omp-telegram.dependency" &&
			String(launchOutcome.message.content).includes("written by no one"),
	);
	check(
		"the launch outcome is not attributed to the poller",
		launchOutcome !== undefined && !String(launchOutcome.message.content).includes("from the agent of the omp session"),
	);
	check(
		"the launch carries the request into the worktree",
		existsSync(join(root, "github", "dep.upstreams", "it-rejects-valid-x", "upstream", "request.md")),
	);
	check(
		"the launch excludes upstream/ through the private exclude",
		readFileSync(join(root, "github", "dep", ".git", "info", "exclude"), "utf8").includes("upstream/"),
	);
	check("the own launch neither lists nor creates a fork", !ghText().includes("forks") && !ghText().includes("POST"));
	check("the launching session gets a node so its dependency can reach it", existsSync(join(nodesDir, `${upId}.json`)));
	const ownLaunch = launchFiles()
		.map((f) => JSON.parse(readFileSync(join(launchesDir, f), "utf8")))
		.find((l) => l.repo === "LucaCappelletti94/dep");
	check(
		"the launch records its parent, target and branch for the child to claim",
		ownLaunch?.parent === upId &&
			ownLaunch.branch === "upstream/it-rejects-valid-x" &&
			ownLaunch.problem === "It rejects valid X.",
	);
	check("the launch window opens in the requesting session's tmux session", tmuxText().includes("new-window -t work:"));
	check(
		"the launch window carries the launch id in its environment",
		tmuxText().includes(`-e OMP_TELEGRAM_LAUNCH=${ownLaunch?.id}`),
	);
	check("the kickoff names the parent session to send doubts to", tmuxText().includes(upId));
	check(
		"the launch file is private",
		ownLaunch !== undefined && (statSync(join(launchesDir, `${ownLaunch.id}.json`)).mode & 0o777) === 0o600,
	);

	// b. A third-party repository with no fork yet: the fork is created, under whatever name GitHub gave it.
	process.env.GH_FORK_CREATED = "LucaCappelletti94/widget-1";
	freshLogs();
	const fork = await launchTool("b", { repo: "someorg/widget", document: "req.md", problem: "Widget mis-encodes Y." });
	const forkId = fork.details?.id;
	await tap(forkId, "l");
	await settle(500);
	const forkDone = requestOf(forkId);
	check("the forked launch reaches the launched state", forkDone.state === "launched", forkDone.state);
	check("the forked launch names the branch", forkDone.branch === "upstream/widget-mis-encodes-y", forkDone.branch);
	check(
		"the fork POST names the forked head",
		ghText().includes("--method POST") && ghText().includes("repos/someorg/widget/forks"),
	);
	check(
		"a created fork is cloned by its real name",
		gitText().includes(`clone git@github.com:LucaCappelletti94/widget-1.git ${join(root, "github", "widget")}`),
	);
	check(
		"the created fork's worktree holds the request",
		existsSync(join(root, "github", "widget.upstreams", "widget-mis-encodes-y", "upstream", "request.md")),
	);
	const forkLaunch = launchFiles()
		.map((f) => JSON.parse(readFileSync(join(launchesDir, f), "utf8")))
		.find((l) => l.repo === "someorg/widget");
	check(
		"a fork launch records the head as owner:branch",
		forkLaunch?.branch === "LucaCappelletti94:upstream/widget-mis-encodes-y",
	);
	delete process.env.GH_FORK_CREATED;

	// c. A third-party repository already forked: reuse it, fork nothing, and never re-point a remote.
	process.env.GH_FORK_EXISTING = "LucaCappelletti94/gadget";
	mkdirSync(join(root, "github", "gadget", ".git", "info"), { recursive: true });
	process.env.GIT_REMOTES =
		"origin git@github.com:LucaCappelletti94/gadget.git;upstream git@github.com:someoneelse/gadget.git";
	freshLogs();
	const reuse = await launchTool("c", { repo: "someorg/gadget", document: "req.md", problem: "Gadget drops Z." });
	await tap(reuse.details?.id, "l");
	await settle(500);
	check("an existing fork is reused without a new fork", requestOf(reuse.details?.id).state === "launched");
	check("case c reuses without forking", !ghText().includes("--method POST"));
	check("case c never re-points an existing remote", !gitText().includes("set-url") && !gitText().includes("rename"));
	check(
		"case c adds the target under a free remote name and branches from it",
		gitText().includes("remote add someorg git@github.com:someorg/gadget.git") &&
			/worktree add .* someorg\/main$/mu.test(gitText()),
	);
	delete process.env.GH_FORK_EXISTING;
	process.env.GIT_REMOTES = "origin git@github.com:LucaCappelletti94/dep.git";

	// d. A Cancel tap closes the request without launching.
	freshLogs();
	const cancel = await launchTool("d", { repo: "someorg/thing", document: "req.md", problem: "Thing breaks." });
	const cancelId = cancel.details?.id;
	await tap(cancelId, "c");
	await settle(300);
	check("a Cancel tap closes the request", requestOf(cancelId).state === "cancelled");
	const cancelCard = await waitForEdit(requestOf(cancelId).messageId, (e) => String(e.text).includes("Cancelled"));
	check(
		"the cancelled card settles without buttons",
		cancelCard !== undefined && cancelCard.reply_markup.inline_keyboard.length === 0,
		cancelCard?.text,
	);
	check("no tool runs for a cancelled request", ghText() === "" && gitText() === "" && tmuxText() === "");
	await deliver();
	check("the requester is told the cancel", told("cancelled on Telegram"));

	// d2. A text reply to a card is the user's word, held for the requesting session and steered to it.
	freshLogs();
	const replyRes = await launchTool("d2", {
		repo: "someorg/reply-only",
		document: "req.md",
		problem: "The parser rejects X.",
	});
	const replyId = replyRes.details?.id;
	const replyText = "Another session is already fixing this.\nUse its result.";
	await replyToCard(requestOf(replyId).messageId, replyText);
	await settle(300);
	check(
		"a text reply to a card reaches the session as a user message",
		up.steers.some((s) => steerText(s) === replyText),
		JSON.stringify(up.steers.map((s) => steerText(s))),
	);
	check(
		"a reply to a card is not an aside",
		!up.customs.some((c) => String(c.message.content).includes("Use its result.")),
	);
	check("a text reply does not change the request state", requestOf(replyId).state === "pending");
	check(
		"a text reply does not launch",
		ghText() === "" && gitText() === "" && !tmuxText().includes("new-window") && !tmuxText().includes("new-session"),
	);
	await launchTool("d2cancel", { action: "retract", id: replyId });

	// d3. An already started tap closes the request with no launch.
	freshLogs();
	const launchesBeforeExisting = launchFiles().sort().join(",");
	const existing = await launchTool("d3", {
		repo: "someorg/existing-work",
		document: "req.md",
		problem: "This upstream fix is already underway.",
	});
	const existingId = existing.details?.id;
	await tap(existingId, "a");
	await settle(300);
	check("an already started tap closes the request", requestOf(existingId).state === "already-started");
	const existingCard = await waitForEdit(requestOf(existingId).messageId, (e) =>
		/already started/.test(String(e.text)),
	);
	check("the already started card settles", existingCard !== undefined, existingCard?.text);
	check(
		"an already started tap launches nothing and records nothing",
		ghText() === "" &&
			gitText() === "" &&
			tmuxText() === "" &&
			launchFiles().sort().join(",") === launchesBeforeExisting,
	);
	await deliver();
	check("the requester is told the already started outcome", told("closed as already started"));

	// e. Validation refuses before any request file or card.
	const badRepo = await launchTool("e1", { repo: "not-a-repo", document: "req.md", problem: "x" });
	check("a malformed repo is refused", badRepo.isError === true && badRepo.content[0].text.includes("owner/name"));
	const noDoc = await launchTool("e2", { repo: "a/b", document: "missing.md", problem: "x" });
	check(
		"a missing request document is refused",
		noDoc.isError === true && noDoc.content[0].text.includes("no request document"),
	);
	delete process.env.TMUX;
	const noTmux = await launchTool("e3", { repo: "a/b", document: "req.md", problem: "x" });
	process.env.TMUX = "/tmp/fake-tmux,1,0";
	check(
		"a request without tmux is refused",
		noTmux.isError === true && noTmux.content[0].text.includes("no tmux session"),
	);

	// f. Every failure lands in the request file and keeps the card open.
	const failLaunch = async (tag, repo, problem, extra, slug) => {
		const prev = {};
		for (const [key, value] of Object.entries(extra)) {
			prev[key] = process.env[key];
			process.env[key] = value;
		}
		const res = await launchTool(tag, { repo, document: "req.md", problem, ...(slug === undefined ? {} : { slug }) });
		const id = res.details?.id;
		await tap(id, "l");
		await settle(300);
		for (const key of Object.keys(extra)) {
			if (prev[key] === undefined) delete process.env[key];
			else process.env[key] = prev[key];
		}
		return { id, res };
	};
	const checkFailed = (label, id, needle) => {
		const r = requestOf(id);
		check(`${label}: the state is failed`, r.state === "failed", r.state);
		check(`${label}: the error names the cause`, String(r.error).includes(needle), r.error);
		check(`${label}: the card keeps the Launch and Cancel buttons`, cardKeyboard(id).flat().length === 3);
	};
	{
		const { id } = await failLaunch("e-login", "LucaCappelletti94/dep", "P.", { GH_NOLOGIN: "1" });
		checkFailed("an unreadable gh login", id, "could not read your GitHub login");
		freshLogs();
		await tap(id, "l");
		await settle(600);
		check(
			"a retry tap on a failed request relaunches",
			requestOf(id).state === "launched" &&
				gitText().includes("worktree add") &&
				tmuxText().includes("new-window -t work:"),
		);
		await deliver();
	}
	const { id: noTargetId } = await failLaunch("e-notarget", "someorg/gone", "P.", { GH_NOREPO: "1" });
	checkFailed("an unreadable target repository", noTargetId, "from GitHub");
	freshLogs();
	const { id: forksFailId } = await failLaunch("e-forksfail", "someorg/unlisted", "P.", { GH_FORKSFAIL: "1" });
	checkFailed("a failing fork lookup", forksFailId, "could not look up your fork");
	check("a failing fork lookup does not fork", !ghText().includes("--method POST"));
	mkdirSync(join(root, "github", "diffrepo", ".git", "info"), { recursive: true });
	const { id: wrongForkId } = await failLaunch("e-wrong", "LucaCappelletti94/diffrepo", "P.", {
		GIT_REMOTES: "origin git@github.com:someoneelse/other.git",
	});
	checkFailed("a clone holding a different repository", wrongForkId, "no remote pointing at");
	const { id: forkFailId } = await failLaunch("e-forkfail", "someorg/ff", "P.", { GH_FORKFAIL: "1" });
	checkFailed("a refused fork creation", forkFailId, "forking someorg/ff failed");
	const { id: cloneFailId } = await failLaunch("e-clonefail", "LucaCappelletti94/clonefail", "P.", {
		GIT_CLONEFAIL: "1",
	});
	checkFailed("a failing clone", cloneFailId, "git clone");
	mkdirSync(join(root, "github", "fetchfail", ".git", "info"), { recursive: true });
	const { id: fetchFailId } = await failLaunch("e-fetchfail", "LucaCappelletti94/fetchfail", "P.", {
		GIT_REMOTES: "origin git@github.com:LucaCappelletti94/fetchfail.git",
		GIT_FETCHFAIL: "1",
	});
	checkFailed("a failing fetch", fetchFailId, "git fetch");
	mkdirSync(join(root, "github", "deffail", ".git", "info"), { recursive: true });
	const { id: defFailId } = await failLaunch("e-deffail", "LucaCappelletti94/deffail", "P.", {
		GIT_REMOTES: "origin git@github.com:LucaCappelletti94/deffail.git",
		GH_NODEFAULT: "1",
	});
	checkFailed("a missing default branch", defFailId, "default branch");
	mkdirSync(join(root, "github", "wtfail", ".git", "info"), { recursive: true });
	const { id: wtFailId } = await failLaunch("e-wtfail", "LucaCappelletti94/wtfail", "P.", {
		GIT_REMOTES: "origin git@github.com:LucaCappelletti94/wtfail.git",
		GIT_WTFAIL: "1",
	});
	checkFailed("a failing worktree add", wtFailId, "git worktree add failed");
	mkdirSync(join(root, "github", "wtexists", ".git", "info"), { recursive: true });
	mkdirSync(join(root, "github", "wtexists.upstreams", "edge-case"), { recursive: true });
	const { id: wtExistsId } = await failLaunch("e-wtexists", "LucaCappelletti94/wtexists", "Edge case.", {
		GIT_REMOTES: "origin git@github.com:LucaCappelletti94/wtexists.git",
	});
	checkFailed("an existing worktree", wtExistsId, "a worktree already exists");
	await deliver();
	check("the requester is told the failure", told("a worktree already exists"));

	// g. A directory or an empty document is refused.
	const dirDoc = await launchTool("g1", { repo: "a/b", document: ".", problem: "P." });
	check("a document that is a directory is refused", dirDoc.isError === true);
	writeFileSync(join(workK, "empty.md"), "   \n");
	const emptyDoc = await launchTool("g2", { repo: "a/b", document: "empty.md", problem: "P." });
	check("an empty request document is refused", emptyDoc.isError === true);

	// h. A session with no Telegram config refuses before anything else.
	const cfgBackup = readFileSync(join(root, "notify-telegram.json"), "utf8");
	writeFileSync(join(root, "notify-telegram.json"), "");
	const noCfg = spawn(noCfgId, workK);
	await noCfg.fire("session_start");
	const requestsBeforeNoCfg = existsSync(requestsDir) ? readdirSync(requestsDir).length : 0;
	const noCfgRes = await noCfg.tools
		.get("upstream_launch")
		.execute("h", { repo: "a/b", document: "req.md", problem: "P." }, undefined, undefined, noCfg.ctx);
	check(
		"a session without a bot config refuses the request",
		noCfgRes.isError === true && noCfgRes.content[0].text.includes("Telegram is not configured"),
	);
	check("a refused request writes no request file", readdirSync(requestsDir).length === requestsBeforeNoCfg);
	writeFileSync(join(root, "notify-telegram.json"), cfgBackup);

	// i. A card that cannot be sent is refused without a request file.
	const requestsBeforeSend = readdirSync(requestsDir).length;
	api.failMethods = ["sendMessage"];
	api.failDescription = "telegram down";
	const sendFail = await launchTool("i", { repo: "a/b", document: "req.md", problem: "P." });
	api.failMethods = [];
	check(
		"an unsent card refuses the request",
		sendFail.isError === true && sendFail.content[0].text.includes("could not send the launch card"),
	);
	check("an unsent card writes no request file", readdirSync(requestsDir).length === requestsBeforeSend);

	// j. A fresh fork whose first clone is not ready yet is retried to success.
	const flakyMarker = join(root, "flaky-clone-marker");
	rmSync(flakyMarker, { force: true });
	const flaky = await launchTool("j", { repo: "someorg/flaky", document: "req.md", problem: "P." });
	process.env.GIT_CLONE_FLAKY = flakyMarker;
	await tap(flaky.details?.id, "l");
	await settle(2_800);
	delete process.env.GIT_CLONE_FLAKY;
	check(
		"a fork whose first clone is not ready is retried to success",
		requestOf(flaky.details?.id).state === "launched",
		requestOf(flaky.details?.id).state,
	);
	check("the flaky clone ran twice", (gitText().match(/clone /g) ?? []).length >= 2);

	// k. A launch that cannot open its tmux window rolls the worktree back and reports it.
	mkdirSync(join(root, "github", "rollback", ".git", "info"), { recursive: true });
	const rolledBack = await launchTool("k", {
		repo: "LucaCappelletti94/rollback",
		document: "req.md",
		problem: "P.",
		slug: "p",
	});
	process.env.GIT_REMOTES = "origin git@github.com:LucaCappelletti94/rollback.git";
	process.env.TMUX_NEWWIN_FAIL = "1";
	await tap(rolledBack.details?.id, "l");
	await settle(400);
	delete process.env.TMUX_NEWWIN_FAIL;
	check(
		"a failed tmux window fails the launch",
		requestOf(rolledBack.details?.id).state === "failed" &&
			String(requestOf(rolledBack.details?.id).error).includes("tmux new-window failed"),
	);
	check("the rolled-back worktree is gone", !existsSync(join(root, "github", "rollback.upstreams", "p")));
	check(
		"a rolled-back launch leaves no launch record",
		!launchFiles().some(
			(f) => JSON.parse(readFileSync(join(launchesDir, f), "utf8")).repo === "LucaCappelletti94/rollback",
		),
	);
	check("the failed window card keeps its buttons", cardKeyboard(rolledBack.details?.id).flat().length === 3);
	await deliver();

	// l..y the launch mechanics, each through its own request.
	const entry = async (tag, params, env) => {
		const prev = {};
		for (const [key, value] of Object.entries(env)) {
			prev[key] = process.env[key];
			process.env[key] = value;
		}
		freshLogs();
		const res = await launchTool(tag, params);
		const id = res.details?.id;
		await tap(id, "l");
		await settle(400);
		for (const key of Object.keys(env)) {
			if (prev[key] === undefined) delete process.env[key];
			else process.env[key] = prev[key];
		}
		return { id, git: gitText(), gh: ghText(), tmux: tmuxText() };
	};

	// m. A fork named differently from its parent is found by its parent and used by its real name.
	{
		const { id, git, gh, tmux } = await entry(
			"m",
			{ repo: "upstreamorg/longname-rs", document: "req.md", problem: "P." },
			{
				GH_FORK_EXISTING: "LucaCappelletti94/shortname-rs",
			},
		);
		check(
			"a differently named fork is reused without forking again",
			requestOf(id).state === "launched" && !gh.includes("--method POST"),
		);
		check(
			"a differently named fork is cloned by its real name",
			git.includes(`clone git@github.com:LucaCappelletti94/shortname-rs.git ${join(root, "github", "longname-rs")}`),
		);
		check(
			"the fresh fork clone gains the target remote and branches from it",
			git.includes("remote add upstream git@github.com:upstreamorg/longname-rs.git") &&
				/worktree add .* upstream\/main$/mu.test(git),
		);
		check(
			"the kickoff names the fork's real compare page",
			tmux.includes(
				"https://github.com/upstreamorg/longname-rs/compare/main...LucaCappelletti94:shortname-rs:upstream/p",
			),
		);
		await deliver();
	}

	// n. A clone whose origin is the target and whose fork sits on another remote is used as it stands.
	{
		const splitPath = join(root, "github", "sqlish-rs");
		mkdirSync(join(splitPath, ".git", "info"), { recursive: true });
		const { id, git, tmux } = await entry(
			"n",
			{ repo: "upstreamorg/sqlish-rs", document: "req.md", problem: "P." },
			{
				GH_FORK_EXISTING: "LucaCappelletti94/sqlish",
				GIT_REMOTES: "origin git@github.com:upstreamorg/sqlish-rs.git;fork git@github.com:LucaCappelletti94/sqlish.git",
			},
		);
		check("a clone with the target on origin launches", requestOf(id).state === "launched");
		check(
			"a clone with both remotes present is neither re-cloned nor re-wired",
			!/^(?:clone |.*remote (?:add|set-url|rename|remove))/mu.test(git),
		);
		check(
			"the branch is cut from the remote that points at the target",
			git.includes(`-C ${splitPath} fetch origin`) && /worktree add .* origin\/main$/mu.test(git),
		);
		check(
			"the kickoff names the remote that points at the fork",
			tmux.includes("`fork`") &&
				tmux.includes("https://github.com/upstreamorg/sqlish-rs/compare/main...LucaCappelletti94:sqlish:upstream/p"),
		);
		await deliver();
	}

	// o. With push permission on the target, the branch goes to the target itself.
	{
		mkdirSync(join(root, "github", "maintained", ".git", "info"), { recursive: true });
		const { id, git, gh, tmux } = await entry(
			"o",
			{ repo: "upstreamorg/maintained", document: "req.md", problem: "P." },
			{
				GH_PUSH: "1",
				GIT_REMOTES:
					"origin git@github.com:upstreamorg/maintained.git;fork git@github.com:LucaCappelletti94/maintained-fork.git",
			},
		);
		check("push permission launches against the target itself", requestOf(id).state === "launched");
		check("push permission never looks for or makes a fork", !gh.includes("forks"));
		check(
			"push permission branches from the target remote without re-wiring",
			/worktree add .* origin\/main$/mu.test(git) && !/remote (add|set-url|rename|remove)/u.test(git),
		);
		check(
			"the kickoff sends the push to the target remote",
			tmux.includes("`origin`") && tmux.includes("https://github.com/upstreamorg/maintained/compare/main...upstream/p"),
		);
		await deliver();
	}

	// p. A clone with no remote pointing at the target or the fork is refused and left untouched.
	{
		const strangerPath = join(root, "github", "stranger");
		mkdirSync(join(strangerPath, ".git", "info"), { recursive: true });
		const { id, git } = await entry(
			"p",
			{ repo: "upstreamorg/stranger", document: "req.md", problem: "P." },
			{
				GH_FORK_EXISTING: "LucaCappelletti94/stranger-fork",
				GIT_REMOTES: "origin git@github.com:someoneelse/other.git;upstream git@github.com:third/party.git",
			},
		);
		const r = requestOf(id);
		check("a clone pointing at neither repository is refused", r.state === "failed");
		check(
			"the refusal names both repositories it looked for",
			String(r.error).includes("upstreamorg/stranger") && String(r.error).includes("LucaCappelletti94/stranger-fork"),
			r.error,
		);
		check(
			"the refused clone is only read, never touched",
			git
				.split("\n")
				.filter((line) => line.length > 0)
				.every((line) => line === `-C ${strangerPath} remote -v`),
		);
		check("no worktree is cut for a refused clone", !existsSync(join(root, "github", "stranger.upstreams")));
		await deliver();
	}

	// q. A branch left by an earlier launch is refused, never reset over its commits.
	{
		mkdirSync(join(root, "github", "branchy", ".git", "info"), { recursive: true });
		const { id, git } = await entry(
			"q",
			{ repo: "LucaCappelletti94/branchy", document: "req.md", problem: "P." },
			{
				GIT_REMOTES: "origin git@github.com:LucaCappelletti94/branchy.git",
				GIT_BRANCH_EXISTS: "1",
			},
		);
		check(
			"an existing upstream branch is refused by name",
			requestOf(id).state === "failed" && String(requestOf(id).error).includes("upstream/p"),
		);
		check("an existing upstream branch is never reset", !git.includes("worktree add"));
		await deliver();
	}

	// r. When every preferred remote name is held by something else, the target gets a numbered one.
	{
		mkdirSync(join(root, "github", "crowded", ".git", "info"), { recursive: true });
		const { id, git } = await entry(
			"r",
			{ repo: "crowdorg/crowded", document: "req.md", problem: "P." },
			{
				GH_FORK_EXISTING: "LucaCappelletti94/crowded",
				GIT_REMOTES:
					"origin git@github.com:LucaCappelletti94/crowded.git;upstream git@github.com:x/crowded.git;crowdorg git@github.com:y/crowded.git",
			},
		);
		check(
			"a crowded clone gains the target under a numbered name and branches from it",
			requestOf(id).state === "launched" &&
				git.includes("remote add upstream-2 git@github.com:crowdorg/crowded.git") &&
				/worktree add .* upstream-2\/main$/mu.test(git),
		);
		await deliver();
	}

	// s. A fork creation that answers without a repository name is refused before anything is cloned.
	{
		const { id, git } = await entry(
			"s",
			{ repo: "someorg/nameless", document: "req.md", problem: "P." },
			{ GH_FORK_CREATED: "null" },
		);
		check(
			"a fork creation without a name is refused before cloning",
			requestOf(id).state === "failed" && !git.includes("clone"),
		);
		await deliver();
	}

	// t. A directory at the clone path that is not a git checkout is refused.
	{
		mkdirSync(join(root, "github", "notrepo"), { recursive: true });
		const { id, git } = await entry(
			"t",
			{ repo: "LucaCappelletti94/notrepo", document: "req.md", problem: "P." },
			{ GIT_NOTREPO: "1" },
		);
		check(
			"a clone path that is not a git checkout is refused",
			requestOf(id).state === "failed" && String(requestOf(id).error).includes("not a git checkout"),
		);
		check("a non git checkout adds no worktree", !git.includes("worktree add"));
		await deliver();
	}

	// u. A target remote that cannot be added stops the launch before it fetches.
	{
		const { id, git } = await entry(
			"u",
			{ repo: "someorg/baseadd", document: "req.md", problem: "P." },
			{ GIT_ADDFAIL: "1" },
		);
		check(
			"a failed target remote add stops the launch before fetching",
			requestOf(id).state === "failed" && !git.includes("fetch"),
		);
		await deliver();
	}

	// v. A fork remote that cannot be added stops the launch too.
	{
		mkdirSync(join(root, "github", "pushadd", ".git", "info"), { recursive: true });
		const { id, git } = await entry(
			"v",
			{ repo: "someorg/pushadd", document: "req.md", problem: "P." },
			{
				GH_FORK_EXISTING: "LucaCappelletti94/pushadd",
				GIT_REMOTES: "origin git@github.com:someorg/pushadd.git",
				GIT_ADDFAIL: "1",
			},
		);
		check(
			"a failed fork remote add stops the launch before any worktree",
			requestOf(id).state === "failed" &&
				git.includes("remote add fork git@github.com:LucaCappelletti94/pushadd.git") &&
				!git.includes("worktree add"),
		);
		await deliver();
	}

	// w. A remote that fetches the target but pushes elsewhere is not where a maintainer's branch goes.
	{
		mkdirSync(join(root, "github", "pushurl", ".git", "info"), { recursive: true });
		const { id, git, tmux } = await entry(
			"w",
			{ repo: "upstreamorg/pushurl", document: "req.md", problem: "P." },
			{
				GH_PUSH: "1",
				GIT_REMOTES: "origin git@github.com:upstreamorg/pushurl.git git@github.com:LucaCappelletti94/pushurl.git",
			},
		);
		check(
			"a remote pushing away from the target is not the maintainer's push remote",
			requestOf(id).state === "launched" &&
				git.includes("remote add upstream git@github.com:upstreamorg/pushurl.git") &&
				tmux.includes("`upstream`"),
		);
		check("the maintainer's branch is still cut from the fetching remote", /worktree add .* origin\/main$/mu.test(git));
		await deliver();
	}

	// x. A remote that fetches the target and pushes to the fork serves as both, with nothing added.
	{
		mkdirSync(join(root, "github", "triangle", ".git", "info"), { recursive: true });
		const { id, git } = await entry(
			"x",
			{ repo: "upstreamorg/triangle", document: "req.md", problem: "P." },
			{
				GH_FORK_EXISTING: "LucaCappelletti94/triangle-fork",
				GIT_REMOTES:
					"origin git@github.com:upstreamorg/triangle.git git@github.com:LucaCappelletti94/triangle-fork.git",
			},
		);
		check(
			"a remote fetching the target and pushing to the fork is used for both",
			requestOf(id).state === "launched" && !git.includes("remote add") && /worktree add .* origin\/main$/mu.test(git),
		);
		await deliver();
	}

	// x2. A remote that fetches a mirror but pushes to the fork makes the clone usable, not refused.
	{
		mkdirSync(join(root, "github", "mirrored", ".git", "info"), { recursive: true });
		const { id, git } = await entry(
			"x2",
			{ repo: "upstreamorg/mirrored", document: "req.md", problem: "P." },
			{
				GH_FORK_EXISTING: "LucaCappelletti94/mirrored",
				GIT_REMOTES: "origin git@github.com:mirrororg/mirrored.git git@github.com:LucaCappelletti94/mirrored.git",
			},
		);
		check(
			"a clone known only by a push url launches, pushing there and branching from the added target",
			requestOf(id).state === "launched" &&
				git.includes("remote add upstream git@github.com:upstreamorg/mirrored.git") &&
				/worktree add .* upstream\/main$/mu.test(git),
		);
		await deliver();
	}

	// y. A checkout with no remotes at all is refused and left as it is.
	{
		mkdirSync(join(root, "github", "bare", ".git", "info"), { recursive: true });
		const { id, git } = await entry(
			"y",
			{ repo: "LucaCappelletti94/bare", document: "req.md", problem: "P." },
			{ GIT_REMOTES: "" },
		);
		check(
			"a checkout without remotes is refused untouched",
			requestOf(id).state === "failed" &&
				String(requestOf(id).error).includes("no remotes") &&
				!git.includes("remote add"),
		);
		await deliver();
	}

	// z. Two Launch taps on the same card run the launch once.
	{
		freshLogs();
		const dbl = await launchTool("z", { repo: "someorg/double", document: "req.md", problem: "double tap" });
		const dblId = dbl.details?.id;
		const dblCard = requestOf(dblId).messageId;
		api.queued = [
			{
				update_id: 9_001_000,
				callback_query: {
					id: "ud1",
					data: `u:${dblId}:l`,
					from: { id: CHAT },
					message: { message_id: dblCard, chat: { id: CHAT } },
				},
			},
			{
				update_id: 9_001_001,
				callback_query: {
					id: "ud2",
					data: `u:${dblId}:l`,
					from: { id: CHAT },
					message: { message_id: dblCard, chat: { id: CHAT } },
				},
			},
		];
		await up.pump(400);
		await settle(600);
		check("the first Launch tap toasts", toasts().includes("Starting it."));
		check("the second Launch tap is refused", toasts().includes("That request is already starting."));
		check(
			"only one window opens for two Launch taps",
			(tmuxText().match(/new-window/g) ?? []).length === 1,
			tmuxText(),
		);
		check("the double-tapped request is launched once", requestOf(dblId).state === "launched");
		await deliver();
	}

	// z2. A slow launch holds the card in the launching state.
	{
		freshLogs();
		const slow = await launchTool("z2", { repo: "someorg/slow", document: "req.md", problem: "slow launch" });
		const slowId = slow.details?.id;
		process.env.GH_SLOW = "1";
		await tap(slowId, "l");
		const slowLaunching = requestOf(slowId);
		check(
			"a slow launch is in the launching state",
			slowLaunching.state === "launching" && slowLaunching.launchPid > 0,
			JSON.stringify(slowLaunching),
		);
		const launchingCard = await waitForEdit(slowLaunching.messageId, (e) => String(e.text).includes("Launching"));
		check(
			"the launching card drops its buttons with its text",
			launchingCard !== undefined && launchingCard.reply_markup.inline_keyboard.length === 0,
			JSON.stringify(launchingCard?.reply_markup),
		);
		await tap(slowId, "c");
		check(
			"a Cancel tap on a running launch is refused",
			toasts().at(-1) === "That request is already starting.",
			toasts().join("|"),
		);
		check("the running launch keeps launching", requestOf(slowId).state === "launching");
		await settle(1_500);
		delete process.env.GH_SLOW;
		check("the slow launch settles as launched", requestOf(slowId).state === "launched");
		await deliver();
	}

	// z3. A launch whose poller is gone is marked interrupted.
	{
		freshLogs();
		const interrupted = await launchTool("z3", { repo: "someorg/interrupt", document: "req.md", problem: "interrupt" });
		const intId = interrupted.details?.id;
		// Model a poller that died mid launch. The request is stuck in the launching state with a dead
		// pid, and no launch is running in this process to settle it.
		const intFile = join(requestsDir, `${intId}.json`);
		const intBefore = requestOf(intId);
		writeFileSync(
			intFile,
			JSON.stringify({ ...intBefore, state: "launching", stateAt: Date.now(), launchPid: deadPid }),
		);
		up.heartbeat();
		await settle(300);
		const intDone = requestOf(intId);
		check(
			"an interrupted launch is failed",
			intDone.state === "failed" && String(intDone.error).includes("interrupted"),
			JSON.stringify(intDone),
		);
		const intCard = await waitForEdit(requestOf(intId).messageId, (e) => String(e.text).includes("interrupted"));
		check(
			"the interrupted card names the error and keeps the buttons",
			intCard !== undefined && intCard.reply_markup.inline_keyboard.flat().length === 3,
		);
		await deliver();
		check(
			"the requester is told the interruption written by no one",
			up.customs.some(
				(c) =>
					String(c.message.content).includes("written by no one") && String(c.message.content).includes("interrupted"),
			),
		);
	}

	// r. The retract action.
	const retract = (tag, id) => launchTool(tag, { action: "retract", id });
	{
		const rePending = await launchTool("r1", {
			repo: "someorg/repend",
			document: "req.md",
			problem: "retract pending",
		});
		const rePendingId = rePending.details?.id;
		const rePendingCard = requestOf(rePendingId).messageId;
		const rePendingRes = await retract("r1b", rePendingId);
		check(
			"a retract on a pending request closes it",
			!rePendingRes.isError && requestOf(rePendingId).state === "retracted",
			rePendingRes.content[0].text,
		);
		check(
			"a retract deletes the card",
			called("deleteMessage").some((c) => c.body.message_id === rePendingCard),
		);
		const { id: reFailedId } = await failLaunch("r2", "someorg/refailed", "P.", { GH_NOLOGIN: "1" });
		const reFailedCard = requestOf(reFailedId).messageId;
		const reFailedRes = await retract("r2b", reFailedId);
		check(
			"a retract on a failed request closes it",
			!reFailedRes.isError && requestOf(reFailedId).state === "retracted",
		);
		check(
			"a retract deletes the failed card",
			called("deleteMessage").some((c) => c.body.message_id === reFailedCard),
		);
		const reNoId = await launchTool("r3", { action: "retract" });
		check(
			"a retract without an id is refused",
			reNoId.isError === true && reNoId.content[0].text.includes("retract needs"),
		);
		const reUnknown = await retract("r4", "01a070f9-0000-0000-0000-00000000dead");
		check(
			"a retract of an unknown id is refused",
			reUnknown.isError === true && reUnknown.content[0].text.includes("no request"),
		);
		const reClosed = await retract("r5", cancelId);
		check(
			"a retract of a cancelled request is refused",
			reClosed.isError === true && reClosed.content[0].text.includes("cancelled"),
		);
		const reLaunched = await retract("r6", ownId);
		check(
			"a retract of a launched request is refused",
			reLaunched.isError === true && reLaunched.content[0].text.includes("launched"),
		);
		const reExisting = await retract("r7", existingId);
		check(
			"a retract of an already started request is refused",
			reExisting.isError === true && reExisting.content[0].text.includes("already-started"),
		);
		const reAgain = await retract("r8", rePendingId);
		check(
			"a second retract of the same request is refused",
			reAgain.isError === true && reAgain.content[0].text.includes("retracted"),
		);
		freshLogs();
		const reRunning = await launchTool("r9", { repo: "someorg/rerun", document: "req.md", problem: "retract running" });
		const reRunningId = reRunning.details?.id;
		process.env.GH_SLOW = "1";
		await tap(reRunningId, "l");
		const reRunningRes = await retract("r9b", reRunningId);
		check(
			"a retract of a running launch is refused",
			reRunningRes.isError === true && reRunningRes.content[0].text.includes("already starting"),
		);
		await settle(1_500);
		delete process.env.GH_SLOW;
	}

	// h2. An ended requester is told through the held queue and the resume card.
	const up2 = spawn(up2Id, workK);
	await up2.fire("session_start");
	up2.heartbeat();
	await settle(100);
	const up2Tool = (tag, params) => up2.tools.get("upstream_launch").execute(tag, params, undefined, undefined, up2.ctx);
	const heldOf = (id) => {
		const dir = join(root, "notify-telegram/graph/pending", id);
		return existsSync(dir)
			? readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "card.json" && f !== "resuming.json")
			: [];
	};
	{
		const foreign = await up2Tool("h2", { repo: "someorg/foreign", document: "req.md", problem: "foreign" });
		const foreignId = foreign.details?.id;
		const foreignCard = requestOf(foreignId).messageId;
		const reOther = await retract("h2b", foreignId);
		check(
			"another session cannot retract a request",
			reOther.isError === true && reOther.content[0].text.includes("only the requesting session"),
		);
		api.deleteRefusals = [foreignCard];
		const re48 = await up2.tools
			.get("upstream_launch")
			.execute("h2c", { action: "retract", id: foreignId }, undefined, undefined, up2.ctx);
		check(
			"a retract whose delete is refused settles the request",
			!re48.isError && requestOf(foreignId).state === "retracted",
			re48.content[0].text,
		);
		check(
			"a refused delete settles the card instead",
			(lastEdit(foreignCard)?.text ?? "").includes("Retracted") &&
				lastEdit(foreignCard)?.reply_markup.inline_keyboard.length === 0,
		);
		api.deleteRefusals = [];
		api.failMethods = ["deleteMessage"];
		api.failDescription = "telegram down";
		const reTransient = await launchTool("r12", {
			repo: "someorg/transient",
			document: "req.md",
			problem: "transient delete",
		});
		const reTransientId = reTransient.details?.id;
		const reTransientRes = await retract("r12b", reTransientId);
		api.failMethods = [];
		check(
			"a transient delete refusal does not fail the retract",
			!reTransientRes.isError && requestOf(reTransientId).state === "retracted",
			reTransientRes.content[0].text,
		);
		check(
			"the transient card keeps its buttons",
			lastEdit(requestOf(reTransientId).messageId) === undefined && cardKeyboard(reTransientId).flat().length === 3,
		);
		const cardlessId = "01a070f9-0000-0000-0000-000000000003";
		const now = Date.now();
		writeFileSync(
			join(requestsDir, `${cardlessId}.json`),
			JSON.stringify({
				id: cardlessId,
				requester: upId,
				owner: "someorg",
				name: "cardless",
				slug: "cardless",
				problem: "no card",
				doc: "# doc",
				docPath: "/doc.md",
				tmux: "work",
				messageId: null,
				state: "pending",
				at: now,
				stateAt: now,
				error: "",
				branch: "",
				tab: "",
				launchPid: 0,
			}),
		);
		const deletesBeforeCardless = called("deleteMessage").length;
		const reCardless = await retract("r13", cardlessId);
		check(
			"a retract of a cardless request succeeds",
			!reCardless.isError && requestOf(cardlessId).state === "retracted",
		);
		check("a cardless retract deletes nothing", called("deleteMessage").length === deletesBeforeCardless);
	}
	{
		const ended = await up2Tool("h3", { repo: "someorg/ended", document: "req.md", problem: "ended requester" });
		const endedId = ended.details?.id;
		const endedCard = requestOf(endedId).messageId;
		await up2.fire("session_shutdown");
		await settle(200);
		check("an ended requester keeps a pending request", requestOf(endedId).state === "pending");
		await tap(endedId, "l");
		await settle(600);
		check("the ended requester's launch proceeds", requestOf(endedId).state === "launched", requestOf(endedId).state);
		check("the ended requester's outcome is held", heldOf(up2Id).length === 1, heldOf(up2Id).join(","));
		const heldPendingDir = join(root, "notify-telegram/graph/pending", up2Id);
		const heldLaunchFile = heldOf(up2Id).find((f) => f.startsWith("l-"));
		const heldLaunch =
			heldLaunchFile !== undefined ? JSON.parse(readFileSync(join(heldPendingDir, heldLaunchFile), "utf8")) : null;
		check(
			"the held outcome is a launch item for the launched state",
			heldLaunch !== null && heldLaunch.kind === "launch" && heldLaunch.state === "launched",
			JSON.stringify(heldLaunch),
		);
		check(
			"a resume card is raised naming the held launch outcome",
			called("sendMessage").some(
				(c) =>
					JSON.stringify(c.body).includes(`r:${up2Id}`) &&
					String(c.body.text).includes("the upstream launch for someorg/ended opened a branch"),
			),
		);
		await replyToCard(endedCard, "note the branch name");
		check("a reply to an ended requester's card is held", heldOf(up2Id).length === 2);
		const heldReplyFile = heldOf(up2Id).find((f) => f.startsWith("i-"));
		const heldReply =
			heldReplyFile !== undefined ? JSON.parse(readFileSync(join(heldPendingDir, heldReplyFile), "utf8")) : null;
		check(
			"the held reply is a text inbox entry",
			heldReply !== null &&
				heldReply.kind === "inbox" &&
				heldReply.entry?.kind === "text" &&
				heldReply.entry?.value === "note the branch name",
			JSON.stringify(heldReply),
		);
		const dropped = await up2Tool("h4", { repo: "someorg/dropped", document: "req.md", problem: "dropped" });
		const droppedId = dropped.details?.id;
		await tap(droppedId, "c");
		await settle(300);
		check("a cancelled ended request is not held", heldOf(up2Id).length === 2);
		check("the cancelled ended request is closed", requestOf(droppedId).state === "cancelled");
		// A hand-edited or corrupt launch item with a state the code never writes is discarded by the
		// resume card, so its text is never shown to the user.
		writeFileSync(
			join(heldPendingDir, "malformed-launch.json"),
			JSON.stringify({
				kind: "launch",
				at: Date.now(),
				requestId: "not-a-state-token",
				state: "bogus",
				text: "malformed launch text",
				summary: "malformed summary",
			}),
		);
		check("a malformed launch item is on disk", heldOf(up2Id).includes("malformed-launch.json"));
		const h5 = await up2Tool("h5", { repo: "someorg/valid", document: "req.md", problem: "valid" });
		await tap(h5.details?.id ?? "", "l");
		await settle(400);
		check(
			"a malformed launch item is discarded by the resume card",
			!called("sendMessage").some((c) => String(c.body.text).includes("malformed launch text")),
		);
		// A held message whose sender has no emoji is shown on the resume card by its tag.
		writeFileSync(
			join(heldPendingDir, "no-emoji-message.json"),
			JSON.stringify({
				kind: "message",
				at: Date.now(),
				message: {
					id: "abcdef012345",
					text: "a no-emoji message",
					hop: 1,
					from: {
						session: "01a0e000-0000-7000-8000-000000000000",
						emoji: "",
						label: "",
						cwd: "/home/dev/work/noemoji",
						tag: "01a0d000-0000-7000-8000-000000000000",
					},
				},
			}),
		);
		const h6 = await up2Tool("h6", { repo: "someorg/msg", document: "req.md", problem: "msg" });
		await tap(h6.details?.id ?? "", "l");
		await settle(400);
		const resumeTexts = [...called("sendMessage"), ...called("editMessageText")].map((c) => String(c.body.text));
		check(
			"a held message from a no-emoji session is shown by its tag",
			resumeTexts.some((t) => t.includes("a message from") && t.includes("01a0d000")),
		);
	}

	// g2. A tap on a gone or a closed request is closed.
	{
		const gone = await launchTool("g3", { repo: "someorg/gone", document: "req.md", problem: "gone" });
		const goneId = gone.details?.id;
		const goneCard = requestOf(goneId).messageId;
		unlinkSync(join(requestsDir, `${goneId}.json`));
		api.queued = [
			{
				update_id: 9_002_000,
				callback_query: {
					id: "ltapg",
					data: `u:${goneId}:l`,
					from: { id: CHAT },
					message: { message_id: goneCard, chat: { id: CHAT } },
				},
			},
		];
		await up.pump(400);
		check("a tap on a gone request is closed", toasts().at(-1) === "That request is closed.", toasts().join("|"));
		check(
			"the gone card keyboard is stripped",
			called("editMessageReplyMarkup").some(
				(c) => c.body.message_id === goneCard && c.body.reply_markup.inline_keyboard.length === 0,
			),
		);
		await tap(cancelId, "l");
		check("a tap on a closed request is closed", toasts().at(-1) === "That request is closed.");
		api.queued = [
			{
				update_id: 9_002_002,
				callback_query: {
					id: "ltapg2",
					data: `u:${goneId}:l`,
					from: { id: CHAT },
				},
			},
		];
		await up.pump(400);
		check("a tap without a message still says the request is closed", toasts().at(-1) === "That request is closed.");
		api.queued = [
			{
				update_id: 9_002_003,
				callback_query: {
					id: "ltapg3",
					data: "u:",
					from: { id: CHAT },
					message: { message_id: goneCard, chat: { id: CHAT } },
				},
			},
		];
		await up.pump(400);
		check("a tap with no request id is closed", toasts().at(-1) === "That request is closed.", toasts().join("|"));
	}

	// g3. A malformed request file reads as absent.
	{
		const malformed = (id, patch) => {
			writeFileSync(
				join(requestsDir, `${id}.json`),
				JSON.stringify({
					id,
					requester: upId,
					owner: "someorg",
					name: "malformed",
					slug: "malformed",
					problem: "P.",
					doc: "# d",
					docPath: "/d.md",
					tmux: "work",
					messageId: null,
					state: "pending",
					at: Date.now(),
					stateAt: Date.now(),
					error: "",
					branch: "",
					tab: "",
					launchPid: 0,
					...patch,
				}),
			);
		};
		const badStateId = "01a070f9-0000-0000-0000-00000000f001";
		const badPidId = "01a070f9-0000-0000-0000-00000000f002";
		const badMessageId = "01a070f9-0000-0000-0000-00000000f003";
		const badContentId = "01a070f9-0000-0000-0000-00000000f004";
		const badFieldId = "01a070f9-0000-0000-0000-00000000f005";
		malformed(badStateId, { state: "bogus" });
		malformed(badPidId, { launchPid: "x" });
		malformed(badMessageId, { messageId: 0 });
		malformed(badContentId, { id: "not a token" });
		malformed(badFieldId, { owner: 123 });
		const reState = await retract("g4", badStateId);
		check(
			"a file with an unknown state reads as absent",
			reState.isError === true && reState.content[0].text.includes("no request"),
		);
		const rePid = await retract("g5", badPidId);
		check(
			"a file with a bad launch pid reads as absent",
			rePid.isError === true && rePid.content[0].text.includes("no request"),
		);
		const reMessage = await retract("g6", badMessageId);
		check(
			"a file with a nonpositive message id reads as absent",
			reMessage.isError === true && reMessage.content[0].text.includes("no request"),
		);
		const reContent = await retract("g8", badContentId);
		check(
			"a file whose content id is no state token reads as absent",
			reContent.isError === true && reContent.content[0].text.includes("no request"),
		);
		const reField = await retract("g9", badFieldId);
		check(
			"a file with a non-string field reads as absent",
			reField.isError === true && reField.content[0].text.includes("no request"),
		);
		const reToken = await retract("g7", "not a token");
		check(
			"an unparseable id reads as absent",
			reToken.isError === true && reToken.content[0].text.includes("no request"),
		);
	}

	// g5. A request file that predates the head redraws its card without one.
	{
		const legacyId = "01a070f9-0000-0000-0000-00000000f006";
		const legacyCard = 88_800_001;
		writeFileSync(
			join(requestsDir, `${legacyId}.json`),
			JSON.stringify({
				id: legacyId,
				requester: upId,
				owner: "someorg",
				name: "legacy",
				slug: "legacy",
				problem: "legacy problem",
				doc: "# d",
				docPath: "/d.md",
				tmux: "work",
				messageId: legacyCard,
				state: "pending",
				at: Date.now(),
				stateAt: Date.now(),
				error: "",
				branch: "",
				tab: "",
				launchPid: 0,
			}),
		);
		api.queued = [
			{
				update_id: 9_002_004,
				callback_query: {
					id: "ltaplegacy",
					data: `u:${legacyId}:c`,
					from: { id: CHAT },
					message: { message_id: legacyCard, chat: { id: CHAT } },
				},
			},
		];
		await up.pump(400);
		await settle(300);
		const legacyEdit = lastEdit(legacyCard);
		check(
			"a headless request redraws its card without a head",
			legacyEdit !== undefined &&
				String(legacyEdit.text).includes("Cancelled") &&
				!String(legacyEdit.text).includes("Task:"),
			legacyEdit?.text,
		);
	}

	// g4. A request from a session with no known tmux place opens the tab in the default session.
	{
		const ntId = "01a070f0-0000-0000-0000-000000000003";
		process.env.TMUX_PLACE_FAIL = "1";
		const nt = spawn(ntId, workK);
		await nt.fire("session_start");
		nt.heartbeat();
		await settle(100);
		const ntReq = await nt.tools
			.get("upstream_launch")
			.execute(
				"h-nt",
				{ repo: "someorg/notmux", document: "req.md", problem: "no tmux place" },
				undefined,
				undefined,
				nt.ctx,
			);
		delete process.env.TMUX_PLACE_FAIL;
		await nt.pump(400);
		const ntReqId = ntReq.details?.id;
		check(
			"a request without a tmux place names no session",
			!ntReq.isError && requestOf(ntReqId).tmux === "",
			ntReq.content[0].text,
		);
		check(
			"the card of a request without a place names no tab",
			!String(cardOf(ntReqId).text).includes("in tmux"),
			cardOf(ntReqId).text,
		);
		freshLogs();
		await tap(ntReqId, "l");
		await settle(400);
		const newWin = tmuxText()
			.split("\n")
			.find((l) => l.startsWith("new-window"));
		check("the no place launch reaches tmux", newWin !== undefined);
		check(
			"the tab opens without a target session",
			newWin === undefined || newWin.startsWith("new-window -c "),
			newWin,
		);
		check("the no place request is launched", requestOf(ntReqId).state === "launched");
		await nt.pump(200);
		await nt.pump(200);
		await settle(100);
		check(
			"the no place requester hears the outcome written by no one",
			nt.customs.some(
				(c) =>
					String(c.message.content).includes("written by no one") &&
					String(c.message.content).includes("opened branch"),
			),
		);
	}

	// i2. The list action.
	{
		writeFileSync(
			join(nodesDir, "01a070f3-0000-0000-0000-000000000000.json"),
			JSON.stringify({
				session: "01a070f3-0000-0000-0000-000000000000",
				label: "upstream dep",
				emoji: "\u{1F680}",
				tag: "depwork",
				cwd: "/home/dev/work/depwork",
				repo: "LucaCappelletti94/dep",
				branch: "upstream/it-rejects-valid-x",
				status: "working",
				note: "",
				edges: [],
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}),
		);
		writeFileSync(
			join(nodesDir, "01a070f3-0000-0000-0000-000000000009.json"),
			JSON.stringify({
				session: "01a070f3-0000-0000-0000-000000000009",
				label: "branch without a repository",
				emoji: "\u{1F680}",
				tag: "norepo",
				cwd: "/home/dev/work/norepo",
				branch: "upstream/no-repo-branch",
				status: "working",
				note: "",
				edges: [],
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}),
		);
		const agedId = "01a070f9-0000-0000-0000-000000000004";
		const twodayId = "01a070f9-0000-0000-0000-000000000005";
		const listNow = Date.now();
		for (const [id, owner, name, at] of [
			[agedId, "agedorg", "aged", listNow - 2 * 3_600_000],
			[twodayId, "twodayorg", "twoday", listNow - 2 * 24 * 3_600_000],
		]) {
			writeFileSync(
				join(requestsDir, `${id}.json`),
				JSON.stringify({
					id,
					requester: "01a070f9-0000-0000-0000-000000000000",
					owner,
					name,
					slug: `${name}-slug`,
					problem: "aged problem",
					doc: "# d",
					docPath: "/d.md",
					tmux: "work",
					messageId: null,
					state: "pending",
					at,
					stateAt: at,
					error: "",
					branch: "",
					tab: "",
					launchPid: 0,
				}),
			);
		}
		const listWidget = await launchTool("i1", { action: "list", repo: "someorg/widget" });
		check(
			"a list names the repository's request",
			listWidget.content[0].text.includes(forkId) && listWidget.content[0].text.includes("widget-mis-encodes-y"),
		);
		check("a list shows the requester", listWidget.content[0].text.includes(upId));
		check(
			"a list shows the not started work with its branch",
			listWidget.content[0].text.includes("LucaCappelletti94:upstream/widget-mis-encodes-y") &&
				listWidget.content[0].text.includes("not started"),
		);
		const listDep = await launchTool("i2", { action: "list", repo: "LucaCappelletti94/dep" });
		check(
			"a list shows the session branch and status",
			listDep.content[0].text.includes("upstream/it-rejects-valid-x") && listDep.content[0].text.includes("working"),
		);
		const listAll = await launchTool("i3", { action: "list" });
		check(
			"a list without a repository shows the launch repositories",
			listAll.content[0].text.includes("someorg/widget") && listAll.content[0].text.includes("LucaCappelletti94/dep"),
		);
		check(
			"a list names a session branch without a repository",
			listAll.content[0].text.includes("upstream/no-repo-branch"),
			listAll.content[0].text,
		);
		check(
			"a list shows request ages",
			listAll.content[0].text.includes("pending, 2h") && listAll.content[0].text.includes("pending, 2d"),
		);
		const listNone = await launchTool("i4", { action: "list", repo: "nope/nothing" });
		check(
			"a list without work shows two none lines",
			(listNone.content[0].text.match(/- none/g) ?? []).length === 2,
			listNone.content[0].text,
		);
		const listBogus = await launchTool("i5", { action: "bogus" });
		check(
			"an unknown action is refused",
			listBogus.isError === true && listBogus.content[0].text.includes("unknown action"),
		);
	}

	// j2. A request older than a week is expired by the sweep.
	{
		const expire = await launchTool("j1", { repo: "someorg/expire", document: "req.md", problem: "expire" });
		const expireId = expire.details?.id;
		const { id: expireFailId } = await failLaunch("j2", "someorg/expfail", "P.", { GH_NOLOGIN: "1" });
		const oldId = "01a070f9-0000-0000-0000-000000000001";
		const crashedId = "01a070f9-0000-0000-0000-000000000002";
		const oldAt = Date.now() - 366 * 24 * 3_600_000;
		const crashedAt = Date.now() - 8 * 24 * 3_600_000;
		for (const [id, owner, name, at] of [
			[oldId, "oldorg", "old", oldAt],
			[crashedId, "crashedorg", "crash", crashedAt],
		]) {
			writeFileSync(
				join(requestsDir, `${id}.json`),
				JSON.stringify({
					id,
					requester: "01a070f9-0000-0000-0000-000000000000",
					owner,
					name,
					slug: `${name}-slug`,
					problem: "old problem",
					doc: "# d",
					docPath: "/d.md",
					tmux: "work",
					messageId: null,
					state: "pending",
					at,
					stateAt: at,
					error: "",
					branch: "",
					tab: "",
					launchPid: 0,
				}),
			);
		}
		jump(7 * 24 * 3_600_000 + 10_000);
		up.heartbeat();
		await settle(300);
		check("a week old pending request is expired", requestOf(expireId).state === "expired", requestOf(expireId).state);
		check("a week old failed request is expired", requestOf(expireFailId).state === "expired");
		const expireCard = await waitForEdit(requestOf(expireId).messageId, (e) =>
			String(e.text).includes("expired after seven days"),
		);
		check(
			"an expired card greys out without buttons",
			expireCard !== undefined && expireCard.reply_markup.inline_keyboard.length === 0,
		);
		check("a year old request file is pruned with the graph", !existsSync(join(requestsDir, `${oldId}.json`)));
		check("a crashed card expires without a send", requestOf(crashedId).state === "expired");
		await deliver();
		check("the requester is told the expiry", told("expired after seven days"));
		const reExpired = await retract("j3", expireId);
		check(
			"a retract of an expired request is refused",
			reExpired.isError === true && reExpired.content[0].text.includes("expired"),
		);
		await deliver();
	}

	// end of section: restore the environment and the clock.
	process.env.PATH = oldPath;
	process.env.HOME = oldHome;
	delete process.env.TMUX;
	delete process.env.TMUX_PANE;
	delete process.env.GH_LOG;
	delete process.env.GIT_LOG;
	delete process.env.TMUX_LOG;
	delete process.env.GIT_REMOTES;
	api.deleteRefusals = [];
	clockSkew = 0; // The expiry jumped the clock seven days; the next sections measure staleness against it.
}

heading("session_message between live sessions");
{
	const parrot = "\u{1F99C}";
	const hedgehog = "\u{1F994}";
	const jelly = "\u{1FABC}";
	const a = spawn("0b1f0000-aaaa-7000-8000-00000000000a", "/home/dev/work/alpha");
	const b = spawn("0b1f0000-bbbb-7000-8000-00000000000b", "/home/dev/work/beta");
	const c = spawn("0b1f0000-cccc-7000-8000-00000000000c", "/home/dev/work/gamma");
	for (const [s, emoji, label] of [
		[a, parrot, "alpha work"],
		[b, hedgehog, "beta work"],
		[c, jelly, "gamma work"],
	]) {
		await s.fire("session_start");
		await s.tools.get("session_badge").execute("sb", { emoji, label }, undefined, undefined, s.ctx);
	}
	const message = (from, args, signal) =>
		from.tools.get("session_message").execute("sm", args, signal, undefined, from.ctx);
	/** Sends, lets the peer's drain tick once, then returns the settled tool result. */
	const exchange = async (from, to, args) => {
		const pending = message(from, args);
		await settle(50);
		await to.pump(150);
		return pending;
	};
	const telegramTraffic = () =>
		api.calls.filter((call) => ["sendMessage", "setMessageReaction", "sendChatAction"].includes(call.method)).length;

	check("session_message is registered", a.tools.has("session_message"));

	const listing = await message(a, {});
	const listText = listing.content[0].text;
	check(
		"a bare call lists every other live session with its badge and folder",
		listText.includes(hedgehog) && listText.includes("/home/dev/work/beta") && listText.includes(jelly),
	);
	check("the listing names the caller's own badge", listText.includes(parrot));
	check("the caller is not listed as its own peer", !listing.details.peers.some((peer) => peer.emoji === parrot));

	const trafficBefore = telegramTraffic();
	const first = await exchange(a, b, { to: hedgehog, text: "Which branch holds the fix?" });
	check("a drained message reports delivered", first.details?.delivered === true && first.isError !== true);
	check("a first message starts the chain at hop 1", first.details.hop === 1);
	const firstId = first.details.id;
	check("the message carries an id", typeof firstId === "string" && firstId.length >= 8);
	const arrived = b.customs.at(-1);
	check(
		"the peer receives it as an aside that wakes an idle session",
		b.customs.length === 1 && arrived.options.deliverAs === "aside" && arrived.options.triggerTurn === true,
	);
	check("the message is shown in the transcript", arrived.message.display === true);
	check("the message is attributed to an agent", arrived.message.attribution === "agent");
	check(
		"the reply instruction names the sender's stable tag, which a later badge change cannot reroute",
		arrived.message.content.includes(`to "${record(a.id).tag}"`),
	);
	check(
		"the delivered text names the sender badge, the id and the body",
		arrived.message.content.includes(parrot) &&
			arrived.message.content.includes(firstId) &&
			arrived.message.content.includes("Which branch holds the fix?"),
	);
	check("an agent message never goes through the prompt flow", b.steers.length === 0);
	check("an agent message sends nothing to Telegram", telegramTraffic() === trafficBefore);
	check("the peer's inbox is empty after delivery", inboxCount(b.id) === 0);

	const reply = await exchange(b, a, { to: parrot, text: "fix/drain", reply_to: firstId });
	check("a reply one step down the chain is hop 2", reply.details?.delivered === true && reply.details.hop === 2);
	const replyArrived = a.customs.at(-1);
	check(
		"the reply quotes the message it answers",
		replyArrived.message.content.includes(firstId) && replyArrived.message.details.replyTo === firstId,
	);

	let last = reply;
	for (let hop = 3; hop <= 20; hop++) {
		const [from, to, target] = hop % 2 === 1 ? [a, b, hedgehog] : [b, a, parrot];
		last = await exchange(from, to, { to: target, text: `step ${hop}`, reply_to: last.details.id });
		if (hop === 19) {
			const content = b.customs.at(-1).message.content;
			check(
				"hop 19 still invites an answer",
				content.includes("Hop 19 of 20") && content.includes("To answer, call session_message"),
			);
		}
	}
	check("the chain reaches hop 20", last.details?.delivered === true && last.details.hop === 20);
	check(
		"the final hop tells the recipient to stop relaying",
		a.customs.at(-1).message.content.includes("do not answer"),
	);
	const beyond = await message(a, { to: hedgehog, text: "step 21", reply_to: last.details.id });
	check("hop 21 is refused", beyond.isError === true && beyond.details.sent === false);
	check("a refused message never reaches the inbox", inboxCount(b.id) === 0);

	await a.fire("input", {});
	const fresh = await exchange(a, b, { to: hedgehog, text: "new question from the user" });
	check("user input starts a fresh chain", fresh.details?.delivered === true && fresh.details.hop === 1);

	const unknown = await message(a, { to: "\u{1F996}", text: "hello?" });
	check(
		"an unknown badge is refused with the live peers listed",
		unknown.isError === true && unknown.content[0].text.includes(hedgehog),
	);
	const own = await message(a, { to: parrot, text: "talking to myself" });
	check("a session cannot message itself", own.isError === true);
	const empty = await message(a, { to: hedgehog, text: "   " });
	check("an empty message is refused", empty.isError === true);
	const huge = await message(a, { to: hedgehog, text: "x".repeat(40_000) });
	check("an oversized message is refused", huge.isError === true && inboxCount(b.id) === 0);

	// The native ask blocks the turn, and only the user may answer it.
	const askState = {};
	const runAsk = b.tools
		.get("ask")
		.execute("sm-ask", singleQuestion, undefined, undefined, stubbornCtx(b.ctx, askState));
	let askSettled = false;
	runAsk.then(() => {
		askSettled = true;
	});
	await settle(150);
	const duringAsk = await exchange(a, b, { to: hedgehog, text: "use Postgres" });
	await settle(100);
	check("a message to a session with an open ask is still delivered", duringAsk.details?.delivered === true);
	check("an agent message never answers the user's ask", askSettled === false);
	writeFileSync(join(inboxOf(b.id), "9001.json"), JSON.stringify({ kind: "text", value: "SQLite" }));
	await b.pump(150);
	check("the ask still takes the user's answer", (await runAsk).details.customInput === "SQLite");

	const started = performance.now();
	const queued = await message(a, { to: jelly, text: "are you there?" });
	const waited = performance.now() - started;
	check(
		"an undrained message reports not yet delivered after a bounded wait",
		queued.details?.delivered === false && queued.isError !== true && waited >= 2_500 && waited < 6_000,
	);
	check("the undrained message stays queued for the peer", inboxCount(c.id) === 1);
	await c.pump(150);
	check("the queued message arrives once the peer drains", c.customs.length === 1 && inboxCount(c.id) === 0);

	const controller = new AbortController();
	const abortStart = performance.now();
	const abortedSend = message(a, { to: jelly, text: "second" }, controller.signal);
	await settle(100);
	controller.abort();
	const aborted = await abortedSend;
	check(
		"aborting the wait returns at once with the message still queued",
		aborted.details?.delivered === false && performance.now() - abortStart < 1_500 && inboxCount(c.id) === 1,
	);
	await c.pump(150);

	writeFileSync(join(inboxOf(c.id), `${Date.now()}-bad.json`), JSON.stringify({ kind: "agent", value: "no sender" }));
	const customsBeforeBad = c.customs.length;
	const warnsBeforeBad = c.warns.length;
	await c.pump(150);
	check(
		"a malformed agent entry is discarded with a warning",
		c.customs.length === customsBeforeBad && inboxCount(c.id) === 0 && c.warns.length > warnsBeforeBad,
	);

	// A live peer can hold no emoji once the palette runs out, and its tag still names it.
	const blankId = "0b1f0000-eeee-7000-8000-00000000000e";
	writeFileSync(
		join(sessionsDir, `${blankId}.json`),
		JSON.stringify({ ...record(c.id), emoji: "", emojiChosen: false, tag: "zz9", heartbeat: Date.now() }),
	);
	check("the listing shows a peer's tag", (await message(a, {})).content[0].text.includes("zz9"));
	const byTag = await message(a, { to: "zz9", text: "reach me by tag" }, AbortSignal.abort());
	check(
		"a peer without an emoji is addressable by its tag",
		byTag.details?.sent === true && byTag.isError !== true && inboxCount(blankId) === 1,
	);
	const ownTag = await message(a, { to: record(a.id).tag, text: "me again" });
	check("a session cannot message itself by its tag", ownTag.isError === true);
	writeFileSync(
		join(inboxOf(c.id), `${Date.now()}-0123456789ab.json`),
		JSON.stringify({
			kind: "agent",
			value: "from a session without an emoji",
			id: "0123456789ab",
			hop: 1,
			from: { session: blankId, emoji: "", label: "", cwd: "/home/dev/work/blank", tag: "zz9" },
		}),
	);
	await c.pump(150);
	check(
		"a message from a session without an emoji says to answer by its tag",
		c.customs.at(-1).message.content.includes('to "zz9"'),
	);
	rmSync(join(sessionsDir, `${blankId}.json`), { force: true });

	const unpaired = spawn("0b1f0000-dddd-7000-8000-00000000000d", "/home/dev/work/delta");
	const unpairedSend = await message(unpaired, { to: hedgehog, text: "anyone?" });
	check(
		"a session without the Telegram pairing is told messaging needs it",
		unpairedSend.isError === true && unpairedSend.content[0].text.includes("setup.mjs"),
	);

	// An older omp-telegram drains an unknown kind as user text, so it must never be sent one.
	const legacyId = "0b1f0000-ffff-7000-8000-00000000000f";
	const { messaging: _dropped, ...legacyRecord } = record(c.id);
	writeFileSync(
		join(sessionsDir, `${legacyId}.json`),
		JSON.stringify({ ...legacyRecord, emoji: "\u{1F9A5}", tag: "old1", heartbeat: Date.now() }),
	);
	const legacy = await message(a, { to: "\u{1F9A5}", text: "hello old friend" });
	check(
		"a peer running a version without messaging is refused and named for a restart",
		legacy.isError === true && legacy.content[0].text.includes("restart") && inboxCount(legacyId) === 0,
	);
	rmSync(join(sessionsDir, `${legacyId}.json`), { force: true });

	// The sender stays awake through the target's silence, so the stale heartbeat is evidence, not sleep.
	for (let step = 0; step < 13; step++) {
		jump(4_000);
		await a.pump(20);
	}
	const stale = await message(a, { to: hedgehog, text: "still there?" });
	check("a session whose heartbeat went stale while the sender was awake is not addressable", stale.isError === true);

	for (const s of [a, b, c]) await s.fire("session_shutdown");
}

heading("dependency graph across sessions");
{
	const graphDir = join(root, "notify-telegram/graph");
	rmSync(graphDir, { recursive: true, force: true });
	rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
	const savedPath = process.env.PATH;
	const gBin = join(root, "graph-bin");
	mkdirSync(gBin, { recursive: true });
	const ghLog = join(root, "graph-gh.log");
	const tmuxLog = join(root, "graph-tmux.log");
	const mmdcLog = join(root, "graph-mmdc.log");
	const prJson = join(root, "graph-pr.json");
	const prGone = join(root, "graph-pr-gone");
	for (const log of [ghLog, tmuxLog, mmdcLog]) writeFileSync(log, "");
	writeFileSync(
		join(gBin, "gh"),
		`#!/bin/sh\necho "$*" >> ${ghLog}\ncase "$1 $2" in\n  "pr view") if [ -f ${prGone} ]; then echo "GraphQL: Could not resolve to a Repository with the name 'someorg/docs'. (repository)" >&2; exit 1; fi; cat ${prJson} ;;\n  "pr list") printf '%s' "$GRAPH_PR_LIST" ;;\n  *) exit 1 ;;\nesac\n`,
		{ mode: 0o755 },
	);
	// The pane sits where graphWhere says. A reopen at a tab prints that tab, unless graphTaken holds it,
	// and an append lands on tab 6. The tmux session `gone` does not exist, so a resume there creates it,
	// and graphTaken set to `move` refuses the move to the old tab.
	const graphWhere = join(root, "graph-tmux-where");
	const graphTaken = join(root, "graph-tmux-taken");
	writeFileSync(graphWhere, "work\t4\n");
	writeFileSync(
		join(gBin, "tmux"),
		`#!/bin/sh\necho "$*" >> ${tmuxLog}\ncase "$1" in\n  display-message) cat ${graphWhere} ;;\n  has-session) [ "$3" != "=gone" ] ;;\n  new-session) echo 0 ;;\n  move-window) [ "$(cat ${graphTaken} 2>/dev/null)" != "move" ] ;;\n  new-window) case "$4" in\n    *:) echo "\${4}6" ;;\n    *) [ "$4" = "$(cat ${graphTaken} 2>/dev/null)" ] && { echo "index in use" >&2; exit 1; }; echo "$4" ;;\n  esac ;;\nesac\n`,
		{ mode: 0o755 },
	);
	const onePixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
	const mmdcScript = `#!/bin/sh\necho "$*" >> ${mmdcLog}\nout=""; in=""; prev=""\nfor a in "$@"; do [ "$prev" = "-o" ] && out="$a"; [ "$prev" = "-i" ] && in="$a"; prev="$a"; done\ncat "$in" >> ${mmdcLog}\nprintf '%s' '${onePixel}' | base64 -d > "$out"\n`;
	writeFileSync(join(gBin, "mmdc"), mmdcScript, { mode: 0o755 });
	process.env.PATH = `${gBin}:${savedPath}`;
	process.env.TMUX = "/tmp/fake-tmux,1,0";
	process.env.TMUX_PANE = "%9";
	process.env.GRAPH_PR_LIST = "[]";

	const parentId = "0c1a0001-0000-7000-8000-00000000000a";
	const waiterId = "0c1a0002-0000-7000-8000-00000000000b";
	const followerId = "0c1a0003-0000-7000-8000-00000000000c";
	const childId = "0c1a0004-0000-7000-8000-00000000000d";
	const nodeFile = (id) => join(graphDir, "nodes", `${id}.json`);
	const nodeOf = (id) => JSON.parse(readFileSync(nodeFile(id), "utf8"));
	const pendingOf = (id) =>
		existsSync(join(graphDir, "pending", id))
			? readdirSync(join(graphDir, "pending", id)).filter((f) => f.endsWith(".json") && f !== "card.json")
			: [];
	const graph = (s, args) => s.tools.get("session_graph").execute("g", args, undefined, undefined, s.ctx);
	const text = (result) => result.content[0].text;
	const beatAll = (...sessions) => {
		for (const s of sessions) s.heartbeat();
	};

	const appDir = join(root, "work-app");
	mkdirSync(appDir, { recursive: true });
	const parent = spawn(parentId, appDir);
	await parent.fire("session_start");
	check("session_graph is registered", parent.tools.has("session_graph"));
	const parentStatus = await graph(parent, { action: "status", status: "waiting", note: "on the widget fix" });
	check("a session records its own status", parentStatus.isError !== true && nodeOf(parentId).status === "waiting");
	await parent.tools
		.get("session_badge")
		.execute("gb", { code: "WIDGET", label: "wait on the widget fix" }, undefined, undefined, parent.ctx);
	parent.heartbeat();
	await settle(50);
	check(
		"the heartbeat relabels the node with the badge code and label",
		nodeOf(parentId).label === "WIDGET: wait on the widget fix",
	);
	await parent.tools.get("session_badge").execute("gb2", { code: "WDG" }, undefined, undefined, parent.ctx);
	await graph(parent, { action: "status", status: "waiting", note: "still on the widget fix" });
	check(
		"a status update writes the current code into the node label",
		nodeOf(parentId).label === "WDG: wait on the widget fix",
	);
	check("the node records the tmux tab its session runs in", nodeOf(parentId).launch?.tmuxWindow === 4);
	writeFileSync(graphWhere, "work\t5\n");
	parent.heartbeat();
	await settle(50);
	parent.heartbeat();
	await settle(50);
	check("a session moved to another tab rewrites its node", nodeOf(parentId).launch?.tmuxWindow === 5);
	writeFileSync(graphWhere, "work\t4\n");
	parent.heartbeat();
	await settle(50);
	parent.heartbeat();
	await settle(50);

	const launchId = "0c1a1a00-0000-7000-8000-000000000001";
	mkdirSync(join(graphDir, "launches"), { recursive: true });
	writeFileSync(
		join(graphDir, "launches", `${launchId}.json`),
		JSON.stringify({
			id: launchId,
			parent: parentId,
			repo: "someorg/widget",
			branch: "LucaCappelletti94:upstream/fix-y",
			problem: "Widget mis-encodes Y.",
			worktree: "/home/dev/widget.upstreams/fix-y",
			at: Date.now(),
		}),
	);
	process.env.OMP_TELEGRAM_LAUNCH = launchId;
	const child = spawn(childId, "/home/dev/widget.upstreams/fix-y");
	await child.fire("session_start");
	const childNode = nodeOf(childId);
	check(
		"a child claims its launch into a node with an upstream edge from its parent",
		childNode.edges.some((e) => e.type === "upstream" && e.from === parentId && e.to === childId) &&
			childNode.repo === "someorg/widget" &&
			childNode.branch === "LucaCappelletti94:upstream/fix-y",
	);
	check("the child's node is labelled by the problem", childNode.label.includes("Widget mis-encodes Y"));
	check("the claimed launch record is gone", !existsSync(join(graphDir, "launches", `${launchId}.json`)));
	check("a claim clears the launch id from the environment", process.env.OMP_TELEGRAM_LAUNCH === undefined);
	check("the node records how to relaunch the session", Array.isArray(childNode.launch?.argv));
	check("a node file is private", (statSync(nodeFile(childId)).mode & 0o077) === 0);

	const waiter = spawn(waiterId, "/home/dev/work/web");
	await waiter.fire("session_start");
	const follower = spawn(followerId, "/home/dev/work/docs");
	await follower.fire("session_start");
	const linked = await graph(waiter, { action: "link", type: "waits-on", to: childId.slice(0, 8) });
	check("a session declares that it waits on another by session id prefix", linked.isError !== true);
	const followed = await graph(follower, { action: "link", type: "follows-up", to: record(childId).tag });
	check("a session declares a follow-up by tag", followed.isError !== true);
	check(
		"an upstream edge can only come from a launch",
		(await graph(waiter, { action: "link", type: "upstream", to: childId.slice(0, 8) })).isError === true,
	);
	check(
		"a link to an unknown session is refused",
		(await graph(waiter, { action: "link", type: "waits-on", to: "ffffffff" })).isError === true,
	);
	check(
		"a session cannot depend on itself",
		(await graph(waiter, { action: "link", type: "waits-on", to: waiterId.slice(0, 8) })).isError === true,
	);

	const loop = await graph(child, { action: "link", type: "waits-on", to: waiterId.slice(0, 8) });
	check(
		"a blocking link that would close a loop is refused with the loop named",
		loop.isError === true && text(loop).includes(waiterId) && !nodeOf(childId).edges.some((e) => e.to === waiterId),
	);
	check(
		"a non-blocking link may point back along a loop",
		(await graph(child, { action: "link", type: "related", to: waiterId.slice(0, 8) })).isError !== true,
	);
	await graph(child, { action: "unlink", type: "related", to: waiterId.slice(0, 8) });

	const parentView = text(await graph(parent, {}));
	check(
		"show lists what a session waits on, with the edge and its status",
		parentView.includes("Widget mis-encodes Y") && parentView.includes("upstream") && parentView.includes("working"),
	);
	const childView = text(await graph(child, {}));
	check(
		"show lists who waits on a session",
		childView.includes(parentId.slice(0, 8)) &&
			childView.includes(waiterId.slice(0, 8)) &&
			childView.includes("follows up"),
	);
	const found = text(await graph(waiter, { action: "find", query: "WIDGET" }));
	check("find matches a node by repository, case-insensitively", found.includes(childId));

	await graph(child, { action: "status", status: "blocked", note: "asking Luca" });
	for (const s of [parent, waiter, follower]) await s.pump(120);
	check("a status that is not an outcome wakes nobody", parent.customs.length === 0 && waiter.customs.length === 0);
	check("an unknown status is refused", (await graph(child, { action: "status", status: "shipped" })).isError === true);
	check(
		"a PR link that is not a GitHub pull request is refused",
		(await graph(child, { action: "status", status: "working", pr: "https://example.com/x" })).isError === true,
	);

	await graph(child, { action: "status", status: "pushed" });
	for (const s of [parent, waiter, follower]) await s.pump(150);
	const pushed = parent.customs.at(-1);
	check(
		"an outcome reaches the upstream parent as an aside that wakes it",
		parent.customs.length === 1 &&
			pushed.options.deliverAs === "aside" &&
			pushed.options.triggerTurn === true &&
			pushed.message.customType === "omp-telegram.dependency",
	);
	check(
		"the outcome names the dependency and what happened",
		pushed.message.content.includes("Widget mis-encodes Y") && pushed.message.content.includes("pushed"),
	);
	check("a waits-on dependent is woken too", waiter.customs.length === 1);
	check("a follow-up session is not woken", follower.customs.length === 0);
	check("a delivered outcome leaves nothing pending", pendingOf(parentId).length === 0);
	await graph(child, { action: "status", status: "pushed" });
	for (const s of [parent, waiter]) await s.pump(120);
	check("repeating an outcome status sends nothing twice", parent.customs.length === 1 && waiter.customs.length === 1);

	// The poller finds the PR from the recorded head branch.
	writeFileSync(
		prJson,
		JSON.stringify({
			state: "OPEN",
			isDraft: false,
			reviewDecision: "",
			latestReviews: [],
			statusCheckRollup: [],
			url: "https://github.com/someorg/widget/pull/5",
			number: 5,
		}),
	);
	process.env.GRAPH_PR_LIST = JSON.stringify([
		{ number: 5, url: "https://github.com/someorg/widget/pull/5", headRepositoryOwner: { login: "LucaCappelletti94" } },
	]);
	jump(10 * 60_000 + 1_000);
	beatAll(parent, waiter, follower, child);
	await settle(400);
	for (const s of [parent, waiter]) await s.pump(150);
	check(
		"the poller looks the PR up by its head branch on the target",
		readFileSync(ghLog, "utf8").includes("pr list --repo someorg/widget --head upstream/fix-y"),
	);
	const prRecord = JSON.parse(readFileSync(join(graphDir, "pr", `${childId}.json`), "utf8"));
	check("the PR state is recorded", prRecord.state === "pr-open" && prRecord.number === 5);
	check(
		"a PR first seen open wakes the dependents with its link",
		parent.customs.at(-1).message.content.includes("pull/5") && waiter.customs.length === 2,
	);

	writeFileSync(
		prJson,
		JSON.stringify({ ...JSON.parse(readFileSync(prJson, "utf8")), reviewDecision: "CHANGES_REQUESTED" }),
	);
	jump(10 * 60_000 + 1_000);
	beatAll(parent, waiter, follower, child);
	await settle(400);
	for (const s of [parent, waiter]) await s.pump(150);
	check(
		"requested changes update the ledger without waking anyone",
		JSON.parse(readFileSync(join(graphDir, "pr", `${childId}.json`), "utf8")).state === "changes-requested" &&
			parent.customs.length === 2,
	);

	// The parent ends before the merge, so the merge is held for it and a resume card goes out.
	await parent.fire("session_shutdown");
	writeFileSync(prJson, JSON.stringify({ ...JSON.parse(readFileSync(prJson, "utf8")), state: "MERGED" }));
	jump(10 * 60_000 + 1_000);
	beatAll(waiter, follower, child);
	await settle(400);
	await waiter.pump(150);
	check("the merge reaches the live waiter", waiter.customs.at(-1).message.content.includes("merged"));
	check("the merge is held for the ended parent", pendingOf(parentId).length === 1);
	const cardCalls = () =>
		called("sendMessage").filter((c) =>
			c.body.reply_markup?.inline_keyboard?.flat().some((b) => b.callback_data === `r:${parentId}`),
		);
	const card = cardCalls()[0];
	check("an outcome for an ended session raises a resume card", cardCalls().length === 1);
	check(
		"the card offers Later beside Resume",
		card?.body.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === `l:${parentId}`) === true,
	);
	check(
		"the card offers No to dismiss it",
		card?.body.reply_markup.inline_keyboard
			.flat()
			.some((b) => b.text === "No" && b.callback_data === `n:${parentId}`) === true,
	);
	check("the card names what is waiting", card?.body.text.includes("merged") === true);
	check("the card names the tmux tab the session ran in", card?.body.text.includes("<code>work:4</code>") === true);
	jump(10 * 60_000 + 1_000);
	beatAll(waiter, follower, child);
	await settle(400);
	check("a repeated poll holds nothing twice", pendingOf(parentId).length === 1 && cardCalls().length === 1);
	api.queued = [
		{
			update_id: 9099,
			callback_query: {
				id: "gl1",
				data: `l:${parentId}`,
				from: { id: CHAT },
				message: { message_id: 424242, chat: { id: CHAT } },
			},
		},
	];
	await waiter.pump(250);
	check(
		"Later on one held item says it is held",
		/1 update for .* is held until you resume it/.test(lastCall("editMessageText")?.body.text ?? ""),
	);

	const editsBefore = called("editMessageText").length;
	const heldSend = await child.tools
		.get("session_message")
		.execute("m", { to: parentId, text: "Is Z acceptable?" }, undefined, undefined, child.ctx);
	await settle(150);
	check("a message to an ended node is held and says so", heldSend.details?.held === true && heldSend.isError !== true);
	check(
		"a second held item edits the open card instead of sending another",
		cardCalls().length === 1 && called("editMessageText").length > editsBefore,
	);

	const cardId = 424242;
	api.queued = [
		{
			update_id: 9101,
			callback_query: {
				id: "gl",
				data: `l:${parentId}`,
				from: { id: CHAT },
				message: { message_id: cardId, chat: { id: CHAT } },
			},
		},
	];
	await waiter.pump(250);
	check(
		"Later keeps the items and marks the card held",
		pendingOf(parentId).length === 2 && lastCall("editMessageText").body.text.includes("held"),
	);
	check(
		"the held card can still be dismissed",
		lastCall("editMessageText")
			.body.reply_markup.inline_keyboard.flat()
			.some((b) => b.callback_data === `n:${parentId}`),
	);

	api.queued = [{ update_id: 9102, message: { message_id: 902, date: 1, chat: { id: CHAT }, text: "/resume" } }];
	await waiter.pump(250);
	check(
		"/resume lists ended sessions with waiting items as buttons",
		lastCall("sendMessage")
			.body.reply_markup?.inline_keyboard?.flat()
			.some((b) => b.callback_data === `r:${parentId}`) === true,
	);

	renameSync(appDir, `${appDir}-gone`);
	writeFileSync(tmuxLog, "");
	const goneResumeSends = called("sendMessage").length;
	api.queued = [
		{
			update_id: 9111,
			callback_query: {
				id: "grg",
				data: `r:${parentId}`,
				from: { id: CHAT },
				message: { message_id: cardId, chat: { id: CHAT } },
			},
		},
	];
	await waiter.pump(250);
	check(
		"Resume on a session whose folder is gone answers at once and tells the user the error",
		lastCall("answerCallbackQuery").body.text === "Resuming it in a new tmux window." &&
			!readFileSync(tmuxLog, "utf8").includes("new-window") &&
			called("sendMessage")
				.slice(goneResumeSends)
				.some((c) => String(c.body.text).includes("failed") && String(c.body.text).includes(appDir)),
	);
	renameSync(`${appDir}-gone`, appDir);

	writeFileSync(tmuxLog, "");
	api.queued = [
		{
			update_id: 9103,
			callback_query: {
				id: "gr",
				data: `r:${parentId}`,
				from: { id: CHAT },
				message: { message_id: cardId, chat: { id: CHAT } },
			},
		},
	];
	await waiter.pump(300);
	const resumed = readFileSync(tmuxLog, "utf8");
	check(
		"Resume opens a tmux window in the session's folder that resumes it",
		resumed.includes("new-window") && resumed.includes(`-c ${appDir}`) && resumed.includes(`--resume ${parentId}`),
	);
	check("Resume reopens the session at the tab it ran in", resumed.includes("new-window -d -t work:4 "));
	check(
		"the card says the session is resuming in that tab",
		/Resuming .*<code>work:4<\/code>/u.test(lastCall("editMessageText").body.text),
	);
	writeFileSync(tmuxLog, "");
	api.queued = [
		{
			update_id: 9108,
			callback_query: {
				id: "gr1",
				data: `r:${parentId}`,
				from: { id: CHAT },
				message: { message_id: cardId, chat: { id: CHAT } },
			},
		},
	];
	await waiter.pump(250);
	check(
		"a second Resume tap while the session starts opens no second window",
		!readFileSync(tmuxLog, "utf8").includes("new-window") &&
			lastCall("answerCallbackQuery").body.text.includes("already starting"),
	);

	api.queued = [
		{
			update_id: 9104,
			callback_query: {
				id: "gr2",
				data: `r:${waiterId}`,
				from: { id: CHAT },
				message: { message_id: 5, chat: { id: CHAT } },
			},
		},
	];
	writeFileSync(tmuxLog, "");
	await waiter.pump(250);
	check(
		"Resume on a live session opens nothing and says it is running",
		!readFileSync(tmuxLog, "utf8").includes("new-window") &&
			lastCall("answerCallbackQuery").body.text.includes("already running"),
	);

	// An imported worktree whose session never existed has nothing to resume.
	const orphan = "import-widget-fix-z";
	writeFileSync(
		nodeFile(orphan),
		JSON.stringify({
			session: orphan,
			label: "Widget fix Z",
			emoji: "",
			tag: "",
			cwd: "/home/dev/widget.upstreams/fix-z",
			status: "pushed",
			note: "",
			edges: [],
			createdAt: Date.now(),
			updatedAt: Date.now(),
		}),
	);
	writeFileSync(tmuxLog, "");
	const orphanSends = called("sendMessage").length;
	api.queued = [
		{
			update_id: 9109,
			callback_query: {
				id: "gro",
				data: `r:${orphan}`,
				from: { id: CHAT },
				message: { message_id: 6, chat: { id: CHAT } },
			},
		},
	];
	await waiter.pump(250);
	check(
		"Resume on a node with no omp session behind it answers at once and says why",
		!readFileSync(tmuxLog, "utf8").includes("new-window") &&
			lastCall("answerCallbackQuery").body.text === "Resuming it in a new tmux window." &&
			called("sendMessage")
				.slice(orphanSends)
				.some((c) => String(c.body.text).includes("no omp session")),
	);
	rmSync(nodeFile(orphan));

	// Wherever the window lands, the card names the tab it got: the end of the tmux session when another
	// window holds the old number, and the old number in a tmux session a reboot took, unless the move fails.
	const landings = [
		{
			name: "a resume whose tab is taken appends the window",
			tmux: "work",
			window: 4,
			never: "new-session",
			taken: "work:4",
			calls: ["new-window -d -t work:4 ", "new-window -d -t work: "],
			tab: "work:6",
		},
		{
			name: "a resume whose tmux session is gone recreates it at the old tab",
			tmux: "gone",
			window: 4,
			never: "new-window",
			taken: "",
			calls: ["new-session -d -s gone ", "move-window -d -s gone:0 -t gone:4"],
			tab: "gone:4",
		},
		{
			name: "a recreated tmux session that refuses the move keeps the window where it opened",
			tmux: "gone",
			window: 4,
			never: "new-window",
			taken: "move",
			calls: ["new-session -d -s gone ", "move-window -d -s gone:0 -t gone:4"],
			tab: "gone:0",
		},
		{
			name: "a node written before tabs were recorded reopens wherever its recreated tmux session starts",
			tmux: "gone",
			window: undefined,
			taken: "",
			calls: ["new-session -d -s gone "],
			never: "move-window",
			tab: "gone:0",
		},
	];
	for (const [i, landing] of landings.entries()) {
		const landId = `0c1a0008-0000-7000-8000-00000000000${i}`;
		const landCard = 777010 + i;
		writeFileSync(
			nodeFile(landId),
			JSON.stringify({
				session: landId,
				label: "Landing widget",
				emoji: "",
				tag: "",
				cwd: appDir,
				status: "pushed",
				note: "",
				edges: [],
				createdAt: Date.now(),
				updatedAt: Date.now(),
				launch: { argv: [], tmuxSession: landing.tmux, tmuxWindow: landing.window },
			}),
		);
		mkdirSync(join(graphDir, "pending", landId), { recursive: true });
		writeFileSync(join(graphDir, "pending", landId, "card.json"), JSON.stringify({ messageId: landCard }));
		writeFileSync(graphTaken, landing.taken);
		writeFileSync(tmuxLog, "");
		api.queued = [
			{
				update_id: 9117 + i,
				callback_query: {
					id: `gland${i}`,
					data: `r:${landId}`,
					from: { id: CHAT },
					message: { message_id: landCard, chat: { id: CHAT } },
				},
			},
		];
		await waiter.pump(300);
		const landLog = readFileSync(tmuxLog, "utf8");
		const settled = called("editMessageText").findLast((c) => c.body.message_id === landCard);
		check(
			`${landing.name}, and the card names the tab it got`,
			landing.calls.every((call) => landLog.includes(call)) &&
				!landLog.includes(landing.never) &&
				new RegExp(`Resuming .*<code>${landing.tab}</code>`, "u").test(settled?.body.text ?? ""),
		);
		rmSync(nodeFile(landId));
		rmSync(join(graphDir, "pending", landId), { recursive: true });
	}
	rmSync(graphTaken);

	// A slow tmux must not hold a Resume tap, so the answer lands at once and what is queued behind it
	// moves on. A second tap while the first window is still opening starts nothing.
	const slowId = "0c1a0007-0000-7000-8000-000000000007";
	const slowBin = join(root, "graph-slow-bin");
	mkdirSync(slowBin, { recursive: true });
	const slowLog = join(root, "graph-slow-tmux.log");
	writeFileSync(slowLog, "");
	writeFileSync(
		join(slowBin, "tmux"),
		`#!/bin/sh\necho "$*" >> ${slowLog}\nsleep 1\ncase "$1" in\n  has-session) exit 0 ;;\n  new-window) echo @78 ;;\nesac\n`,
		{ mode: 0o755 },
	);
	const slowPath = process.env.PATH;
	process.env.PATH = `${slowBin}:${slowPath}`;
	writeFileSync(
		nodeFile(slowId),
		JSON.stringify({
			session: slowId,
			label: "Slow widget",
			emoji: "",
			tag: "",
			cwd: appDir,
			status: "pushed",
			note: "",
			edges: [],
			createdAt: Date.now(),
			updatedAt: Date.now(),
			launch: { argv: [], tmuxSession: "work" },
		}),
	);
	const slowResumeSends = called("sendMessage").filter((c) => String(c.body.text).includes("updates waiting")).length;
	api.queued = [
		{
			update_id: 9113,
			callback_query: {
				id: "gsr",
				data: `r:${slowId}`,
				from: { id: CHAT },
				message: { message_id: 777001, chat: { id: CHAT } },
			},
		},
		{
			update_id: 9114,
			message: { message_id: 9114, date: 1, chat: { id: CHAT }, text: "/resume" },
		},
	];
	await waiter.pump(400);
	check(
		"a resume tap is answered before the window opens",
		lastCall("answerCallbackQuery").body.text === "Resuming it in a new tmux window." &&
			!readFileSync(slowLog, "utf8").includes("new-window"),
	);
	check(
		"a text queued behind the tap is handled without waiting for tmux",
		called("sendMessage").filter((c) => String(c.body.text).includes("updates waiting")).length === slowResumeSends + 1,
	);
	api.queued = [
		{
			update_id: 9115,
			callback_query: {
				id: "gsr1",
				data: `r:${slowId}`,
				from: { id: CHAT },
				message: { message_id: 777002, chat: { id: CHAT } },
			},
		},
		{
			update_id: 9116,
			callback_query: {
				id: "gsr2",
				data: `r:${slowId}`,
				from: { id: CHAT },
				message: { message_id: 777003, chat: { id: CHAT } },
			},
		},
	];
	await waiter.pump(400);
	check(
		"a second resume tap while the first window is still opening starts nothing",
		lastCall("answerCallbackQuery").body.text === "That session is already starting." &&
			!readFileSync(slowLog, "utf8").includes(`--resume ${slowId}`),
	);
	await settle(2_500);
	const slowOpened = readFileSync(slowLog, "utf8");
	check(
		"the window opens once when the slow tmux answers",
		slowOpened.includes(`new-window -d -t work:`) &&
			slowOpened.includes(`omp --resume ${slowId}`) &&
			slowOpened.split(`--resume ${slowId}`).length - 1 === 1,
	);
	process.env.PATH = slowPath;
	rmSync(nodeFile(slowId));

	mkdirSync(join(graphDir, "pending", parentId), { recursive: true });
	writeFileSync(join(graphDir, "pending", parentId, "z-bad.json"), "{not json");
	const back = spawn(parentId, appDir);
	await back.fire("session_start");
	await back.pump(200);
	check(
		"a resumed session receives what was held, in order",
		back.customs.length === 2 &&
			back.customs[0].message.content.includes("merged") &&
			back.customs[1].message.content.includes("Is Z acceptable?"),
	);
	check("a held agent message keeps its agent attribution", back.customs[1].message.attribution === "agent");
	check("a malformed held item is discarded with a warning", back.warns.length > 0 && pendingOf(parentId).length === 0);
	check(
		"the card says the items were delivered, and where",
		/Delivered .*<code>work:4<\/code>/u.test(lastCall("editMessageText").body.text),
	);

	// A launch nobody claimed shows as never started.
	writeFileSync(
		join(graphDir, "launches", "0c1a1a00-0000-7000-8000-000000000002.json"),
		JSON.stringify({
			id: "0c1a1a00-0000-7000-8000-000000000002",
			parent: "0c1a0009-0000-7000-8000-000000000009",
			repo: "someorg/gizmo",
			branch: "upstream/g",
			problem: "Gizmo leaks.",
			worktree: "/home/dev/gizmo.upstreams/g",
			at: Date.now() - 2 * 3_600_000,
		}),
	);
	const photosBefore = called("sendPhoto").length;
	api.queued = [{ update_id: 9105, message: { message_id: 903, date: 1, chat: { id: CHAT }, text: "/deps" } }];
	await waiter.pump(600);
	check("/deps sends the rendered diagram as a photo", called("sendPhoto").length === photosBefore + 1);
	const diagram = readFileSync(mmdcLog, "utf8");
	check(
		"the diagram holds the nodes and typed edges",
		diagram.includes("Widget mis-encodes Y") && diagram.includes("==>|upstream|") && diagram.includes("-->|waits on|"),
	);
	const listing = lastCall("sendMessage").body.text;
	check("/deps follows with the status list and PR links", listing.includes("merged") && listing.includes("pull/5"));
	check(
		"an unclaimed launch shows as never started",
		listing.includes("Gizmo leaks") && listing.includes("not-started"),
	);

	// A long ledger is split across messages rather than cut.
	const bulk = Array.from({ length: 60 }, (_, i) => `0c1ab${String(i).padStart(3, "0")}-0000-7000-8000-000000000000`);
	for (const [i, id] of bulk.entries()) {
		writeFileSync(
			nodeFile(id),
			JSON.stringify({
				session: id,
				label: `Bulk task number ${i} with a fairly long descriptive label`,
				emoji: "",
				tag: "",
				cwd: `/home/dev/bulk/${i}`,
				repo: `someorg/bulk-repository-${i}`,
				status: "working",
				note: "",
				edges: [],
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}),
		);
	}
	const sendsBefore = called("sendMessage").length;
	api.queued = [{ update_id: 9110, message: { message_id: 906, date: 1, chat: { id: CHAT }, text: "/deps bulk" } }];
	await waiter.pump(800);
	const bulkTexts = called("sendMessage")
		.slice(sendsBefore)
		.map((c) => c.body.text);
	check(
		"a status list too long for one message is split across several with nothing cut",
		bulkTexts.length > 1 &&
			bulkTexts.every((t) => t.length <= 4096) &&
			bulk.every((_, i) => bulkTexts.some((t) => t.includes(`Bulk task number ${i} with`))),
	);
	for (const id of bulk) rmSync(nodeFile(id));

	writeFileSync(mmdcLog, "");
	api.queued = [{ update_id: 9106, message: { message_id: 904, date: 1, chat: { id: CHAT }, text: "/deps gizmo" } }];
	await waiter.pump(600);
	check(
		"a /deps filter keeps only the matching component",
		readFileSync(mmdcLog, "utf8").includes("Gizmo leaks") &&
			!readFileSync(mmdcLog, "utf8").includes("Widget mis-encodes Y"),
	);

	// A PATH with no mmdc anywhere, so an installed one on this machine cannot answer.
	rmSync(join(gBin, "mmdc"));
	process.env.PATH = `${gBin}:/usr/bin:/bin`;
	const photosBeforeMissing = called("sendPhoto").length;
	api.queued = [{ update_id: 9107, message: { message_id: 905, date: 1, chat: { id: CHAT }, text: "/deps" } }];
	await waiter.pump(400);
	process.env.PATH = `${gBin}:${savedPath}`;
	check(
		"without mmdc /deps still sends the list and says why there is no diagram",
		called("sendPhoto").length === photosBeforeMissing && lastCall("sendMessage").body.text.includes("mmdc"),
	);

	const unlinked = await graph(follower, { action: "unlink", type: "follows-up", to: childId.slice(0, 8) });
	check(
		"unlink removes the declared edge",
		unlinked.isError !== true && !nodeOf(followerId).edges.some((e) => e.to === childId),
	);

	// A card that Telegram refused is sent again with the next held item rather than edited into nothing.
	const quietId = "0c1a0005-0000-7000-8000-000000000005";
	writeFileSync(
		nodeFile(quietId),
		JSON.stringify({
			session: quietId,
			label: "quiet ended session",
			emoji: "",
			tag: "",
			cwd: appDir,
			status: "waiting",
			note: "",
			edges: [],
			createdAt: Date.now(),
			updatedAt: Date.now(),
			launch: { argv: [], tmuxSession: "" },
		}),
	);
	const quietCards = () =>
		called("sendMessage").filter((c) =>
			c.body.reply_markup?.inline_keyboard?.flat().some((b) => b.callback_data === `r:${quietId}`),
		).length;
	const sendQuiet = (body) =>
		waiter.tools.get("session_message").execute("q", { to: quietId, text: body }, undefined, undefined, waiter.ctx);
	api.failMethods = ["sendMessage"];
	await sendQuiet("first try");
	await settle(150);
	api.failMethods = [];
	const cardsAfterFailure = quietCards();
	await sendQuiet("second try");
	await settle(150);
	check(
		"a resume card Telegram refused is sent with the next held item",
		quietCards() === cardsAfterFailure + 1 && pendingOf(quietId).length === 2,
	);
	const quietCardFile = join(graphDir, "pending", quietId, "card.json");
	const quietCardId = JSON.parse(readFileSync(quietCardFile, "utf8")).messageId;
	const heldItems = pendingOf(quietId).map((file) => readFileSync(join(graphDir, "pending", quietId, file)));
	writeFileSync(tmuxLog, "");
	api.queued = [
		{
			update_id: 9120,
			callback_query: {
				id: "dismiss-quiet",
				data: `n:${quietId}`,
				from: { id: CHAT },
				message: { message_id: quietCardId, chat: { id: CHAT } },
			},
		},
	];
	await waiter.pump(250);
	check(
		"No closes the resume card without opening a session",
		lastCall("editMessageText").body.message_id === quietCardId &&
			lastCall("editMessageText").body.reply_markup.inline_keyboard.length === 0 &&
			!existsSync(quietCardFile) &&
			!readFileSync(tmuxLog, "utf8").includes("new-window"),
	);
	check(
		"No keeps the held updates intact",
		pendingOf(quietId).length === heldItems.length &&
			pendingOf(quietId).every((file, i) =>
				readFileSync(join(graphDir, "pending", quietId, file)).equals(heldItems[i]),
			),
	);
	api.queued = [{ update_id: 9121, message: { message_id: 906, date: 1, chat: { id: CHAT }, text: "/resume" } }];
	await waiter.pump(250);
	check(
		"/resume still offers a dismissed session's held updates",
		lastCall("sendMessage")
			.body.reply_markup?.inline_keyboard?.flat()
			.some((b) => b.callback_data === `r:${quietId}`),
	);
	const cardsAfterDismissal = quietCards();
	await sendQuiet("another update");
	await settle(150);
	check(
		"a new update raises a fresh card after dismissal",
		quietCards() === cardsAfterDismissal + 1 && pendingOf(quietId).length === 3,
	);
	const newQuietCardId = JSON.parse(readFileSync(quietCardFile, "utf8")).messageId;
	const editsBeforeStaleNo = called("editMessageText").length;
	api.queued = [
		{
			update_id: 9122,
			callback_query: {
				id: "dismiss-old-quiet",
				data: `n:${quietId}`,
				from: { id: CHAT },
				message: { message_id: quietCardId, chat: { id: CHAT } },
			},
		},
	];
	await waiter.pump(250);
	check(
		"a stale No tap cannot close a newer resume card",
		called("editMessageText").length === editsBeforeStaleNo &&
			JSON.parse(readFileSync(quietCardFile, "utf8")).messageId === newQuietCardId,
	);
	rmSync(nodeFile(quietId));
	rmSync(join(graphDir, "pending", quietId), { recursive: true, force: true });

	// A card the user deleted on Telegram cannot carry the next held item, so a new one replaces it.
	const deletedId = "0c1a0007-0000-7000-8000-000000000007";
	writeFileSync(
		nodeFile(deletedId),
		JSON.stringify({
			session: deletedId,
			label: "deleted card session",
			emoji: "",
			tag: "",
			cwd: appDir,
			status: "waiting",
			note: "",
			edges: [],
			createdAt: Date.now(),
			updatedAt: Date.now(),
			launch: { argv: [], tmuxSession: "" },
		}),
	);
	const sendDeleted = (body) =>
		waiter.tools.get("session_message").execute("q", { to: deletedId, text: body }, undefined, undefined, waiter.ctx);
	await sendDeleted("first try");
	await settle(150);
	const deletedCardFile = join(graphDir, "pending", deletedId, "card.json");
	const firstDeletedCard = JSON.parse(readFileSync(deletedCardFile, "utf8")).messageId;
	api.editRefusals = [firstDeletedCard];
	const deletedSends = called("sendMessage").length;
	const deletedEdits = called("editMessageText").length;
	await sendDeleted("second try");
	await settle(150);
	check(
		"a deleted resume card is replaced by a new one with the next held item",
		called("editMessageText")
			.slice(deletedEdits)
			.some((c) => c.body.message_id === firstDeletedCard) &&
			called("sendMessage")
				.slice(deletedSends)
				.some((c) => c.body.reply_markup?.inline_keyboard?.flat().some((b) => b.callback_data === `r:${deletedId}`)),
	);
	check(
		"the card record points at the replacement card",
		JSON.parse(readFileSync(deletedCardFile, "utf8")).messageId !== firstDeletedCard,
	);
	// A card file still holding its empty claim means a raise has not sent yet, so the next item adds no second card.
	writeFileSync(deletedCardFile, "{}");
	const inflightSends = called("sendMessage").length;
	await sendDeleted("third try");
	await settle(150);
	check(
		"a held item for a session whose resume card is in flight sends no second card",
		called("sendMessage").length === inflightSends && readFileSync(deletedCardFile, "utf8") === "{}",
	);
	api.editRefusals = [];
	rmSync(nodeFile(deletedId));
	rmSync(join(graphDir, "pending", deletedId), { recursive: true, force: true });

	// A pull request gh cannot read keeps its last known state and wakes nobody.
	await graph(follower, { action: "status", status: "working", pr: "https://github.com/someorg/docs/pull/9" });
	writeFileSync(prJson, "not json");
	const waiterWarns = waiter.warns.length;
	const waiterCustoms = waiter.customs.length;
	jump(10 * 60_000 + 1_000);
	beatAll(waiter, follower, back);
	await settle(400);
	await waiter.pump(150);
	check(
		"an unreadable pull request is logged, recorded as nothing and wakes nobody",
		!existsSync(join(graphDir, "pr", `${followerId}.json`)) &&
			waiter.warns.slice(waiterWarns).some((w) => w.m.includes("could not read a pull request")) &&
			waiter.customs.length === waiterCustoms,
	);

	// A pull request whose repository GitHub no longer has is gone for good. Its dependents hear so once, and
	// it is not looked up again.
	await graph(waiter, { action: "link", type: "waits-on", to: followerId.slice(0, 8) });
	writeFileSync(prGone, "");
	const goneCustoms = waiter.customs.length;
	jump(10 * 60_000 + 1_000);
	beatAll(waiter, follower, back);
	await settle(400);
	await waiter.pump(150);
	const goneFile = join(graphDir, "pr", `${followerId}.json`);
	const lookupsOf = () =>
		readFileSync(ghLog, "utf8")
			.split("\n")
			.filter((line) => line.includes("pr view https://github.com/someorg/docs/pull/9")).length;
	check(
		"a pull request whose repository no longer exists is recorded as gone and wakes its dependents",
		existsSync(goneFile) &&
			JSON.parse(readFileSync(goneFile, "utf8")).state === "gone" &&
			waiter.customs.length === goneCustoms + 1 &&
			waiter.customs.at(-1).message.content.includes("gone"),
	);
	const goneLookups = lookupsOf();
	jump(10 * 60_000 + 1_000);
	beatAll(waiter, follower, back);
	await settle(400);
	await waiter.pump(150);
	check(
		"a gone pull request is not looked up again and wakes nobody twice",
		lookupsOf() === goneLookups && waiter.customs.length === goneCustoms + 1,
	);
	rmSync(prGone, { force: true });
	await graph(waiter, { action: "unlink", type: "waits-on", to: followerId.slice(0, 8) });

	check(
		"unlinking an edge the session never declared is refused",
		(await graph(follower, { action: "unlink", type: "related", to: waiterId.slice(0, 8) })).isError === true,
	);

	// A live session that never wrote a node still shows as the end of an edge, named from its record.
	const bareId = "0c1a0006-0000-7000-8000-000000000006";
	const bare = spawn(bareId, join(root, "bare-folder"));
	await bare.fire("session_start");
	await graph(waiter, { action: "link", type: "related", to: record(bareId).tag });
	check(
		"a linked live session with no node of its own is described from the registry",
		!existsSync(nodeFile(bareId)) && text(await graph(waiter, {})).includes("bare-folder"),
	);
	await graph(waiter, { action: "unlink", type: "related", to: bareId.slice(0, 8) });
	await bare.fire("session_shutdown");

	// A year later, ended sessions' nodes are pruned and live ones stay.
	jump(366 * 24 * 3_600_000);
	beatAll(waiter, back);
	await settle(400);
	check(
		"a year-old node of an ended session is pruned with its PR record",
		!existsSync(nodeFile(childId)) && !existsSync(join(graphDir, "pr", `${childId}.json`)),
	);
	check("a live session's node survives the prune", existsSync(nodeFile(waiterId)));

	for (const s of [back, waiter, follower, child]) await s.fire("session_shutdown");
	process.env.PATH = savedPath;
	delete process.env.TMUX;
	delete process.env.TMUX_PANE;
	delete process.env.GRAPH_PR_LIST;
}

heading("sessions that died without shutting down");
{
	const stateDir = join(root, "notify-telegram");
	const crashDir = join(stateDir, "crashed");
	const bootId = (() => {
		try {
			return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
		} catch {
			return "";
		}
	})();
	const kBin = join(root, "crash-bin");
	mkdirSync(kBin, { recursive: true });
	const tmuxLog = join(root, "crash-tmux.log");
	writeFileSync(tmuxLog, "");
	const tmuxWhere = join(root, "crash-tmux-where");
	writeFileSync(tmuxWhere, "work\t3\n");
	// Only the tmux session `work` survived; any other name has to be created. Its window 2 is taken.
	// A command named in tmuxFail is refused, as a broken tmux server would.
	const tmuxFail = join(root, "crash-tmux-fail");
	writeFileSync(tmuxFail, "");
	writeFileSync(
		join(kBin, "tmux"),
		`#!/bin/sh\necho "$*" >> ${tmuxLog}\n[ "$1" = "$(cat ${tmuxFail})" ] && { echo "$1 refused by test" >&2; exit 1; }\ncase "$1" in\n  has-session) [ "$3" = "=work" ] ;;\n  new-session) echo 0 ;;\n  new-window) [ "$4" != "work:2" ] || { echo "create window failed: index 2 in use" >&2; exit 1; } ;;\n  display-message) cat ${tmuxWhere} ;;\n  *) exit 0 ;;\nesac\n`,
		{ mode: 0o755 },
	);
	const systemState = join(root, "crash-system-state");
	writeFileSync(systemState, "running\n");
	writeFileSync(
		join(kBin, "systemctl"),
		`#!/bin/sh\nstate=$(cat ${systemState})\necho "$state"\n[ "$state" = running ]\n`,
		{ mode: 0o755 },
	);
	const savedPath = process.env.PATH;
	process.env.PATH = `${kBin}:${savedPath}`;
	delete process.env.TMUX;
	delete process.env.TMUX_PANE;
	rmSync(join(stateDir, "poller.lock"), { force: true });
	rmSync(crashDir, { recursive: true, force: true });
	// Crash records expire by file age, and the files are written now, so the year the graph
	// section walked the clock forward would expire them the moment they exist.
	clockSkew = 0;

	const folder = (name) => {
		const path = join(root, "crash-work", name);
		mkdirSync(path, { recursive: true });
		return path;
	};
	const died = Date.now() - 10 * 60_000;
	const crashed = (id, fields) =>
		writeFileSync(
			join(sessionsDir, `${id}.json`),
			JSON.stringify({
				pid: process.pid,
				tag: id.slice(0, 5),
				name: "",
				cwd: "/nowhere",
				emoji: "",
				emojiChosen: false,
				label: "",
				lastNotified: died,
				recent: [],
				question: null,
				replyQuestion: null,
				standing: null,
				closeOffer: null,
				pinned: null,
				state: "idle",
				health: "",
				summary: "",
				summaryAt: 0,
				messaging: 1,
				heartbeat: died,
				boot: "boot-before-the-crash",
				argv: ["--model", "opus"],
				tmux: "work",
				...fields,
			}),
		);
	const workingId = "0c2a0001-0000-7000-8000-000000000001";
	const idleId = "0c2a0002-0000-7000-8000-000000000002";
	const goneId = "0c2a0003-0000-7000-8000-000000000003";
	const frozenId = "0c2a0004-0000-7000-8000-000000000004";
	const cleanId = "0c2a0005-0000-7000-8000-000000000005";
	const loudId = "0c2a0007-0000-7000-8000-000000000007";
	const loudDir = folder("asking");
	const workingDir = folder("parser");
	const idleDir = folder("docs");
	const goneDir = join(root, "crash-work", "removed");
	crashed(workingId, {
		cwd: workingDir,
		emoji: "\u{1F9EA}",
		label: "Fix the parser",
		state: "working (bash)",
		question: 501,
	});
	crashed(idleId, {
		cwd: idleDir,
		emoji: "\u{1F4DA}",
		label: "Write the docs",
		tmux: "gone",
		tmuxWindow: 4,
		recent: [502],
		standing: { id: "st-crash", messageId: 502, labels: ["Merge", "Wait"], head: "docs head" },
		closeOffer: 503,
		pinned: 504,
	});
	crashed(goneId, { cwd: goneDir, label: "Folder removed", state: "working" });
	crashed(frozenId, { cwd: folder("frozen"), label: "Suspended", boot: bootId });
	crashed(cleanId, { cwd: folder("clean"), label: "Closed cleanly", heartbeat: 0 });
	crashed(loudId, { cwd: loudDir, label: "Half applied", state: "waiting on a question" });
	const spareId = "0c2a0009-0000-7000-8000-000000000009";
	const spareDir = folder("spare");
	crashed(spareId, { cwd: spareDir, label: "Never came back", tmuxWindow: 6 });
	const pinnedId = "0c2a000a-0000-7000-8000-00000000000a";
	crashed(pinnedId, {
		cwd: join(root, "crash-work", "also-removed"),
		label: "Pinned and gone",
		standing: { id: "st-pinned", messageId: 601, labels: ["Go"], head: "pinned head" },
		closeOffer: 602,
		pinned: 603,
	});

	const crashCalls = () => called("sendMessage").filter((c) => String(c.body.text).includes("\u{1F691}"));
	const cardButtons = (body) => (body?.reply_markup?.inline_keyboard ?? []).flat().map((b) => b.callback_data);
	const lastCard = () => {
		const sends = crashCalls();
		const edits = called("editMessageText").filter((c) => String(c.body.text).includes("\u{1F691}"));
		return [...sends, ...edits].sort((a, b) => api.calls.indexOf(a) - api.calls.indexOf(b)).at(-1)?.body;
	};
	const tap = async (who, updateId, data, messageId) => {
		api.queued = [
			{
				update_id: updateId,
				callback_query: {
					id: `cb-${updateId}`,
					from: { id: CHAT },
					message: { message_id: messageId, chat: { id: CHAT } },
					data,
				},
			},
		];
		await who.pump(300);
		return lastCall("answerCallbackQuery")?.body.text ?? "";
	};

	const cardsBefore = crashCalls().length;
	const first = spawn("0c2a0010-0000-7000-8000-000000000010", folder("first"));
	await first.fire("session_start");
	await settle(100);
	check(
		"a crashed record leaves the registry and is kept for restore",
		!existsSync(join(sessionsDir, `${workingId}.json`)) && existsSync(join(crashDir, `${workingId}.json`)),
	);
	check(
		"a record whose process still runs on this boot is left alone",
		existsSync(join(sessionsDir, `${frozenId}.json`)) && !existsSync(join(crashDir, `${frozenId}.json`)),
	);
	check(
		"a record its session shut down cleanly is deleted and never offered",
		!existsSync(join(sessionsDir, `${cleanId}.json`)) && !existsSync(join(crashDir, `${cleanId}.json`)),
	);
	check(
		"the open ask of a crashed session loses its buttons",
		called("editMessageReplyMarkup").some((c) => c.body.message_id === 501),
	);
	// A second heartbeat while the first card is still being sent must not post a second card.
	let releaseCard;
	api.sendMessageGate = new Promise((resolve) => {
		releaseCard = resolve;
	});
	first.heartbeat();
	await settle(50);
	first.heartbeat();
	await settle(50);
	releaseCard();
	api.sendMessageGate = null;
	await settle(150);
	const card = crashCalls().at(-1)?.body;
	check("the poller posts one card for the whole batch", crashCalls().length === cardsBefore + 1);
	check(
		"the card says the machine restarted and lists every crashed session",
		/machine restarted/i.test(card?.text ?? "") &&
			card.text.includes("Fix the parser") &&
			card.text.includes("Write the docs") &&
			card.text.includes("Folder removed") &&
			!card.text.includes("Suspended") &&
			!card.text.includes("Closed cleanly"),
	);
	check("the card names the state each session died in", card?.text.includes("working (bash)") === true);
	const cardId = api.nextMessage - 1;
	const buttons = cardButtons(card);
	const batch = buttons.find((b) => b.startsWith("ka:"))?.slice(3) ?? "";
	check(
		"the card offers restore per session, restore all and dismiss",
		[workingId, idleId, goneId].every((id) => buttons.includes(`kr:${id}`)) &&
			batch.length > 0 &&
			buttons.includes(`kd:${batch}`),
	);
	first.heartbeat();
	await settle(100);
	check("an unchanged card is not sent again", crashCalls().length === cardsBefore + 1);

	writeFileSync(tmuxLog, "");
	const restoredToast = await tap(first, 9501, `kr:${idleId}`, cardId);
	const opened = readFileSync(tmuxLog, "utf8");
	check(
		"restore recreates a tmux session the reboot took, resuming the session in its folder with its flags",
		opened.includes("new-session -d -s gone") &&
			opened.includes(`-c ${idleDir}`) &&
			opened.includes(`omp --model opus --resume ${idleId}`),
	);
	check(
		"restore moves the first window of a recreated tmux session to the recorded index",
		opened.includes("move-window -d -s gone:0 -t gone:4"),
	);
	check("the restore toast says it is reopening", /restor/i.test(restoredToast));
	check("the card marks it as restoring", /restoring/i.test(lastCard()?.text ?? ""));
	writeFileSync(tmuxLog, "");
	const twiceToast = await tap(first, 9502, `kr:${idleId}`, cardId);
	check(
		"a second tap while it starts opens nothing",
		!readFileSync(tmuxLog, "utf8").includes("omp") && twiceToast.includes("already starting"),
	);
	const goneToast = await tap(first, 9503, `kr:${goneId}`, cardId);
	await settle(100);
	first.heartbeat();
	await settle(150);
	check(
		"restoring a session whose folder is gone opens nothing and says it is reopening",
		!readFileSync(tmuxLog, "utf8").includes("omp") && /restor/i.test(goneToast),
	);
	check(
		"the card shows why it failed and keeps its button",
		(lastCard()?.text ?? "").includes(goneDir) && cardButtons(lastCard()).includes(`kr:${goneId}`),
	);

	// The tapped session comes back: it adopts what the crash left and has no work to report.
	const idleBack = spawn(idleId, idleDir);
	await idleBack.fire("session_start");
	await idleBack.pump(150);
	check(
		"a restored session adopts its label, standing question and reply routing",
		record(idleId).label === "Write the docs" &&
			record(idleId).standing?.id === "st-crash" &&
			record(idleId).recent.includes(502),
	);
	check("a session that died idle is not woken", idleBack.customs.length === 0);
	first.heartbeat();
	await settle(150);
	check(
		"the card marks it restored and drops its button",
		/restored/i.test(lastCard()?.text ?? "") && !cardButtons(lastCard()).includes(`kr:${idleId}`),
	);
	check("a live session is not offered again", (await tap(first, 9504, `kr:${idleId}`, cardId)).includes("running"));

	// Resumed by hand rather than from the card, a session that died mid-turn is told what happened.
	const workingBack = spawn(workingId, workingDir);
	await workingBack.fire("session_start");
	await workingBack.pump(150);
	const note = workingBack.customs.at(-1);
	check(
		"a session that died mid-turn is woken with what happened",
		workingBack.customs.length === 1 &&
			note.options?.triggerTurn === true &&
			/machine restarted/i.test(note.message.content) &&
			note.message.content.includes("working (bash)") &&
			note.message.content.includes("notify_status"),
	);
	const quietSends = called("sendMessage").length;
	const quietStop = await workingBack.fire("session_stop");
	await settle(150);
	check(
		"a recovery turn with nothing left to do sends nothing and is not blocked",
		!quietStop.some((r) => r?.decision === "block") && called("sendMessage").length === quietSends,
	);
	const laterStop = await workingBack.fire("session_stop");
	check(
		"only the recovery turn is exempt",
		laterStop.some((r) => r?.decision === "block"),
	);

	const loudBack = spawn(loudId, loudDir);
	await loudBack.fire("session_start");
	await loudBack.pump(150);
	await loudBack.tools.get("notify_status").execute(
		"crash-orange",
		{
			summary: "The parser fix was half applied when the machine went down.",
			urgency: "orange",
			question: "Continue the fix?",
			options: opts("Continue", "Stop here"),
		},
		undefined,
		undefined,
		loudBack.ctx,
	);
	await loudBack.fire("session_stop");
	await settle(150);
	check(
		"a recovery turn that found work asks on Telegram",
		lastCall("sendMessage").body.text.includes("Continue the fix?"),
	);

	// Restore all opens what can be opened and names what cannot.
	writeFileSync(tmuxLog, "");
	const allToast = await tap(first, 9507, `ka:${batch}`, cardId);
	const allOpened = readFileSync(tmuxLog, "utf8");
	check(
		"restore all opens every waiting session at its recorded window index in a tmux session that still exists",
		allOpened.includes(`new-window -d -t work:6 -n Never came back -c ${spareDir}`) &&
			allOpened.includes(`--resume ${spareId}`) &&
			!allOpened.includes(pinnedId),
	);
	check(
		"the restore all toast counts what it started without claiming an outcome",
		allToast === "Restoring 3 sessions.",
	);
	// A window that opened but whose omp never came live is offered again after a minute.
	jump(61_000);
	first.heartbeat();
	await settle(150);
	check(
		"a restore that never came back is offered again",
		(lastCard()?.text ?? "").includes("did not come back") && cardButtons(lastCard()).includes(`kr:${spareId}`),
	);

	const stripsBefore = called("editMessageReplyMarkup").length;
	await tap(first, 9505, `kd:${batch}`, cardId);
	await settle(100);
	const stripped = called("editMessageReplyMarkup")
		.slice(stripsBefore)
		.map((c) => c.body.message_id);
	check(
		"dismiss takes the buttons off what the dead session left open and unpins its red status",
		stripped.includes(601) &&
			stripped.includes(602) &&
			called("unpinChatMessage").some((c) => c.body.message_id === 603),
	);
	check(
		"dismiss leaves the questions of a restored session alone",
		!stripped.includes(502) && !called("unpinChatMessage").some((c) => c.body.message_id === 504),
	);
	check(
		"after dismiss no session is waiting and the card has no buttons",
		/dismissed/i.test(lastCard()?.text ?? "") && cardButtons(lastCard()).length === 0,
	);
	check(
		"a dismissed session is not restored by a stale button",
		(await tap(first, 9508, `kr:${spareId}`, cardId)).includes("dismissed"),
	);

	// A lone omp that dies while the poller runs is found on the heartbeat, without a machine restart.
	const loneId = "0c2a0006-0000-7000-8000-000000000006";
	crashed(loneId, {
		cwd: folder("lone"),
		label: "Lone crash",
		boot: bootId,
		pid: 999_999,
		heartbeat: Date.now() - 60_000,
	});
	const lonely = crashCalls().length;
	first.heartbeat();
	await settle(150);
	first.heartbeat();
	await settle(150);
	const loneCard = crashCalls().at(-1)?.body;
	check(
		"a process that died on this boot is offered on its own card without claiming a restart",
		crashCalls().length === lonely + 1 &&
			loneCard.text.includes("Lone crash") &&
			!/machine restarted/i.test(loneCard.text) &&
			cardButtons(loneCard).includes(`kr:${loneId}`),
	);
	const loneCardId = api.nextMessage - 1;
	// A card with a single waiting session answers Restore all for that one session.
	const loneBatchFile = readdirSync(join(crashDir, "batches")).find((f) =>
		JSON.parse(readFileSync(join(crashDir, "batches", f), "utf8")).ids.includes(loneId),
	);
	check(
		"restore all on a card with one waiting session answers for the single session",
		(await tap(first, 9518, `ka:${loneBatchFile.slice(0, -5)}`, loneCardId)) === "Restoring 1 session.",
	);

	// omp killed under tmux can linger as a zombie its parent never reaps, which kill(pid, 0) still finds.
	const holder = startProcess("sh", ["-c", "sleep 0 & echo $!; exec sleep 30"], {
		stdio: ["ignore", "pipe", "ignore"],
	});
	const zombiePid = Number(
		await new Promise((done) => holder.stdout.once("data", (chunk) => done(String(chunk).trim()))),
	);
	await settle(200);
	const zombieId = "0c2a0008-0000-7000-8000-000000000008";
	crashed(zombieId, {
		cwd: folder("zombie"),
		label: "Killed under tmux",
		boot: bootId,
		pid: zombiePid,
		heartbeat: Date.now() - 60_000,
	});
	first.heartbeat();
	await settle(150);
	check(
		"a zombie process counts as dead",
		existsSync(join(crashDir, `${zombieId}.json`)) && !existsSync(join(sessionsDir, `${zombieId}.json`)),
	);
	holder.kill();

	// A reboot or poweroff ends each session through a clean shutdown, which has to stay restorable.
	const haltedId = "0c2a000b-0000-7000-8000-00000000000b";
	const cutId = "0c2a000c-0000-7000-8000-00000000000c";
	const exitedId = "0c2a000d-0000-7000-8000-00000000000d";
	const diedTooId = "0c2a000e-0000-7000-8000-00000000000e";
	const haltedDir = folder("halted");
	const cutDir = folder("cut");
	process.env.TMUX = "/tmp/tmux-crash,1,0";
	process.env.TMUX_PANE = "%1";
	const halted = spawn(haltedId, haltedDir);
	await halted.fire("session_start");
	check("a session in tmux records its window index", record(haltedId).tmuxWindow === 3);
	writeFileSync(tmuxWhere, "work\t2\n");
	halted.heartbeat();
	await settle(100);
	halted.heartbeat();
	check("the heartbeat follows a window moved to another index", record(haltedId).tmuxWindow === 2);
	delete process.env.TMUX;
	delete process.env.TMUX_PANE;
	await halted.tools
		.get("notify_status")
		.execute(
			"halted-red",
			{ summary: "Pick a branch.", urgency: "red", options: opts("Agent will merge", "Agent will wait") },
			undefined,
			undefined,
			halted.ctx,
		);
	await halted.fire("session_stop");
	await settle();
	const haltedPin = record(haltedId).pinned;
	const haltedStanding = record(haltedId).standing;
	const haltedEmoji = record(haltedId).emoji;
	const cut = spawn(cutId, cutDir);
	await cut.fire("session_start");
	await cut.fire("agent_start");
	const exited = spawn(exitedId, folder("exited"));
	await exited.fire("session_start");
	await exited.fire("session_shutdown");
	writeFileSync(systemState, "stopping\n");
	const editsBefore = called("editMessageText").length;
	await halted.fire("session_shutdown");
	await cut.fire("session_shutdown");
	await settle(100);
	writeFileSync(systemState, "running\n");
	check(
		"a system shutdown leaves the record marked as ended by it",
		record(haltedId).heartbeat === 0 && record(haltedId).systemShutdownAt > 0,
	);
	check("a user exit leaves no system shutdown mark", record(exitedId).systemShutdownAt === 0);
	check(
		"a system shutdown keeps the red pin and the standing question for the restore",
		haltedPin !== null &&
			api.pinned.has(haltedPin) &&
			record(haltedId).standing?.id === haltedStanding?.id &&
			!called("editMessageText")
				.slice(editsBefore)
				.some((c) => c.body.message_id === haltedStanding?.messageId),
	);
	first.heartbeat();
	await settle(150);
	check(
		"a session ended by a system shutdown waits for the reboot rather than being offered on the same boot",
		existsSync(join(sessionsDir, `${haltedId}.json`)) && !existsSync(join(crashDir, `${haltedId}.json`)),
	);
	// The reboot: every record now predates the current boot.
	for (const id of [haltedId, cutId, exitedId]) {
		writeFileSync(join(sessionsDir, `${id}.json`), JSON.stringify({ ...record(id), boot: "boot-before-the-crash" }));
	}
	crashed(diedTooId, { cwd: folder("died-too"), label: "Too slow to stop" });
	const rebootCards = crashCalls().length;
	first.heartbeat();
	await settle(150);
	first.heartbeat();
	await settle(150);
	const rebootCard = crashCalls().at(-1)?.body;
	const rebootCardId = api.nextMessage - 1;
	check(
		"after the reboot one card lists the sessions the shutdown ended alongside the one that died",
		crashCalls().length === rebootCards + 1 &&
			/machine restarted/i.test(rebootCard?.text ?? "") &&
			rebootCard.text.includes("2 sessions shut down with it") &&
			rebootCard.text.includes("1 session died without shutting down") &&
			[haltedId, cutId, diedTooId].every((id) => cardButtons(rebootCard).includes(`kr:${id}`)),
	);
	check(
		"a session the user closed before the reboot is not offered",
		!existsSync(join(crashDir, `${exitedId}.json`)) && !cardButtons(rebootCard).includes(`kr:${exitedId}`),
	);
	writeFileSync(tmuxLog, "");
	const haltedToast = await tap(first, 9510, `kr:${haltedId}`, rebootCardId);
	const haltedOpened = readFileSync(tmuxLog, "utf8");
	check(
		"restore asks for the recorded window index and appends the window when that index is taken",
		haltedOpened.includes("new-window -d -t work:2 -n") &&
			haltedOpened.includes(`new-window -d -t work: -n`) &&
			haltedOpened.includes(`--resume ${haltedId}`) &&
			/restor/i.test(haltedToast),
	);
	const haltedBack = spawn(haltedId, haltedDir);
	await haltedBack.fire("session_start");
	await haltedBack.pump(150);
	check(
		"a session restored after a system shutdown adopts its badge, pin and standing question",
		haltedEmoji.length > 0 &&
			record(haltedId).emoji === haltedEmoji &&
			record(haltedId).pinned === haltedPin &&
			record(haltedId).standing?.id === haltedStanding?.id &&
			record(haltedId).systemShutdownAt === 0,
	);
	const cutBack = spawn(cutId, cutDir);
	await cutBack.fire("session_start");
	await cutBack.pump(150);
	const cutNote = cutBack.customs.at(-1)?.message.content ?? "";
	check(
		"a session the shutdown cut off mid-turn is told it was shut down by the restart",
		/was shut down/i.test(cutNote) && /machine restarted/i.test(cutNote) && !/died/i.test(cutNote),
	);

	// Outside a pane the tab is read from the current client, and a tmux that cannot answer keeps the tab last read.
	const placedId = "0c2a000f-0000-7000-8000-00000000000f";
	process.env.TMUX = "/tmp/tmux-crash,1,0";
	writeFileSync(tmuxWhere, "work\t5\n");
	writeFileSync(tmuxLog, "");
	const placed = spawn(placedId, folder("placed"));
	await placed.fire("session_start");
	check(
		"without a pane id the tab is read from the current client",
		record(placedId).tmuxWindow === 5 &&
			readFileSync(tmuxLog, "utf8")
				.split("\n")
				.some((line) => line.startsWith("display-message -p #{session_name}")),
	);
	writeFileSync(tmuxFail, "display-message");
	writeFileSync(tmuxWhere, "work\t7\n");
	placed.heartbeat();
	await settle(100);
	placed.heartbeat();
	check(
		"a tmux that cannot say where the pane is leaves the last known tab",
		record(placedId).tmuxWindow === 5 && record(placedId).tmux === "work",
	);
	writeFileSync(tmuxFail, "");
	delete process.env.TMUX;
	await placed.fire("session_shutdown");

	// A session closed by hand that has held updates raises its resume card, never a restore offer.
	const closedId = "0c2a0013-0000-7000-8000-000000000013";
	crashed(closedId, { cwd: folder("closed-held"), label: "Closed with news", heartbeat: 0 });
	const heldDir = join(stateDir, "graph", "pending", closedId);
	mkdirSync(heldDir, { recursive: true });
	writeFileSync(
		join(heldDir, "o-0c2a0099-merged.json"),
		JSON.stringify({
			kind: "outcome",
			at: Date.now(),
			source: "0c2a0099-0000-7000-8000-000000000099",
			outcome: "merged",
			title: "\u{1F9EA} widget fix",
			place: "widget",
			edge: "waits-on",
		}),
	);
	// The heartbeat reaps only deaths, so the closed record goes when the next session starts.
	const cardsBeforeClosed = crashCalls().length;
	const starter = spawn("0c2a0015-0000-7000-8000-000000000015", folder("starter"));
	await starter.fire("session_start");
	await settle(150);
	first.heartbeat();
	await settle(150);
	check(
		"a session closed by hand with held updates raises its resume card and no restore card",
		crashCalls().length === cardsBeforeClosed &&
			!existsSync(join(sessionsDir, `${closedId}.json`)) &&
			!existsSync(join(crashDir, `${closedId}.json`)) &&
			called("sendMessage").some((c) =>
				c.body.reply_markup?.inline_keyboard?.flat().some((b) => b.callback_data === `r:${closedId}`),
			),
	);
	await starter.fire("session_shutdown");

	// Sessions that all shut down with the machine, and restores that tmux refuses.
	const offLostId = "0c2a0011-0000-7000-8000-000000000011";
	const offWorkId = "0c2a0012-0000-7000-8000-000000000012";
	crashed(offLostId, {
		cwd: folder("off-lost"),
		label: "Off with its tmux gone",
		tmux: "lost",
		heartbeat: 0,
		systemShutdownAt: died,
	});
	crashed(offWorkId, {
		cwd: folder("off-work"),
		label: "Off in work",
		tmux: "work",
		tmuxWindow: 9,
		heartbeat: 0,
		systemShutdownAt: died,
	});
	const offCards = crashCalls().length;
	first.heartbeat();
	await settle(150);
	first.heartbeat();
	await settle(150);
	const offCard = crashCalls().at(-1)?.body;
	const offCardId = api.nextMessage - 1;
	check(
		"a card for sessions that all shut down with the machine names no deaths",
		crashCalls().length === offCards + 1 &&
			offCard.text.includes("2 sessions shut down with it.") &&
			!/died/.test(offCard.text),
	);
	writeFileSync(tmuxFail, "new-session");
	const lostToast = await tap(first, 9511, `kr:${offLostId}`, offCardId);
	await settle(100);
	first.heartbeat();
	await settle(150);
	check(
		"a restore whose tmux session cannot be created says so on the card",
		/restor/i.test(lostToast) && (lastCard()?.text ?? "").includes("tmux new-session failed"),
	);
	writeFileSync(tmuxFail, "new-window");
	const workToast = await tap(first, 9512, `kr:${offWorkId}`, offCardId);
	await settle(100);
	first.heartbeat();
	await settle(150);
	check(
		"a restore whose window cannot be opened says so on the card",
		/restor/i.test(workToast) && (lastCard()?.text ?? "").includes("tmux new-window failed"),
	);
	writeFileSync(tmuxFail, "");

	// An omp that ended unexpectedly while the machine kept running is told exactly that.
	const lostId = "0c2a0014-0000-7000-8000-000000000014";
	const lostDir = folder("lost-process");
	const gone = startProcess(process.execPath, ["-e", ""]);
	await new Promise((resolve) => gone.on("exit", resolve));
	crashed(lostId, { cwd: lostDir, label: "Process vanished", state: "working", boot: bootId, pid: gone.pid });
	first.heartbeat();
	await settle(150);
	const lostBack = spawn(lostId, lostDir);
	await lostBack.fire("session_start");
	await lostBack.pump(150);
	const lostNote = lostBack.customs.at(-1)?.message.content ?? "";
	check(
		"a session whose omp ended unexpectedly on a running machine is told so",
		/died without shutting down/i.test(lostNote) && /ended unexpectedly/i.test(lostNote),
	);

	// A slow tmux must not hold a Restore tap, so the answer lands at once and what is queued behind it
	// moves on. A second tap while the first window is still opening starts nothing.
	const slowA = "0c2a0017-0000-7000-8000-000000000017";
	const slowB = "0c2a0018-0000-7000-8000-000000000018";
	const slowC = "0c2a0019-0000-7000-8000-000000000019";
	crashed(slowA, { cwd: folder("slow-a"), label: "Slow one", tmux: "work", tmuxWindow: 11 });
	crashed(slowB, { cwd: folder("slow-b"), label: "Slow two", tmux: "work", tmuxWindow: 12 });
	crashed(slowC, { cwd: folder("slow-c"), label: "Slow three", tmux: "work", tmuxWindow: 13 });
	first.heartbeat();
	await settle(150);
	const slowCard = crashCalls().at(-1)?.body;
	const slowCardId = api.nextMessage - 1;
	const slowBatch =
		cardButtons(slowCard)
			.find((b) => b.startsWith("ka:"))
			?.slice(3) ?? "";
	check(
		"the slow batch gets its own card with a restore all button",
		slowCard.text.includes("Slow one") &&
			slowCard.text.includes("Slow two") &&
			slowCard.text.includes("Slow three") &&
			slowBatch.length > 0,
	);
	const slowBin = join(root, "crash-slow-bin");
	mkdirSync(slowBin, { recursive: true });
	const slowLog = join(root, "crash-slow-tmux.log");
	writeFileSync(slowLog, "");
	writeFileSync(
		join(slowBin, "tmux"),
		`#!/bin/sh\necho "$*" >> ${slowLog}\nsleep 1\ncase "$1" in\n  has-session) [ "$3" = "=work" ] ;;\n  new-window) [ "$4" != "work:2" ] || { echo "create window failed: index 2 in use" >&2; exit 1; } ;;\n  display-message) cat ${tmuxWhere} ;;\n  *) exit 0 ;;\nesac\n`,
		{ mode: 0o755 },
	);
	const slowPath = process.env.PATH;
	process.env.PATH = `${slowBin}:${slowPath}`;
	const slowResumeSends = called("sendMessage").filter((c) => String(c.body.text).includes("updates waiting")).length;
	api.queued = [
		{
			update_id: 9513,
			callback_query: {
				id: "cb-9513",
				from: { id: CHAT },
				message: { message_id: slowCardId, chat: { id: CHAT } },
				data: `ka:${slowBatch}`,
			},
		},
		{
			update_id: 9514,
			message: { message_id: 9514, date: 1, chat: { id: CHAT }, text: "/resume" },
		},
	];
	await first.pump(400);
	check(
		"restore all is answered before the windows open",
		lastCall("answerCallbackQuery").body.text === "Restoring 3 sessions." &&
			!readFileSync(slowLog, "utf8").includes("new-window"),
	);
	check(
		"a text queued behind the tap is handled without waiting for tmux",
		called("sendMessage").filter((c) => String(c.body.text).includes("updates waiting")).length === slowResumeSends + 1,
	);
	api.queued = [
		{
			update_id: 9515,
			callback_query: {
				id: "cb-9515",
				from: { id: CHAT },
				message: { message_id: slowCardId, chat: { id: CHAT } },
				data: `kr:${slowC}`,
			},
		},
		{
			update_id: 9516,
			callback_query: {
				id: "cb-9516",
				from: { id: CHAT },
				message: { message_id: slowCardId, chat: { id: CHAT } },
				data: `kr:${slowC}`,
			},
		},
	];
	await first.pump(400);
	check(
		"a second restore tap while the first is in flight starts nothing",
		lastCall("answerCallbackQuery").body.text === "That session is already starting." &&
			!readFileSync(slowLog, "utf8").includes(`--resume ${slowC}`),
	);
	// Every session of the batch still opens its window, so Restore all is refused as a whole.
	api.queued = [
		{
			update_id: 9517,
			callback_query: {
				id: "cb-9517",
				from: { id: CHAT },
				message: { message_id: slowCardId, chat: { id: CHAT } },
				data: `ka:${slowBatch}`,
			},
		},
	];
	await first.pump(400);
	check(
		"a second restore all tap while the first is in flight is refused and starts nothing",
		lastCall("answerCallbackQuery").body.text === "That session is already starting.",
	);
	await settle(2_500);
	process.env.PATH = slowPath;
	const slowOpened = readFileSync(slowLog, "utf8");
	check(
		"the slow restores open exactly one window per session",
		slowOpened.includes(`new-window -d -t work:11 -n Slow one -c`) &&
			slowOpened.includes(`new-window -d -t work:12 -n Slow two -c`) &&
			slowOpened.includes(`new-window -d -t work:13 -n Slow three -c`) &&
			slowOpened.split("new-window").length - 1 === 3 &&
			slowOpened.split(`--resume ${slowC}`).length - 1 === 1,
	);

	// Telegram calling the edit unchanged means the card already shows that text, so it is current.
	const batchFile = join(crashDir, "batches", `${batch}.json`);
	writeFileSync(batchFile, JSON.stringify({ ...JSON.parse(readFileSync(batchFile, "utf8")), shown: "stale" }));
	const cardEdits = (messageId = cardId) =>
		called("editMessageText").filter((c) => c.body.message_id === messageId).length;
	const editsBeforeUnchanged = cardEdits();
	api.failMethods = ["editMessageText"];
	api.failDescription =
		"Bad Request: message is not modified: specified new message content and reply markup are exactly the same";
	first.heartbeat();
	await settle(150);
	api.failMethods = [];
	api.failDescription = undefined;
	first.heartbeat();
	await settle(150);
	check("a crash card Telegram calls unchanged is not edited again", cardEdits() === editsBeforeUnchanged + 1);

	// A card Telegram reports deleted is posted again once, and the new message is the one kept.
	writeFileSync(batchFile, JSON.stringify({ ...JSON.parse(readFileSync(batchFile, "utf8")), shown: "stale" }));
	const cardsBeforeGone = crashCalls().length;
	api.failMethods = ["editMessageText"];
	api.failDescription = "Bad Request: message to edit not found";
	first.heartbeat();
	await settle(150);
	api.failMethods = [];
	api.failDescription = undefined;
	first.heartbeat();
	await settle(150);
	first.heartbeat();
	await settle(150);
	const reposted = JSON.parse(readFileSync(batchFile, "utf8")).messageId;
	check(
		"a crash card Telegram reports deleted is posted again once",
		crashCalls().length === cardsBeforeGone + 1 && reposted !== cardId && cardEdits(reposted) === 0,
	);

	// What reached a session after it died but before it drained is held for its restore, never deleted.
	const heldId = "0c2a0016-0000-7000-8000-000000000016";
	const heldWorkDir = folder("held-inbox");
	const heldQuestion = 771;
	const heldMulti = 772;
	const askedOn = (id, question) =>
		writeFileSync(
			join(root, "notify-telegram/sent", `${id}.json`),
			JSON.stringify({
				version: 1,
				id,
				at: Date.now(),
				kind: "question",
				text: question.question,
				session: { id: heldId, tag: "0c2a0", emoji: "", name: "", cwd: heldWorkDir },
				payload: { context: "", question },
			}),
		);
	askedOn(heldQuestion, singleQuestion.questions[0]);
	askedOn(heldMulti, {
		id: "targets",
		question: "Targets?",
		multi: true,
		options: askOpts("linux", "macos", "windows"),
	});
	askedOn(777, { id: "platforms", question: "Platforms?", multi: true, options: askOpts("arm", "x86") });
	askedOn(778, { id: "extras", question: "Extras?", multi: true, options: askOpts("docs", "bench") });
	crashed(heldId, {
		cwd: heldWorkDir,
		label: "Held inbox",
		state: "working",
		boot: bootId,
		pid: gone.pid,
		question: heldQuestion,
		standing: { id: "st-held", messageId: 773, labels: ["Merge", "Wait"], head: "held head" },
	});
	mkdirSync(inboxOf(heldId), { recursive: true });
	const queueFor = (name, entry) => writeFileSync(join(inboxOf(heldId), name), JSON.stringify(entry));
	// A reply keeps the message it answers while it is held.
	queueFor("9601.json", {
		kind: "text",
		value: "Go on with the parser",
		messageId: 800_601,
		replyTo: heldQuestion,
		quote: "Which backend?",
	});
	queueFor("9602.json", { kind: "callback", value: "o:zzzzz-1:0:1", messageId: heldQuestion });
	queueFor("9603.json", { kind: "command", value: "stop" });
	queueFor("9604.json", { kind: "callback", value: "c:st-held:1", messageId: 773 });
	// Linux on, windows on, linux off, Done, then a tap after Done that a running session would discard too.
	queueFor("9605.json", { kind: "callback", value: "o:zzzzz-2:0:0", messageId: heldMulti });
	queueFor("9606.json", { kind: "callback", value: "o:zzzzz-2:0:2", messageId: heldMulti });
	queueFor("9607.json", { kind: "callback", value: "o:zzzzz-2:0:0", messageId: heldMulti });
	queueFor("9608.json", { kind: "callback", value: "d:zzzzz-2:0", messageId: heldMulti });
	queueFor("9609.json", { kind: "callback", value: "o:zzzzz-2:0:1", messageId: heldMulti });
	queueFor("9610.json", { kind: "callback", value: `k:${heldId}`, messageId: 774 });
	queueFor("9611.json", { kind: "callback", value: "o:zzzzz-1:0:0", messageId: heldQuestion });
	// The drain had renamed this one before the process died.
	queueFor("9612.json.processing", { kind: "text", value: "picked up mid-drain", messageId: 800_612 });
	// Taps that answer nothing now, and entries that carry nothing.
	queueFor("9613.json", { kind: "callback", value: "o:zzzzz-3:0:0", messageId: 779 });
	queueFor("9614.json", { kind: "callback", value: "c:st-old:0", messageId: 773 });
	queueFor("9615.json", { kind: "callback", value: "z:unknown", messageId: heldQuestion });
	queueFor("9616.json", { kind: "bogus", value: "nothing" });
	queueFor("9617.json", { kind: "text", value: "" });
	// Options chosen without Done, and a Done with nothing left chosen.
	queueFor("9618.json", { kind: "callback", value: "o:zzzzz-4:0:1", messageId: 777 });
	queueFor("9619.json", { kind: "callback", value: "o:zzzzz-5:0:0", messageId: 778 });
	queueFor("9620.json", { kind: "callback", value: "o:zzzzz-5:0:0", messageId: 778 });
	queueFor("9621.json", { kind: "callback", value: "d:zzzzz-5:0", messageId: 778 });
	queueFor(`${Date.now()}-0123456789ab.json`, {
		kind: "agent",
		value: "The schema landed",
		id: "0123456789ab",
		hop: 1,
		from: { session: workingId, emoji: "", label: "Peer", cwd: "/peer", tag: "peer1" },
	});
	const heldDirOf = join(root, "notify-telegram/graph/pending", heldId);
	const heldItems = () =>
		existsSync(heldDirOf)
			? readdirSync(heldDirOf).filter((f) => f.endsWith(".json") && f !== "card.json" && f !== "resuming.json")
			: [];
	const sendsBeforeHeld = called("sendMessage").length;
	first.heartbeat();
	await settle(150);
	check(
		"what reached a dead session before it drained is held for its restore",
		heldItems().length === 8 && !existsSync(inboxOf(heldId)),
	);
	check("the crash card counts what is held", crashCalls().at(-1)?.body.text.includes("8 updates waiting") === true);
	check(
		"what only a running session could act on is dropped with a notice naming it",
		called("sendMessage")
			.slice(sendsBeforeHeld)
			.some(
				(c) =>
					String(c.body.text).includes("/stop") &&
					String(c.body.text).includes("a close tap") &&
					String(c.body.text).includes("a tap on a question that is no longer on record"),
			),
	);
	const heldBack = spawn(heldId, heldWorkDir);
	await heldBack.fire("session_start");
	await heldBack.pump(300);
	// The first drain tick hands the held entries back to the inbox, and the next one reads them.
	await heldBack.pump(300);
	const heldNote = heldBack.customs.find((c) => /died without shutting down/i.test(c.message.content ?? ""));
	check(
		"the restore note says the user wrote after the session ended",
		/after it ended/i.test(heldNote?.message.content ?? "") &&
			!/No user message has arrived/.test(heldNote?.message.content ?? ""),
	);
	check(
		"the restored session receives the held text with the part of the message it quoted",
		heldBack.steers.some(
			(s) => steerText(s) === "Go on with the parser" && referenceOf(s).includes("this part of a message you sent"),
		),
	);
	check(
		"a held tap reaches the restored session as the answer it gave, and a later tap on it is discarded",
		heldBack.steers.filter((s) => String(s.text).includes("Which backend?")).length === 1 &&
			heldBack.steers.some((s) => String(s.text).includes("Which backend?") && String(s.text).includes("Postgres")),
	);
	check(
		"a held tap on the standing question reaches the session as the label chosen",
		heldBack.steers.some((s) => s.text === "Wait"),
	);
	const targets = heldBack.steers.filter((s) => String(s.text).includes("Targets?"));
	check(
		"held multiple-choice taps reach the session as the one selection confirmed with Done",
		targets.length === 1 &&
			targets[0].text.includes('"windows"') &&
			!targets[0].text.includes('"linux"') &&
			!targets[0].text.includes('"macos"') &&
			!targets[0].text.includes("had not pressed Done"),
	);
	check(
		"an entry the drain had already picked up when the session died is held too",
		heldBack.steers.some((s) => s.text === "picked up mid-drain"),
	);
	check(
		"options chosen without Done reach the session as chosen but not confirmed",
		heldBack.steers.some(
			(s) =>
				String(s.text).includes("Platforms?") &&
				String(s.text).includes('"x86"') &&
				String(s.text).includes("had not pressed Done"),
		),
	);
	check(
		"a Done with nothing chosen reaches the session as no option selected",
		heldBack.steers.some((s) => String(s.text).includes("Extras?") && String(s.text).includes("no option selected")),
	);
	check(
		"a held agent message reaches the restored session",
		JSON.stringify(heldBack.customs).includes("The schema landed") && heldItems().length === 0,
	);
	await heldBack.fire("session_shutdown");

	// A week on, the card's records are gone and a tap says so. The batch file was written by a render
	// since, which must not keep a card with nothing left on it alive.
	jump(8 * 24 * 3_600_000);
	utimesSync(batchFile, new Date(Date.now()), new Date(Date.now()));
	const editsBeforeExpiry = cardEdits(reposted);
	first.heartbeat();
	await settle(150);
	check("a week-old crash record expires", !existsSync(join(crashDir, `${loneId}.json`)));
	check(
		"a card whose records all expired is retired without another edit",
		!existsSync(batchFile) && cardEdits(reposted) === editsBeforeExpiry,
	);
	const expiredToast = await tap(first, 9506, `kr:${loneId}`, loneCardId);
	check(
		"a tap on an expired card says so and strips its buttons",
		expiredToast.includes("no longer") &&
			called("editMessageReplyMarkup").some((c) => c.body.message_id === loneCardId),
	);
	check(
		"restore all on an expired card says so",
		(await tap(first, 9509, `ka:${batch}`, cardId)).includes("no longer"),
	);

	for (const s of [first, idleBack, workingBack, loudBack, haltedBack, cutBack, lostBack])
		await s.fire("session_shutdown");
	rmSync(join(sessionsDir, `${frozenId}.json`), { force: true });
	process.env.PATH = savedPath;
}

// ---------------------------------------------------------------- version skew

const stampFiles = ["index.ts", "render.ts", "graph.ts"].map((name) => new URL(`../${name}`, import.meta.url).pathname);
const stampOf = () => {
	const h = createHash("sha256");
	for (const f of stampFiles) h.update(readFileSync(f));
	return h.digest("hex");
};

heading("stale code yields the fleet locks");
clockSkew = 0;
// Earlier sections left records with old heartbeats; make them fresh so this section's reaper has no stale material.
mkdirSync(sessionsDir, { recursive: true });
for (const f of readdirSync(sessionsDir)) {
	const id = f.slice(0, -5);
	try {
		writeFileSync(join(sessionsDir, f), JSON.stringify({ ...record(id), heartbeat: Date.now() }));
	} catch {}
}
rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
rmSync(join(root, "notify-telegram/dashboard.lock"), { force: true });
writeConfig({ pinnedDashboard: true });
const vsBin = join(root, "vs-bin");
mkdirSync(vsBin, { recursive: true });
writeFileSync(
	join(vsBin, "tmux"),
	`#!/bin/sh
echo "$*" >> "$VS_TMUX_LOG"
S="$VS_STATE"
case "$1" in
  capture-pane) cat "$S/capture" ;;
  display-message)
    case "$5" in
      *pane_dead*) cat "$S/pane_dead" ;;
      *pane_pid*) cat "$S/pane_pid" ;;
      *window_activity*) cat "$S/window_activity" ;;
      *pane_id*) grep -qx "$4" "$S/pane_ok" || exit 1 ;;
    esac ;;
  list-panes) cat "$S/list_panes" ;;
  has-session) [ -e "$S/session_missing" ] && exit 1 || exit 0 ;;
  respawn-pane)
    F=$(cat "$S/respawn_fails" 2>/dev/null || echo 0)
    [ "$F" = "0" ] || { echo $((F - 1)) > "$S/respawn_fails"; echo "respawn refused" 1>&2; exit 1; }
    printf '%s\n' "$@" >> "$S/argv" ;;
  *) exit 0 ;;
esac
`,
	{ mode: 0o755 },
);
writeFileSync(join(vsBin, "systemctl"), "#!/bin/sh\necho running\n", { mode: 0o755 });
const savedVsPath = process.env.PATH;
process.env.PATH = `${vsBin}:${savedVsPath}`;
const vsState = join(root, "vs-state");
mkdirSync(vsState, { recursive: true });
const vsSet = (name, value) => writeFileSync(join(vsState, name), value);
const vsTmuxLog = join(root, "vs-tmux.log");
process.env.VS_STATE = vsState;
process.env.VS_TMUX_LOG = vsTmuxLog;
vsSet("capture", "idle\n");
vsSet("pane_dead", "0");
vsSet("pane_pid", "0");
vsSet("pane_ok", "%9\n");
vsSet("list_panes", "");
vsSet("window_activity", String(Math.floor(Date.now() / 1000) - 3600));
vsSet("respawn_fails", "0");
writeFileSync(vsTmuxLog, "");
const vsLog = () => readFileSync(vsTmuxLog, "utf8");
const vsLogReset = () => writeFileSync(vsTmuxLog, "");
const dummies = [];
const dummy = (command, ...args) => {
	const child = startProcess(command, args);
	dummies.push(child);
	return child;
};

const stampOriginal = stampOf();
const renderBytes = readFileSync(stampFiles[1]);
const restoreStamp = () => writeFileSync(stampFiles[1], renderBytes);
const vsPoller = spawn("01a1f101-0000-7000-8000-000000000001", "/home/dev/work/version-skew", "The poller");
await vsPoller.fire("session_start");
check("the record carries the stamp of the code it loaded", record(vsPoller.id).codeStamp === stampOriginal);
check(
	"the poller lock carries the stamp",
	JSON.parse(readFileSync(join(root, "notify-telegram/poller.lock"), "utf8")).code === stampOriginal,
);
await vsPoller.pump(150);
const vsBoard = join(root, "notify-telegram/dashboard.lock");
check(
	"the dashboard lock carries the stamp",
	existsSync(vsBoard) && JSON.parse(readFileSync(vsBoard, "utf8")).code === stampOriginal,
);

writeFileSync(stampFiles[1], Buffer.concat([renderBytes, Buffer.from("\n// version-skew stamp test\n")]));
const stampNew = stampOf();
check("the holder's stamp no longer matches the disk", record(vsPoller.id).codeStamp !== stampNew);
vsPoller.heartbeat();
check(
	"a stale holder keeps the poller lock while no current-code session is live",
	JSON.parse(readFileSync(join(root, "notify-telegram/poller.lock"), "utf8")).sessionId === vsPoller.id,
);
const vsFresh = spawn("01a1f102-0000-7000-8000-000000000002", "/home/dev/work/version-skew", "The current one");
await vsFresh.fire("session_start");
check("the current-code session records the new stamp", record(vsFresh.id).codeStamp === stampNew);
check(
	"a current-code session does not steal a live holder's fresh lock",
	JSON.parse(readFileSync(join(root, "notify-telegram/poller.lock"), "utf8")).sessionId === vsPoller.id,
);
vsPoller.heartbeat();
await settle(50);
check(
	"a stale holder yields the poller lock while a current-code session is live",
	!existsSync(join(root, "notify-telegram/poller.lock")),
);
check("a stale holder yields the board lock", !existsSync(vsBoard));
vsFresh.heartbeat();
await settle(50);
const vsOwner = JSON.parse(readFileSync(join(root, "notify-telegram/poller.lock"), "utf8"));
check(
	"the current-code session takes the freed lock with its own stamp",
	vsOwner.sessionId === vsFresh.id && vsOwner.code === stampNew,
);
restoreStamp();
vsFresh.heartbeat();
await settle(50);
vsPoller.heartbeat();
await settle(50);
check(
	"the poller is back once the disk matches its code again",
	JSON.parse(readFileSync(join(root, "notify-telegram/poller.lock"), "utf8")).sessionId === vsPoller.id,
);
await vsFresh.fire("session_shutdown");

heading("the restart wave of the current-code poller");
const vsSessions = join(root, "sessions");
mkdirSync(join(vsSessions, "proj"), { recursive: true });
const vsFolder = (n) => {
	const dir = join(root, `vs-folder-${n}`);
	mkdirSync(dir, { recursive: true });
	return dir;
};
const vsTranscript = (id) => {
	const path = join(vsSessions, "proj", `2026-01-01T00-00-00Z_${id}.jsonl`);
	writeFileSync(path, "{}\n");
	return path;
};
const vsMarker = (id) => join(root, "notify-telegram/restart-pending", `${id}.json`);
const vsMarkerRead = (id) => {
	try {
		return JSON.parse(readFileSync(vsMarker(id), "utf8"));
	} catch {
		return null;
	}
};
const vsNoticeTexts = () =>
	called("sendMessage")
		.filter((c) => String(c.body?.text ?? "").includes("could not be restarted"))
		.map((c) => c.body.text);
const vsWaveNotices = () => vsNoticeTexts().length;
const lastVsNotice = () => vsNoticeTexts().at(-1) ?? "";
const vsCandidate = (session, folder, fields) => {
	const next = {
		...record(session.id),
		state: "idle",
		tmux: "work",
		tmuxWindow: 9,
		tmuxPane: "%9",
		cwd: folder,
		lastInputAt: Date.now() - 3 * 60_000,
		heartbeat: Date.now(),
		...fields,
	};
	writeFileSync(join(sessionsDir, `${session.id}.json`), JSON.stringify(next));
	return next;
};
const vsRetire = (id) =>
	writeFileSync(join(sessionsDir, `${id}.json`), JSON.stringify({ ...record(id), heartbeat: 0 }));

// A stale record with a live standing question, close offer and red pin is restarted, its shutdown keeps
// all three, and the resumed process adopts them.
{
	const folder = vsFolder("adopt");
	const transcript = vsTranscript("01a1f110-0000-7000-8000-000000000010");
	const old = dummy(process.execPath, "-e", "setInterval(() => {}, 600000)");
	const stale = spawn("01a1f110-0000-7000-8000-000000000010", folder, "Stale one");
	await stale.fire("session_start");
	// Plain green opens the close offer; the green choice becomes the standing question; the red light gets pinned.
	await stale.tools
		.get("notify_status")
		.execute(
			"vs1",
			{ summary: "The first pass is done.", urgency: "green", effect: "thumbs_up" },
			undefined,
			undefined,
			stale.ctx,
		);
	await stale.fire("session_stop");
	await settle(150);
	await stale.tools.get("notify_status").execute(
		"vs2",
		{
			summary: "Green, choose.",
			urgency: "green",
			effect: "thumbs_up",
			question: "What next for the stale one?",
			options: opts("Go", "Stop"),
		},
		undefined,
		undefined,
		stale.ctx,
	);
	await stale.fire("session_stop");
	await settle(150);
	await stale.tools
		.get("notify_status")
		.execute("vs3", { summary: "The red light.", urgency: "red" }, undefined, undefined, stale.ctx);
	await stale.fire("session_stop");
	await settle(150);
	const redMessage = api.nextMessage - 1;
	check("the candidate's red status is pinned", api.pinned.has(redMessage));
	const before = record(stale.id);
	check(
		"the candidate has a standing question and a close offer",
		before.standing !== null && before.closeOffer !== null && before.pinned === redMessage,
	);
	vsCandidate(stale, folder, { codeStamp: "stale-stamp", pid: old.pid });
	vsSet("pane_ok", "%9\n");
	vsSet("pane_pid", String(old.pid));
	vsSet("pane_dead", "1");
	vsSet("capture", "idle\n");
	vsLogReset();
	vsPoller.heartbeat();
	// The exit wait needs a probe round after the kill, so wait for the respawn instead of a fixed settle.
	for (let i = 0; i < 40 && !vsLog().includes("respawn-pane"); i++) await settle(100);
	const marker = vsMarkerRead(stale.id);
	check(
		"the wave wrote the restart marker before the kill",
		marker !== null && marker.pid === old.pid && typeof marker.at === "number",
	);
	const log = vsLog();
	check(
		"the pane is held open while the process is gone and respawned with the transcript",
		log.includes("remain-on-exit on") &&
			log.indexOf("remain-on-exit on") < log.indexOf("respawn-pane") &&
			log.includes(`omp --resume '${transcript}'`),
	);
	const released = "set-option -p -u -t %9 remain-on-exit";
	for (let i = 0; i < 20 && !vsLog().includes(released); i++) await settle(100);
	check(
		"the respawned pane is released, so quitting the resumed session closes it",
		vsLog().indexOf(released) > vsLog().indexOf("respawn-pane"),
	);
	await stale.fire("session_shutdown");
	await settle(150);
	const after = record(stale.id);
	check(
		"a restart shutdown keeps the standing question",
		after.standing !== null && after.standing.id === before.standing.id,
	);
	check("a restart shutdown keeps the close offer", after.closeOffer === before.closeOffer);
	check("a restart shutdown keeps the red pin", after.pinned === redMessage && api.pinned.has(redMessage));
	check("the marker is consumed by the shutdown", !existsSync(vsMarker(stale.id)));
	const back = spawn(stale.id, folder, "Stale one");
	await back.fire("session_start");
	await settle(100);
	vsPoller.heartbeat();
	await settle(200);
	check(
		"the wave confirms the resume by the record, the new pid and the current stamp",
		record(stale.id).pid !== old.pid,
	);
	check("the resumed process adopts the standing question", record(stale.id).standing?.id === before.standing.id);
	check("the resumed process adopts the close offer", record(stale.id).closeOffer === before.closeOffer);
	check("the resumed process adopts the red pin", record(stale.id).pinned === redMessage);
	writeFileSync(
		join(inboxOf(stale.id), "9601.json"),
		JSON.stringify({ kind: "callback", value: `c:${before.standing.id}:0` }),
	);
	await back.pump(250);
	check(
		"the turn-end question survives the restart and starts the next turn",
		back.steers.some((x) => x.text === "Go"),
	);
	check("a fully restarted wave sends no notice", vsWaveNotices() === 0);
	await back.fire("session_shutdown");
	vsRetire(stale.id);
}

// A stale record with no stamp and an open turn-end question waits for the answer, and says nothing.
{
	const folder = vsFolder("old-question");
	const old = dummy(process.execPath, "-e", "setInterval(() => {}, 600000)");
	const stale = spawn("01a1f111-0000-7000-8000-000000000011", folder, "Stale two");
	await stale.fire("session_start");
	const rec = vsCandidate(stale, folder, {
		codeStamp: "",
		pid: old.pid,
		standing: { id: "vs-old-q", messageId: 99001, labels: ["Go"], head: "head" },
	});
	delete rec.lastInputAt;
	writeFileSync(join(sessionsDir, `${stale.id}.json`), JSON.stringify(rec));
	vsSet("pane_pid", String(old.pid));
	vsLogReset();
	vsPoller.heartbeat();
	await settle(400);
	check(
		"an old-code session with an open question is not restarted",
		!vsLog().includes("respawn-pane") && !existsSync(vsMarker(stale.id)),
	);
	check("a busy skip sends no notice", vsWaveNotices() === 0);
	vsRetire(stale.id);
	old.kill("SIGKILL");
}

// Each remaining gate, one candidate at a time, each silent.
{
	const busyChecks = [
		{ id: "01a1f112-0000-7000-8000-000000000012", name: "a working state", fields: { state: "working" } },
		{ id: "01a1f113-0000-7000-8000-000000000013", name: "a question on screen", fields: {} },
		{ id: "01a1f114-0000-7000-8000-000000000014", name: "recent input", fields: { lastInputAt: Date.now() - 60_000 } },
		{ id: "01a1f115-0000-7000-8000-000000000015", name: "recent terminal activity", fields: {} },
	];
	const busyDummies = [];
	for (const spec of busyChecks) {
		const folder = vsFolder(spec.name);
		const old = dummy(process.execPath, "-e", "setInterval(() => {}, 600000)");
		busyDummies.push(old);
		const stale = spawn(spec.id, folder, `Stale ${spec.name}`);
		await stale.fire("session_start");
		vsCandidate(stale, folder, { codeStamp: "stale-stamp", pid: old.pid, ...spec.fields });
		if (spec.name === "a question on screen") vsSet("capture", "1. Go\n2. Stop\n⏎ select ⎋ cancel\n");
		if (spec.name === "recent terminal activity") {
			const rec = record(spec.id);
			delete rec.lastInputAt;
			writeFileSync(join(sessionsDir, `${spec.id}.json`), JSON.stringify(rec));
			vsSet("window_activity", String(Math.floor(Date.now() / 1000) - 30));
		}
		vsSet("pane_pid", String(old.pid));
		vsLogReset();
		vsPoller.heartbeat();
		await settle(400);
		check(
			`the wave leaves a ${spec.name} session alone, without a notice`,
			!vsLog().includes("respawn-pane") && !existsSync(vsMarker(spec.id)) && vsWaveNotices() === 0,
		);
		vsSet("capture", "idle\n");
		vsSet("window_activity", String(Math.floor(Date.now() / 1000) - 3600));
		vsRetire(spec.id);
	}
	for (const old of busyDummies) old.kill("SIGKILL");
}

// A child process that is not one of omp's own workers blocks the restart.
{
	const folder = vsFolder("stray-child");
	const old = dummy("bash", "-c", "( exec -a stray sleep 600 ) & wait");
	const stale = spawn("01a1f116-0000-7000-8000-000000000016", folder, "Stale six");
	await stale.fire("session_start");
	vsCandidate(stale, folder, { codeStamp: "stale-stamp", pid: old.pid });
	vsSet("pane_pid", String(old.pid));
	vsLogReset();
	vsPoller.heartbeat();
	await settle(400);
	check(
		"a session with a non-worker child is not restarted",
		!vsLog().includes("respawn-pane") && !existsSync(vsMarker(stale.id)) && vsWaveNotices() === 0,
	);
	vsRetire(stale.id);
	old.kill("SIGKILL");
}

// The same shape with omp's own children, a worker and the Python eval kernel, passes the gate, and a resume
// nobody confirms is reported once.
{
	const folder = vsFolder("worker-child");
	const runnerDir = join(root, "omp-python-runner-1000");
	mkdirSync(runnerDir, { recursive: true });
	const runner = join(runnerDir, "runner-test.py");
	writeFileSync(runner, "import time\ntime.sleep(600)\n");
	const old = dummy("bash", "-c", `( exec -a __omp_worker_test sleep 600 ) & python3 -u '${runner}' & wait`);
	const stale = spawn("01a1f117-0000-7000-8000-000000000017", folder, "Stale seven");
	await stale.fire("session_start");
	const transcript = vsTranscript(stale.id);
	vsCandidate(stale, folder, { codeStamp: "stale-stamp", pid: old.pid });
	vsSet("pane_pid", String(old.pid));
	vsSet("pane_dead", "1");
	// The forked shells must have become the worker and the kernel before the wave reads them.
	await settle(300);
	vsLogReset();
	vsPoller.heartbeat();
	for (let i = 0; i < 40 && !vsLog().includes("omp --resume"); i++) await settle(100);
	await stale.fire("session_shutdown");
	await settle(100);
	check("omp's own children do not block the restart", vsLog().includes(`omp --resume '${transcript}'`));
	jump(95_000);
	vsPoller.heartbeat();
	await settle(200);
	check(
		"an unconfirmed resume is reported with its tab and reason",
		vsWaveNotices() === 1 &&
			lastVsNotice().includes("work:9") &&
			lastVsNotice().includes("Stale seven") &&
			lastVsNotice().includes("not confirmed"),
	);
	vsRetire(stale.id);
	old.kill("SIGKILL");
}

// Failures found before the kill are reported in one notice, and the process is left alone.
{
	const folderT = vsFolder("no-transcript");
	const folderF = vsFolder("no-folder-folder");
	const missingTranscript = dummy(process.execPath, "-e", "setInterval(() => {}, 600000)");
	const t = spawn("01a1f118-0000-7000-8000-000000000018", folderT, "Stale eight");
	await t.fire("session_start");
	vsTranscript("01a1f119-0000-7000-8000-000000000019");
	vsCandidate(t, folderT, { codeStamp: "stale-stamp", pid: missingTranscript.pid });
	const missingFolder = dummy(process.execPath, "-e", "setInterval(() => {}, 600000)");
	const f = spawn("01a1f119-0000-7000-8000-000000000019", folderF, "Stale nine");
	await f.fire("session_start");
	vsCandidate(f, join(root, "vs-gone-folder"), { codeStamp: "stale-stamp", pid: missingFolder.pid });
	const missingPane = dummy(process.execPath, "-e", "setInterval(() => {}, 600000)");
	const p = spawn("01a1f120-0000-7000-8000-000000000020", folderT, "Stale ten");
	await p.fire("session_start");
	vsCandidate(p, folderT, { codeStamp: "stale-stamp", pid: missingPane.pid, tmuxPane: "%17" });
	vsSet("pane_ok", "%9\n");
	vsSet("pane_dead", "0");
	vsLogReset();
	vsPoller.heartbeat();
	await settle(500);
	vsPoller.heartbeat();
	await settle(200);
	check(
		"one wave notice names every failed tab and its reason",
		vsWaveNotices() === 2 &&
			lastVsNotice().includes("no transcript") &&
			lastVsNotice().includes("folder is gone") &&
			lastVsNotice().includes("no pane") &&
			lastVsNotice().includes("Stale eight") &&
			lastVsNotice().includes("Stale nine") &&
			lastVsNotice().includes("Stale ten"),
	);
	check(
		"a pre-kill failure leaves the process running",
		missingTranscript.exitCode === null && missingFolder.exitCode === null && missingPane.exitCode === null,
	);
	check(
		"a pre-kill failure never respawns a pane",
		!vsLog().includes("respawn-pane") && !vsLog().includes("new-window"),
	);
	vsRetire(t.id);
	vsRetire(f.id);
	vsRetire(p.id);
	missingTranscript.kill("SIGKILL");
	missingFolder.kill("SIGKILL");
	missingPane.kill("SIGKILL");
}

// A process that does not exit is left running, reported, retried by the next wave, not reported twice.
{
	const sigLog = join(root, "vs-signal.log");
	process.env.VS_SIGNAL_LOG = sigLog;
	writeFileSync(sigLog, "");
	const stubborn = dummy(
		process.execPath,
		"-e",
		'process.on("SIGTERM", () => { require("fs").appendFileSync(process.env.VS_SIGNAL_LOG, "TERM\\n"); }); setInterval(() => {}, 1000);',
	);
	const folder = vsFolder("stubborn");
	const stale = spawn("01a1f121-0000-7000-8000-000000000021", folder, "Stale eleven");
	await stale.fire("session_start");
	vsTranscript(stale.id);
	vsCandidate(stale, folder, { codeStamp: "stale-stamp", pid: stubborn.pid });
	vsSet("pane_pid", String(stubborn.pid));
	vsSet("pane_dead", "1");
	vsLogReset();
	vsPoller.heartbeat();
	// The marker proves the wave reached the kill, so the exit wait's deadline is set before the jump.
	for (let i = 0; i < 40 && !existsSync(vsMarker(stale.id)); i++) await settle(100);
	await settle(100);
	jump(31_000);
	await settle(1500);
	vsPoller.heartbeat();
	await settle(400);
	check(
		"a process that ignores SIGTERM is left running and reported",
		stubborn.exitCode === null && vsWaveNotices() === 3 && lastVsNotice().includes("did not exit"),
	);
	check("the wave that reported it did not respawn a pane", !vsLog().includes("respawn-pane"));
	writeFileSync(join(sessionsDir, `${stale.id}.json`), JSON.stringify({ ...record(stale.id), heartbeat: Date.now() }));
	vsLogReset();
	vsPoller.heartbeat();
	// The retry's kill takes real milliseconds through the fake tmux.
	for (
		let i = 0;
		i < 40 &&
		readFileSync(sigLog, "utf8")
			.split("\n")
			.filter((l) => l === "TERM").length < 2;
		i++
	)
		await settle(100);
	check(
		"the next wave retries a process that did not exit",
		readFileSync(sigLog, "utf8")
			.split("\n")
			.filter((l) => l === "TERM").length === 2,
	);
	// Retiring now keeps the next wave from opening a third entry whose restart would run past this subtest.
	vsRetire(stale.id);
	jump(31_000);
	await settle(1500);
	vsPoller.heartbeat();
	await settle(400);
	check("the same failure is not reported twice", vsWaveNotices() === 3);
	stubborn.kill("SIGKILL");
}

// A respawn that fails twice opens a new window in the same tmux session and is reported.
{
	const folder = vsFolder("respawn-fail");
	const old = dummy(process.execPath, "-e", "setInterval(() => {}, 600000)");
	const stale = spawn("01a1f122-0000-7000-8000-000000000022", folder, "Stale twelve");
	await stale.fire("session_start");
	const transcript = vsTranscript(stale.id);
	vsCandidate(stale, folder, { codeStamp: "stale-stamp", pid: old.pid });
	vsSet("pane_pid", String(old.pid));
	vsSet("pane_dead", "1");
	vsSet("respawn_fails", "2");
	vsLogReset();
	vsPoller.heartbeat();
	for (let i = 0; i < 40 && !vsLog().includes("new-window"); i++) await settle(100);
	const log = vsLog();
	check(
		"a failed respawn is retried once and then a new window opens in the same tmux session",
		log.split("respawn-pane").length - 1 === 2 &&
			log.includes("new-window") &&
			log.includes("=work") &&
			log.includes(`omp --resume '${transcript}'`),
	);
	const back = spawn(stale.id, folder, "Stale twelve");
	await back.fire("session_start");
	await settle(100);
	vsPoller.heartbeat();
	await settle(200);
	check(
		"the new window is reported even though the resume confirmed",
		vsWaveNotices() === 4 && lastVsNotice().includes("new window"),
	);
	await back.fire("session_shutdown");
	vsRetire(stale.id);
	vsSet("respawn_fails", "0");
	old.kill("SIGKILL");
}

// A respawn that fails once succeeds on the retry, releases the pane and sends no notice.
{
	const folder = vsFolder("respawn-retry");
	const old = dummy(process.execPath, "-e", "setInterval(() => {}, 600000)");
	const stale = spawn("01a1f1a0-0000-7000-8000-0000000000a0", folder, "Stale retried");
	await stale.fire("session_start");
	vsTranscript(stale.id);
	vsCandidate(stale, folder, { codeStamp: "stale-stamp", pid: old.pid });
	vsSet("pane_pid", String(old.pid));
	vsSet("pane_dead", "1");
	vsSet("respawn_fails", "1");
	vsLogReset();
	vsPoller.heartbeat();
	const released = "set-option -p -u -t %9 remain-on-exit";
	for (let i = 0; i < 40 && !vsLog().includes(released); i++) await settle(100);
	const log = vsLog();
	check(
		"a respawn that fails once is retried in the same pane and the pane is released",
		log.split("respawn-pane").length - 1 === 2 &&
			log.indexOf(released) > log.lastIndexOf("respawn-pane") &&
			!log.includes("new-window"),
	);
	const back = spawn(stale.id, folder, "Stale retried");
	await back.fire("session_start");
	await settle(100);
	vsPoller.heartbeat();
	await settle(200);
	check("a respawn that succeeds on the retry sends no notice", vsWaveNotices() === 4);
	await back.fire("session_shutdown");
	vsRetire(stale.id);
	vsSet("respawn_fails", "0");
	old.kill("SIGKILL");
}

// An old record without a pane id is found through its pid and its parent, and driven with send-keys.
{
	const parentPidFile = join(root, "vs-parent-pid");
	process.env.VS_CHILD_FILE = parentPidFile;
	const shell = dummy("sh", "-c", `sleep 600 & S=$!; echo $S > "$VS_CHILD_FILE"; wait $S`);
	await settle(150);
	const ompPid = Number(readFileSync(parentPidFile, "utf8"));
	const folder = vsFolder("pane-by-parent");
	const stale = spawn("01a1f123-0000-7000-8000-000000000023", folder, "Stale thirteen");
	await stale.fire("session_start");
	const transcript = vsTranscript(stale.id);
	vsCandidate(stale, folder, { codeStamp: "stale-stamp", pid: ompPid, tmuxPane: "" });
	const rec = record(stale.id);
	delete rec.tmuxPane;
	writeFileSync(join(sessionsDir, `${stale.id}.json`), JSON.stringify(rec));
	vsSet("pane_ok", "%11\n");
	vsSet("pane_pid", String(shell.pid));
	vsSet("list_panes", `%11\t${shell.pid}\t0\n`);
	vsSet("pane_dead", "0");
	vsLogReset();
	vsPoller.heartbeat();
	for (let i = 0; i < 40 && !vsLog().includes("send-keys"); i++) await settle(100);
	const log = vsLog();
	check(
		"a pane whose process is the parent of the session is found and driven with send-keys",
		log.includes("send-keys") &&
			log.includes(`cd '${folder}' && omp --resume '${transcript}'`) &&
			!log.includes("respawn-pane"),
	);
	const back = spawn(stale.id, folder, "Stale thirteen");
	await back.fire("session_start");
	await settle(100);
	vsPoller.heartbeat();
	await settle(200);
	check("the send-keys resume is confirmed", record(stale.id).pid === process.pid && vsWaveNotices() === 4);
	await back.fire("session_shutdown");
	vsRetire(stale.id);
	shell.kill("SIGKILL");
}

// A send-keys restart must type nothing while the old process still runs, and type the resume once it is gone.
{
	const folder = vsFolder("sendkeys-delay");
	const late = dummy(
		process.execPath,
		"-e",
		"process.on('SIGTERM', () => { setTimeout(() => process.exit(0), 2000) }); setInterval(() => {}, 1000);",
	);
	const stale = spawn("01a1f124-0000-7000-8000-000000000024", folder, "Stale fourteen");
	await stale.fire("session_start");
	const transcript = vsTranscript(stale.id);
	vsCandidate(stale, folder, { codeStamp: "stale-stamp", pid: late.pid, tmuxPane: "" });
	vsSet("pane_ok", "%11\n");
	vsSet("pane_pid", "1");
	vsSet("list_panes", `%11\t${late.pid}\t0\n`);
	vsSet("pane_dead", "0");
	vsLogReset();
	vsPoller.heartbeat();
	for (let i = 0; i < 40 && !existsSync(vsMarker(stale.id)); i++) await settle(100);
	await settle(300);
	const quiet = !vsLog().includes("send-keys") && late.exitCode === null;
	for (let i = 0; i < 60 && !vsLog().includes("send-keys"); i++) await settle(100);
	const log = vsLog();
	check(
		"a send-keys restart types nothing while the old process still runs and types the resume once it has exited",
		quiet &&
			log.includes(`send-keys -t %11 -l cd '${folder}' && omp --resume '${transcript}'`) &&
			log.includes("send-keys -t %11 Enter"),
	);
	vsRetire(stale.id);
}

// A folder whose name has a space and a single quote must reach the respawn command intact.
{
	const folder = join(root, "vs q'uote folder");
	mkdirSync(folder, { recursive: true });
	const old = dummy(process.execPath, "-e", "setInterval(() => {}, 600000)");
	const stale = spawn("01a1f125-0000-7000-8000-000000000025", folder, "Stale fifteen");
	await stale.fire("session_start");
	const transcript = vsTranscript(stale.id);
	vsCandidate(stale, folder, { codeStamp: "stale-stamp", pid: old.pid });
	vsSet("pane_ok", "%11\n");
	vsSet("pane_pid", String(old.pid));
	vsSet("list_panes", `%11\t${old.pid}\t0\n`);
	vsSet("pane_dead", "1");
	vsSet("respawn_fails", "0");
	writeFileSync(join(vsState, "argv"), "");
	vsLogReset();
	vsPoller.heartbeat();
	for (let i = 0; i < 40 && !vsLog().includes("respawn-pane"); i++) await settle(100);
	const argv = readFileSync(join(vsState, "argv"), "utf8").split("\n");
	check(
		"a cwd with a space and a single quote reaches the shell intact in the respawn command",
		argv.includes(folder) && argv.includes(`omp --resume '${transcript}'`),
	);
	vsRetire(stale.id);
	old.kill("SIGKILL");
}

// The transcript lookup survives a stray entry and an unreadable project dir, and reports a missing sessions dir.
{
	const folder = vsFolder("transcript-robust");
	const stray = join(vsSessions, "aa-stray.txt");
	const unreadable = join(vsSessions, "aa-unreadable");
	const d1 = dummy(process.execPath, "-e", "setInterval(() => {}, 600000)");
	const stale = spawn("01a1f126-0000-7000-8000-000000000026", folder, "Stale sixteen");
	await stale.fire("session_start");
	const transcript = vsTranscript(stale.id);
	writeFileSync(stray, "x");
	mkdirSync(unreadable, { recursive: true });
	chmodSync(unreadable, 0);
	vsCandidate(stale, folder, { codeStamp: "stale-stamp", pid: d1.pid });
	vsSet("pane_ok", "%9\n");
	vsSet("pane_pid", String(d1.pid));
	vsSet("list_panes", `%9\t${d1.pid}\t0\n`);
	vsSet("pane_dead", "1");
	vsLogReset();
	vsPoller.heartbeat();
	for (let i = 0; i < 40 && !vsLog().includes("respawn-pane"); i++) await settle(100);
	check(
		"a stray entry and an unreadable project dir do not hide the transcript",
		vsLog().includes(`omp --resume '${transcript}'`),
	);
	await stale.fire("session_shutdown");
	vsRetire(stale.id);
	d1.kill("SIGKILL");
	chmodSync(unreadable, 0o755);
	rmSync(unreadable, { recursive: true, force: true });
	rmSync(stray, { force: true });

	const d2 = dummy(process.execPath, "-e", "setInterval(() => {}, 600000)");
	const stale2 = spawn("01a1f127-0000-7000-8000-000000000027", folder, "Stale seventeen");
	await stale2.fire("session_start");
	vsTranscript(stale2.id);
	vsCandidate(stale2, folder, { codeStamp: "stale-stamp", pid: d2.pid });
	vsSet("pane_ok", "%9\n");
	vsSet("pane_pid", String(d2.pid));
	vsSet("list_panes", `%9\t${d2.pid}\t0\n`);
	vsLogReset();
	renameSync(vsSessions, `${vsSessions}.gone`);
	vsPoller.heartbeat();
	await settle(700);
	renameSync(`${vsSessions}.gone`, vsSessions);
	check(
		"a missing sessions dir is reported as no transcript",
		lastVsNotice().includes("no transcript") && lastVsNotice().includes("Stale seventeen"),
	);
	vsRetire(stale2.id);
	d2.kill("SIGKILL");
}

// A pre-stamp session with no open question is restarted, not left waiting for an answer.
{
	const folder = vsFolder("old-noq");
	const old = dummy(process.execPath, "-e", "setInterval(() => {}, 600000)");
	const stale = spawn("01a1f128-0000-7000-8000-000000000028", folder, "Stale eighteen");
	await stale.fire("session_start");
	const transcript = vsTranscript(stale.id);
	vsCandidate(stale, folder, { codeStamp: "", pid: old.pid });
	vsSet("pane_ok", "%9\n");
	vsSet("pane_pid", String(old.pid));
	vsSet("list_panes", `%9\t${old.pid}\t0\n`);
	vsSet("pane_dead", "1");
	vsLogReset();
	vsPoller.heartbeat();
	for (let i = 0; i < 40 && !vsLog().includes("respawn-pane"); i++) await settle(100);
	check("a pre-stamp session with no open question is restarted", vsLog().includes(`omp --resume '${transcript}'`));
	await stale.fire("session_shutdown");
	vsRetire(stale.id);
	old.kill("SIGKILL");
}

// A failed respawn whose tmux session is gone and has no name falls back to the default session.
{
	const folder = vsFolder("no-tmux");
	const old = dummy(process.execPath, "-e", "setInterval(() => {}, 600000)");
	const stale = spawn("01a1f129-0000-7000-8000-000000000029", folder, "Stale nineteen");
	await stale.fire("session_start");
	const transcript = vsTranscript(stale.id);
	vsCandidate(stale, folder, { codeStamp: "stale-stamp", pid: old.pid, tmux: "" });
	vsSet("pane_ok", "%9\n");
	vsSet("pane_pid", String(old.pid));
	vsSet("list_panes", `%9\t${old.pid}\t0\n`);
	vsSet("pane_dead", "1");
	vsSet("respawn_fails", "2");
	writeFileSync(join(vsState, "session_missing"), "");
	vsLogReset();
	vsPoller.heartbeat();
	for (let i = 0; i < 40 && !vsLog().includes("new-session"); i++) await settle(100);
	const log = vsLog();
	check(
		"a failed respawn with no session name opens the default session",
		log.includes(`new-session -d -s omp -n restart ${stale.id.slice(0, 8)} -c ${folder} omp --resume '${transcript}'`),
	);
	vsPoller.heartbeat();
	await settle(400);
	check(
		"the new-session fallback is reported with the folder as the tab",
		lastVsNotice().includes("new window") && lastVsNotice().includes(folder),
	);
	vsRetire(stale.id);
	vsSet("respawn_fails", "0");
	rmSync(join(vsState, "session_missing"), { force: true });
	old.kill("SIGKILL");
}

// The lock itself: old-code and stale-code holders are taken over by the rules from dead-poller-lock.
{
	const lockFile = join(root, "notify-telegram/poller.lock");
	const placeLock = (lock) => {
		writeFileSync(`${lockFile}.vs.tmp`, JSON.stringify(lock));
		renameSync(`${lockFile}.vs.tmp`, lockFile);
	};
	placeLock({ sessionId: "01a1f130-0000-7000-8000-000000000030", pid: deadPid, heartbeat: Date.now() });
	vsPoller.pump(150);
	check(
		"a drain tick takes a fresh lock whose holder has no stamp and is gone",
		JSON.parse(readFileSync(lockFile, "utf8")).sessionId === vsPoller.id,
	);
	placeLock({
		sessionId: "01a1f131-0000-7000-8000-000000000031",
		pid: deadPid,
		heartbeat: Date.now() - 60_000,
		code: "stale-stamp",
	});
	vsPoller.heartbeat();
	await settle(50);
	check(
		"a heartbeat takes a stale-heartbeat lock that names stale code",
		JSON.parse(readFileSync(lockFile, "utf8")).sessionId === vsPoller.id,
	);
	placeLock({
		sessionId: "01a1f132-0000-7000-8000-000000000032",
		pid: process.pid,
		heartbeat: Date.now(),
		code: "stale-stamp",
	});
	vsPoller.heartbeat();
	await settle(50);
	check(
		"a fresh lock held by a live process is left alone",
		JSON.parse(readFileSync(lockFile, "utf8")).sessionId === "01a1f132-0000-7000-8000-000000000032",
	);
}

// A record carrying the poller's own stamp is never a candidate, no matter how tempting it looks.
{
	const id = "01a1f140-0000-7000-8000-000000000040";
	const folder = vsFolder("current-code");
	const old = dummy(process.execPath, "-e", "setInterval(() => {}, 600000)");
	vsTranscript(id);
	const rec = {
		instance: "vs-current",
		leased: false,
		pid: old.pid,
		tag: "vscur1",
		name: "Stale looking",
		cwd: folder,
		emoji: "",
		emojiChosen: false,
		label: "",
		code: "",
		lastNotified: 0,
		recent: [],
		question: null,
		replyQuestion: null,
		standing: null,
		closeOffer: null,
		pinned: null,
		pinPendingUntil: 0,
		state: "idle",
		health: "",
		summary: "",
		summaryAt: 0,
		heartbeat: Date.now(),
		systemShutdownAt: 0,
		messaging: 1,
		boot: "boot-before-the-crash",
		argv: [],
		tmux: "work",
		tmuxWindow: 9,
		tmuxPane: "%9",
		lastInputAt: Date.now() - 3 * 60_000,
		codeStamp: stampOriginal,
	};
	writeFileSync(join(sessionsDir, `${id}.json`), JSON.stringify(rec));
	vsSet("pane_pid", String(old.pid));
	vsLogReset();
	vsPoller.heartbeat();
	await settle(400);
	check(
		"a current-code record is never a restart candidate",
		!vsLog().includes("respawn-pane") && !existsSync(vsMarker(id)) && old.exitCode === null,
	);
	rmSync(join(sessionsDir, `${id}.json`), { force: true });
	old.kill("SIGKILL");
}

// The reaper leaves a record alone while its restart marker is live, and takes it up once the marker ages out.
{
	const id = "01a1f141-0000-7000-8000-000000000041";
	const rec = {
		instance: "vs-reaped",
		leased: false,
		pid: deadPid,
		tag: "vsreap",
		name: "Mid restart",
		cwd: vsFolder("reaped"),
		emoji: "",
		emojiChosen: false,
		label: "",
		code: "",
		lastNotified: 0,
		recent: [],
		question: null,
		replyQuestion: null,
		standing: null,
		closeOffer: null,
		pinned: null,
		pinPendingUntil: 0,
		state: "idle",
		health: "",
		summary: "",
		summaryAt: 0,
		heartbeat: Date.now() - 100_000,
		systemShutdownAt: 0,
		messaging: 1,
		boot: "boot-before-the-crash",
		argv: [],
		tmux: "work",
		tmuxWindow: 9,
		tmuxPane: "%9",
		lastInputAt: 0,
		codeStamp: "stale-stamp",
	};
	writeFileSync(join(sessionsDir, `${id}.json`), JSON.stringify(rec));
	mkdirSync(join(root, "notify-telegram/restart-pending"), { recursive: true });
	writeFileSync(vsMarker(id), JSON.stringify({ at: Date.now(), pid: deadPid }), { mode: 0o600 });
	rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
	vsPoller.heartbeat();
	await settle(150);
	check(
		"the reaper leaves a marked record alone while its restart marker is live",
		existsSync(join(sessionsDir, `${id}.json`)) && !existsSync(join(root, "notify-telegram/crashed", `${id}.json`)),
	);
	jump(6 * 60_000);
	vsPoller.heartbeat();
	await settle(200);
	check(
		"the reaper takes up a marked record once its marker is gone",
		!existsSync(join(sessionsDir, `${id}.json`)) && existsSync(join(root, "notify-telegram/crashed", `${id}.json`)),
	);
}

restoreStamp();
process.env.PATH = savedVsPath;
delete process.env.VS_STATE;
delete process.env.VS_TMUX_LOG;
delete process.env.VS_CHILD_FILE;
delete process.env.VS_SIGNAL_LOG;
for (const child of dummies) {
	if (child.exitCode === null) child.kill("SIGKILL");
}
await settle(200);
vsPoller.heartbeat();
await settle(100);
await vsPoller.fire("session_shutdown");
for (const f of readdirSync(sessionsDir)) rmSync(join(sessionsDir, f), { force: true });
check(
	"the extension files are left as they were",
	readFileSync(stampFiles[1], "utf8") === renderBytes.toString("utf8"),
);

heading("PR watch");
{
	const savedPath = process.env.PATH;
	rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
	const wBin = join(root, "watch-bin");
	mkdirSync(wBin, { recursive: true });
	const wghLog = join(root, "watch-gh.log");
	const ghTable = join(root, "watch-gh-table.json");
	const ghRaw = join(root, "watch-gh-raw.json");
	const ghServe = new URL("./watch-gh-serve.mjs", import.meta.url).pathname;
	const prView = join(root, "watch-pr-view.json");
	writeFileSync(wghLog, "");
	writeFileSync(ghTable, "{}");
	writeFileSync(ghRaw, "");
	writeFileSync(
		prView,
		JSON.stringify({
			state: "OPEN",
			isDraft: false,
			reviewDecision: "",
			latestReviews: [],
			statusCheckRollup: [],
			url: "https://github.com/someorg/widget/pull/7",
			number: 7,
		}),
	);
	writeFileSync(
		join(wBin, "gh"),
		`#!/bin/sh
echo "$*" >> ${wghLog}
case "$1 $2" in
  "api graphql")
    if [ "$WGH_FAIL" = "1" ]; then echo "HTTP 500" 1>&2; exit 1; fi
    if [ -n "$WGH_RAW" ]; then cat ${ghRaw}; exit 0; fi
    if [ -n "$WGH_SLOW" ]; then sleep 2; fi
    node ${ghServe} ${ghTable} "$4" ;;
  "pr view") cat ${prView} ;;
  "pr list") printf '%s' "$WGH_PR_LIST" ;;
  *) exit 1 ;;
esac
echo done >> ${wghLog}
`,
		{ mode: 0o755 },
	);
	process.env.PATH = `${wBin}:${savedPath}`;
	process.env.WGH_PR_LIST = "[]";
	const watchesDir = join(root, "notify-telegram/graph/watches");
	const nodesDir = join(root, "notify-telegram/graph/nodes");
	const watchOf = (session, owner, name, number) =>
		JSON.parse(readFileSync(join(watchesDir, session, `${owner}+${name}+${number}.json`), "utf8"));
	const pendingFiles = (id) => {
		const dir = join(root, "notify-telegram/graph/pending", id);
		return existsSync(dir)
			? readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "card.json" && f !== "resuming.json")
			: [];
	};
	const ghLogText = () => readFileSync(wghLog, "utf8");
	const prOf = (s, args) =>
		s.tools.get("pr_watch")
			? s.tools.get("pr_watch").execute("w", args, undefined, undefined, s.ctx)
			: Promise.resolve({ content: [{ type: "text", text: "tool missing" }], isError: true });
	const prText = (result) => result.content[0].text;
	const cardsFor = (id) =>
		called("sendMessage").filter((c) =>
			c.body.reply_markup?.inline_keyboard?.flat().some((b) => b.callback_data === `r:${id}`),
		);
	// The fake gh appends a line when a call finishes, so a stable log means no poll is mid-query.
	const ghQuiet = async () => {
		await settle(300);
		let last = -1;
		let stable = 0;
		while (stable < 2) {
			const len = ghLogText().length;
			stable = len === last ? stable + 1 : 0;
			last = len;
			await settle(100);
		}
	};
	const tick = async (holder, live, pumpers) => {
		await ghQuiet();
		jump(61_000);
		holder.heartbeat();
		for (const s of live) s.heartbeat();
		await ghQuiet();
		for (const s of pumpers) await s.pump(200);
	};
	// The pull request fields of one alias, in the exact shape a real `gh api graphql` answer carries.
	const pr = (number, state, extra = {}) => ({
		number,
		state,
		isDraft: extra.isDraft === true,
		headRefOid: extra.head ?? "h1",
		reviews: { nodes: extra.reviews ?? [] },
		statusCheckRollup: {
			commit: { oid: extra.commitOid ?? extra.head ?? "h1" },
			contexts: { nodes: extra.contexts ?? [] },
		},
	});
	const review = (id, login, state, body, submittedAt = "2026-11-07T10:00:00Z") => ({
		id,
		author: { login },
		state,
		body,
		submittedAt,
	});
	const checkRun = (name, conclusion, status = "COMPLETED") => ({ __typename: "CheckRun", name, conclusion, status });
	const statusCtx = (context, state) => ({ __typename: "StatusContext", context, state });
	// The table the fake gh serves, keyed by owner/name/number, plus the gone markers.
	const setGhTable = (table) => writeFileSync(ghTable, JSON.stringify(table));
	const setGhRaw = (raw) => writeFileSync(ghRaw, raw);
	const URL9 = "https://github.com/someorg/widget/pull/9";
	const URL11 = "https://github.com/someorg/widget/pull/11";
	const URL12 = "https://github.com/someorg/widget/pull/12";
	const URL13 = "https://github.com/someorg/widget/pull/13";

	const w1Id = "0d1b0001-0000-7000-8000-000000000001";
	const w2Id = "0d1b0002-0000-7000-8000-000000000002";
	const w3Id = "0d1b0003-0000-7000-8000-000000000003";
	const authorId = "0d1b0004-0000-7000-8000-000000000004";
	const w4Id = "0d1b0005-0000-7000-8000-000000000005";
	const autoId = "0d1b0007-0000-7000-8000-000000000007";
	const w1 = spawn(w1Id, "/home/dev/work/w1");
	await w1.fire("session_start");
	check("pr_watch is registered", w1.tools.has("pr_watch"));
	w1.heartbeat();
	await settle(150);
	check(
		"the first session holds the lock that drives the watch poll",
		JSON.parse(readFileSync(lockPath, "utf8")).sessionId === w1Id,
	);
	const noWatchTick = w1.customs.length;
	await tick(w1, [], [w1]);
	check(
		"a tick with nothing watched sends nothing and queries nothing",
		w1.customs.length === noWatchTick && !ghLogText().includes("api graphql"),
	);

	// A session without the pairing gets the refusal, and the tool refuses URLs it cannot validate.
	unlinkSync(join(root, "notify-telegram.json"));
	const noCfgId = "0d1b0006-0000-7000-8000-000000000006";
	const noCfg = spawn(noCfgId, "/home/dev/work/nocfg");
	await noCfg.fire("session_start");
	check("a session without the pairing is told pr_watch needs it", (await prOf(noCfg, {})).isError === true);
	writeConfig();
	check(
		"add refuses a URL that is not a GitHub pull request",
		(await prOf(w1, { action: "add", url: "https://example.com/pull/9" })).isError === true,
	);
	check(
		"add refuses a repository name the file name would not accept",
		(await prOf(w1, { action: "add", url: "https://github.com/.secret/widget/pull/9" })).isError === true,
	);
	setGhTable({ "someorg/.github/2": pr(2, "OPEN") });
	check(
		"add watches a repository whose name starts with a dot",
		!(await prOf(w1, { action: "add", url: "https://github.com/someorg/.github/pull/2" })).isError &&
			existsSync(join(watchesDir, w1Id, "someorg+.github+2.json")),
	);
	await prOf(w1, { action: "remove", url: "https://github.com/someorg/.github/pull/2" });
	check(
		"add refuses pull request zero",
		(await prOf(w1, { action: "add", url: "https://github.com/someorg/widget/pull/0" })).isError === true,
	);

	// add returns the current state and seeds the watch with it, so nothing repeats on the first tick.
	setGhTable({
		"someorg/widget/9": pr(9, "OPEN", {
			reviews: [review("r1", "alice", "COMMENTED", "Looks mostly right.")],
			contexts: [checkRun("ci/build", "FAILURE"), statusCtx("codecov/patch", "SUCCESS")],
		}),
	});
	const added = await prOf(w1, { action: "add", url: URL9 });
	check(
		"add answers with the pull request's current state",
		!added.isError &&
			prText(added).includes("Watching someorg/widget#9") &&
			prText(added).includes("CI red on ci/build") &&
			prText(added).includes("1 review already seen"),
	);
	const addedWatch = watchOf(w1Id, "someorg", "widget", 9);
	check(
		"the watch is written seeded with the state add saw",
		addedWatch.url === URL9 &&
			addedWatch.by === w1Id &&
			addedWatch.seeded === true &&
			addedWatch.head === "h1" &&
			addedWatch.redSent === true &&
			addedWatch.greenSent === false &&
			addedWatch.reviews.join(",") === "r1",
	);
	check(
		"a second add of the same pull request says it is already watched",
		prText(await prOf(w1, { action: "add", url: URL9 })).includes("Already watching"),
	);
	check(
		"list names the watched pull request",
		prText(await prOf(w1, { action: "list" })).includes("someorg/widget/pull/9"),
	);
	const before = w1.customs.length;
	await tick(w1, [w1], [w1]);
	check("the first tick after add fires nothing that add already reported", w1.customs.length === before);

	// A new review and fully green CI on the same head both reach the live watcher.
	setGhTable({
		"someorg/widget/9": pr(9, "OPEN", {
			reviews: [
				review("r1", "alice", "COMMENTED", "Looks mostly right."),
				review("r2", "CodeRabbit", "APPROVED", "LGTM."),
			],
			contexts: [checkRun("ci/build", "SUCCESS")],
		}),
	});
	await tick(w1, [w1], [w1]);
	const news = w1.customs.slice(before);
	check(
		"the new review reaches the watcher with reviewer, verdict and body",
		news.length === 2 &&
			news[0].message.content.includes("review from CodeRabbit") &&
			news[0].message.content.includes("APPROVED") &&
			news[0].message.content.includes("LGTM."),
	);
	check("fully green CI reaches the watcher", news[1].message.content.includes("CI green on its head commit"));
	check(
		"the event is an aside written by no one that wakes the session",
		news[0].options.deliverAs === "aside" && news[0].options.triggerTurn === true,
	);
	const afterReview = w1.customs.length;
	check(
		"the watch remembers the review and the green verdict",
		watchOf(w1Id, "someorg", "widget", 9).reviews.join(",") === "r1,r2" &&
			watchOf(w1Id, "someorg", "widget", 9).greenSent === true,
	);
	await tick(w1, [w1], [w1]);
	check("repeating the same state sends nothing twice", w1.customs.length === afterReview);

	// A second session watches the same pull request, then ends: its events are held and raise its resume card.
	const w2 = spawn(w2Id, "/home/dev/work/w2");
	await w2.fire("session_start");
	w1.heartbeat();
	w2.heartbeat();
	await settle(150);
	check(
		"a call without an action lists what the session watches",
		prText(await prOf(w2, {})).includes("watches no pull requests"),
	);
	setGhTable({
		"someorg/widget/9": pr(9, "OPEN", {
			reviews: [
				review("r1", "alice", "COMMENTED", "Looks mostly right."),
				review("r2", "CodeRabbit", "APPROVED", "LGTM."),
			],
			contexts: [statusCtx("ci", "PENDING")],
		}),
	});
	const w2Added = await prOf(w2, { action: "add", url: URL9 });
	check("a second watcher's add reports CI still running", prText(w2Added).includes("CI still running"));
	await w2.fire("session_shutdown");
	setGhTable({
		"someorg/widget/9": pr(9, "OPEN", {
			reviews: [
				review("r1", "alice", "COMMENTED", "Looks mostly right."),
				review("r2", "CodeRabbit", "APPROVED", "LGTM."),
				review("r3", "bob", "CHANGES_REQUESTED", "Fix the test."),
			],
			contexts: [statusCtx("ci", "PENDING")],
		}),
	});
	const sendsBefore = called("sendMessage").length;
	await tick(w1, [w1], [w1]);
	const w1News = w1.customs.slice(afterReview);
	check(
		"each watcher of the same pull request gets its own review event",
		w1News.length === 1 &&
			w1News[0].message.content.includes("review from bob") &&
			w1News[0].message.content.includes("CHANGES_REQUESTED"),
	);
	check("the ended watcher's review is held for it", pendingFiles(w2Id).length === 1);
	check(
		"the ended watcher's held review raises a resume card",
		cardsFor(w2Id).length === 1 && cardsFor(w2Id)[0].body.text.includes("got a review from bob"),
	);
	check(
		"the only Telegram trace of a live event is the ended session's resume card",
		called("sendMessage").length === sendsBefore + 1,
	);
	setGhTable({ "someorg/widget/9": pr(9, "MERGED") });
	const editsBefore = called("editMessageText").length;
	await tick(w1, [w1], [w1]);
	check("the merge reaches the live watcher", w1.customs.at(-1).message.content.includes("was merged"));
	check("the merge is held for the ended watcher", pendingFiles(w2Id).length === 2);
	check(
		"the merged pull request ends every watch of it",
		!prText(await prOf(w1, { action: "list" })).includes(URL9) &&
			!prText(await prOf(w2, { action: "list" })).includes(URL9),
	);
	check(
		"the second held event edits the open card instead of sending another",
		cardsFor(w2Id).length === 1 &&
			called("editMessageText").length === editsBefore + 1 &&
			called("editMessageText").at(-1).body.text.includes("was merged"),
	);
	// An agent told of the merge records its outcome with the pull request again, which asks for the watch again.
	await w1.tools
		.get("session_graph")
		.execute("g", { action: "status", status: "pushed", pr: URL9 }, undefined, undefined, w1.ctx);
	const mergesSeen = w1.customs.filter((c) => c.message.content.includes("was merged")).length;
	await tick(w1, [w1], [w1]);
	await tick(w1, [w1], [w1]);
	check(
		"a merge already reported is never reported again when the pull request is named again",
		w1.customs.filter((c) => c.message.content.includes("was merged")).length === mergesSeen,
	);
	// The status update gave w1 a graph node, which the later retention checks do not expect.
	rmSync(join(nodesDir, `${w1Id}.json`), { force: true });
	rmSync(join(root, "notify-telegram/graph/pr", `${w1Id}.json`), { force: true });

	// A new pull request's CI: red then green on one head, red again on the next, nothing for a push that is pending.
	const w3 = spawn(w3Id, "/home/dev/work/w3");
	await w3.fire("session_start");
	w1.heartbeat();
	w3.heartbeat();
	await settle(150);
	setGhTable({
		"someorg/widget/11": pr(11, "OPEN", {
			reviews: [review("r9a", "carol", "COMMENTED", "First pass."), review("r9b", "dave", "COMMENTED", "Second pass.")],
			contexts: [checkRun("ci/lint", "FAILURE")],
		}),
	});
	const c1 = await prOf(w1, { action: "add", url: URL11 });
	check(
		"add of a draft-free red pull request reports both reviews",
		prText(c1).includes("open, CI red on ci/lint") && prText(c1).includes("2 reviews already seen"),
	);
	// w3's own single pull request, queried with its own alias.
	setGhTable({
		"someorg/widget/12": pr(12, "OPEN", {
			head: "m1",
			isDraft: true,
			reviews: [review("r5", "carol", "COMMENTED", "Watch this one.")],
			contexts: [checkRun("ci", "SUCCESS")],
		}),
	});
	const w3Add = await prOf(w3, { action: "add", url: URL12 });
	check(
		"add of a draft reports the draft state and green CI",
		prText(w3Add).includes("open (draft)") && prText(w3Add).includes("CI green"),
	);
	// The lock moves to w3, and the new holder compares with the stored state on disk.
	// The world still matches the stored state, so the move itself reports nothing.
	setGhTable({
		"someorg/widget/11": pr(11, "OPEN", {
			reviews: [review("r9a", "carol", "COMMENTED", "First pass."), review("r9b", "dave", "COMMENTED", "Second pass.")],
			contexts: [checkRun("ci/lint", "FAILURE")],
		}),
		"someorg/widget/12": pr(12, "OPEN", {
			head: "m1",
			isDraft: true,
			reviews: [review("r5", "carol", "COMMENTED", "Watch this one.")],
			contexts: [checkRun("ci", "SUCCESS")],
		}),
	});
	rmSync(lockPath, { force: true });
	await tick(w3, [w1, w3], [w1]);
	check("the lock moved to the third session", JSON.parse(readFileSync(lockPath, "utf8")).sessionId === w3Id);
	setGhTable({
		"someorg/widget/11": pr(11, "OPEN", {
			head: "k2",
			reviews: [review("r9a", "carol", "COMMENTED", "First pass."), review("r9b", "dave", "COMMENTED", "Second pass.")],
			contexts: [checkRun("ci/test", "FAILURE")],
		}),
		"someorg/widget/12": pr(12, "OPEN", {
			head: "m1",
			reviews: [review("r5", "carol", "COMMENTED", "Watch this one.")],
			contexts: [checkRun("ci", "SUCCESS")],
		}),
	});
	const c2 = w1.customs.length;
	await tick(w3, [w1, w3], [w1]);
	check(
		"a new head may fire red again, from the new lock holder",
		w1.customs.length === c2 + 1 &&
			w1.customs.at(-1).message.content.includes("CI red on its head commit") &&
			w1.customs.at(-1).message.content.includes("Failing checks: ci/test"),
	);
	check(
		"the stored head moved with the verdict",
		watchOf(w1Id, "someorg", "widget", 11).head === "k2" && watchOf(w1Id, "someorg", "widget", 11).redSent === true,
	);
	setGhTable({
		"someorg/widget/11": pr(11, "OPEN", {
			head: "k2",
			reviews: [review("r9a", "carol", "COMMENTED", "First pass."), review("r9b", "dave", "COMMENTED", "Second pass.")],
			contexts: [checkRun("ci/test", "SUCCESS")],
		}),
		"someorg/widget/12": pr(12, "OPEN", {
			head: "m1",
			reviews: [review("r5", "carol", "COMMENTED", "Watch this one.")],
			contexts: [checkRun("ci", "SUCCESS")],
		}),
	});
	await tick(w3, [w1, w3], [w1]);
	const greenAt = w1.customs.findIndex((c, i) => i > c2 && c.message.content.includes("CI green"));
	check(
		"green after red on the same head is sent in order",
		greenAt === c2 + 1 && w1.customs[greenAt].message.content.includes("CI green on its head commit"),
	);
	setGhTable({
		"someorg/widget/11": pr(11, "OPEN", {
			head: "k3",
			reviews: [review("r9a", "carol", "COMMENTED", "First pass."), review("r9b", "dave", "COMMENTED", "Second pass.")],
			contexts: [],
		}),
		"someorg/widget/12": pr(12, "OPEN", {
			head: "m1",
			reviews: [review("r5", "carol", "COMMENTED", "Watch this one.")],
			contexts: [checkRun("ci", "SUCCESS")],
		}),
	});
	const c3 = w1.customs.length;
	await tick(w3, [w1, w3], [w1]);
	check(
		"a push whose checks are pending sends nothing for the push itself",
		w1.customs.length === c3 &&
			watchOf(w1Id, "someorg", "widget", 11).head === "k3" &&
			watchOf(w1Id, "someorg", "widget", 11).redSent === false,
	);
	setGhTable({
		"someorg/widget/11": pr(11, "OPEN", {
			head: "k3",
			reviews: [review("r9a", "carol", "COMMENTED", "First pass."), review("r9b", "dave", "COMMENTED", "Second pass.")],
			contexts: [checkRun("ci/test", "SUCCESS")],
		}),
		"someorg/widget/12": pr(12, "OPEN", {
			head: "m1",
			reviews: [review("r5", "carol", "COMMENTED", "Watch this one."), review("r6", "dave", "APPROVED", "Fine now.")],
			contexts: [checkRun("ci", "SUCCESS")],
		}),
	});
	const c4 = w1.customs.length;
	const c4w3 = w3.customs.length;
	await tick(w3, [w1, w3], [w1, w3]);
	check(
		"green fires again on the new head",
		w1.customs.length === c4 + 1 && w1.customs.at(-1).message.content.includes("CI green"),
	);
	check(
		"w3's own new review reaches w3 written by no one",
		w3.customs.length === c4w3 + 1 &&
			w3.customs.at(-1).message.content.includes("review from dave") &&
			w3.customs.at(-1).message.content.includes("Fine now."),
	);

	// An errored status counts as red, an expected one keeps the verdict open, and a check that has
	// not completed is not a verdict. Checks belonging to a head the pull request no longer has are
	// not the head's verdict.
	setGhTable({
		"someorg/widget/11": pr(11, "OPEN", {
			head: "k3",
			reviews: [review("r9a", "carol", "COMMENTED", "First pass."), review("r9b", "dave", "COMMENTED", "Second pass.")],
			contexts: [checkRun("ci/test", "SUCCESS"), statusCtx("deploy", "ERROR")],
		}),
		"someorg/widget/12": pr(12, "OPEN", {
			head: "m1",
			reviews: [review("r5", "carol", "COMMENTED", "Watch this one."), review("r6", "dave", "APPROVED", "Fine now.")],
			contexts: [checkRun("ci", "SUCCESS")],
		}),
	});
	await tick(w3, [w1, w3], [w1]);
	check(
		"an errored status context counts as red",
		w1.customs.at(-1).message.content.includes("CI red on its head commit") &&
			w1.customs.at(-1).message.content.includes("Failing checks: deploy"),
	);
	const redState = w1.customs.length;
	setGhTable({
		"someorg/widget/11": pr(11, "OPEN", {
			head: "k3",
			reviews: [review("r9a", "carol", "COMMENTED", "First pass."), review("r9b", "dave", "COMMENTED", "Second pass.")],
			contexts: [
				checkRun("ci/test", "SUCCESS"),
				statusCtx("deploy", "EXPECTED"),
				checkRun("flake", "SUCCESS", "IN_PROGRESS"),
			],
		}),
		"someorg/widget/12": pr(12, "OPEN", {
			head: "m1",
			reviews: [review("r5", "carol", "COMMENTED", "Watch this one."), review("r6", "dave", "APPROVED", "Fine now.")],
			contexts: [checkRun("ci", "SUCCESS")],
		}),
	});
	await tick(w3, [w1, w3], [w1]);
	check("an expected status and a check that has not completed keep the verdict open", w1.customs.length === redState);
	setGhTable({
		"someorg/widget/11": pr(11, "OPEN", {
			head: "k4",
			commitOid: "k3",
			reviews: [review("r9a", "carol", "COMMENTED", "First pass."), review("r9b", "dave", "COMMENTED", "Second pass.")],
			contexts: [checkRun("ci/test", "SUCCESS")],
		}),
		"someorg/widget/12": pr(12, "OPEN", {
			head: "m1",
			reviews: [review("r5", "carol", "COMMENTED", "Watch this one."), review("r6", "dave", "APPROVED", "Fine now.")],
			contexts: [checkRun("ci", "SUCCESS")],
		}),
	});
	await tick(w3, [w1, w3], [w1]);
	check(
		"checks on a head the pull request no longer has send nothing",
		w1.customs.length === redState &&
			watchOf(w1Id, "someorg", "widget", 11).head === "k4" &&
			watchOf(w1Id, "someorg", "widget", 11).greenSent === false,
	);
	// Back to the state the gone phase expects: k3, green, the two seen reviews.
	setGhTable({
		"someorg/widget/11": pr(11, "OPEN", {
			head: "k3",
			reviews: [review("r9a", "carol", "COMMENTED", "First pass."), review("r9b", "dave", "COMMENTED", "Second pass.")],
			contexts: [checkRun("ci/test", "SUCCESS")],
		}),
		"someorg/widget/12": pr(12, "OPEN", {
			head: "m1",
			reviews: [review("r5", "carol", "COMMENTED", "Watch this one."), review("r6", "dave", "APPROVED", "Fine now.")],
			contexts: [checkRun("ci", "SUCCESS")],
		}),
	});
	await tick(w3, [w1, w3], [w1]);

	// A pull request that disappears is reported once, and its watch ends.
	setGhTable({
		"someorg/widget/13": pr(13, "OPEN", { head: "n1", contexts: [checkRun("ci", "SUCCESS")] }),
	});
	const d1 = await prOf(w1, { action: "add", url: URL13 });
	check(
		"add of an open pull request watches it",
		!d1.isError && existsSync(join(watchesDir, w1Id, "someorg+widget+13.json")),
	);
	setGhTable({
		"someorg/widget/11": pr(11, "OPEN", {
			head: "k3",
			reviews: [review("r9a", "carol", "COMMENTED", "First pass."), review("r9b", "dave", "COMMENTED", "Second pass.")],
			contexts: [checkRun("ci/test", "SUCCESS")],
		}),
		"someorg/widget/12": pr(12, "OPEN", {
			head: "m1",
			reviews: [review("r5", "carol", "COMMENTED", "Watch this one."), review("r6", "dave", "APPROVED", "Fine now.")],
			contexts: [checkRun("ci", "SUCCESS")],
		}),
		"someorg/widget/13": { __gone: "pr" },
	});
	const d2 = w1.customs.length;
	await tick(w3, [w1, w3], [w1]);
	check(
		"a pull request GitHub no longer finds is reported once",
		w1.customs.length === d2 + 1 && w1.customs.at(-1).message.content.includes("is gone from GitHub"),
	);
	const w1Listed = prText(await prOf(w1, { action: "list" }));
	check(
		"the gone pull request ends its watch while the others keep theirs",
		!w1Listed.includes(URL13) && w1Listed.includes(URL11) && prText(await prOf(w3, { action: "list" })).includes(URL12),
	);

	// A failed query keeps every stored state, and the next tick retries.
	const elevenBefore = watchOf(w1Id, "someorg", "widget", 11);
	process.env.WGH_FAIL = "1";
	const e1 = w1.customs.length;
	await tick(w3, [w1, w3], [w1]);
	check(
		"a failed query sends nothing and keeps every stored state",
		w1.customs.length === e1 && JSON.stringify(watchOf(w1Id, "someorg", "widget", 11)) === JSON.stringify(elevenBefore),
	);
	delete process.env.WGH_FAIL;
	setGhTable({
		"someorg/widget/11": { __error: "Something else broke." },
		"someorg/widget/12": pr(12, "OPEN", {
			head: "m1",
			reviews: [review("r5", "carol", "COMMENTED", "Watch this one."), review("r6", "dave", "APPROVED", "Fine now.")],
			contexts: [checkRun("ci", "SUCCESS")],
		}),
	});
	await tick(w3, [w1, w3], [w1]);
	check(
		"an error that is not a disappearance keeps that pull request's state",
		w1.customs.length === e1 && JSON.stringify(watchOf(w1Id, "someorg", "widget", 11)) === JSON.stringify(elevenBefore),
	);
	setGhTable({
		"someorg/widget/11": pr(11, "OPEN", {
			head: "k3",
			reviews: [
				review("r9a", "carol", "COMMENTED", "First pass."),
				review("r9b", "dave", "COMMENTED", "Second pass."),
				review("r11", "erin", "COMMENTED", "Retry worked."),
			],
			contexts: [checkRun("ci/test", "SUCCESS")],
		}),
		"someorg/widget/12": pr(12, "OPEN", {
			head: "m1",
			reviews: [review("r5", "carol", "COMMENTED", "Watch this one."), review("r6", "dave", "APPROVED", "Fine now.")],
			contexts: [checkRun("ci", "SUCCESS")],
		}),
	});
	await tick(w3, [w1, w3], [w1]);
	check(
		"the next tick retries and delivers the new review",
		w1.customs.length === e1 + 1 && w1.customs.at(-1).message.content.includes("review from erin"),
	);

	// A tick while the previous poll still waits on GitHub starts no second query.
	const queriesBefore = ghLogText()
		.split("\n")
		.filter((line) => line.startsWith("api graphql")).length;
	process.env.WGH_SLOW = "1";
	jump(61_000);
	w3.heartbeat();
	await settle(300);
	jump(61_000);
	w3.heartbeat();
	await settle(2_500);
	delete process.env.WGH_SLOW;
	await ghQuiet();
	check(
		"a tick during a running poll starts no second query",
		ghLogText()
			.split("\n")
			.filter((line) => line.startsWith("api graphql")).length ===
			queriesBefore + 1,
	);

	// A watch changed while the poll waits on GitHub keeps the change, and the poll's stale view sends nothing.
	const reviewedEleven = pr(11, "OPEN", {
		reviews: [
			review("r9a", "carol", "COMMENTED", "First pass."),
			review("r9b", "dave", "COMMENTED", "Second pass."),
			review("r9c", "erin", "COMMENTED", "A late look."),
		],
		contexts: [checkRun("ci/lint", "FAILURE")],
	});
	const tableSaved = readFileSync(ghTable, "utf8");
	setGhTable({ "someorg/widget/11": reviewedEleven, "someorg/widget/12": pr(12, "OPEN", { head: "m1" }) });
	await ghQuiet();
	const beforeRemoval = w1.customs.length;
	const elevenFile = join(watchesDir, w1Id, "someorg+widget+11.json");
	const elevenSaved = readFileSync(elevenFile, "utf8");
	process.env.WGH_SLOW = "1";
	jump(61_000);
	w3.heartbeat();
	await settle(300);
	await prOf(w1, { action: "remove", url: URL11 });
	await settle(2_500);
	delete process.env.WGH_SLOW;
	await ghQuiet();
	await w1.pump(200);
	check(
		"a watch removed while the poll waits on GitHub stays removed and reports nothing",
		w1.customs.length === beforeRemoval && !prText(await prOf(w1, { action: "list" })).includes(URL11),
	);
	// The checks below expect w1 to watch #11 as before.
	writeFileSync(elevenFile, elevenSaved);

	// A poller that lost the lock while it waited on GitHub leaves the news to the new holder.
	const twelveBefore = JSON.stringify(watchOf(w3Id, "someorg", "widget", 12));
	setGhTable({
		"someorg/widget/12": pr(12, "OPEN", { head: "m1", reviews: [review("r12", "frank", "COMMENTED", "Late.")] }),
	});
	const heldLock = readFileSync(lockPath, "utf8");
	process.env.WGH_SLOW = "1";
	jump(61_000);
	w3.heartbeat();
	await settle(300);
	writeFileSync(
		lockPath,
		JSON.stringify({ ...JSON.parse(heldLock), instance: "another-poller", heartbeat: Date.now() }),
	);
	await settle(2_500);
	delete process.env.WGH_SLOW;
	await ghQuiet();
	check(
		"a poller that lost the lock mid-query writes no watch state and sends nothing",
		JSON.stringify(watchOf(w3Id, "someorg", "widget", 12)) === twelveBefore &&
			pendingFiles(w3Id).length === 0 &&
			!w3.customs.some((c) => c.message.content.includes("review from frank")),
	);
	writeFileSync(lockPath, JSON.stringify({ ...JSON.parse(heldLock), heartbeat: Date.now() }));
	writeFileSync(ghTable, tableSaved);

	// Terminal pull requests are reported by add without a watch, and so is a repository the token cannot read.
	setGhTable({ "someorg/widget/14": pr(14, "MERGED") });
	check(
		"add of an already merged pull request writes no watch",
		prText(await prOf(w1, { action: "add", url: "https://github.com/someorg/widget/pull/14" })).includes(
			"already merged",
		) && !existsSync(join(watchesDir, w1Id, "someorg+widget+14.json")),
	);
	setGhTable({ "someorg/widget/15": pr(15, "CLOSED") });
	check(
		"add of an already closed pull request writes no watch",
		prText(await prOf(w1, { action: "add", url: "https://github.com/someorg/widget/pull/15" })).includes(
			"already closed",
		) && !existsSync(join(watchesDir, w1Id, "someorg+widget+15.json")),
	);
	setGhTable({ "ghostorg/ghost/1": { __gone: "repo" } });
	check(
		"add of a pull request GitHub cannot find is refused with the error",
		(await prOf(w1, { action: "add", url: "https://github.com/ghostorg/ghost/pull/1" })).isError === true,
	);
	check(
		"remove stops a watch and only the caller's goes",
		prText(await prOf(w3, { action: "remove", url: URL12 })).includes("Stopped watching") &&
			!existsSync(join(watchesDir, w3Id, "someorg+widget+12.json")),
	);
	check(
		"remove of an unwatched pull request says so",
		(await prOf(w3, { action: "remove", url: URL12 })).isError === true,
	);
	check("a bogus action is refused", (await prOf(w1, { action: "peel", url: URL9 })).isError === true);
	check(
		"add without a URL asks for one",
		prText(await prOf(w1, { action: "add" })).includes("Pass the GitHub pull request URL"),
	);

	// Two reviews in two ticks for an ended session are held beside each other, and both name the card.
	const w5Id = "0d1b0008-0000-7000-8000-000000000008";
	const w5 = spawn(w5Id, "/home/dev/work/w5");
	await w5.fire("session_start");
	w3.heartbeat();
	w5.heartbeat();
	await settle(150);
	setGhTable({
		"someorg/widget/16": pr(16, "OPEN", { head: "z1", contexts: [checkRun("ci", "SUCCESS")] }),
	});
	check(
		"add of an open pull request the session keeps watches it",
		!(await prOf(w5, { action: "add", url: "https://github.com/someorg/widget/pull/16" })).isError &&
			existsSync(join(watchesDir, w5Id, "someorg+widget+16.json")),
	);
	await w5.fire("session_shutdown");
	setGhTable({
		"someorg/widget/11": pr(11, "OPEN", {
			head: "k3",
			reviews: [review("r9a", "carol", "COMMENTED", "First pass."), review("r9b", "dave", "COMMENTED", "Second pass.")],
			contexts: [checkRun("ci/test", "SUCCESS")],
		}),
		"someorg/widget/16": pr(16, "OPEN", {
			head: "z1",
			reviews: [review("ra", "gwen", "COMMENTED", "First hold.")],
			contexts: [checkRun("ci", "SUCCESS")],
		}),
	});
	await tick(w3, [w3], [w3]);
	check("the first review of an ended watcher is held", pendingFiles(w5Id).length === 1);
	setGhTable({
		"someorg/widget/11": pr(11, "OPEN", {
			head: "k3",
			reviews: [review("r9a", "carol", "COMMENTED", "First pass."), review("r9b", "dave", "COMMENTED", "Second pass.")],
			contexts: [checkRun("ci/test", "SUCCESS")],
		}),
		"someorg/widget/16": pr(16, "OPEN", {
			head: "z1",
			reviews: [review("ra", "gwen", "COMMENTED", "First hold."), review("rb", "hugh", "APPROVED", "Second hold.")],
			contexts: [checkRun("ci", "SUCCESS")],
		}),
	});
	await tick(w3, [w3], [w3]);
	check("a second review in a later tick is held beside the first", pendingFiles(w5Id).length === 2);
	const heldCardText = () =>
		called("editMessageText")
			.map((c) => String(c.body.text ?? ""))
			.findLast((text) => text.includes("got a review from gwen")) ?? "";
	await settle(300);
	check(
		"the resume card is sent once and edited to name both held reviews",
		cardsFor(w5Id).length === 1 && heldCardText().includes("got a review from hugh"),
		heldCardText(),
	);
	// CI turning red or green is news only for a live session, so an ended one holds nothing for it.
	setGhTable({
		"someorg/widget/11": pr(11, "OPEN", {
			head: "k3",
			reviews: [review("r9a", "carol", "COMMENTED", "First pass."), review("r9b", "dave", "COMMENTED", "Second pass.")],
			contexts: [checkRun("ci/test", "SUCCESS")],
		}),
		"someorg/widget/16": pr(16, "OPEN", {
			head: "z2",
			reviews: [review("ra", "gwen", "COMMENTED", "First hold."), review("rb", "hugh", "APPROVED", "Second hold.")],
			contexts: [checkRun("ci", "FAILURE")],
		}),
	});
	const editsBeforeRed = called("editMessageText").length;
	await tick(w3, [w3], [w3]);
	await settle(300);
	check(
		"an ended session holds nothing when its pull request's CI turns red",
		pendingFiles(w5Id).length === 2 &&
			called("editMessageText").length === editsBeforeRed &&
			watchOf(w5Id, "someorg", "widget", 16).head === "z2" &&
			watchOf(w5Id, "someorg", "widget", 16).redSent === true,
	);

	// A pr pending item the drain cannot validate is discarded.
	const pdir = join(root, "notify-telegram/graph/pending", w3Id);
	mkdirSync(pdir, { recursive: true });
	writeFileSync(
		join(pdir, "p-malformed-1.json"),
		JSON.stringify({
			kind: "pr",
			at: Date.now(),
			owner: "bad owner",
			name: "r",
			number: 1,
			event: "review",
			reviewer: "x",
			verdict: "y",
			body: "z",
		}),
	);
	writeFileSync(
		join(pdir, "p-malformed-2.json"),
		JSON.stringify({
			kind: "pr",
			at: Date.now(),
			owner: "o",
			name: "r",
			number: 1,
			event: "review",
			verdict: "y",
			body: "z",
		}),
	);
	writeFileSync(
		join(pdir, "p-malformed-3.json"),
		JSON.stringify({ kind: "pr", at: Date.now(), owner: "o", name: "r", number: 1, event: "ci-red", checks: [] }),
	);
	writeFileSync(
		join(pdir, "p-malformed-4.json"),
		JSON.stringify({ kind: "pr", at: Date.now(), owner: "o", name: "r", number: 1, event: "peeled" }),
	);
	const malformedBefore = w3.customs.length;
	w3.heartbeat();
	await w3.pump(200);
	check(
		"a malformed pr pending item is discarded by the drain",
		w3.customs.length === malformedBefore &&
			!existsSync(join(pdir, "p-malformed-1.json")) &&
			!existsSync(join(pdir, "p-malformed-4.json")),
	);

	// A validation error is a whole-query failure, so every stored state is kept.
	process.env.WGH_RAW = "1";
	setGhRaw(
		JSON.stringify({
			errors: [
				{
					type: "Validation",
					path: ["query"],
					locations: [{ line: 1, column: 1 }],
					message: "Field 'pullRequest' does not exist on type 'Repository'.",
				},
			],
		}),
	);
	const validationBefore = w1.customs.length;
	const elevenAtValidation = JSON.stringify(watchOf(w1Id, "someorg", "widget", 11));
	await tick(w3, [w1, w3], [w1]);
	delete process.env.WGH_RAW;
	check(
		"a validation error sends nothing and keeps every stored state",
		w1.customs.length === validationBefore &&
			JSON.stringify(watchOf(w1Id, "someorg", "widget", 11)) === elevenAtValidation,
	);

	// A repository GitHub no longer resolves is reported as gone, and its watch ends.
	const w6Id = "0d1b0009-0000-7000-8000-000000000009";
	const w6 = spawn(w6Id, "/home/dev/work/w6");
	await w6.fire("session_start");
	w3.heartbeat();
	w6.heartbeat();
	await settle(150);
	mkdirSync(join(watchesDir, w6Id), { recursive: true });
	writeFileSync(
		join(watchesDir, w6Id, "someorg+ghost+1.json"),
		JSON.stringify({
			url: "https://github.com/someorg/ghost/pull/1",
			owner: "someorg",
			name: "ghost",
			number: 1,
			by: w6Id,
			at: Date.now(),
			seeded: true,
			head: "h1",
			redSent: false,
			greenSent: false,
			reviews: [],
		}),
	);
	setGhTable({
		"someorg/ghost/1": { __gone: "repo" },
		"someorg/widget/11": pr(11, "OPEN", {
			head: "k3",
			reviews: [review("r9a", "carol", "COMMENTED", "First pass."), review("r9b", "dave", "COMMENTED", "Second pass.")],
			contexts: [checkRun("ci/test", "SUCCESS")],
		}),
		"someorg/widget/16": pr(16, "OPEN", {
			head: "z1",
			reviews: [review("ra", "gwen", "COMMENTED", "First hold."), review("rb", "hugh", "APPROVED", "Second hold.")],
			contexts: [checkRun("ci", "SUCCESS")],
		}),
	});
	const ghostBefore = w6.customs.length;
	await tick(w3, [w3, w6], [w6]);
	check(
		"a repository GitHub no longer resolves is reported as gone and ends the watch",
		w6.customs.length === ghostBefore + 1 &&
			w6.customs.at(-1).message.content.includes("is gone from GitHub") &&
			!prText(await prOf(w6, { action: "list" })).includes("someorg/ghost/pull/1"),
	);

	// add with no readable GitHub output is refused.
	process.env.WGH_FAIL = "1";
	check(
		"add with no readable GitHub output is refused",
		(await prOf(w1, { action: "add", url: "https://github.com/someorg/widget/pull/18" })).isError === true,
	);
	delete process.env.WGH_FAIL;
	process.env.WGH_RAW = "1";
	setGhRaw("not json");
	const silent = await prOf(w1, { action: "add", url: "https://github.com/someorg/widget/pull/18" });
	check(
		"add whose GitHub answer is unreadable and silent says there was no output",
		silent.isError === true && prText(silent).includes("no output"),
	);
	delete process.env.WGH_RAW;

	// The session's own pull request is watched without asking, from its node and from the poller's lookup.
	const author = spawn(authorId, "/home/dev/work/notes");
	await author.fire("session_start");
	w3.heartbeat();
	author.heartbeat();
	await settle(150);
	await author.tools
		.get("session_graph")
		.execute(
			"g",
			{ action: "status", status: "waiting", pr: "https://github.com/someorg/notes/pull/0" },
			undefined,
			undefined,
			author.ctx,
		);
	check(
		"a pull request number GitHub never hands out gets no watch",
		!existsSync(join(watchesDir, authorId, "someorg+notes+0.json")),
	);
	await author.tools
		.get("session_graph")
		.execute(
			"g",
			{ action: "status", status: "waiting", pr: "https://github.com/someorg/notes/pull/3" },
			undefined,
			undefined,
			author.ctx,
		);
	check(
		"a session that names its pull request is watched automatically",
		existsSync(join(watchesDir, authorId, "someorg+notes+3.json")),
	);
	check(
		"the automatic watch is unseeded until the first poll",
		watchOf(authorId, "someorg", "notes", 3).seeded === false,
	);
	writeFileSync(
		join(nodesDir, `${autoId}.json`),
		JSON.stringify({
			session: autoId,
			label: "widget fix",
			emoji: "",
			tag: "auto",
			cwd: "/home/dev/widget",
			repo: "someorg/widget",
			branch: "LucaCappelletti94:upstream/fix-y",
			status: "working",
			note: "",
			edges: [],
			createdAt: Date.now(),
			updatedAt: Date.now(),
			launch: { argv: [], tmuxSession: "work", tmuxWindow: null },
		}),
	);
	// A node no omp session stands behind, such as an imported worktree, gets no watch for its pull request.
	writeFileSync(
		join(nodesDir, "import-notes-fix.json"),
		JSON.stringify({
			session: "import-notes-fix",
			label: "imported notes fix",
			emoji: "",
			tag: "",
			cwd: "/home/dev/notes.upstreams/fix",
			status: "pushed",
			note: "",
			pr: "https://github.com/someorg/notes/pull/3",
			edges: [],
			createdAt: Date.now(),
			updatedAt: Date.now(),
		}),
	);
	process.env.WGH_PR_LIST = JSON.stringify([
		{ number: 7, url: "https://github.com/someorg/widget/pull/7", headRepositoryOwner: { login: "LucaCappelletti94" } },
	]);
	setGhTable({
		"someorg/notes/3": pr(3, "OPEN", { head: "g1", contexts: [checkRun("ci", "SUCCESS")] }),
		"someorg/widget/7": pr(7, "OPEN", {
			head: "p1",
			reviews: [review("r7", "eve", "COMMENTED", "On the branch PR.")],
			contexts: [checkRun("ci", "SUCCESS")],
		}),
		"someorg/widget/11": pr(11, "OPEN", {
			head: "k3",
			reviews: [
				review("r9a", "carol", "COMMENTED", "First pass."),
				review("r9b", "dave", "COMMENTED", "Second pass."),
				review("r11", "erin", "COMMENTED", "Retry worked."),
			],
			contexts: [checkRun("ci/test", "SUCCESS")],
		}),
	});
	jump(10 * 60_000 + 1_000);
	w3.heartbeat();
	author.heartbeat();
	await ghQuiet();
	check(
		"the poller looks the pull request up by the branch's head",
		ghLogText().includes("pr list --repo someorg/widget --head upstream/fix-y"),
	);
	check(
		"the poller watches the pull request it finds for a branch",
		existsSync(join(watchesDir, autoId, "someorg+widget+7.json")),
	);
	check("an imported node's pull request gets no watch", !existsSync(join(watchesDir, "import-notes-fix")));
	const seedTable = {
		"someorg/notes/3": pr(3, "OPEN", { head: "g1", contexts: [checkRun("ci", "SUCCESS")] }),
		"someorg/widget/7": pr(7, "OPEN", {
			head: "p1",
			reviews: [review("r7", "eve", "COMMENTED", "On the branch PR.")],
			contexts: [checkRun("ci", "SUCCESS")],
		}),
		"someorg/widget/11": pr(11, "OPEN", {
			head: "k3",
			reviews: [
				review("r9a", "carol", "COMMENTED", "First pass."),
				review("r9b", "dave", "COMMENTED", "Second pass."),
				review("r11", "erin", "COMMENTED", "Retry worked."),
			],
			contexts: [checkRun("ci/test", "SUCCESS")],
		}),
	};
	setGhTable(seedTable);
	await tick(w3, [w3, author], [w3, author]);
	check(
		"the found pull request's first poll seeds without an event",
		watchOf(autoId, "someorg", "widget", 7).seeded === true && watchOf(authorId, "someorg", "notes", 3).seeded === true,
	);
	check(
		"the seeded pull requests fire nothing for sessions that already know their state",
		pendingFiles(autoId).length === 0 && cardsFor(autoId).length === 0,
	);
	const r8Table = JSON.parse(JSON.stringify(seedTable));
	r8Table["someorg/widget/7"].reviews.nodes.push(
		review("r8", "frank", "CHANGES_REQUESTED", "Rename the helper.", "2026-11-07T12:00:00Z"),
	);
	setGhTable(r8Table);
	await tick(w3, [w3, author], [w3, author]);
	check(
		"a review on an automatically watched pull request is held for the ended session",
		pendingFiles(autoId).length === 1,
	);
	check(
		"its resume card names the review",
		cardsFor(autoId).length === 1 && cardsFor(autoId)[0].body.text.includes("got a review from frank"),
	);

	// A watch outlives its session for the graph's year, and malformed watch files are discarded.
	const w4 = spawn(w4Id, "/home/dev/work/w4");
	await w4.fire("session_start");
	w3.heartbeat();
	w4.heartbeat();
	await settle(150);
	setGhTable({ "someorg/notes/4": pr(4, "OPEN", { head: "q1", contexts: [checkRun("ci", "SUCCESS")] }) });
	await prOf(w4, { action: "add", url: "https://github.com/someorg/notes/pull/4" });
	await w4.fire("session_shutdown");
	await author.fire("session_shutdown");
	const w1w = join(watchesDir, w1Id);
	const bad = [
		"null",
		"42",
		JSON.stringify({}),
		JSON.stringify({ owner: 3, name: "r" }),
		JSON.stringify({ owner: "bad owner", name: "r" }),
		JSON.stringify({ owner: "o", name: "x y" }),
		JSON.stringify({ owner: "o", name: "r", number: "9" }),
		JSON.stringify({
			owner: "o",
			name: "r",
			number: 0,
			url: "u",
			by: w1Id,
			at: 1,
			seeded: false,
			head: null,
			redSent: false,
			greenSent: false,
			reviews: [],
		}),
		JSON.stringify({
			owner: "o",
			name: "r",
			number: 9,
			by: w1Id,
			at: 1,
			seeded: false,
			head: null,
			redSent: false,
			greenSent: false,
			reviews: [],
		}),
		JSON.stringify({
			owner: "o",
			name: "r",
			number: 9,
			url: "u",
			by: "!!",
			at: 1,
			seeded: false,
			head: null,
			redSent: false,
			greenSent: false,
			reviews: [],
		}),
		JSON.stringify({
			owner: "o",
			name: "r",
			number: 9,
			url: "u",
			by: w1Id,
			seeded: false,
			head: null,
			redSent: false,
			greenSent: false,
			reviews: [],
		}),
		JSON.stringify({
			owner: "o",
			name: "r",
			number: 9,
			url: "u",
			by: w1Id,
			at: 1,
			head: null,
			redSent: false,
			greenSent: false,
			reviews: [],
		}),
		JSON.stringify({
			owner: "o",
			name: "r",
			number: 9,
			url: "u",
			by: w1Id,
			at: 1,
			seeded: false,
			head: 42,
			redSent: false,
			greenSent: false,
			reviews: [],
		}),
		JSON.stringify({
			owner: "o",
			name: "r",
			number: 9,
			url: "u",
			by: w1Id,
			at: 1,
			seeded: false,
			head: null,
			greenSent: false,
			reviews: [],
		}),
		JSON.stringify({
			owner: "o",
			name: "r",
			number: 9,
			url: "u",
			by: w1Id,
			at: 1,
			seeded: false,
			head: null,
			redSent: false,
			reviews: [],
		}),
		JSON.stringify({
			owner: "o",
			name: "r",
			number: 9,
			url: "u",
			by: w1Id,
			at: 1,
			seeded: false,
			head: null,
			redSent: false,
			greenSent: false,
			reviews: "x",
		}),
		JSON.stringify({
			owner: "o",
			name: "r",
			number: 9,
			url: "u",
			by: w1Id,
			at: 1,
			seeded: false,
			head: null,
			redSent: false,
			greenSent: false,
			reviews: [1],
		}),
		JSON.stringify({
			owner: "o",
			name: "r",
			number: 9,
			url: "u",
			by: w1Id,
			at: 1,
			seeded: false,
			ended: "yes",
			head: null,
			redSent: false,
			greenSent: false,
			reviews: [],
		}),
	];
	bad.forEach((content, i) => {
		writeFileSync(join(w1w, `bad-${i}.json`), content);
	});
	check(
		"list skips a malformed watch file",
		prText(await prOf(w1, { action: "list" })).includes("someorg/widget/pull/11") &&
			!prText(await prOf(w1, { action: "list" })).includes("bad-"),
	);
	setGhTable({
		"someorg/notes/3": pr(3, "OPEN", { head: "g1", contexts: [checkRun("ci", "SUCCESS")] }),
		"someorg/notes/4": pr(4, "OPEN", { head: "q1", contexts: [checkRun("ci", "SUCCESS")] }),
		"someorg/notes/5": pr(5, "OPEN", { head: "q5", contexts: [checkRun("ci", "SUCCESS")] }),
		"someorg/widget/7": pr(7, "OPEN", {
			head: "p1",
			reviews: [
				review("r7", "eve", "COMMENTED", "On the branch PR."),
				review("r8", "frank", "CHANGES_REQUESTED", "Rename the helper."),
			],
			contexts: [checkRun("ci", "SUCCESS")],
		}),
		"someorg/widget/11": pr(11, "OPEN", {
			head: "k3",
			reviews: [
				review("r9a", "carol", "COMMENTED", "First pass."),
				review("r9b", "dave", "COMMENTED", "Second pass."),
				review("r11", "erin", "COMMENTED", "Retry worked."),
			],
			contexts: [checkRun("ci/test", "SUCCESS")],
		}),
	});
	jump(366 * 24 * 3_600_000);
	// A fresh watch of the ended w2 with one malformed neighbour, so the year sweep reads both.
	mkdirSync(join(watchesDir, w2Id), { recursive: true });
	writeFileSync(
		join(watchesDir, w2Id, "someorg+notes+5.json"),
		JSON.stringify({
			url: "https://github.com/someorg/notes/pull/5",
			owner: "someorg",
			name: "notes",
			number: 5,
			by: w2Id,
			at: Date.now(),
			seeded: false,
			head: null,
			redSent: false,
			greenSent: false,
			reviews: [],
		}),
	);
	writeFileSync(join(watchesDir, w2Id, "bad-0.json"), "not json");
	// The author's graph presence is fresh through its PR record, so its watch outlives the year.
	writeFileSync(
		join(root, "notify-telegram/graph/pr", `${authorId}.json`),
		JSON.stringify({
			url: "https://github.com/someorg/notes/pull/3",
			number: 3,
			state: "pr-open",
			checkedAt: Date.now(),
			changedAt: Date.now(),
			emitted: [],
		}),
	);
	w3.heartbeat();
	w1.heartbeat();
	await ghQuiet();
	await w3.pump(200);
	await w1.pump(200);
	check(
		"malformed watch files are discarded by the poll",
		readdirSync(w1w).filter((f) => f.startsWith("bad-")).length === 0 &&
			existsSync(join(w1w, "someorg+widget+11.json")),
	);
	check("a live session's watch survives the year", existsSync(join(watchesDir, w1Id, "someorg+widget+11.json")));
	check(
		"a watch whose graph presence is fresh through its PR record survives the year",
		existsSync(join(watchesDir, authorId, "someorg+notes+3.json")),
	);
	check(
		"a year-old watch of an ended session without a fresh record is pruned",
		!existsSync(join(watchesDir, autoId)) && !existsSync(join(watchesDir, w4Id)),
	);
	check(
		"a fresh watch of an ended session survives the year",
		existsSync(join(watchesDir, w2Id, "someorg+notes+5.json")) && !existsSync(join(watchesDir, w2Id, "bad-0.json")),
	);

	for (const s of [w1, w3, w4, w6]) await s.fire("session_shutdown");
	process.env.PATH = savedPath;
	delete process.env.WGH_PR_LIST;
	delete process.env.WGH_FAIL;
}
// ---------------------------------------------------------- pane state for the bar
heading("pane state for the tmux bar");
{
	// The PR watch section walked the clock a year forward; make every record fresh so this
	// section's reaper has no stale material.
	clockSkew = 0;
	writeConfig();
	mkdirSync(sessionsDir, { recursive: true });
	for (const f of readdirSync(sessionsDir)) {
		const id = f.slice(0, -5);
		try {
			writeFileSync(join(sessionsDir, f), JSON.stringify({ ...record(id), heartbeat: Date.now() }));
		} catch {}
	}
	rmSync(join(root, "notify-telegram/poller.lock"), { force: true });
	rmSync(join(root, "notify-telegram/dashboard.lock"), { force: true });
	const crashDirPath = join(root, "notify-telegram/crashed");
	rmSync(crashDirPath, { recursive: true, force: true });
	const bootId = (() => {
		try {
			return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
		} catch {
			return "";
		}
	})();
	// A fake tmux that records every call and keeps each pane's option value in a file, so a
	// clear can be checked against what the pane still reads. Pane %83 refuses to be read.
	const paneBin = join(root, "pane-bin");
	mkdirSync(paneBin, { recursive: true });
	const paneLog = join(root, "pane-tmux.log");
	const paneStateDir = join(root, "pane-state");
	mkdirSync(paneStateDir, { recursive: true });
	const paneFail = join(root, "pane-tmux-fail");
	writeFileSync(paneLog, "");
	writeFileSync(
		join(paneBin, "tmux"),
		`#!/bin/sh
echo "$*" >> ${paneLog}
[ -e ${paneFail} ] && [ "$1" = set-option ] && { echo "set-option refused by test" >&2; exit 1; }
case "$1" in
  set-option)
    P=""; U=0; V=""; shift
    while [ $# -gt 0 ]; do
      case "$1" in
        -t) shift; P="$1" ;;
        -u) U=1 ;;
        -p) ;;
        @*) ;;
        *) V="$1" ;;
      esac
      shift
    done
    if [ "$U" = 1 ]; then rm -f ${paneStateDir}/"$P"; else printf '%s\\n' "$V" > ${paneStateDir}/"$P"; fi
    ;;
  display-message)
    P=""; F=""; shift
    while [ $# -gt 0 ]; do
      case "$1" in
        -t) shift; P="$1" ;;
        *) F="$1" ;;
      esac
      shift
    done
    case "$F" in
      *omp_state*)
        [ -n "$P" ] || exit 1
        [ "$P" = "%83" ] && exit 1
        [ -f ${paneStateDir}/"$P" ] && cat ${paneStateDir}/"$P"
        ;;
      *) printf 'work\\t3\\n' ;;
    esac
    ;;
  *) exit 0 ;;
esac
`,
		{ mode: 0o755 },
	);
	writeFileSync(join(paneBin, "gh"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
	const paneSavedPath = process.env.PATH;
	process.env.PATH = `${paneBin}:${paneSavedPath}`;
	process.env.TMUX = "/tmp/fake-tmux,1,0";
	const paneLogText = () => (existsSync(paneLog) ? readFileSync(paneLog, "utf8") : "");
	const paneLogReset = () => writeFileSync(paneLog, "");
	const paneValue = (pane) =>
		existsSync(join(paneStateDir, pane)) ? readFileSync(join(paneStateDir, pane), "utf8").trim() : "";

	process.env.TMUX_PANE = "%78";
	const psId = "0c2c0002-0000-7000-8000-000000000002";
	const ps = spawn(psId, "/home/dev/work/panestate");
	let tail = "";
	ps.ctx.sessionManager.getBranch = () => [
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "do the thing" }] } },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: tail }] } },
	];
	const notify = (name, params) => ps.tools.get("notify_status").execute(name, params, undefined, undefined, ps.ctx);
	const freshTurn = async () => {
		await ps.fire("input");
		await settle(50);
		paneLogReset();
	};
	const stopTurn = async () => {
		await ps.fire("session_stop");
		await settle(150);
	};
	const gtId = "0c2c000a-0000-7000-8000-00000000000a";
	const fakeId = "0c2c9999-9999-9999-9999-999999999999";
	const gtNode = (status) =>
		writeFileSync(
			join(root, "notify-telegram/graph/nodes", `${gtId}.json`),
			JSON.stringify({
				session: gtId,
				label: "The target",
				emoji: "",
				tag: "gttgt",
				cwd: "/nowhere",
				status,
				note: "",
				edges: [],
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}),
		);
	const ownNode = (edges) =>
		writeFileSync(
			join(root, "notify-telegram/graph/nodes", `${psId}.json`),
			JSON.stringify({
				session: psId,
				label: "Pane state",
				emoji: "",
				tag: record(psId).tag,
				cwd: "/home/dev/work/panestate",
				status: "working",
				note: "",
				edges,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}),
		);

	writeFileSync(join(paneStateDir, "%78"), "crashed\n");
	await ps.fire("session_start");
	await settle(150);
	check(
		"session start clears a crashed an earlier omp left in the pane",
		paneLogText().includes("set-option -p -u -t %78 @omp_state") && paneValue("%78") === "",
	);
	paneLogReset();
	await ps.fire("input");
	await settle(100);
	check(
		"a new input clears the pane state",
		paneLogText().includes("set-option -p -u -t %78 @omp_state") && paneValue("%78") === "",
	);
	paneLogReset();
	await ps.fire("agent_start");
	await settle(100);
	check(
		"agent start clears the pane state",
		paneLogText().includes("set-option -p -u -t %78 @omp_state") && paneValue("%78") === "",
	);
	paneLogReset();

	await freshTurn();
	await notify("p1", { summary: "Blocked on the database.", urgency: "red" });
	await stopTurn();
	check(
		"a red turn end marks the pane urgent",
		paneLogText().includes("set-option -p -t %78 @omp_state urgent") && paneValue("%78") === "urgent",
	);

	await freshTurn();
	await notify("p2", { summary: "Where to next.", urgency: "orange" });
	await stopTurn();
	check(
		"an orange turn end asks the pane for a reply",
		paneLogText().includes("set-option -p -t %78 @omp_state reply") && paneValue("%78") === "reply",
	);

	await freshTurn();
	await notify("p3", { summary: "Which backend?", urgency: "orange", options: opts("SQLite", "Postgres") });
	await stopTurn();
	check(
		"an orange turn end with choices still asks for a reply",
		paneLogText().includes("set-option -p -t %78 @omp_state reply") && paneValue("%78") === "reply",
	);

	await freshTurn();
	await notify("p4", { summary: "Pick a direction.", urgency: "green", effect: "none", options: opts("A", "B") });
	await stopTurn();
	check(
		"a green turn end with choices asks the pane for a reply",
		paneLogText().includes("set-option -p -t %78 @omp_state reply") && paneValue("%78") === "reply",
	);

	await freshTurn();
	await notify("p5", { summary: "All done.", urgency: "green", effect: "none" });
	await stopTurn();
	check(
		"a green turn end that waits on nothing marks the pane done",
		paneLogText().includes("set-option -p -t %78 @omp_state done") && paneValue("%78") === "done",
	);

	gtNode("working");
	ownNode([
		{ from: psId, to: gtId, type: "related", at: Date.now() },
		{ from: psId, to: fakeId, type: "upstream", at: Date.now() },
		{ from: psId, to: gtId, type: "waits-on", at: Date.now() },
	]);
	await freshTurn();
	await notify("p6", { summary: "The graph is green.", urgency: "green", effect: "none" });
	await stopTurn();
	check(
		"a green turn end that waits on an unfinished session sleeps the pane",
		paneLogText().includes("set-option -p -t %78 @omp_state sleeping") && paneValue("%78") === "sleeping",
	);

	gtNode("done");
	await freshTurn();
	await notify("p7", { summary: "The target finished.", urgency: "green", effect: "none" });
	await stopTurn();
	check(
		"a green turn end whose target is finished marks the pane done",
		paneLogText().includes("set-option -p -t %78 @omp_state done") && paneValue("%78") === "done",
	);

	tail = "Should I delete the legacy shim?";
	await freshTurn();
	await stopTurn();
	check(
		"a fallback turn end that ends on a question asks the pane for a reply",
		paneLogText().includes("set-option -p -t %78 @omp_state reply") && paneValue("%78") === "reply",
	);

	ownNode([]);
	tail = "All tests pass and the branch is ready.";
	await freshTurn();
	await stopTurn();
	check(
		"a fallback turn end that waits on nothing marks the pane done",
		paneLogText().includes("set-option -p -t %78 @omp_state done") && paneValue("%78") === "done",
	);

	gtNode("working");
	ownNode([{ from: psId, to: gtId, type: "waits-on", at: Date.now() }]);
	tail = "The build is green.";
	await freshTurn();
	await stopTurn();
	check(
		"a fallback turn end that waits on an unfinished session sleeps the pane",
		paneLogText().includes("set-option -p -t %78 @omp_state sleeping") && paneValue("%78") === "sleeping",
	);

	ownNode([]);
	writeFileSync(paneFail, "");
	tail = "Done for today.";
	await freshTurn();
	await stopTurn();
	check(
		"a failed pane write is ignored and the pane keeps its value",
		paneLogText().includes("set-option -p -t %78 @omp_state done") && paneValue("%78") === "sleeping",
	);
	unlinkSync(paneFail);
	await freshTurn();
	await notify("p8", { summary: "Blocked again.", urgency: "red" });
	await stopTurn();
	check(
		"the next turn end writes again after a failure",
		paneLogText().includes("set-option -p -t %78 @omp_state urgent") && paneValue("%78") === "urgent",
	);

	await freshTurn();
	await notify("p9", { summary: "The job is still running.", urgency: "red" });
	await ps.fire("agent_end", { awaitingAsyncWork: true });
	await settle(150);
	check(
		"an async end recorded red marks the pane urgent",
		paneLogText().includes("set-option -p -t %78 @omp_state urgent") && paneValue("%78") === "urgent",
	);

	await freshTurn();
	await notify("p10", { summary: "Waiting on the answer.", urgency: "orange" });
	await ps.fire("agent_end", { awaitingAsyncWork: true });
	await settle(150);
	check(
		"an async end recorded orange asks the pane for a reply",
		paneLogText().includes("set-option -p -t %78 @omp_state reply") && paneValue("%78") === "reply",
	);

	await freshTurn();
	await notify("p11", {
		summary: "The job runs, pick a path.",
		urgency: "green",
		effect: "none",
		options: opts("A", "B"),
	});
	await ps.fire("agent_end", { awaitingAsyncWork: true });
	await settle(150);
	check(
		"an async end with choices asks the pane for a reply",
		paneLogText().includes("set-option -p -t %78 @omp_state reply") && paneValue("%78") === "reply",
	);

	await freshTurn();
	await notify("p12", { summary: "The job runs on its own.", urgency: "green", effect: "none" });
	await ps.fire("agent_end", { awaitingAsyncWork: true });
	await settle(150);
	check(
		"an async end that reported green sleeps the pane on its job",
		paneLogText().includes("set-option -p -t %78 @omp_state sleeping") && paneValue("%78") === "sleeping",
	);

	tail = "Wait for the job before cleaning up?";
	await freshTurn();
	await ps.fire("agent_end", { awaitingAsyncWork: true });
	await settle(150);
	check(
		"a fallback async end that ends on a question asks the pane for a reply",
		paneLogText().includes("set-option -p -t %78 @omp_state reply") && paneValue("%78") === "reply",
	);

	tail = "The job runs in the background.";
	await freshTurn();
	await ps.fire("agent_end", { awaitingAsyncWork: true });
	await settle(150);
	check(
		"a fallback async end that reported nothing sleeps the pane",
		paneLogText().includes("set-option -p -t %78 @omp_state sleeping") && paneValue("%78") === "sleeping",
	);

	paneLogReset();
	await ps.fire("session_shutdown");
	await settle(150);
	check(
		"session shutdown clears the pane state",
		paneLogText().includes("set-option -p -u -t %78 @omp_state") && paneValue("%78") === "",
	);
	rmSync(join(root, "notify-telegram/graph/nodes", `${psId}.json`), { force: true });

	delete process.env.TMUX_PANE;
	const np = spawn("0c2c0003-0000-7000-8000-000000000003", "/home/dev/work/outside-tmux");
	await np.fire("session_start");
	await np.fire("input");
	await settle(100);
	paneLogReset();
	await np.fire("session_stop");
	await settle(150);
	check("a session outside tmux writes no pane option", !paneLogText().includes("@omp_state"));
	await np.fire("session_shutdown");

	process.env.TMUX_PANE = "%78";
	const pc = spawn("0c2c0001-0000-7000-8000-000000000001", "/home/dev/work/panepoller");
	await pc.fire("session_start");
	await settle(150);
	paneLogReset();
	const victimDir = join(root, "pane-crash");
	mkdirSync(victimDir, { recursive: true });
	const died = Date.now() - 10 * 60_000;
	const victim = (id, fields) =>
		writeFileSync(
			join(sessionsDir, `${id}.json`),
			JSON.stringify({
				pid: deadPid,
				tag: id.slice(0, 5),
				name: "",
				cwd: victimDir,
				emoji: "",
				emojiChosen: false,
				label: "",
				lastNotified: died,
				recent: [],
				question: null,
				replyQuestion: null,
				standing: null,
				closeOffer: null,
				pinned: null,
				state: "idle",
				health: "",
				summary: "",
				summaryAt: 0,
				messaging: 1,
				heartbeat: died,
				boot: bootId,
				argv: ["--model", "opus"],
				tmux: "work",
				tmuxWindow: null,
				tmuxPane: "%79",
				...fields,
			}),
		);
	const crashCards = () => called("sendMessage").filter((c) => String(c.body.text).includes("\u{1F691}"));

	const v0Id = "0c2c0004-0000-7000-8000-000000000004";
	victim(v0Id, { label: "No pane", tmuxPane: "" });
	pc.heartbeat();
	await settle(400);
	check(
		"a crash record that names no pane writes nothing to tmux",
		existsSync(join(crashDirPath, `${v0Id}.json`)) && !paneLogText().includes("@omp_state"),
	);

	const v1Id = "0c2c0005-0000-7000-8000-000000000005";
	const v2Id = "0c2c0006-0000-7000-8000-000000000006";
	const v3Id = "0c2c0007-0000-7000-8000-000000000007";
	victim(v1Id, { label: "Died in pane seventy-nine" });
	victim(v2Id, { label: "Overwritten by another producer", tmuxPane: "%80" });
	victim(v3Id, { label: "Restored from the card", tmuxPane: "%81" });
	const cardsBefore = crashCards().length;
	paneLogReset();
	pc.heartbeat();
	await settle(500);
	check(
		"each dead session's pane is marked crashed while its card is open",
		paneLogText().includes("set-option -p -t %79 @omp_state crashed") &&
			paneValue("%79") === "crashed" &&
			paneValue("%80") === "crashed" &&
			paneValue("%81") === "crashed",
	);
	const card = crashCards().at(-1)?.body;
	check("the poller posts one card for the batch", crashCards().length === cardsBefore + 1);
	const cardId = api.nextMessage - 1;
	const buttons = (card?.reply_markup?.inline_keyboard ?? []).flat().map((b) => b.callback_data);
	const batchId = buttons.find((b) => typeof b === "string" && b.startsWith("ka:"))?.slice(3);

	paneLogReset();
	api.queued = [
		{
			update_id: 9601,
			callback_query: {
				id: "cb-9601",
				from: { id: CHAT },
				message: { message_id: cardId, chat: { id: CHAT } },
				data: `kr:${v3Id}`,
			},
		},
	];
	await pc.pump(500);
	check(
		"restore reopens the session in its tmux session, resuming it with its flags",
		paneLogText().includes("new-window -d -t work:") && paneLogText().includes(`omp --model opus --resume ${v3Id}`),
	);
	const v3Crash = JSON.parse(readFileSync(join(crashDirPath, `${v3Id}.json`), "utf8"));
	writeFileSync(
		join(sessionsDir, `${v3Id}.json`),
		JSON.stringify({
			...v3Crash.record,
			instance: "pane-test",
			leased: false,
			pid: process.pid,
			heartbeat: Date.now(),
			systemShutdownAt: 0,
		}),
	);
	pc.heartbeat();
	await settle(500);
	check(
		"a session that comes back unsets crashed on its pane",
		paneLogText().includes("display-message -p -t %81 #{@omp_state}") &&
			paneLogText().includes("set-option -p -u -t %81 @omp_state") &&
			paneValue("%81") === "",
	);

	writeFileSync(join(paneStateDir, "%80"), "urgent\n");
	paneLogReset();
	api.queued = [
		{
			update_id: 9602,
			callback_query: {
				id: "cb-9602",
				from: { id: CHAT },
				message: { message_id: cardId, chat: { id: CHAT } },
				data: `kd:${batchId}`,
			},
		},
	];
	await pc.pump(500);
	await settle(300);
	check(
		"a dismissed crash unsets crashed on the pane that still reads it",
		paneLogText().includes("set-option -p -u -t %79 @omp_state") && paneValue("%79") === "",
	);
	check(
		"a pane another producer overwrote is left alone on dismiss",
		!paneLogText().includes("set-option -p -u -t %80 @omp_state") && paneValue("%80") === "urgent",
	);

	const v4Id = "0c2c0008-0000-7000-8000-000000000008";
	const v5Id = "0c2c000b-0000-7000-8000-00000000000b";
	victim(v4Id, { label: "Expired a week later", tmuxPane: "%82" });
	victim(v5Id, { label: "Pane that cannot be read", tmuxPane: "%83" });
	paneLogReset();
	pc.heartbeat();
	await settle(400);
	check(
		"the newest dead sessions mark their panes too",
		paneValue("%82") === "crashed" && paneValue("%83") === "crashed",
	);
	writeFileSync(join(crashDirPath, "bad.json"), "not json");
	jump(8 * 24 * 3_600_000);
	paneLogReset();
	pc.heartbeat();
	await settle(500);
	check(
		"an expired crash record unsets crashed on its pane",
		!existsSync(join(crashDirPath, `${v4Id}.json`)) &&
			!existsSync(join(crashDirPath, "bad.json")) &&
			paneLogText().includes("set-option -p -u -t %82 @omp_state") &&
			paneValue("%82") === "",
	);
	check(
		"the expiry leaves an overwritten pane alone",
		!paneLogText().includes("set-option -p -u -t %80 @omp_state") && paneValue("%80") === "urgent",
	);
	check(
		"a pane tmux refuses to read keeps its value when the clear cannot confirm it",
		paneValue("%83") === "crashed" && !paneLogText().includes("set-option -p -u -t %83 @omp_state"),
	);
	check(
		"every crash record expired with the file age",
		readdirSync(crashDirPath).filter((f) => f.endsWith(".json")).length === 0,
	);

	await pc.fire("session_shutdown");
	process.env.PATH = paneSavedPath;
	delete process.env.TMUX;
	delete process.env.TMUX_PANE;
	clockSkew = 0;
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
rmSync(root, { recursive: true, force: true });
console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);

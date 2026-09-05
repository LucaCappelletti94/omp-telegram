// Prints a rendered question and turn-end notice; sends nothing.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "omp-telegram-preview-"));
process.env.PI_CODING_AGENT_DIR = root;
writeFileSync(
	join(root, "notify-telegram.json"),
	JSON.stringify({ token: `12345:${"A".repeat(30)}`, chatId: 1, offset: 1, quietSeconds: 0 }),
);

const sent = [];
globalThis.fetch = async (url, init) => {
	const body = JSON.parse(init.body);
	if (String(url).endsWith("/sendMessage")) sent.push(body);
	return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
};

const mod = await import(new URL("../index.ts", import.meta.url).pathname);
const chain = new Proxy(() => chain, { get: () => chain, apply: () => chain });
const handlers = new Map();
const tools = new Map();
mod.default({
	zod: chain,
	logger: { debug() {}, info() {}, warn() {}, error() {} },
	on: (event, fn) => handlers.set(event, [...(handlers.get(event) ?? []), fn]),
	registerTool: (def) => tools.set(def.name, def),
	sendUserMessage() {},
});
const ctx = {
	hasUI: false,
	cwd: "/home/dev/work/sqlitegis",
	model: { provider: "anthropic", id: "claude-opus-5" },
	sessionManager: {
		getSessionId: () => "01a00000-0000-0000-0000-000000000000",
		getSessionName: () => "Fix FTS5 rebuild",
	},
	ui: { onTerminalInput: () => () => {} },
	setInterval: () => 0,
	setTimeout: () => 0,
	clearTimer() {},
};
for (const fn of handlers.get("session_start")) await fn({}, ctx);

tools.get("ask").execute(
	"p",
	{
		context:
			'`rebuild_index` drops the table first, so a crash mid-run leaves no index:\n```rust\nconn.execute("DELETE FROM idx")?;\n```',
		questions: [
			{
				id: "fix",
				header: "Index strategy",
				question: "How should `rebuild_index` behave on a **partial** failure?",
				options: [
					{ label: "Rebuild in a transaction", description: "Costs ~200 MB of temp space." },
					{
						label: "Build beside, then swap",
						description: "Doubles peak disk use.",
						preview: "ALTER TABLE idx_new RENAME TO idx;",
					},
					{ label: "Leave it", description: "Nightly job retries anyway.", discouraged: true },
					{ label: "Rebuild synchronously", description: "Blocks writers for minutes.", lukewarm: true },
				],
				recommended: 1,
			},
		],
	},
	undefined,
	undefined,
	{ ...ctx, invokeTool: () => new Promise(() => {}) },
);
await new Promise((r) => setTimeout(r, 200));

await tools.get("notify_status").execute(
	"s",
	{
		summary: "Refactor done, **all tests pass**.",
		urgency: "orange",
		question: "How should we proceed?",
		options: [
			{ label: "Continue", description: "Starts the index rebuild work on top of this.", recommended: true },
			{ label: "Review the diff", description: "Walks the 14 changed files before anything else." },
			{ label: "Stop here", description: "Leaves the branch unmerged and the session idle.", lukewarm: true },
		],
	},
	undefined,
	undefined,
	ctx,
);
for (const fn of handlers.get("session_stop")) await fn({}, ctx);
await new Promise((r) => setTimeout(r, 200));

await tools.get("notify_snippet").execute(
	"c",
	{
		purpose: "PR body for #12",
		text: "Rebuilds the FTS5 index beside the live one and swaps it in, so a crash mid-run leaves the old index in place.\n\nThe temporary table doubles peak disk use, which the nightly job already tolerates.",
	},
	undefined,
	undefined,
	ctx,
);
await new Promise((r) => setTimeout(r, 200));

for (const message of sent) {
	console.log("=".repeat(60));
	console.log(message.text);
	for (const row of message.reply_markup?.inline_keyboard ?? []) {
		console.log("  [", row.map((b) => b.text + (b.style ? ` {${b.style}}` : "")).join(" | "), "]");
	}
}

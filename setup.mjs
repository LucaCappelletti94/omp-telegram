import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".omp", "agent");
const configPath = join(agentDir, "notify-telegram.json");

const rl = createInterface({ input: process.stdin, output: process.stdout });
const api = async (token, method, body) => {
	const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body ?? {}),
		signal: AbortSignal.timeout(30_000),
	});
	const payload = await response.json().catch(() => null);
	if (payload === null || payload.ok !== true) {
		throw new Error(`${method} failed: ${payload?.description ?? response.status}`);
	}
	return payload.result;
};

console.log(`Token from @BotFather. Written only to ${configPath} (mode 600).\n`);

const token = (await rl.question("Bot token: ")).trim();
const me = await api(token, "getMe");
console.log(`\nToken valid: @${me.username}`);

if (existsSync(configPath)) {
	const keep = (await rl.question("A config already exists. Overwrite it? [y/N] ")).trim().toLowerCase();
	if (keep !== "y") {
		console.log("Left untouched.");
		process.exit(0);
	}
}

console.log(`\nNow open Telegram, find @${me.username}, press Start, and send it any message.`);
console.log("Waiting...");

let chatId = null;
let sender = "";
let offset = 0;
const deadline = Date.now() + 5 * 60_000;
while (chatId === null && Date.now() < deadline) {
	const updates = await api(token, "getUpdates", { offset, timeout: 25, allowed_updates: ["message"] });
	for (const update of updates) {
		offset = Math.max(offset, update.update_id + 1);
		const chat = update.message?.chat;
		if (chat?.type === "private") {
			chatId = chat.id;
			const from = update.message?.from ?? {};
			sender = [from.first_name, from.last_name, from.username ? `(@${from.username})` : ""].filter(Boolean).join(" ");
		}
	}
}
if (chatId === null) {
	console.log("No message arrived within five minutes. Run setup again.");
	process.exit(1);
}

// The first private message wins the pairing, so confirm who was captured before binding.
const accept = (await rl.question(`\nGot a message from ${sender || "an unnamed account"}. Bind to them? [y/N] `))
	.trim()
	.toLowerCase();
if (accept !== "y") {
	console.log("Not bound. Run setup again.");
	process.exit(1);
}

mkdirSync(agentDir, { recursive: true });
const temp = `${configPath}.tmp`;
writeFileSync(
	temp,
	`${JSON.stringify({ token, chatId, offset, quietSeconds: 45, notifyOnTurnEnd: true, streamDrafts: true }, null, 2)}\n`,
	{ mode: 0o600 },
);
renameSync(temp, configPath);
await api(token, "sendMessage", {
	chat_id: chatId,
	text: "omp-telegram is configured. Notifications will arrive here.",
});

const checkout = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
console.log(`\nDone. Chat id ${chatId} written to ${configPath}.`);
console.log(`\nLast step, add this checkout to ${join(agentDir, "config.yml")}:\n`);
console.log("extensions:");
console.log(`  - ${checkout}`);
console.log("\nNew omp sessions pick it up.");
rl.close();

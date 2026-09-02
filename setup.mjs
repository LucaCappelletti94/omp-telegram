import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const PAIRING_WINDOW_MS = 5 * 60_000;
const RETRY_MS = 3_000;

/**
 * The wizard with its network, its prompts and its output injected, so the suite can drive it.
 * Returns the process exit code rather than calling `process.exit`.
 */
export async function runSetup({
	fetch,
	ask,
	log,
	agentDir,
	checkout,
	pairingWindowMs = PAIRING_WINDOW_MS,
	retryMs = RETRY_MS,
}) {
	const configPath = join(agentDir, "notify-telegram.json");
	const call = async (token, method, body) => {
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

	log(`Token from @BotFather. Written only to ${configPath} (mode 600).\n`);

	const token = (await ask("Bot token: ")).trim();
	let me;
	try {
		me = await call(token, "getMe");
	} catch (error) {
		log(`\nTelegram refused that token: ${error.message}`);
		log("Open @BotFather, send /mybots, pick the bot, copy its token, then run setup again.");
		return 1;
	}
	log(`\nToken valid: @${me.username}`);

	if (existsSync(configPath)) {
		const keep = (await ask("A config already exists. Overwrite it? [y/N] ")).trim().toLowerCase();
		if (keep !== "y") {
			log("Left untouched.");
			return 0;
		}
	}

	log(`\nNow open Telegram, find @${me.username}, press Start, and send it a message.`);
	log("It has to be a private message to the bot, since the pairing binds one direct chat.");
	log("Waiting...");

	let chatId = null;
	let sender = "";
	let offset = 0;
	const deadline = Date.now() + pairingWindowMs;
	let explainedGroup = false;
	while (chatId === null && Date.now() < deadline) {
		let updates;
		try {
			updates = await call(token, "getUpdates", { offset, timeout: 25, allowed_updates: ["message"] });
		} catch (error) {
			// A dropped connection must not throw away a half-finished setup.
			log(`Telegram did not answer (${error.message}). Retrying...`);
			await new Promise((wake) => setTimeout(wake, retryMs));
			continue;
		}
		for (const update of updates) {
			offset = Math.max(offset, update.update_id + 1);
			const chat = update.message?.chat;
			if (chat === undefined) continue;
			if (chat.type !== "private") {
				if (!explainedGroup) {
					explainedGroup = true;
					log(`A ${chat.type} message arrived. Send the bot a private message instead, a group cannot pair it.`);
				}
				continue;
			}
			chatId = chat.id;
			const from = update.message?.from ?? {};
			sender = [from.first_name, from.last_name, from.username ? `(@${from.username})` : ""].filter(Boolean).join(" ");
		}
	}
	if (chatId === null) {
		log("No private message arrived within five minutes. Run setup again.");
		return 1;
	}

	// The first private message wins the pairing, so confirm who was captured before binding.
	const accept = (await ask(`\nGot a message from ${sender || "an unnamed account"}. Bind to them? [y/N] `))
		.trim()
		.toLowerCase();
	if (accept !== "y") {
		log("Not bound. Run setup again.");
		return 1;
	}

	mkdirSync(agentDir, { recursive: true });
	const temp = `${configPath}.tmp`;
	writeFileSync(
		temp,
		`${JSON.stringify({ token, chatId, offset, quietSeconds: 45, notifyOnTurnEnd: true, streamDrafts: true }, null, 2)}\n`,
		{ mode: 0o600 },
	);
	renameSync(temp, configPath);
	await call(token, "sendMessage", {
		chat_id: chatId,
		text: "omp-telegram is configured. Notifications will arrive here.",
	});

	log(`\nDone. Chat id ${chatId} written to ${configPath}.`);
	log(`\nLast step, add this checkout to ${join(agentDir, "config.yml")}:\n`);
	log("extensions:");
	log(`  - ${checkout}`);
	log("\nNew omp sessions pick it up.");
	return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const code = await runSetup({
		fetch,
		ask: (prompt) => rl.question(prompt),
		log: console.log,
		agentDir: process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".omp", "agent"),
		checkout: new URL(".", import.meta.url).pathname.replace(/\/$/, ""),
	});
	rl.close();
	process.exit(code);
}

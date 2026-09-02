// The setup wizard against a stubbed Telegram API and stubbed prompts; touches no network.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { runSetup } = await import(new URL("../setup.mjs", import.meta.url).href);

let fails = 0;
const heading = (title) => {
	console.log(`\n-- ${title}`);
};
const check = (label, ok) => {
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
	if (!ok) fails++;
};

const ok = (result) => ({ json: async () => ({ ok: true, result }) });
const privateMessage = (id) => ({
	update_id: id,
	message: { chat: { id: 42, type: "private" }, from: { first_name: "Ada", username: "ada" } },
});

/** Runs the wizard with a scripted API, collecting everything it printed. */
const drive = async (route, answer) => {
	const agentDir = mkdtempSync(join(tmpdir(), "setup-suite-"));
	const lines = [];
	let thrown = null;
	let code = null;
	try {
		code = await runSetup({
			fetch: async (url, init) => await route(String(url).split("/").pop(), JSON.parse(init.body)),
			ask: async (prompt) => answer(prompt),
			log: (line) => lines.push(String(line)),
			agentDir,
			checkout: "/home/dev/omp-telegram",
			pairingWindowMs: 5_000,
			retryMs: 0,
		});
	} catch (error) {
		thrown = error;
	}
	return { agentDir, code, thrown, text: lines.join("\n") };
};

const pairedChatId = (agentDir) => {
	try {
		return JSON.parse(readFileSync(join(agentDir, "notify-telegram.json"), "utf8")).chatId;
	} catch {
		return null;
	}
};

const yesToEverything = (prompt) => (prompt.startsWith("Bot token") ? "12345:token" : "y");

heading("an invalid token");
{
	const run = await drive(
		async () => ({ json: async () => ({ ok: false, description: "Unauthorized" }) }),
		() => "bogus",
	);
	check("an invalid token does not crash the wizard", run.thrown === null);
	check("an invalid token exits nonzero", run.code === 1);
	check("an invalid token points back at @BotFather", run.text.includes("/mybots"));
	check("an invalid token names the refusal", run.text.includes("Unauthorized"));
	rmSync(run.agentDir, { recursive: true, force: true });
}

heading("a network failure while waiting");
{
	let polls = 0;
	const run = await drive(async (method) => {
		if (method === "getMe") return ok({ username: "test_bot" });
		if (method === "getUpdates") {
			polls += 1;
			if (polls === 1) throw new TypeError("fetch failed");
			return ok([privateMessage(1)]);
		}
		return ok(true);
	}, yesToEverything);
	check("a failed poll does not crash the wizard", run.thrown === null);
	check("a failed poll announces the retry", run.text.includes("Retrying"));
	check("the wizard still pairs after the failed poll", run.code === 0);
	check("the paired chat id reaches the config", pairedChatId(run.agentDir) === 42);
	rmSync(run.agentDir, { recursive: true, force: true });
}

heading("a group message while waiting");
{
	let polls = 0;
	const run = await drive(async (method) => {
		if (method === "getMe") return ok({ username: "test_bot" });
		if (method === "getUpdates") {
			polls += 1;
			if (polls === 1) return ok([{ update_id: 1, message: { chat: { id: -100123, type: "supergroup" } } }]);
			return ok([privateMessage(2)]);
		}
		return ok(true);
	}, yesToEverything);
	check("a group message explains that a private message is needed", run.text.includes("private message"));
	check("a group message does not pair the group", run.code === 0);
	check("a later private message wins the pairing", pairedChatId(run.agentDir) === 42);
	rmSync(run.agentDir, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);

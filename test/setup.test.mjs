// The setup wizard against a stubbed Telegram API and stubbed prompts; touches no network.

import { execFileSync, spawn } from "node:child_process";
import fs, { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os, { tmpdir } from "node:os";
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
const drive = async (route, answer, existingDir, overrides = {}) => {
	const agentDir = existingDir ?? mkdtempSync(join(tmpdir(), "setup-suite-"));
	const commands = [];
	const lines = [];
	let thrown = null;
	let code = null;
	try {
		const exec = (command, args) => {
			commands.push([command, ...args]);
			if (command === "which") return "/home/dev/.local/bin/omp\n";
			if (command !== "systemctl") throw new Error(`Unexpected command ${command}`);
			return "";
		};
		code = await runSetup({
			fetch: async (url, init) => await route(String(url).split("/").pop(), JSON.parse(init.body)),
			ask: async (prompt) => answer(prompt),
			log: (line) => lines.push(String(line)),
			agentDir,
			checkout: "/home/dev/omp-telegram",
			fs,
			exec,
			configHome: join(agentDir, "xdg"),
			pairingWindowMs: 5_000,
			retryMs: 0,
			...overrides,
		});
	} catch (error) {
		thrown = error;
	}
	return { agentDir, code, thrown, commands, text: lines.join("\n") };
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

heading("the boot user unit");
{
	const route = async (method) => {
		if (method === "getMe") return ok({ username: "test_bot" });
		if (method === "getUpdates") return ok([privateMessage(1)]);
		return ok(true);
	};
	const run = await drive(route, yesToEverything);
	const unitPath = join(run.agentDir, "xdg/systemd/user/omp-telegram-boot.service");
	check("setup installs the user unit under XDG_CONFIG_HOME", existsSync(unitPath));
	const unit = existsSync(unitPath) ? readFileSync(unitPath, "utf8") : "";
	check(
		"the unit uses the absolute node and checkout paths",
		unit.includes(process.execPath) && unit.includes("/home/dev/omp-telegram/boot.ts"),
	);
	check(
		"the unit has a bounded oneshot startup and default target",
		unit.includes("Type=oneshot") && unit.includes("TimeoutStartSec=") && unit.includes("WantedBy=default.target"),
	);
	check("the unit avoids a default target ordering cycle", !unit.includes("After=default.target"));
	check(
		"the unit PATH contains the resolved omp directory",
		unit.includes("/home/dev/.local/bin:/usr/local/bin:/usr/bin:/bin"),
	);
	check(
		"setup reloads and enables only the boot user unit",
		JSON.stringify(run.commands.filter((c) => c[0] === "systemctl")) ===
			JSON.stringify([
				["systemctl", "--user", "daemon-reload"],
				["systemctl", "--user", "enable", "omp-telegram-boot.service"],
			]),
	);
	check(
		"setup reports the unit and lingering requirement",
		run.text.includes("omp-telegram-boot.service") && run.text.includes("enable-linger"),
	);
	const second = await drive(route, yesToEverything, run.agentDir);
	check(
		"installing the unit again is idempotent",
		second.code === 0 && existsSync(unitPath) && readFileSync(unitPath, "utf8") === unit,
	);
	const savedXdg = process.env.XDG_CONFIG_HOME;
	process.env.XDG_CONFIG_HOME = join(run.agentDir, "custom-config");
	const xdgRun = await drive(route, yesToEverything, run.agentDir, { configHome: undefined });
	check(
		"setup reads XDG_CONFIG_HOME from the environment",
		xdgRun.code === 0 && existsSync(join(process.env.XDG_CONFIG_HOME, "systemd/user/omp-telegram-boot.service")),
	);
	const originalHome = os.homedir;
	try {
		os.homedir = () => run.agentDir;
		delete process.env.XDG_CONFIG_HOME;
		syncBuiltinESMExports();
		const defaultHome = await drive(route, yesToEverything, run.agentDir, { configHome: undefined });
		check(
			"setup defaults to the user's config directory",
			defaultHome.code === 0 && existsSync(join(run.agentDir, ".config/systemd/user/omp-telegram-boot.service")),
		);
	} finally {
		os.homedir = originalHome;
		syncBuiltinESMExports();
	}
	if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
	else process.env.XDG_CONFIG_HOME = savedXdg;
	const declined = await drive(route, (prompt) => (prompt.startsWith("Bot token") ? "12345:token" : "n"), run.agentDir);
	check(
		"declining overwrite leaves the installed unit untouched",
		declined.code === 0 && declined.commands.length === 0 && readFileSync(unitPath, "utf8") === unit,
	);
	for (const output of ["omp", null]) {
		const failed = await drive(route, yesToEverything, run.agentDir, {
			exec: () => {
				if (output === null) throw new Error("user manager unavailable");
				return output;
			},
		});
		check(
			`setup reports an installation failure for ${output}`,
			failed.code === 1 && failed.thrown === null && failed.text.includes("Could not install the boot unit."),
		);
	}
	const quoted = await drive(route, yesToEverything, run.agentDir, { checkout: '/home/dev/a $b% "quote"' });
	const quotedUnit = readFileSync(unitPath, "utf8");
	check(
		"unit paths escape systemd substitutions and quotes",
		quoted.code === 0 && quotedUnit.includes('a $$b%% \\"quote\\"/boot.ts'),
	);
	const failedWrite = await drive(route, yesToEverything, run.agentDir, {
		fs: {
			...fs,
			mkdirSync: (path, options) => {
				if (path.endsWith("/systemd/user")) throw new Error("unit directory denied");
				return fs.mkdirSync(path, options);
			},
		},
	});
	check(
		"setup reports a unit filesystem failure",
		failedWrite.code === 1 && failedWrite.text.includes("unit directory denied"),
	);
	const bin = join(run.agentDir, "bin");
	const log = join(run.agentDir, "commands.jsonl");
	fs.mkdirSync(bin);
	for (const command of ["which", "systemctl"])
		fs.writeFileSync(
			join(bin, command),
			`#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify([${JSON.stringify(command)}, ...process.argv.slice(2)]) + "\\n");
if (${JSON.stringify(command)} === "which") console.log("/home/dev/.local/bin/omp");
`,
			{ mode: 0o755 },
		);
	const savedPath = process.env.PATH;
	process.env.PATH = `${bin}:${savedPath}`;
	try {
		check("setup host-command stubs lead PATH", process.env.PATH.split(":")[0] === bin);
		const defaults = await drive(route, yesToEverything, run.agentDir, { exec: undefined, fs: undefined });
		check(
			"setup's default host services only reach the executable stubs",
			defaults.code === 0 && readFileSync(log, "utf8").trim().split("\n").length === 3,
		);
		const cliAgent = join(run.agentDir, "cli-agent");
		const cliConfig = join(run.agentDir, "cli-config");
		const preload = `globalThis.fetch = async url => ({json: async () => ({ok:true,result:String(url).endsWith("/getMe") ? {username:"test_bot"} : String(url).endsWith("/getUpdates") ? [${JSON.stringify(privateMessage(1))}] : true})});`;
		const request = "setup-cli";
		const result = await new Promise((resolve) => {
			const child = spawn(
				process.execPath,
				[
					"--import",
					`data:text/javascript,${encodeURIComponent(preload)}`,
					new URL("../setup.mjs", import.meta.url).pathname,
				],
				{
					env: { ...process.env, PI_CODING_AGENT_DIR: cliAgent, XDG_CONFIG_HOME: cliConfig },
					stdio: ["pipe", "pipe", "pipe"],
				},
			);
			let output = "";
			let tokenSent = false;
			let bound = false;
			const deadline = setTimeout(() => child.kill("SIGKILL"), 5_000);
			child.stdout.on("data", (chunk) => {
				output += chunk;
				if (!tokenSent && output.includes("Bot token:")) {
					tokenSent = true;
					child.stdin.write(`12345:${"A".repeat(30)}\n`);
				}
				if (!bound && output.includes("Bind to them?")) {
					bound = true;
					child.stdin.end("y\n");
				}
			});
			child.on("close", (code) => {
				clearTimeout(deadline);
				resolve({ request, code });
			});
		});
		check(
			"the setup command installs its checkout through stubbed host services",
			result.request === request &&
				result.code === 0 &&
				readFileSync(join(cliConfig, "systemd/user/omp-telegram-boot.service"), "utf8").includes(
					new URL("../boot.ts", import.meta.url).pathname,
				),
		);
		const cliPath = join(cliAgent, "notify-telegram.json");
		const paired = readFileSync(cliPath, "utf8");
		const unitOnlyArgs = [
			"--import",
			`data:text/javascript,${encodeURIComponent('globalThis.fetch = () => { throw new Error("Unexpected fetch"); };')}`,
			new URL("../setup.mjs", import.meta.url).pathname,
			"--boot-unit",
		];
		let cliCode = 0;
		let cliOutput = "";
		try {
			cliOutput = execFileSync(process.execPath, unitOnlyArgs, {
				env: { ...process.env, PI_CODING_AGENT_DIR: cliAgent, XDG_CONFIG_HOME: cliConfig },
				input: "",
				encoding: "utf8",
				timeout: 5_000,
			});
		} catch (error) {
			cliCode = error.status;
		}
		check(
			"the boot-unit command installs without fetching or pairing",
			cliCode === 0 &&
				cliOutput.includes("Installed and enabled") &&
				!cliOutput.includes("Bot token:") &&
				readFileSync(cliPath, "utf8") === paired,
		);
		rmSync(cliPath);
		try {
			cliOutput = execFileSync(process.execPath, unitOnlyArgs, {
				env: { ...process.env, PI_CODING_AGENT_DIR: cliAgent, XDG_CONFIG_HOME: cliConfig },
				input: "",
				encoding: "utf8",
				timeout: 5_000,
			});
			cliCode = 0;
		} catch (error) {
			cliCode = error.status;
			cliOutput = String(error.stdout);
		}
		check(
			"the boot-unit command refuses a missing configuration",
			cliCode === 1 && cliOutput.includes("notify-telegram.json") && cliOutput.includes("node setup.mjs"),
		);
	} finally {
		process.env.PATH = savedPath;
	}
	rmSync(run.agentDir, { recursive: true, force: true });
}

heading("boot unit installation without pairing");
{
	const agentDir = mkdtempSync(join(tmpdir(), "boot-unit-setup-suite-"));
	const configPath = join(agentDir, "notify-telegram.json");
	const bytes = '{"token":"kept","chatId":42}\n';
	fs.writeFileSync(configPath, bytes);
	const forbidden = () => {
		throw new Error("Pairing must not run.");
	};
	const run = await drive(forbidden, forbidden, agentDir, { bootUnitOnly: true });
	check(
		"boot-only setup installs without fetching or asking",
		run.code === 0 && run.thrown === null && existsSync(join(agentDir, "xdg/systemd/user/omp-telegram-boot.service")),
	);
	check("boot-only setup preserves the paired configuration byte for byte", readFileSync(configPath, "utf8") === bytes);
	const failed = await drive(forbidden, forbidden, agentDir, {
		bootUnitOnly: true,
		exec: () => {
			throw new Error("user manager unavailable");
		},
	});
	check(
		"boot-only setup reports an installation failure",
		failed.code === 1 && failed.text.includes("user manager unavailable") && readFileSync(configPath, "utf8") === bytes,
	);
	rmSync(configPath);
	const missing = await drive(forbidden, forbidden, agentDir, { bootUnitOnly: true });
	check(
		"boot-only setup refuses an unpaired machine before any host command",
		missing.code === 1 &&
			missing.thrown === null &&
			missing.commands.length === 0 &&
			missing.text.includes(configPath) &&
			missing.text.includes("node setup.mjs"),
	);
	rmSync(agentDir, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);

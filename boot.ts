import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buttonText, fitToTelegram, type InlineButton, toTelegramHtml } from "./render.ts";
import {
	isStateToken,
	openOmp,
	type Run,
	readJsonFile,
	removeStatePath,
	transcriptPath,
	writePrivateJson,
} from "./restore.ts";

interface BootRecord {
	pid: number;
	heartbeat: number;
	systemShutdownAt: number;
	boot: string;
	cwd: string;
	tmux: string;
	tmuxWindow: number | null;
	argv: string[];
	label: string;
	name: string;
	emoji: string;
}

interface BootEntry {
	id: string;
	record: BootRecord;
	tab: string;
	error: string;
	confirmed: boolean;
}

const exec = promisify(execFile);

/** Restores earlier-boot wind-down records once per boot. */
export async function runBoot({ confirmMs = 90_000, timeoutMs = 180_000 } = {}): Promise<number> {
	const agent = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".omp", "agent");
	const config = readJsonFile(join(agent, "notify-telegram.json")) as { token?: unknown; chatId?: unknown } | null;
	if (
		config === null ||
		typeof config.token !== "string" ||
		!/^\d+:[A-Za-z0-9_-]{25,}$/u.test(config.token) ||
		typeof config.chatId !== "number"
	) {
		console.error("Boot restoration needs a valid notify-telegram config.");
		return 1;
	}
	try {
		await restoreBoot(agent, config as { token: string; chatId: number }, confirmMs, timeoutMs);
	} catch (error) {
		console.error("Boot restoration could not finish.", error);
	}
	return 0;
}

/** Holds all selected sessions before opening any of their windows. */
async function restoreBoot(
	agent: string,
	config: { token: string; chatId: number },
	confirmMs: number,
	timeoutMs: number,
): Promise<void> {
	const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
	if (!isStateToken(boot)) throw new Error("The kernel boot id is unavailable.");
	const state = join(agent, "notify-telegram");
	const shutdown = join(state, "shutdown");
	const markers = join(shutdown, "boots");
	mkdirSync(markers, { recursive: true, mode: 0o700 });
	try {
		writeFileSync(join(markers, `${boot}.json`), JSON.stringify({ at: Date.now() }), { flag: "wx", mode: 0o600 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
		throw error;
	}
	const sessions = join(state, "sessions");
	const holds = join(state, "restart-held");
	const crashed = join(state, "crashed");
	const planFile = join(shutdown, "plan.json");
	const plan = readJsonFile(planFile) as { id?: string; boot?: string; startedAt?: number } | null;
	const entries: BootEntry[] = [];
	for (const file of existsSync(sessions) ? readdirSync(sessions) : []) {
		if (!file.endsWith(".json")) continue;
		const id = file.substring(0, file.length - 5);
		if (!isStateToken(id)) continue;
		const record = readJsonFile(join(sessions, file)) as BootRecord | null;
		if (
			record === null ||
			record.heartbeat !== 0 ||
			typeof record.pid !== "number" ||
			typeof record.boot !== "string" ||
			record.boot.length === 0 ||
			record.boot === boot ||
			typeof record.cwd !== "string" ||
			typeof record.tmux !== "string" ||
			!Array.isArray(record.argv) ||
			!record.argv.every((arg) => typeof arg === "string") ||
			(record.tmuxWindow !== null && (!Number.isInteger(record.tmuxWindow) || record.tmuxWindow < 0))
		)
			continue;
		const hold = readJsonFile(join(holds, file)) as { plan?: string; pid?: number; at?: number } | null;
		const straggler =
			plan?.boot === record.boot &&
			plan?.id === hold?.plan &&
			hold?.pid === record.pid &&
			typeof hold?.at === "number" &&
			typeof plan?.startedAt === "number" &&
			hold.at >= plan.startedAt;
		if (!(record.systemShutdownAt > 0) && !straggler) continue;
		entries.push({
			id,
			record: { ...record, systemShutdownAt: record.systemShutdownAt || hold?.at || 0 },
			tab: "",
			error: "",
			confirmed: false,
		});
	}
	if (plan !== null && isStateToken(plan.boot) && plan.boot !== boot && isStateToken(plan.id)) {
		renameSync(planFile, join(shutdown, `${plan.id}.json`));
	}
	if (entries.length === 0) return;
	const batch = `boot-${boot}`;
	for (const entry of entries) writePrivateJson(holds, `${entry.id}.json`, { at: Date.now() });
	for (const entry of entries) {
		writePrivateJson(crashed, `${entry.id}.json`, {
			record: entry.record,
			batch,
			machine: true,
			restoringAt: 0,
			error: "",
			dismissed: false,
		});
		removeStatePath(state, sessions, `${entry.id}.json`);
		removeStatePath(state, join(state, "restart-pending"), `${entry.id}.json`);
	}
	const deadline = performance.now() + timeoutMs;
	const run: Run = async (command, args) => {
		const remaining = deadline - performance.now();
		if (remaining <= 0) return { ok: false, stdout: "", stderr: "Boot restoration timed out." };
		try {
			const result = await exec(command, args, {
				encoding: "utf8",
				timeout: Math.max(1, Math.min(5_000, Math.ceil(remaining))),
				maxBuffer: 1024 * 1024,
			});
			return { ok: true, stdout: result.stdout.trim(), stderr: "" };
		} catch (error) {
			const failure = error as { stderr?: string; message: string };
			return { ok: false, stdout: "", stderr: failure.stderr || failure.message };
		}
	};
	for (const entry of entries) {
		const { id, record } = entry;
		if (!existsSync(record.cwd)) entry.error = "Its folder no longer exists.";
		else if (transcriptPath(join(agent, "sessions"), id) === "") entry.error = "No transcript was found.";
		else {
			const scope = `omp-telegram-tmux-${boot.substring(0, 8)}-${createHash("sha256").update(record.tmux).digest("hex").substring(0, 8)}`;
			const opened = await openOmp(
				record.cwd,
				["omp", ...record.argv, "--resume", id],
				[],
				record.tmux,
				record.tmuxWindow,
				record.label || record.name || id,
				run,
				scope,
			);
			if (opened.ok) entry.tab = opened.tab;
			else entry.error = opened.error;
		}
	}
	const confirmDeadline = Math.min(deadline, performance.now() + confirmMs);
	for (;;) {
		let pending = false;
		for (const entry of entries) {
			if (entry.confirmed || entry.error !== "") continue;
			const current = readJsonFile(join(sessions, `${entry.id}.json`)) as BootRecord | null;
			if (
				current !== null &&
				current.pid !== entry.record.pid &&
				current.boot === boot &&
				current.heartbeat > 0 &&
				Date.now() - current.heartbeat < 45_000
			) {
				entry.confirmed = true;
				removeStatePath(state, holds, `${entry.id}.json`);
			} else if (performance.now() >= confirmDeadline) entry.error = "The reopened session did not confirm.";
			else pending = true;
		}
		if (!pending) break;
		await new Promise((resolve) =>
			setTimeout(resolve, Math.max(1, Math.min(250, confirmDeadline - performance.now()))),
		);
	}
	const lines = ["Sessions restored after boot."];
	const rows: InlineButton[][] = [];
	for (const entry of entries) {
		const { id, record } = entry;
		const title = `${record.emoji || ""} ${record.label || record.name || id}`.trim();
		lines.push(`${title} · ${entry.confirmed ? `reopened in ${entry.tab}` : entry.error}`);
		if (!entry.confirmed) {
			writePrivateJson(crashed, `${id}.json`, {
				record,
				batch,
				machine: true,
				restoringAt: 0,
				error: entry.error,
				dismissed: false,
			});
			if (id.length <= 61) rows.push([{ text: buttonText(`Restore ${title}`), callback_data: `kr:${id}` }]);
		}
		removeStatePath(state, holds, `${id}.json`);
	}
	if (rows.length > 1) rows.push([{ text: "Restore all", callback_data: `ka:${batch}`, style: "success" }]);
	if (rows.length > 0) rows.push([{ text: "Dismiss", callback_data: `kd:${batch}` }]);
	let messageId: number | null = null;
	try {
		const response = await fetch(`https://api.telegram.org/bot${config.token}/sendMessage`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				chat_id: config.chatId,
				text: toTelegramHtml(fitToTelegram(lines.join("\n"), "")),
				parse_mode: "HTML",
				reply_markup: { inline_keyboard: rows },
			}),
			signal: AbortSignal.timeout(15_000),
		});
		const payload = (await response.json()) as { ok?: boolean; result?: { message_id?: number } };
		if (payload.ok === true && typeof payload.result?.message_id === "number") messageId = payload.result.message_id;
	} catch {
		// The poller publishes the retained batch when Telegram is reachable.
	}
	writePrivateJson(join(crashed, "batches"), `${batch}.json`, {
		at: Date.now(),
		ids: entries.map((entry) => entry.id),
		machine: true,
		messageId,
		shown: "",
		boot: true,
	});
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await runBoot();

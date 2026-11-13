import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { writeFileAtomic } from "./lock.ts";
import { clip } from "./render.ts";

export interface RunResult {
	ok: boolean;
	stdout: string;
	stderr: string;
}

export type Run = (command: string, args: string[]) => Promise<RunResult>;

/** Recognizes a session or plan identifier safe for private state filenames. */
export function isStateToken(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
}

/** Reads private state without treating an absent or torn file as a record. */
export function readJsonFile(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

/** Publishes private state atomically. */
export function writePrivateJson(dir: string, name: string, value: unknown): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	writeFileAtomic(join(dir, name), JSON.stringify(value), 0o600);
}

/** Removes a path only inside the private state directory. */
export function removeStatePath(root: string, dir: string, name: string): void {
	const path = resolve(dir, name);
	if (path.startsWith(`${resolve(root)}${sep}`)) rmSync(path, { recursive: true, force: true });
}

/** Finds a transcript under omp's project directories. */
export function transcriptPath(sessions: string, id: string): string {
	if (!existsSync(sessions)) return "";
	for (const dir of readdirSync(sessions, { withFileTypes: true })) {
		if (!dir.isDirectory()) continue;
		const base = join(sessions, dir.name);
		let entries: string[];
		try {
			entries = readdirSync(base);
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (entry.length > id.length + 7 && entry.endsWith(`_${id}.jsonl`)) return join(base, entry);
		}
	}
	return "";
}

/** Opens a detached omp window at its recorded index, appending when occupied. */
export async function openOmp(
	cwd: string,
	command: string[],
	env: string[],
	tmuxSession: string,
	windowIndex: number | null,
	name: string,
	run: Run,
	scope?: string,
): Promise<{ ok: true; tab: string } | { ok: false; error: string }> {
	if (!existsSync(cwd)) {
		return { ok: false, error: `Its folder ${cwd} no longer exists, so omp would resume it somewhere else.` };
	}
	const target = tmuxSession || "omp";
	const named = ["-n", clip(name, 30), "-c", cwd, ...env];
	const window = [...named, ...command];
	if (!(await run("tmux", ["has-session", "-t", `=${target}`])).ok) {
		const args = ["new-session", "-d", "-s", target, "-P", "-F", "#{window_index}", ...window];
		const created =
			scope === undefined
				? await run("tmux", args)
				: await run("systemd-run", ["--user", "--scope", `--unit=${scope}`, "tmux", ...args]);
		if (!created.ok) return { ok: false, error: `tmux new-session failed. ${clip(created.stderr, 150)}` };
		if (windowIndex === null || created.stdout === String(windowIndex)) {
			return { ok: true, tab: `${target}:${created.stdout}` };
		}
		const moved = await run("tmux", [
			"move-window",
			"-d",
			"-s",
			`${target}:${created.stdout}`,
			"-t",
			`${target}:${windowIndex}`,
		]);
		return { ok: true, tab: `${target}:${moved.ok ? windowIndex : created.stdout}` };
	}
	const placed = [...named, "-P", "-F", "#{session_name}:#{window_index}", ...command];
	if (windowIndex !== null) {
		const reopened = await run("tmux", ["new-window", "-d", "-t", `${target}:${windowIndex}`, ...placed]);
		if (reopened.ok) return { ok: true, tab: reopened.stdout };
	}
	const opened = await run("tmux", ["new-window", "-d", "-t", `${target}:`, ...placed]);
	if (opened.ok) return { ok: true, tab: opened.stdout };
	return { ok: false, error: `tmux new-window failed. ${clip(opened.stderr, 150)}` };
}

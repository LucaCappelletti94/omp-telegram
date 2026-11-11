import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { withFileLock, writeFileAtomic } from "./lock.ts";

/** One overall task and the omp session that conducts it, kept in `tasks/<slug>.json`. */
export interface Task {
	name: string;
	slug: string;
	/** What Luca wants from the task, given with the `/conduct` that created it. */
	brief: string;
	/** The conductor's session id, empty until the omp opened for it claims the task. */
	conductor: string;
	/** `dormant` once the conductor was closed by hand, until `/conduct` resumes it. */
	state: "live" | "dormant";
	/** When a window was last opened for the conductor, so a second `/conduct` meanwhile opens none. */
	launchedAt: number;
}

/** A slug is a file name, so it stays a plain token no path can escape. */
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/u;
const SLUG_MAX = 40;
/** Held only across one synchronous read and write of a task file. */
const LOCK_STALE_MS = 2_000;

/** The file name a task's name maps to, empty when the name holds no letter or digit. */
export function taskSlug(name: string): string {
	const words = name
		.normalize("NFKD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/gu, "-")
		.replace(/^-+|-+$/gu, "");
	return words.slice(0, SLUG_MAX).replace(/-+$/u, "");
}

/** `/conduct <name>` with the brief on the lines after it, either of them possibly empty. */
export function parseConduct(text: string): { name: string; brief: string } {
	const rest = text
		.replace(/^\s*\/conduct(@\w+)?/u, "")
		.replace(/^[^\S\n]+/u, "")
		.replace(/^\n+/u, "");
	const cut = rest.indexOf("\n");
	return cut < 0
		? { name: rest.trim(), brief: "" }
		: { name: rest.slice(0, cut).trim(), brief: rest.slice(cut).trim() };
}

function parseTask(raw: unknown, slug: string): Task | null {
	if (typeof raw !== "object" || raw === null) return null;
	const t = raw as Partial<Record<keyof Task, unknown>>;
	if (t.slug !== slug || typeof t.name !== "string" || typeof t.brief !== "string") return null;
	if (typeof t.conductor !== "string" || typeof t.launchedAt !== "number") return null;
	if (t.state !== "live" && t.state !== "dormant") return null;
	return { name: t.name, slug, brief: t.brief, conductor: t.conductor, state: t.state, launchedAt: t.launchedAt };
}

export function readTask(dir: string, slug: string): Task | null {
	if (!SLUG.test(slug)) return null;
	const path = join(dir, `${slug}.json`);
	if (!existsSync(path)) return null;
	try {
		return parseTask(JSON.parse(readFileSync(path, "utf8")), slug);
	} catch {
		return null;
	}
}

/** Every readable task, by name. */
export function listTasks(dir: string): Task[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => name.endsWith(".json"))
		.map((name) => readTask(dir, name.slice(0, -5)))
		.filter((task): task is Task => task !== null)
		.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Reads the task under `tasks.lock`, so the poller and a conductor changing one task at once never lose a
 * write, and writes the task `change` returns. Returning no task leaves the file as it was.
 */
export async function changeTask<T>(
	dir: string,
	slug: string,
	change: (task: Task | null) => { task: Task | null; result: T },
): Promise<T> {
	if (!SLUG.test(slug)) throw new Error(`not a task slug: ${slug}`);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	return withFileLock(join(dir, "tasks.lock"), LOCK_STALE_MS, () => {
		const { task, result } = change(readTask(dir, slug));
		if (task !== null) writeFileAtomic(join(dir, `${slug}.json`), JSON.stringify(task), 0o600);
		return result;
	});
}

/** `changeTask` for a task that exists: an unknown slug or an absent task changes nothing and gives null. */
export async function updateTask<T>(
	dir: string,
	slug: string,
	change: (task: Task) => { task: Task | null; result: T },
): Promise<T | null> {
	if (!SLUG.test(slug)) return null;
	return changeTask(dir, slug, (task) => (task === null ? { task: null, result: null } : change(task)));
}

/** The conductor's standing role, added to its system prompt every turn so compaction and resume keep it. */
export function conductorRole(task: Task): string {
	return [
		`You are the conductor of the task "${task.name}". The brief:`,
		task.brief,
		"You keep the omp sessions working on this task from duplicating work or making engineering choices that contradict each other, and you tell the user where they disagree. You report to the user through notify_status and reach the sessions through session_message, where a call without `to` lists every live session with its folder. You never pause, reorder or rebase a session's work yourself.",
		`Closing this session leaves the task dormant, and \`/conduct ${task.name}\` in Telegram resumes it.`,
	].join("\n\n");
}

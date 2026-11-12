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
	/** Sessions Luca joined to the task. */
	members: Member[];
	/** Sessions the conductor invited, kept while Luca's answer is open or after he skipped them. */
	candidates: Candidate[];
	/** Live sessions the conductor was already told about, so each reaches it once while it stays live. */
	led: string[];
	/** Set once the last member left while the conductor was live, until it closes or a session joins. */
	closing: boolean;
	/** What the conductor raised to Luca, one card each. */
	findings: Finding[];
}

/** The signals a conductor raises, from the plan's decision 4, and `completed` for a member whose work is done. */
export const FINDING_KINDS = [
	"overlap",
	"stacked-parent",
	"dead-wait",
	"duplicate",
	"contradiction",
	"lesson",
	"completed",
] as const;

export interface Finding {
	/** The card's own id, which its buttons carry. */
	id: string;
	kind: (typeof FINDING_KINDS)[number];
	sessions: string[];
	/** Named by the conductor; once Luca settles a finding its subject is never raised again. */
	subject: string;
	text: string;
	/** What the conductor proposes to tell the sessions, empty for none. */
	suggested: string;
	messageId: number | null;
	/** `told` once the suggested message went out, `resolved` or `rejected` once Luca settled the card. */
	state: "open" | "told" | "resolved" | "rejected";
}

export interface Member {
	session: string;
	joinedAt: number;
}

export interface Candidate {
	session: string;
	/** The invitation card's own id, which its buttons carry. */
	card: string;
	/** `skipped` once Luca tapped Skip, so the session is never proposed again. */
	state: "proposed" | "skipped";
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
	const members = (Array.isArray(t.members) ? t.members : []).filter(
		(m): m is Member => typeof m?.session === "string" && typeof m.joinedAt === "number",
	);
	const candidates = (Array.isArray(t.candidates) ? t.candidates : []).filter(
		(c): c is Candidate =>
			typeof c?.session === "string" && typeof c.card === "string" && (c.state === "proposed" || c.state === "skipped"),
	);
	const led = (Array.isArray(t.led) ? t.led : []).filter((id): id is string => typeof id === "string");
	const findings = (Array.isArray(t.findings) ? t.findings : []).filter(
		(f): f is Finding =>
			typeof f?.id === "string" &&
			(FINDING_KINDS as readonly unknown[]).includes(f.kind) &&
			Array.isArray(f.sessions) &&
			f.sessions.every((s: unknown) => typeof s === "string") &&
			typeof f.subject === "string" &&
			typeof f.text === "string" &&
			typeof f.suggested === "string" &&
			(f.messageId === null || typeof f.messageId === "number") &&
			["open", "told", "resolved", "rejected"].includes(f.state),
	);
	return {
		name: t.name,
		slug,
		brief: t.brief,
		conductor: t.conductor,
		state: t.state,
		launchedAt: t.launchedAt,
		members,
		candidates,
		led,
		closing: t.closing === true,
		findings,
	};
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
		"To bring a session into the task, call the `conductor` tool with `action` `invite`, the session's badge emoji or tag in `session`, and in `reason` why it belongs. The user answers Join or Skip on Telegram, and the answer reaches you as an aside written by no one. Each live session that ends a turn reaches you once the same way, so you can judge whether it belongs.",
		"When members overlap, duplicate each other, contradict each other, wait on a session that ended, build on a moved parent, or need a lesson another member learned, raise it with `action` `finding`: one card to the user per finding, under a `subject` you name. Propose in `message` what to tell the sessions, and set `tell` only when they should hear it before the user decides.",
		"When a member has finished its part entirely, its pull request merged and nothing left open, raise a finding of kind `completed` naming that one member and why it is done. The card carries the member's own close buttons, and you never close a session yourself.",
		`Closing this session leaves the task dormant, and \`/conduct ${task.name}\` in Telegram resumes it.`,
	].join("\n\n");
}

/** What a member reads every turn: each task it belongs to and the address of that task's conductor. */
export function memberRole(tasks: { name: string; conductor: string }[]): string {
	const lines = tasks.map((task) => `- "${task.name}", conducted by the session ${task.conductor}`);
	return [
		`This session is a member of ${tasks.length === 1 ? "a task" : `${tasks.length} tasks`}:`,
		...lines,
		"A conductor keeps the sessions of its task from duplicating work or contradicting each other. Tell it through session_message when you start work another member could also take up, or make an engineering choice the others should follow, and expect it to message you when another member's work touches yours.",
	].join("\n");
}

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { withFileLock, writeFileAtomic } from "./lock.ts";

/** A lease transaction is one synchronous read and write, so a lock this old belongs to a dead process. */
const LEASE_LOCK_STALE_MS = 2_000;

/** Limits a lease is granted under. Pressures are the `some avg10` percentages the kernel reports. */
export interface LeasePolicy {
	/** Heavy commands running at once, a grant still waiting for its holder included. */
	limit: number;
	cpuPressure: number;
	memoryPressure: number;
	ioPressure: number;
	/** Share of the command's filesystem that must stay free, from 0 to 1. */
	diskFloor: number;
	/** How long a grant waits for its holder, or a grant from the queue for its session's next heavy command. */
	reserveMs: number;
}

export const DEFAULT_LEASE_POLICY: LeasePolicy = {
	limit: 4,
	cpuPressure: 20,
	memoryPressure: 10,
	ioPressure: 20,
	diskFloor: 0.1,
	reserveMs: 180_000,
};

/**
 * A slot one heavy command holds. `bound` grants belong to a tool call whose command was rewritten to carry the
 * holder, the others were granted from the queue and wait for their session's next heavy command.
 */
export interface Grant {
	id: string;
	session: string;
	command: string;
	grantedAt: number;
	/** Pid of the process that lives as long as the command, null until it starts. */
	holder: number | null;
	bound: boolean;
	/** When a grant without a holder is reclaimed. */
	expires: number;
}

export interface Queued {
	id: string;
	session: string;
	command: string;
	cwd: string;
	requestedAt: number;
}

export interface Leases {
	granted: Grant[];
	queue: Queued[];
}

/** What admission reads off the machine. */
export interface Machine {
	cpu: number;
	memory: number;
	io: number;
	/** Free share of the filesystem holding `cwd`, from 0 to 1. */
	freeShare: (cwd: string) => number;
}

export interface LeaseContext {
	/** Negative when session `a` outranks session `b` in the resource vote, zero on a tie. */
	rank: (a: string, b: string) => number;
	machine: Machine;
	policy: LeasePolicy;
	now: number;
}

/** `blockers` says in words what holds a queued request back, for the agent that has to wait. */
export type Admission =
	| { kind: "grant"; id: string }
	| { kind: "queued"; id: string; ahead: string[]; blockers: string[] };

/** Words that run the command after them, with options and counts of their own in between. */
const RUNNERS: Record<string, true> = {
	nice: true,
	ionice: true,
	time: true,
	timeout: true,
	nohup: true,
	env: true,
	taskset: true,
	chrt: true,
	command: true,
	exec: true,
};
/** Cargo subcommands, aliases included, that compile or run a suite. */
const CARGO_HEAVY: Record<string, true> = {
	build: true,
	b: true,
	check: true,
	c: true,
	clippy: true,
	test: true,
	t: true,
	nextest: true,
	mutants: true,
	fuzz: true,
	"llvm-cov": true,
	bench: true,
	doc: true,
	run: true,
	r: true,
	install: true,
};

/**
 * Whether `command` starts a build, a test suite or another job that loads the whole machine. Each pipeline
 * segment is judged by the program it runs, so `grep 'cargo test' log` stays light.
 */
export function isHeavy(command: string): boolean {
	for (const segment of command.split(/&&|\|\||[;|\n()]/u)) {
		const words = segment.trim().split(/\s+/u);
		let at = 0;
		while (at < words.length) {
			const word = words[at] as string;
			if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(word)) at++;
			else if (RUNNERS[word] === true) {
				at++;
				while (at < words.length && /^(-|[\d.:,-]+[smhd]?$|[A-Za-z_][A-Za-z0-9_]*=)/u.test(words[at] as string)) at++;
			} else break;
		}
		const [program, ...rest] = words.slice(at);
		const args = rest.filter((word) => !word.startsWith("+") && !word.startsWith("-"));
		if (program === "cargo" && CARGO_HEAVY[args[0] ?? ""] === true) return true;
		if (program === "npm" && (args[0] === "test" || (args[0] === "run" && args[1] === "test"))) return true;
		if (program === "make") return true;
		if (program === "docker" && args[0] === "build") return true;
	}
	return false;
}

/** What keeps another heavy command from starting anywhere on the machine, empty when a slot is free and calm. */
function machineBlockers(state: Leases, ctx: LeaseContext): string[] {
	const { machine, policy } = ctx;
	const blockers: string[] = [];
	if (state.granted.length >= policy.limit) blockers.push(`all ${policy.limit} slots are taken`);
	if (machine.cpu >= policy.cpuPressure) blockers.push(`CPU pressure is ${machine.cpu}%`);
	if (machine.memory >= policy.memoryPressure) blockers.push(`memory pressure is ${machine.memory}%`);
	if (machine.io >= policy.ioPressure) blockers.push(`I/O pressure is ${machine.io}%`);
	return blockers;
}

/** Queue order, rank first, the longer wait on a tie. */
function queueOrder(ctx: LeaseContext): (a: Queued, b: Queued) => number {
	return (a, b) => ctx.rank(a.session, b.session) || a.requestedAt - b.requestedAt;
}

/**
 * Decides one heavy command. A reservation the session holds is consumed whatever the machine looks like, since
 * its slot is already counted. Otherwise a free slot goes to it unless a session ahead of it in the queue waits.
 * A session waits in one place, so asking again keeps its id and its original time.
 */
export function admit(
	state: Leases,
	ask: { session: string; id: string; command: string; cwd: string },
	ctx: LeaseContext,
): { state: Leases; outcome: Admission } {
	const reserved = state.granted.find((grant) => grant.session === ask.session && !grant.bound);
	if (reserved !== undefined) {
		const bound = { ...reserved, bound: true, command: ask.command, expires: ctx.now + ctx.policy.reserveMs };
		return {
			state: { ...state, granted: state.granted.map((grant) => (grant === reserved ? bound : grant)) },
			outcome: { kind: "grant", id: reserved.id },
		};
	}
	const own = state.queue.find((entry) => entry.session === ask.session);
	const mine: Queued = own ?? { ...ask, requestedAt: ctx.now };
	const order = queueOrder(ctx);
	const ahead = state.queue
		.filter((entry) => entry.session !== ask.session && order(entry, mine) < 0)
		.sort(order)
		.map((entry) => entry.session);
	const blockers = machineBlockers(state, ctx);
	const free = ctx.machine.freeShare(ask.cwd);
	if (free < ctx.policy.diskFloor) blockers.push(`its filesystem has ${Math.round(free * 100)}% free`);
	if (ahead.length === 0 && blockers.length === 0) {
		const grant: Grant = {
			id: mine.id,
			session: ask.session,
			command: ask.command,
			grantedAt: ctx.now,
			holder: null,
			bound: true,
			expires: ctx.now + ctx.policy.reserveMs,
		};
		return {
			state: { granted: [...state.granted, grant], queue: state.queue.filter((entry) => entry !== own) },
			outcome: { kind: "grant", id: grant.id },
		};
	}
	const queued = { ...mine, command: ask.command, cwd: ask.cwd };
	return {
		state: {
			...state,
			queue: own === undefined ? [...state.queue, queued] : state.queue.map((e) => (e === own ? queued : e)),
		},
		outcome: { kind: "queued", id: mine.id, ahead, blockers },
	};
}

/**
 * The poller's pass. A grant whose holder died, or that waited past its expiry without one, is reclaimed, and so
 * is a holderless grant of a session that ended. A running holder keeps its slot even after its session ends,
 * because its command still loads the machine. Queued requests of ended sessions drop. Free slots then go to the
 * queue in rank order as reservations. Machine pressure or a full slot count stops the pass, while a request held
 * back only by its own filesystem's floor lets the next one through.
 */
export function settle(
	state: Leases,
	ctx: LeaseContext & { live: ReadonlySet<string>; alive: (pid: number) => boolean },
): { state: Leases; granted: Grant[]; reclaimed: Grant[] } {
	const reclaimed: Grant[] = [];
	const kept = state.granted.filter((grant) => {
		const gone =
			grant.holder !== null ? !ctx.alive(grant.holder) : ctx.now > grant.expires || !ctx.live.has(grant.session);
		if (gone) reclaimed.push(grant);
		return !gone;
	});
	let next: Leases = { granted: kept, queue: state.queue.filter((entry) => ctx.live.has(entry.session)) };
	const granted: Grant[] = [];
	for (const entry of [...next.queue].sort(queueOrder(ctx))) {
		if (machineBlockers(next, ctx).length > 0) break;
		if (ctx.machine.freeShare(entry.cwd) < ctx.policy.diskFloor) continue;
		const grant: Grant = {
			id: entry.id,
			session: entry.session,
			command: entry.command,
			grantedAt: ctx.now,
			holder: null,
			bound: false,
			expires: ctx.now + ctx.policy.reserveMs,
		};
		granted.push(grant);
		next = { granted: [...next.granted, grant], queue: next.queue.filter((e) => e !== entry) };
	}
	return { state: next, granted, reclaimed };
}

/** How long a taken grant waits for its holder, which starts a few milliseconds after the take. */
const HOLDER_START_MS = 60_000;

/**
 * Claims grant `id` the moment its command is about to run, since the call that was granted it may have waited for
 * approval or scheduling past the grant's expiry. A bound grant with no holder yet gets a fresh window for its
 * holder to start. A grant already reclaimed, perhaps handed on to another session, or already held by a running
 * copy of the same command, cannot be taken, and the command must not run.
 */
export function take(state: Leases, id: string, now: number): { state: Leases; taken: boolean } {
	if (!state.granted.some((grant) => grant.id === id && grant.bound && grant.holder === null)) {
		return { state, taken: false };
	}
	return {
		state: {
			...state,
			granted: state.granted.map((grant) =>
				grant.id === id ? { ...grant, expires: Math.max(grant.expires, now + HOLDER_START_MS) } : grant,
			),
		},
		taken: true,
	};
}

/** Records the pid that lives as long as lease `id`'s command. An unknown lease changes nothing. */
export function hold(state: Leases, id: string, pid: number): Leases {
	return { ...state, granted: state.granted.map((grant) => (grant.id === id ? { ...grant, holder: pid } : grant)) };
}

export function release(state: Leases, id: string): Leases {
	return { ...state, granted: state.granted.filter((grant) => grant.id !== id) };
}

/** The leases file's contents, dropping any entry that is not well formed. */
export function parseLeases(raw: unknown): Leases {
	const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
	const list = (value: unknown): Record<string, unknown>[] =>
		Array.isArray(value) ? value.filter((item) => typeof item === "object" && item !== null) : [];
	const text = (item: Record<string, unknown>, key: string): boolean => typeof item[key] === "string";
	const num = (item: Record<string, unknown>, key: string): boolean => typeof item[key] === "number";
	return {
		granted: list(record.granted).filter(
			(item): boolean =>
				text(item, "id") &&
				text(item, "session") &&
				text(item, "command") &&
				num(item, "grantedAt") &&
				(item.holder === null || num(item, "holder")) &&
				typeof item.bound === "boolean" &&
				num(item, "expires"),
		) as unknown as Grant[],
		queue: list(record.queue).filter(
			(item): boolean =>
				text(item, "id") &&
				text(item, "session") &&
				text(item, "command") &&
				text(item, "cwd") &&
				num(item, "requestedAt"),
		) as unknown as Queued[],
	};
}

/**
 * Runs `change` on the leases file in `stateDir` as one transaction under `leases.lock`, and writes back the state
 * it returns. Every reader and writer goes through here, so two hooks can never both take the last free slot.
 */
export async function changeLeases<T>(
	stateDir: string,
	change: (state: Leases) => { state: Leases | null; result: T },
): Promise<T> {
	const file = join(stateDir, "leases.json");
	const lock = join(stateDir, "leases.lock");
	return withFileLock(lock, LEASE_LOCK_STALE_MS, () => {
		let raw: unknown = null;
		try {
			raw = JSON.parse(readFileSync(file, "utf8"));
		} catch {}
		const { state, result } = change(parseLeases(raw));
		if (state !== null) writeFileAtomic(file, JSON.stringify(state), 0o600);
		return result;
	});
}

/**
 * `node lease.ts take <stateDir> <id>` runs just before a leased command and fails, so the command never starts,
 * when the grant has already been reclaimed. `node lease.ts hold <stateDir> <id>` then runs on the redirection of
 * the command's group, so it lives exactly as long as the command. It records its pid on the lease, waits for the
 * pipe to close and releases the lease. When the command is killed it dies with it, and the poller reclaims the
 * lease from the dead pid.
 */
if (import.meta.main) {
	const [verb, stateDir, id] = process.argv.slice(2);
	if ((verb !== "take" && verb !== "hold") || stateDir === undefined || id === undefined) {
		process.stderr.write("usage: lease.ts take|hold <stateDir> <id>\n");
		process.exit(2);
	}
	if (verb === "take") {
		const taken = await changeLeases(stateDir, (state) => {
			const claimed = take(state, id, Date.now());
			return { state: claimed.taken ? claimed.state : null, result: claimed.taken };
		});
		if (!taken) {
			process.stderr.write(
				`Resource lease ${id} expired before this command started and its slot may already belong to another session, so nothing ran. Run the command again to queue for a new lease.\n`,
			);
			process.exit(1);
		}
	} else {
		await changeLeases(stateDir, (state) => ({ state: hold(state, id, process.pid), result: null }));
		process.stdin.on("end", () => {
			void changeLeases(stateDir, (state) => ({ state: release(state, id), result: null }));
		});
		process.stdin.resume();
	}
}

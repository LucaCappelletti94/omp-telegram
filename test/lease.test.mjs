// The admission rules behind resource leases, called directly, then the leases file shared by real processes.

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admit, changeLeases, DEFAULT_LEASE_POLICY, hold, isHeavy, parseLeases, release, settle } from "../lease.ts";

let fails = 0;
const heading = (title) => {
	console.log(`\n-- ${title}`);
};
const check = (label, ok) => {
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
	if (!ok) fails++;
};

const policy = { ...DEFAULT_LEASE_POLICY, limit: 2 };
const calm = { cpu: 0, memory: 0, io: 0, freeShare: () => 0.5 };
/** Sessions earlier in `order` rank higher. */
const ranked =
	(...order) =>
	(a, b) =>
		order.indexOf(a) - order.indexOf(b);
const empty = () => ({ granted: [], queue: [] });
const ask = (session, id, command = "cargo test", cwd = "/w") => ({ session, id, command, cwd });
const base = (now = 1_000) => ({ rank: ranked("a", "b", "c", "d"), machine: calm, policy, now });

heading("heavy commands");
check("a cargo build is heavy", isHeavy("cargo build --release"));
check("a cargo test after a cd is heavy", isHeavy("cd crates/x && cargo test -p x"));
check("cargo mutants is heavy", isHeavy("nice cargo mutants -j 4"));
check(
	"runners with their own options and environment assignments are looked through",
	isHeavy("timeout 10m nice -n 5 RUSTFLAGS=-Dwarnings cargo +nightly test"),
);
check("an environment assignment before cargo is looked through", isHeavy("CARGO_TARGET_DIR=/t cargo build"));
check("npm test is heavy", isHeavy("npm test"));
check("npm run test is heavy", isHeavy("npm run test"));
check("npm run of another script is light", !isHeavy("npm run lint"));
check("cargo with no subcommand is light", !isHeavy("cargo"));
check("make is heavy", isHeavy("make -j8 all"));
check("docker build is heavy", isHeavy("docker build -t x ."));
check("cargo metadata is light", !isHeavy("cargo metadata --format-version 1"));
check("a word that only contains make is light", !isHeavy("cmake --version && echo remake"));
check("git status is light", !isHeavy("git status --short"));
check("grep for cargo test in a log is light", !isHeavy("grep 'cargo test' log.txt"));

heading("admission with a free slot");
{
	const { state, outcome } = admit(empty(), ask("a", "l1"), base());
	check("a free slot is granted at once", outcome.kind === "grant" && outcome.id === "l1");
	check(
		"the grant is bound to the call and waits for its holder",
		state.granted[0].bound && state.granted[0].holder === null,
	);
	check("nothing queues", state.queue.length === 0);
}

heading("admission at the limit");
{
	let state = empty();
	state = admit(state, ask("a", "l1"), base()).state;
	state = admit(state, ask("b", "l2"), base()).state;
	const third = admit(state, ask("c", "l3"), base());
	check("a request past the limit queues", third.outcome.kind === "queued" && third.outcome.id === "l3");
	check("a grant whose holder has not started counts against the limit", third.state.granted.length === 2);
	check("the queued answer says the slots are taken", third.outcome.blockers.join() === "all 2 slots are taken");
	const again = admit(third.state, ask("c", "l9", "cargo build"), base(2_000));
	check(
		"a session asking again keeps its one place and id",
		again.outcome.id === "l3" && again.state.queue.length === 1,
	);
	check("the repeated ask keeps its original time", again.state.queue[0].requestedAt === 1_000);
}

heading("rank among the queue");
{
	let state = { granted: [], queue: [{ id: "q1", session: "a", command: "cargo test", cwd: "/w", requestedAt: 500 }] };
	const lower = admit(state, ask("c", "l2"), base());
	check("a free slot is not taken past a higher-ranked queued session", lower.outcome.kind === "queued");
	check("the queued answer names the sessions ahead", lower.outcome.ahead.join() === "a");
	check("a queue alone is no machine blocker", lower.outcome.blockers.length === 0);
	state = { granted: [], queue: [{ id: "q1", session: "c", command: "cargo test", cwd: "/w", requestedAt: 500 }] };
	const higher = admit(state, ask("a", "l2"), base());
	check("a higher-ranked session takes a free slot past a lower-ranked queue", higher.outcome.kind === "grant");
	const tie = admit(
		{ granted: [], queue: [{ id: "q1", session: "x", command: "cargo test", cwd: "/w", requestedAt: 500 }] },
		ask("y", "l2"),
		{ ...base(), rank: () => 0 },
	);
	check("on equal rank the session that waited longer goes first", tie.outcome.kind === "queued");
}

heading("machine pressure and disk");
{
	const hot = admit(empty(), ask("a", "l1"), { ...base(), machine: { ...calm, cpu: 50 } });
	check("CPU pressure over its threshold queues even a free slot", hot.outcome.kind === "queued");
	check("the queued answer gives the pressure", hot.outcome.blockers.join() === "CPU pressure is 50%");
	const swapping = admit(empty(), ask("a", "l1"), { ...base(), machine: { ...calm, memory: 50 } });
	check("memory pressure over its threshold queues", swapping.outcome.kind === "queued");
	const busy = admit(empty(), ask("a", "l1"), { ...base(), machine: { ...calm, io: 50 } });
	check("I/O pressure over its threshold queues", busy.outcome.kind === "queued");
	const full = admit(empty(), ask("a", "l1", "cargo test", "/full"), {
		...base(),
		machine: { ...calm, freeShare: (cwd) => (cwd === "/full" ? 0.01 : 0.5) },
	});
	check("a filesystem under the free-space floor queues", full.outcome.kind === "queued");
	check("the queued answer gives the free share", full.outcome.blockers.join() === "its filesystem has 1% free");
}

heading("settling the queue");
{
	const queue = [
		{ id: "q1", session: "c", command: "cargo test", cwd: "/w", requestedAt: 100 },
		{ id: "q2", session: "a", command: "cargo test", cwd: "/w", requestedAt: 200 },
		{ id: "q3", session: "b", command: "cargo test", cwd: "/w", requestedAt: 300 },
	];
	const ctx = { ...base(), live: new Set(["a", "b", "c"]), alive: () => true };
	const { state, granted } = settle({ granted: [], queue }, ctx);
	check("free slots go to queued sessions in rank order", granted.map((g) => g.session).join() === "a,b");
	check(
		"a grant from the queue is reserved for its session, not bound to a call",
		granted.every((g) => !g.bound),
	);
	check("the reservation expires after the reserve window", granted[0].expires === 1_000 + policy.reserveMs);
	check("the lowest-ranked request still waits", state.queue.map((q) => q.id).join() === "q1");

	const diskQueue = [{ ...queue[1], cwd: "/full" }, queue[2], queue[0]];
	const skipped = settle(
		{ granted: [], queue: diskQueue },
		{ ...ctx, machine: { ...calm, freeShare: (cwd) => (cwd === "/full" ? 0.01 : 0.5) } },
	);
	check(
		"a request blocked only by its own full disk lets the next one through",
		skipped.granted.map((g) => g.session).join() === "b,c",
	);
	const hot = settle({ granted: [], queue }, { ...ctx, machine: { ...calm, memory: 90 } });
	check("machine pressure grants nothing", hot.granted.length === 0 && hot.state.queue.length === 3);
}

heading("reservations");
{
	const reserved = {
		granted: [
			{ id: "z1", session: "z", command: "make", grantedAt: 800, holder: 77, bound: true, expires: 99_000 },
			{ id: "r1", session: "a", command: "cargo test", grantedAt: 900, holder: null, bound: false, expires: 99_000 },
		],
		queue: [],
	};
	const { state, outcome } = admit(reserved, ask("a", "l5", "cargo build"), {
		...base(),
		machine: { ...calm, cpu: 99 },
	});
	check(
		"a session's next heavy command consumes its reservation whatever the pressure",
		outcome.kind === "grant" && outcome.id === "r1",
	);
	check(
		"the consumed reservation is bound to the call, and other grants stay as they were",
		state.granted[1].bound && state.granted[1].command === "cargo build" && state.granted[0] === reserved.granted[0],
	);
	const other = admit(reserved, ask("b", "l6"), { ...base(), policy: { ...policy, limit: 2 } });
	check("another session cannot take a reserved slot", other.outcome.kind === "queued");
}

heading("holders and reclaim");
{
	let state = admit(empty(), ask("a", "l1"), base()).state;
	state = hold(state, "l1", 4242);
	check("the holder records its pid on its grant", state.granted[0].holder === 4242);
	check("holding an unknown lease changes nothing", hold(state, "nope", 1).granted.length === 1);
	const ctx = (now, alive, live = new Set(["a"])) => ({ ...base(now), live, alive });
	const kept = settle(
		state,
		ctx(10_000_000, () => true),
	);
	check(
		"a running holder keeps its lease however long it runs",
		kept.state.granted.length === 1 && kept.reclaimed.length === 0,
	);
	const dead = settle(
		state,
		ctx(2_000, () => false),
	);
	check("a dead holder's lease is reclaimed", dead.state.granted.length === 0 && dead.reclaimed[0].id === "l1");
	const closed = settle(
		state,
		ctx(2_000, () => true, new Set()),
	);
	check("a running holder outlives its session", closed.state.granted.length === 1);
	state = release(state, "l1");
	check("release frees the slot", state.granted.length === 0);

	const pending = admit(empty(), ask("a", "l2"), base()).state;
	const early = settle(
		pending,
		ctx(1_000 + policy.reserveMs, () => true),
	);
	check("a grant waiting for its holder survives the reserve window", early.state.granted.length === 1);
	const late = settle(
		pending,
		ctx(1_001 + policy.reserveMs, () => true),
	);
	check("a grant whose holder never started is reclaimed after it", late.state.granted.length === 0);
	const gone = settle(
		pending,
		ctx(2_000, () => true, new Set()),
	);
	check("a holderless grant of an ended session is reclaimed", gone.state.granted.length === 0);

	const queued = { granted: [], queue: [{ id: "q1", session: "z", command: "cargo test", cwd: "/w", requestedAt: 1 }] };
	check(
		"a queued request of an ended session is dropped",
		settle(
			queued,
			ctx(2_000, () => true),
		).state.queue.length === 0,
	);
}

heading("parsing");
{
	const parsed = parseLeases({
		granted: [
			{ id: "l1", session: "a", command: "c", grantedAt: 1, holder: 5, bound: true, expires: 2 },
			{ id: 3, session: "a" },
		],
		queue: [{ id: "q1", session: "b", command: "c", cwd: "/w", requestedAt: 1 }, null],
	});
	check("well-formed entries survive", parsed.granted.length === 1 && parsed.queue.length === 1);
	check("garbage reads as no leases", parseLeases("nope").granted.length === 0 && parseLeases(null).queue.length === 0);
}

const leaseModule = new URL("../lease.ts", import.meta.url).pathname;
const leasesIn = (dir) => parseLeases(JSON.parse(readFileSync(join(dir, "leases.json"), "utf8")));
const exited = (child) => new Promise((done) => child.on("exit", (code) => done(code)));
const until = async (ok, ms = 5_000) => {
	const end = Date.now() + ms;
	while (!ok() && Date.now() < end) await new Promise((done) => setTimeout(done, 10));
	return ok();
};

heading("separate processes racing for the last slot");
{
	const dir = mkdtempSync(join(tmpdir(), "omp-lease-race-"));
	const racer = `
		import { admit, changeLeases, DEFAULT_LEASE_POLICY } from ${JSON.stringify(leaseModule)};
		const [dir, session] = process.argv.slice(1);
		const ctx = { rank: () => 0, machine: { cpu: 0, memory: 0, io: 0, freeShare: () => 1 }, policy: { ...DEFAULT_LEASE_POLICY, limit: 1 }, now: Date.now() };
		const kind = await changeLeases(dir, (state) => {
			const { state: next, outcome } = admit(state, { session, id: "id-" + session, command: "cargo test", cwd: "/" }, ctx);
			return { state: next, result: outcome.kind };
		});
		process.stdout.write(kind);
	`;
	const racers = Array.from({ length: 8 }, (_, n) => {
		const child = spawn(process.execPath, [
			"--disable-warning=ExperimentalWarning",
			"--input-type=module",
			"-e",
			racer,
			dir,
			`s${n}`,
		]);
		let out = "";
		child.stdout.on("data", (chunk) => {
			out += chunk;
		});
		return exited(child).then(() => out);
	});
	const kinds = await Promise.all(racers);
	const state = leasesIn(dir);
	check(
		"exactly one of eight racing processes is granted the last slot",
		kinds.filter((k) => k === "grant").length === 1,
	);
	check("the file holds that one grant", state.granted.length === 1);
	check("every other process queued, none lost", state.queue.length === 7);
	rmSync(dir, { recursive: true, force: true });
}

heading("the holder process");
{
	const dir = mkdtempSync(join(tmpdir(), "omp-lease-hold-"));
	const misused = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", leaseModule, "hold", dir], {
		stdio: "ignore",
	});
	check("a holder started without a lease id refuses with its usage", (await exited(misused)) === 2);
	const ctx = { rank: () => 0, machine: { cpu: 0, memory: 0, io: 0, freeShare: () => 1 }, policy, now: Date.now() };
	await changeLeases(dir, (state) => ({ state: admit(state, ask("a", "l1"), ctx).state, result: null }));
	const holder = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", leaseModule, "hold", dir, "l1"], {
		stdio: ["pipe", "ignore", "ignore"],
	});
	const holderExit = exited(holder);
	check(
		"the holder records its own pid on the lease",
		await until(() => leasesIn(dir).granted[0]?.holder === holder.pid),
	);
	holder.stdin.end();
	check("closing its pipe releases the lease", await until(() => leasesIn(dir).granted.length === 0));
	check("the holder then exits", (await holderExit) === 0);

	await changeLeases(dir, (state) => ({ state: admit(state, ask("a", "l2"), ctx).state, result: null }));
	const killed = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", leaseModule, "hold", dir, "l2"], {
		stdio: ["pipe", "ignore", "ignore"],
	});
	await until(() => leasesIn(dir).granted[0]?.holder === killed.pid);
	killed.kill("SIGKILL");
	await exited(killed);
	check("a killed holder leaves its lease behind", leasesIn(dir).granted.length === 1);
	const alive = (pid) => {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	};
	const swept = settle(leasesIn(dir), { ...ctx, live: new Set(["a"]), alive });
	check(
		"and the next pass reclaims it from the dead pid",
		swept.state.granted.length === 0 && swept.reclaimed.length === 1,
	);
	rmSync(dir, { recursive: true, force: true });
}

if (fails > 0) {
	console.log(`\n${fails} FAILURE(S)`);
	process.exit(1);
}
console.log("\nALL PASS");

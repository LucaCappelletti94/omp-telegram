// The pure Borda tally behind session priority, called directly. No fake server, no session, no sleeping.

import {
	BACKSTOP_CALM_MS,
	backstopStep,
	bordaPoints,
	byPriority,
	cappedSessions,
	cpuWeight,
	PRIORITY_WEIGHT_MAX,
	PRIORITY_WEIGHT_MIN,
} from "../priority.ts";

let fails = 0;
const heading = (title) => {
	console.log(`\n-- ${title}`);
};
const check = (label, ok) => {
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
	if (!ok) fails++;
};
const tally = (ballots, candidates) => bordaPoints(new Map(Object.entries(ballots)), candidates);
const points = (result, id) => result.points.get(id) ?? Number.NaN;

heading("modified Borda count");
{
	const full = tally({ a: ["b", "c"], b: ["c", "a"], c: ["b", "a"] }, ["a", "b", "c"]);
	check("a first preference on a ballot of two earns two points", points(full, "b") === 2 + 2);
	check("a last preference earns one point", points(full, "a") === 1 + 1);
	check("every voter counts", points(full, "c") === 1 + 2);
	check("the most any candidate could earn is every other voter ranking it first", full.attainable === 4);

	const partial = tally({ a: ["b"], b: ["c", "a"] }, ["a", "b", "c"]);
	check("a ballot ranking one session gives it one point, not a full first place", points(partial, "b") === 1);
	check("a session a ballot leaves out scores nothing from it", points(partial, "a") === 1);
	check("a session with no ballot still collects points", points(partial, "c") === 2);

	const self = tally({ a: ["a", "b"] }, ["a", "b"]);
	check("a voter naming itself is dropped, so the rest of its ballot shrinks", points(self, "b") === 1);
	check("a voter never earns points from its own ballot", points(self, "a") === 0);

	const stale = tally({ a: ["gone", "b", "b", "c"] }, ["a", "b", "c"]);
	check("an ended session and a repeat are dropped before counting", points(stale, "b") === 2);
	check("what follows them moves up", points(stale, "c") === 1);

	const ended = tally({ a: ["b"], gone: ["a"] }, ["a", "b"]);
	check("an ended session's ballot counts for nobody", points(ended, "a") === 0 && ended.attainable === 1);

	const none = tally({}, ["a", "b"]);
	check("with no ballots nothing is attainable", none.attainable === 0 && points(none, "a") === 0);
}

heading("priority order");
{
	const pts = new Map([
		["a", 1],
		["b", 3],
		["c", 3],
	]);
	const order = (marked) => ["a", "b", "c"].sort(byPriority(pts, new Set(marked), (x, y) => (x < y ? 1 : -1)));
	check("more points rank higher", order([]).indexOf("b") < order([]).indexOf("a"));
	check("a tie falls back to the caller's own order", order([]).join("") === "cba");
	check("a mark the user set outranks every vote", order(["a"])[0] === "a");
	check("marked sessions keep the vote order among themselves", order(["a", "b"]).join("") === "bac");
}

heading("CPU weight");
check("no ballots leaves the kernel default", cpuWeight(0, 0, false) === 100);
check("the unanimous first gets the top weight", cpuWeight(4, 4, false) === PRIORITY_WEIGHT_MAX);
check("a session nobody ranks gets the bottom weight", cpuWeight(0, 4, false) === PRIORITY_WEIGHT_MIN);
check("half the attainable points lands on the kernel default", cpuWeight(2, 4, false) === 100);
check("the map is geometric, a quarter of the way doubles the bottom", cpuWeight(1, 4, false) === 50);
check("a mark the user set gets the top weight whatever the votes", cpuWeight(0, 4, true) === PRIORITY_WEIGHT_MAX);
check("a mark gets the top weight with no ballots at all", cpuWeight(0, 0, true) === PRIORITY_WEIGHT_MAX);

heading("memory backstop episode");
{
	const off = { active: false, calmSince: 0 };
	const on = { active: true, calmSince: 0 };
	const step = (prev, pressure, now = 1_000) => backstopStep(prev, pressure, 10, now);
	check("pressure at the threshold starts an episode", JSON.stringify(step(off, 10)) === JSON.stringify(on));
	check("pressure under the threshold starts none", JSON.stringify(step(off, 9)) === JSON.stringify(off));
	check(
		"pressure between half and the threshold keeps an episode on",
		JSON.stringify(step(on, 6)) === JSON.stringify(on),
	);
	check(
		"pressure back in that band forgets the calm so far",
		JSON.stringify(step({ active: true, calmSince: 500 }, 6)) === JSON.stringify(on),
	);
	const calm = step(on, 2, 1_000);
	check("pressure under half the threshold starts the calm clock", calm.active && calm.calmSince === 1_000);
	check(
		"the calm clock keeps its start while it lasts",
		JSON.stringify(step(calm, 2, 1_000 + BACKSTOP_CALM_MS - 1)) === JSON.stringify(calm),
	);
	check(
		"five calm minutes end the episode",
		JSON.stringify(step(calm, 2, 1_000 + BACKSTOP_CALM_MS)) === JSON.stringify(off),
	);
}

heading("sessions the memory backstop caps");
{
	const capped = (order, marked = []) => [...cappedSessions(order, new Set(marked))].join();
	check("the lower half of the resource order is capped", capped(["a", "b", "c", "d"]) === "c,d");
	check("an odd middle session stays uncapped", capped(["a", "b", "c"]) === "c");
	check("a lone session is never capped", capped(["a"]) === "");
	check("a marked window is never capped", capped(["a", "b", "c", "d"], ["d"]) === "c");
}

if (fails > 0) {
	console.log(`\n${fails} FAILURE(S)`);
	process.exit(1);
}
console.log("\nALL PASS");

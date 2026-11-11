// The pure Borda tally behind session priority, called directly. No fake server, no session, no sleeping.

import { bordaPoints, byPriority } from "../priority.ts";

let fails = 0;
const heading = (title) => {
	console.log(`\n-- ${title}`);
};
const check = (label, ok) => {
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
	if (!ok) fails++;
};
const tally = (ballots, candidates) => bordaPoints(new Map(Object.entries(ballots)), candidates);
const points = (result, id) => result.get(id) ?? Number.NaN;

heading("modified Borda count");
{
	const full = tally({ a: ["b", "c"], b: ["c", "a"], c: ["b", "a"] }, ["a", "b", "c"]);
	check("a first preference on a ballot of two earns two points", points(full, "b") === 2 + 2);
	check("a last preference earns one point", points(full, "a") === 1 + 1);
	check("every voter counts", points(full, "c") === 1 + 2);

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
	check("an ended session's ballot counts for nobody", points(ended, "a") === 0);

	const none = tally({}, ["a", "b"]);
	check("with no ballots every live session scores nothing", points(none, "a") === 0 && points(none, "b") === 0);
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
if (fails > 0) {
	console.log(`\n${fails} FAILURE(S)`);
	process.exit(1);
}
console.log("\nALL PASS");

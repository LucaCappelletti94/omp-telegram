// The pure dependency-graph helpers, called directly. No fake server, no session, no sleeping.

import {
	blockingPath,
	classifyPr,
	dependentsOf,
	displayedStatus,
	GRAPH_RETENTION_MS,
	isFinished,
	outcomeOfPr,
	outcomeOfStatus,
	resumeArgs,
	selectNodes,
	statusList,
	toMermaid,
} from "../graph.ts";

let fails = 0;
const heading = (title) => {
	console.log(`\n-- ${title}`);
};
const check = (label, ok) => {
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
	if (!ok) fails++;
};

const NOW = 1_800_000_000_000;
const node = (session, extra = {}) => ({
	session,
	label: `task ${session}`,
	emoji: "",
	tag: session.slice(0, 3),
	cwd: `/home/dev/${session}`,
	status: "working",
	note: "",
	edges: [],
	createdAt: NOW - 1000,
	updatedAt: NOW - 1000,
	...extra,
});
const pr = (state, extra = {}) => ({
	url: "https://github.com/o/r/pull/7",
	number: 7,
	state,
	checkedAt: NOW,
	emitted: [],
	...extra,
});

heading("PR classification");
const open = { state: "OPEN", isDraft: false, reviewDecision: "", latestReviews: [], statusCheckRollup: [] };
check("an open PR with nothing pending is pr-open", classifyPr(open) === "pr-open");
check("a merged PR is merged", classifyPr({ ...open, state: "MERGED" }) === "merged");
check("a closed PR is closed", classifyPr({ ...open, state: "CLOSED" }) === "closed");
check("a draft is draft", classifyPr({ ...open, isDraft: true }) === "draft");
check("an approved PR is approved", classifyPr({ ...open, reviewDecision: "APPROVED" }) === "approved");
check(
	"a latest review requesting changes is changes-requested even without a review decision",
	classifyPr({ ...open, latestReviews: [{ state: "COMMENTED" }, { state: "CHANGES_REQUESTED" }] }) ===
		"changes-requested",
);
check(
	"a failed check run is ci-failing",
	classifyPr({
		...open,
		statusCheckRollup: [
			{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" },
			{ __typename: "CheckRun", status: "COMPLETED", conclusion: "TIMED_OUT" },
		],
	}) === "ci-failing",
);
check(
	"a failed status context is ci-failing",
	classifyPr({ ...open, statusCheckRollup: [{ __typename: "StatusContext", state: "ERROR" }] }) === "ci-failing",
);
check(
	"a running check is not a failure",
	classifyPr({ ...open, statusCheckRollup: [{ __typename: "CheckRun", status: "IN_PROGRESS", conclusion: "" }] }) ===
		"pr-open",
);
check(
	"requested changes outrank a failing check",
	classifyPr({
		...open,
		reviewDecision: "CHANGES_REQUESTED",
		statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" }],
	}) === "changes-requested",
);
check(
	"a merged PR stays merged whatever its checks",
	classifyPr({ ...open, state: "MERGED", isDraft: true }) === "merged",
);
check("an unknown state is rejected", classifyPr({ ...open, state: "WEIRD" }) === null);

heading("displayed status and finish");
check("without a PR the agent status shows", displayedStatus(node("a", { status: "blocked" })) === "blocked");
check(
	"a known PR outranks the agent status",
	displayedStatus(node("a", { status: "done" }), pr("approved")) === "approved",
);
check(
	"not-needed outranks the PR",
	displayedStatus(node("a", { status: "not-needed" }), pr("pr-open")) === "not-needed",
);
check("abandoned outranks the PR", displayedStatus(node("a", { status: "abandoned" }), pr("merged")) === "abandoned");
for (const status of ["merged", "closed", "not-needed", "abandoned", "done"]) {
	check(`${status} is finished`, isFinished(status));
}
for (const status of [
	"working",
	"waiting",
	"blocked",
	"pushed",
	"pr-open",
	"draft",
	"changes-requested",
	"ci-failing",
	"approved",
	"not-started",
]) {
	check(`${status} is not finished`, !isFinished(status));
}

heading("outcomes");
check("setting pushed is an outcome", outcomeOfStatus("working", "pushed") === "pushed");
check("setting done is an outcome", outcomeOfStatus("working", "done") === "done");
check("setting not-needed is an outcome", outcomeOfStatus("working", "not-needed") === "not-needed");
check("setting abandoned is an outcome", outcomeOfStatus("blocked", "abandoned") === "abandoned");
check("setting blocked is not an outcome", outcomeOfStatus("working", "blocked") === null);
check("repeating an outcome status is not a new outcome", outcomeOfStatus("pushed", "pushed") === null);
check("a PR first seen open is an outcome", outcomeOfPr(undefined, "pr-open", []) === "pr-opened");
check("a PR first seen as a draft counts as opened", outcomeOfPr(undefined, "draft", []) === "pr-opened");
check("a PR going from open to merged is merged", outcomeOfPr("approved", "merged", ["pr-opened"]) === "merged");
check("a PR first seen already merged is merged", outcomeOfPr(undefined, "merged", []) === "merged");
check("a PR closing unmerged is closed", outcomeOfPr("pr-open", "closed", ["pr-opened"]) === "closed");
check("changes requested wakes nobody", outcomeOfPr("pr-open", "changes-requested", ["pr-opened"]) === null);
check(
	"an outcome already emitted is not emitted again",
	outcomeOfPr("pr-open", "merged", ["pr-opened", "merged"]) === null,
);
check(
	"a reopened PR does not announce opening twice",
	outcomeOfPr("closed", "pr-open", ["pr-opened", "closed"]) === null,
);

heading("dependents");
const parent = node("parent", {
	edges: [
		{ from: "parent", to: "child", type: "waits-on", at: NOW },
		{ from: "parent", to: "cousin", type: "related", at: NOW },
	],
});
const child = node("child", { edges: [{ from: "grand", to: "child", type: "upstream", at: NOW }] });
const later = node("later", { edges: [{ from: "later", to: "child", type: "follows-up", at: NOW }] });
const grand = node("grand");
const cousin = node("cousin");
const all = [parent, child, later, grand, cousin];
const deps = dependentsOf(all, "child").sort();
check("upstream and waits-on edges make dependents", JSON.stringify(deps) === JSON.stringify(["grand", "parent"]));
check("follows-up and related edges never wake", !deps.includes("later"));
check(
	"an edge declared twice counts once",
	dependentsOf(
		[...all, node("parent2", { edges: [{ from: "parent", to: "child", type: "waits-on", at: NOW }] })],
		"child",
	).length === 2,
);

heading("selection");
const stale = node("stale", { updatedAt: NOW - GRAPH_RETENTION_MS - 1, status: "done" });
const staleOpen = node("stale-open", { updatedAt: NOW - GRAPH_RETENTION_MS - 1, status: "working" });
const fresh = node("fresh", { status: "done", updatedAt: NOW - GRAPH_RETENTION_MS + 60_000 });
const kept = selectNodes([...all, stale, staleOpen, fresh], "", NOW).map((n) => n.session);
check("a node untouched for a year drops out", !kept.includes("stale") && !kept.includes("stale-open"));
check("a finished node within the year stays", kept.includes("fresh"));
const repoNode = node("rs", {
	repo: "diesel-rs/diesel",
	edges: [{ from: "rs", to: "down", type: "upstream", at: NOW }],
});
const down = node("down");
const unrelated = node("unrelated");
const filtered = selectNodes([repoNode, down, unrelated], "DIESEL", NOW).map((n) => n.session);
check(
	"a filter keeps the whole component of a matching node, case-insensitively",
	filtered.includes("rs") && filtered.includes("down") && !filtered.includes("unrelated"),
);
const viaInbound = selectNodes(
	[node("x", { edges: [{ from: "x", to: "y", type: "waits-on", at: NOW }] }), node("y", { label: "needle" })],
	"needle",
	NOW,
).map((n) => n.session);
check("a component is followed against edge direction", viaInbound.includes("x"));

heading("mermaid");
const hostile = node("evil", {
	label: 'x"]; click n0 call alert() %%<b>`&',
	emoji: "\u{1F9AB}",
	edges: [
		{ from: "evil", to: "child", type: "waits-on", at: NOW },
		{ from: "evil", to: "later", type: "related", at: NOW },
		{ from: "evil", to: "gone-node", type: "waits-on", at: NOW },
	],
});
const text = toMermaid([hostile, child, later, grand], new Map([["child", pr("ci-failing")]]), NOW);
check("the output is a left-to-right flowchart", text.startsWith("flowchart LR\n"));
check("a hostile label cannot close its node", !text.includes('x"]'));
check("a hostile label cannot inject a click directive", !/^\s*click /mu.test(text));
check("a hostile label cannot start a comment", !text.includes("%%<"));
check("a hostile label carries no raw markup or backtick", !text.includes("<b>") && !text.includes("`"));
check("an upstream edge is thick and labelled", /n\d+ ==>\|upstream\| n\d+/u.test(text));
check("a waits-on edge is a labelled arrow", /n\d+ -->\|waits on\| n\d+/u.test(text));
check("a related edge has no arrow head", /n\d+ -\.-\|related\| n\d+/u.test(text));
check("an edge to a node outside the selection is dropped", !text.includes("gone-node"));
check("the PR state shows on its node", text.includes("ci-failing"));
check(
	"each node is styled by its status",
	/class n\d+ st_ci_failing/u.test(text) && text.includes("classDef st_ci_failing"),
);
check("the node carries its emoji", text.includes("\u{1F9AB}"));
const followed = toMermaid([later, child], new Map(), NOW);
check("a follows-up edge is dotted with an arrow", /n\d+ -\.->\|follows up\| n\d+/u.test(followed));
check("an empty graph still renders", toMermaid([], new Map(), NOW).startsWith("flowchart LR"));
const loners = Array.from({ length: 9 }, (_, i) => node(`solo${i}`));
const packed = toMermaid([...loners, later, child], new Map(), NOW);
const invisible = [...packed.matchAll(/^ {2}(n\d+) ~~~ (n\d+)$/gmu)].map(([, from, to]) => [from, to]);
check("separate components are chained into rows by invisible links", invisible.length === 7);
check(
	"a component joins its row from its last node, so its own edges keep their direction",
	invisible.some(([from]) => from === "n10") && !invisible.some(([, to]) => to === "n10"),
);
check("a component is entered at its first node", !invisible.some(([from]) => from === "n9"));
const rowOf = (id) => {
	let row = [id];
	for (let grew = true; grew; ) {
		grew = false;
		for (const [from, to] of invisible) {
			if (row.includes(from) && !row.includes(to)) {
				row = [...row, to];
				grew = true;
			}
			if (row.includes(to) && !row.includes(from)) {
				row = [from, ...row];
				grew = true;
			}
		}
	}
	return row;
};
check("a row spans at most four ranks", rowOf("n0").length <= 4 && rowOf("n10").length <= 3);

heading("status list");
const list = statusList(
	[
		node("a", { emoji: "\u{1F9AB}", label: "fix parser", repo: "o/r" }),
		node("b", { status: "blocked", label: "port" }),
	],
	new Map([["a", pr("approved")]]),
);
check("the list names each node with its displayed status", list.includes("fix parser") && list.includes("approved"));
const parserLine = list.split("\n").find((line) => line.includes("fix parser"));
check(
	"the list ends its node's line with the PR link",
	parserLine?.split(" \u2014 ").at(-1) === "https://github.com/o/r/pull/7",
);
check("nodes needing Luca come first", list.indexOf("port") < list.indexOf("fix parser"));
check("an empty list says so", statusList([], new Map()).length > 0);

heading("blocking cycles");
{
	const chain = [
		node("a", { edges: [{ from: "a", to: "b", type: "waits-on", at: NOW }] }),
		node("b", { edges: [{ from: "c", to: "b", type: "upstream", at: NOW }] }),
		node("c", { edges: [{ from: "b", to: "c", type: "follows-up", at: NOW }] }),
	];
	check(
		"a new blocking edge that closes a loop returns the path that forms it",
		JSON.stringify(blockingPath(chain, "b", "a")) === JSON.stringify(["a", "b"]),
	);
	check(
		"the path follows upstream edges transitively",
		JSON.stringify(blockingPath(chain, "b", "c")) === JSON.stringify(["c", "b"]),
	);
	check("an edge that closes no loop returns null", blockingPath(chain, "a", "c") === null);
	check("follow-up edges never make a loop", blockingPath(chain, "c", "b") === null);
	const ring = [
		node("x", { edges: [{ from: "x", to: "y", type: "waits-on", at: NOW }] }),
		node("y", { edges: [{ from: "y", to: "x", type: "waits-on", at: NOW }] }),
	];
	check("a loop already in the ledger does not trap the search", blockingPath(ring, "z", "x") === null);
}

heading("resume arguments");
const carried = resumeArgs([
	"--model",
	"anthropic/x",
	"--config",
	"/a.yml",
	"-p",
	"hello",
	"--resume",
	"abc",
	"fix it",
	"@file.md",
	"--api-key",
	"SECRET",
	"--thinking=high",
	"-e",
	"/ext.ts",
	"--yolo",
	"--max-time",
	"10m",
	"--fork",
	"def",
	"-c",
]);
check(
	"model, overlays, thinking, extensions and approval flags carry over to a resume",
	JSON.stringify(carried) ===
		JSON.stringify(["--model", "anthropic/x", "--config", "/a.yml", "--thinking=high", "-e", "/ext.ts", "--yolo"]),
);
check("an API key never carries over", !carried.includes("SECRET") && !carried.some((a) => a.startsWith("--api-key")));
check("a trailing value flag with no value is dropped", resumeArgs(["--model"]).length === 0);

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);

// The pure dependency-graph helpers, called directly. No fake server, no session, no sleeping.

import { readFileSync } from "node:fs";
import {
	blockingPath,
	buildWatchQuery,
	ciVerdict,
	classifyPr,
	dependentsOf,
	diffWatch,
	displayedStatus,
	failingCheckNames,
	GRAPH_RETENTION_MS,
	isFinished,
	outcomeOfPr,
	outcomeOfStatus,
	parseWatchQuery,
	prWatchName,
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

heading("watch verdicts");
const checkRun = (name, conclusion, status = "COMPLETED") => ({ __typename: "CheckRun", name, conclusion, status });
const statusCtx = (context, state) => ({ __typename: "StatusContext", context, state });
check("no checks on the head is no verdict", ciVerdict([]) === null);
check("a single successful run is green", ciVerdict([checkRun("ci", "SUCCESS")]) === "green");
check(
	"success, neutral, skipped and a passing status context all count as green",
	ciVerdict([
		checkRun("a", "SUCCESS"),
		checkRun("b", "NEUTRAL"),
		checkRun("c", "SKIPPED"),
		statusCtx("codecov/patch", "SUCCESS"),
	]) === "green",
);
check("a failed run is red", ciVerdict([checkRun("a", "SUCCESS"), checkRun("b", "FAILURE")]) === "red");
check("every failure conclusion is red", ciVerdict([checkRun("b", "STARTUP_FAILURE")]) === "red");
check("a failed status context is red", ciVerdict([statusCtx("codecov/patch", "FAILURE")]) === "red");
check("an errored status context is red", ciVerdict([statusCtx("deploy", "ERROR")]) === "red");
check(
	"an expected status context keeps the verdict open",
	ciVerdict([checkRun("a", "SUCCESS"), statusCtx("deploy", "EXPECTED")]) === null,
);
check(
	"a run that has not completed is pending even with a green conclusion",
	ciVerdict([checkRun("a", "SUCCESS", "QUEUED"), checkRun("b", null, "IN_PROGRESS")]) === null,
);
check("a pending status context keeps the verdict open", ciVerdict([statusCtx("b", "PENDING")]) === null);
check("red wins over pending", ciVerdict([checkRun("a", "FAILURE"), checkRun("b", null)]) === "red");
check("a stale conclusion is neither red nor green", ciVerdict([checkRun("a", "STALE")]) === null);
check(
	"only the failing checks are named, and a status context is named by its context",
	JSON.stringify(
		failingCheckNames([
			checkRun("a", "SUCCESS"),
			checkRun("b", "FAILURE"),
			statusCtx("codecov", "FAILURE"),
			statusCtx("deploy", "ERROR"),
			statusCtx("lint", "SUCCESS"),
		]),
	) === JSON.stringify(["b", "codecov", "deploy"]),
);

heading("watch events");
const watch = (extra = {}) => ({
	url: "https://github.com/o/r/pull/7",
	owner: "o",
	name: "r",
	number: 7,
	by: "01a00000-0000-0000-0000-000000000000",
	at: NOW,
	seeded: true,
	head: "h1",
	redSent: false,
	greenSent: false,
	reviews: [],
	...extra,
});
const review = (id, author = "alice", state = "COMMENTED", body = "a note", at = "2026-11-07T10:00:00Z") => ({
	id,
	author,
	state,
	body,
	submittedAt: at,
});
const prData = (state, extra = {}) => ({
	number: 7,
	state,
	isDraft: false,
	headRefOid: "h1",
	commitOid: "h1",
	reviews: [],
	contexts: [],
	...extra,
});
const first = diffWatch(
	watch({ seeded: false, head: null }),
	prData("OPEN", { reviews: [review("r1")], contexts: [checkRun("ci", "FAILURE")] }),
);
check("a first poll seeds the watch instead of firing what is already true", first.events.length === 0);
check(
	"the seed records the head, the seen reviews and the verdict",
	first.next.seeded === true &&
		first.next.head === "h1" &&
		JSON.stringify(first.next.reviews) === '["r1"]' &&
		first.next.redSent === true &&
		first.next.greenSent === false,
);
check(
	"a first poll on a merged pull request still ends the watch",
	diffWatch(watch({ seeded: false }), prData("MERGED")).events[0].event === "merged",
);
check("a missing pull request is gone", diffWatch(watch(), null).events[0].event === "gone");

const seeded = diffWatch(watch({}), prData("OPEN", { reviews: [review("r1")] })).next;
const second = diffWatch(
	seeded,
	prData("OPEN", { reviews: [review("r1"), review("r2", "alice", "APPROVED", "looks good")] }),
);
check(
	"a new review by the same author is a new event",
	second.events.length === 1 &&
		second.events[0].event === "review" &&
		second.events[0].reviewer === "alice" &&
		second.events[0].verdict === "APPROVED" &&
		second.events[0].body === "looks good",
);
const again = diffWatch(
	second.next,
	prData("OPEN", { reviews: [review("r1"), review("r2", "alice", "APPROVED", "looks good")] }),
);
check("a seen review fires nothing twice", again.events.length === 0);
const multi = diffWatch(
	seeded,
	prData("OPEN", {
		reviews: [
			review("r1"),
			review("rb", "bob", "COMMENTED", "later", "2026-11-07T11:00:00Z"),
			review("ra", "carol", "APPROVED", "earlier", "2026-11-07T10:30:00Z"),
		],
	}),
);
check(
	"fresh reviews are sent in the order they were submitted",
	JSON.stringify(multi.events.map((e) => e.reviewer)) === JSON.stringify(["carol", "bob"]),
);
check(
	"a review whose author is gone is named honestly",
	diffWatch(seeded, prData("OPEN", { reviews: [review("r9", null)] })).events[0].reviewer === "an unknown author",
);

const red = diffWatch(seeded, prData("OPEN", { contexts: [checkRun("ci", "FAILURE")] }));
check(
	"red CI on a seeded head fires once with the failing names",
	red.events[0].event === "ci-red" &&
		JSON.stringify(red.events[0].checks) === JSON.stringify(["ci"]) &&
		red.next.redSent === true,
);
check(
	"red CI on the same head fires nothing twice",
	diffWatch(red.next, prData("OPEN", { contexts: [checkRun("ci", "FAILURE")] })).events.length === 0,
);
const green = diffWatch(red.next, prData("OPEN", { contexts: [checkRun("ci", "SUCCESS")] }));
check(
	"green after red on the same head is sent too",
	green.events[0].event === "ci-green" && green.next.greenSent === true,
);
const pushed = diffWatch(
	green.next,
	prData("OPEN", { headRefOid: "h2", commitOid: "h2", contexts: [checkRun("ci", "FAILURE")] }),
);
check("a new head may fire red and green again", pushed.events[0].event === "ci-red" && pushed.next.head === "h2");
const waiting = diffWatch(pushed.next, prData("OPEN", { headRefOid: "h3" }));
check(
	"a push whose checks are pending sends nothing",
	waiting.events.length === 0 && waiting.next.head === "h3" && waiting.next.redSent === false,
);
check("an open pull request with no checks never goes green", diffWatch(watch(), prData("OPEN")).events.length === 0);
const staleHead = diffWatch(
	seeded,
	prData("OPEN", { headRefOid: "h2", commitOid: "h1", contexts: [checkRun("ci", "SUCCESS")] }),
);
check(
	"checks on a head the pull request no longer has fire nothing",
	staleHead.events.length === 0 &&
		staleHead.next.head === "h2" &&
		staleHead.next.redSent === false &&
		staleHead.next.greenSent === false,
);
check(
	"green fires on the new head once its checks are its own",
	diffWatch(
		staleHead.next,
		prData("OPEN", { headRefOid: "h2", commitOid: "h2", contexts: [checkRun("ci", "SUCCESS")] }),
	).events[0].event === "ci-green",
);
check("a merged pull request ends the watch", diffWatch(watch(), prData("MERGED")).next === null);
check("a closed pull request ends the watch", diffWatch(watch(), prData("CLOSED")).events[0].event === "closed");

heading("watch query");
const entries = [
	{ alias: "w0", owner: "o", name: "r", number: 7 },
	{ alias: "w1", owner: "other", name: "repo", number: 8 },
];
const query = buildWatchQuery(entries);
check(
	"the query aliases one repository per watched pull request",
	query.includes('w0: repository(owner: "o", name: "r")') &&
		query.includes('w1: repository(owner: "other", name: "repo")'),
);
// The exact per-pull-request field set verified live against the GraphQL API. Any drift in
// buildWatchQuery fails the suite.
const verifiedFields = [
	"number",
	"state",
	"isDraft",
	"headRefOid",
	"reviews(last: 50) { nodes { id author { login } state body submittedAt } }",
	"statusCheckRollup { commit { oid } contexts(first: 100) { nodes { __typename ... on CheckRun { name status conclusion } ... on StatusContext { context state } } } }",
].join("\n");
check(
	"the query matches the shape verified against the live GraphQL API",
	buildWatchQuery([{ alias: "w0", owner: "apache", name: "datafusion-sqlparser-rs", number: 2829 }]) ===
		`query {\nw0: repository(owner: "apache", name: "datafusion-sqlparser-rs") { pullRequest(number: 2829) { ${verifiedFields} } }\n}`,
);
const live = JSON.parse(readFileSync(new URL("./pr-watch-live.json", import.meta.url), "utf8"));
const liveParsed = parseWatchQuery(live, ["w0", "w1"]);
check(
	"the captured live answer parses with the watched pull request's data",
	liveParsed !== null &&
		liveParsed.get("w0").gone === false &&
		liveParsed.get("w0").data.state === "OPEN" &&
		liveParsed.get("w0").data.reviews.length > 0 &&
		liveParsed.get("w0").data.contexts.length > 0 &&
		liveParsed.get("w0").data.commitOid === liveParsed.get("w0").data.headRefOid,
);
check(
	"the captured live answer names the pull request GitHub cannot find",
	liveParsed.get("w1").gone === true && liveParsed.get("w1").data === null,
);
const reviewNode = (id, login, state, body, submittedAt = "2026-11-07T10:00:00Z") => ({
	id,
	author: login === null ? null : { login },
	state,
	body,
	submittedAt,
});
const response = () => ({
	data: {
		w0: {
			pullRequest: {
				number: 7,
				state: "OPEN",
				isDraft: false,
				headRefOid: "h1",
				reviews: {
					nodes: [
						reviewNode("r1", "alice", "COMMENTED", "hi"),
						reviewNode("r2", null, "APPROVED", ""),
						reviewNode("r3", "luca", "PENDING", "draft", null),
					],
				},
				statusCheckRollup: { commit: { oid: "h1" }, contexts: { nodes: [checkRun("ci", "SUCCESS")] } },
			},
		},
		w1: {
			pullRequest: {
				number: 8,
				state: "OPEN",
				isDraft: true,
				headRefOid: "h8",
				reviews: { nodes: [] },
				statusCheckRollup: null,
			},
		},
	},
});
const parsed = parseWatchQuery(response(), ["w0", "w1"]);
check(
	"the batch parses with each pull request's submitted reviews and checks",
	parsed !== null &&
		parsed.get("w0").gone === false &&
		parsed.get("w0").data.state === "OPEN" &&
		parsed
			.get("w0")
			.data.reviews.map((review) => review.id)
			.join(",") === "r1,r2",
);
check("a review whose account was deleted keeps a null author", parsed.get("w0").data.reviews[1].author === null);
check(
	"a pull request without checks parses with no verdict commit and no checks",
	parsed.get("w1").data.reviews.length === 0 &&
		parsed.get("w1").data.contexts.length === 0 &&
		parsed.get("w1").data.commitOid === null,
);
check("the rollup's commit is the commit its checks belong to", parsed.get("w0").data.commitOid === "h1");
const pathless = parseWatchQuery({ ...response(), errors: [{ message: "Something went wrong." }] }, ["w0", "w1"]);
check(
	"an error naming no alias beside the data leaves every pull request's result standing",
	pathless !== null && pathless.get("w0").data !== null && pathless.get("w0").error === "",
);
const goneRaw = response();
delete goneRaw.data.w0;
const gone = parseWatchQuery(
	{
		...goneRaw,
		errors: [
			{
				path: ["w0", "pullRequest"],
				message: "Could not resolve to a PullRequest with the number of 7.",
				type: "NOT_FOUND",
			},
		],
	},
	["w0", "w1"],
);
check(
	"a pull request GitHub no longer finds is gone",
	gone !== null && gone.get("w0").gone === true && gone.get("w0").data === null && gone.get("w1").gone === false,
);
const repoGone = parseWatchQuery(
	{
		data: { w0: null },
		errors: [
			{
				type: "NOT_FOUND",
				path: ["w0"],
				locations: [{ line: 1, column: 1 }],
				message: "Could not resolve to a Repository with the name 'o/r'. (repository)",
			},
		],
	},
	["w0"],
);
check("a repository GitHub no longer resolves is gone", repoGone !== null && repoGone.get("w0").gone === true);
const broken = parseWatchQuery({ ...goneRaw, errors: [{ path: ["w0"], message: "Something else broke." }] }, ["w0"]);
check(
	"an error that is not a disappearance keeps the stored state",
	broken !== null && broken.get("w0").gone === false && broken.get("w0").data === null,
);
const hollow = parseWatchQuery(
	{
		data: { w0: { pullRequest: null } },
		errors: [{ path: ["w0", "pullRequest"], message: "Could not resolve to a PullRequest with the number of 7." }],
	},
	["w0"],
);
check(
	"a null pull request without a NOT_FOUND error is not gone and keeps GitHub's message",
	hollow !== null &&
		hollow.get("w0").gone === false &&
		hollow.get("w0").data === null &&
		hollow.get("w0").error === "Could not resolve to a PullRequest with the number of 7.",
);
check(
	"a NOT_FOUND type alone makes the pull request gone, whatever the message",
	parseWatchQuery(
		{
			data: { w0: { pullRequest: null } },
			errors: [{ type: "NOT_FOUND", path: ["w0", "pullRequest"], message: "A disappearance by any name." }],
		},
		["w0"],
	).get("w0").gone === true,
);
check(
	"a query-level error discards the whole batch",
	parseWatchQuery({ errors: [{ path: ["$query"], message: "GraphQL API rate limit exceeded" }] }, ["w0"]) === null,
);
check(
	"a validation error discards the whole batch",
	parseWatchQuery(
		{
			errors: [
				{
					type: "Validation",
					path: ["query"],
					locations: [{ line: 1, column: 1 }],
					message: "Field 'pullRequest' does not exist on type 'Repository'.",
				},
			],
		},
		["w0"],
	) === null,
);
check("an answer without data discards the whole batch", parseWatchQuery({}, ["w0"]) === null);
check("an answer whose data is null discards the whole batch", parseWatchQuery({ data: null }, ["w0"]) === null);
check(
	"the file name is built from the pull request's parts",
	prWatchName("o", "r", 7) === "o+r+7" &&
		prWatchName("LucaCappelletti94", "sqlparser", 123) === "LucaCappelletti94+sqlparser+123",
);
check(
	"dash-bearing names that could collide get distinct file names",
	prWatchName("a-b", "c", 1) === "a-b+c+1" && prWatchName("a", "b-c", 1) !== prWatchName("a-b", "c", 1),
);

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);

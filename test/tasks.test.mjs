// Task names, the `/conduct` text, and the task files conductors and the poller share.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	changeTask,
	conductorRole,
	listTasks,
	memberRole,
	parseConduct,
	readTask,
	taskSlug,
	updateTask,
} from "../tasks.ts";

let fails = 0;
const heading = (title) => {
	console.log(`\n-- ${title}`);
};
const check = (label, ok) => {
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
	if (!ok) fails++;
};

heading("task names");
check("a name becomes lower-case words joined by hyphens", taskSlug("Connetto Quotas") === "connetto-quotas");
check(
	"punctuation and repeated separators collapse",
	taskSlug("  R87: quotas -- server/client ") === "r87-quotas-server-client",
);
check("accents fold to their base letter", taskSlug("Déjà vu") === "deja-vu");
check("a name with no letter or digit has no slug", taskSlug("!!! ---") === "");
check(
	"a long name is cut to 40 characters without a trailing hyphen",
	taskSlug(`${"a".repeat(39)} b`) === "a".repeat(39) && taskSlug("x".repeat(60)).length === 40,
);

heading("the /conduct text");
{
	const both = parseConduct("/conduct Connetto quotas\nKeep the server and client PRs in step.\n\nBoth repos.");
	check(
		"the first line is the name and the rest the brief",
		both.name === "Connetto quotas" && both.brief === "Keep the server and client PRs in step.\n\nBoth repos.",
	);
	const addressed = parseConduct("/conduct@pippo_bot  Docs pass  ");
	check("the bot suffix and surrounding blanks are dropped", addressed.name === "Docs pass" && addressed.brief === "");
	const bare = parseConduct("/conduct");
	check("a bare command names nothing", bare.name === "" && bare.brief === "");
	const briefFirst = parseConduct("/conduct\nOnly a brief");
	check(
		"a brief on the line after a bare command still names the task by that line",
		briefFirst.name === "Only a brief",
	);
}

heading("task files");
{
	const dir = mkdtempSync(join(tmpdir(), "tasks-test-"));
	const fresh = {
		name: "Docs pass",
		slug: "docs-pass",
		brief: "b",
		conductor: "",
		state: "live",
		launchedAt: 5,
		members: [{ session: "m", joinedAt: 1 }],
		candidates: [{ session: "c", card: "0a1b2c3d", state: "skipped" }],
		led: ["s"],
		closing: true,
		findings: [
			{
				id: "0f1e2d3c",
				kind: "overlap",
				sessions: ["m"],
				subject: "overlap:a",
				text: "t",
				suggested: "",
				messageId: null,
				state: "open",
			},
		],
		register: [
			{
				id: "1a2b3c4d",
				kind: "claim",
				author: "m",
				title: "t",
				body: "b",
				status: "proposed",
				supersedes: "",
				proposedAt: 1,
				decidedAt: 0,
				reason: "",
				upheld: true,
			},
		],
	};
	const made = await changeTask(dir, "docs-pass", (task) => ({ task: task === null ? fresh : task, result: task }));
	check("an absent task reads as null inside the change", made === null);
	check("a change writes the task it returns", JSON.stringify(readTask(dir, "docs-pass")) === JSON.stringify(fresh));
	const untouched = readFileSync(join(dir, "docs-pass.json"), "utf8");
	await changeTask(dir, "docs-pass", () => ({ task: null, result: undefined }));
	check("returning no task leaves the file as it was", readFileSync(join(dir, "docs-pass.json"), "utf8") === untouched);
	writeFileSync(join(dir, "torn.json"), "{");
	writeFileSync(join(dir, "wrong.json"), JSON.stringify({ ...fresh, slug: "elsewhere" }));
	writeFileSync(join(dir, "bad-state.json"), JSON.stringify({ ...fresh, slug: "bad-state", state: "paused" }));
	writeFileSync(join(dir, "scalar.json"), "5");
	writeFileSync(join(dir, "no-conductor.json"), JSON.stringify({ ...fresh, slug: "no-conductor", conductor: 7 }));
	await changeTask(dir, "alpha", () => ({ task: { ...fresh, name: "Alpha", slug: "alpha" }, result: null }));
	check(
		"listing skips torn and scalar files, files named for another slug, bad fields and unknown states, sorted by name",
		listTasks(dir)
			.map((task) => task.slug)
			.join() === "alpha,docs-pass",
	);
	check("a slug outside the pattern reads as no task", readTask(dir, "../docs-pass") === null);
	let refused = false;
	try {
		await changeTask(dir, "../escape", () => ({ task: fresh, result: null }));
	} catch {
		refused = true;
	}
	check("a change refuses a slug outside the pattern", refused);
	const bumped = await updateTask(dir, "docs-pass", (task) => ({
		task: { ...task, launchedAt: task.launchedAt + 1 },
		result: "seen",
	}));
	check("an update changes a task that exists", bumped === "seen" && readTask(dir, "docs-pass").launchedAt === 6);
	let called = false;
	const absent = await updateTask(dir, "nobody", () => {
		called = true;
		return { task: fresh, result: "seen" };
	});
	check("an update of an absent task changes nothing", absent === null && !called && readTask(dir, "nobody") === null);
	check(
		"an update of a slug outside the pattern gives null",
		(await updateTask(dir, "../escape", () => ({ task: fresh, result: "seen" }))) === null,
	);
	const { members, candidates, led, closing, findings, register, ...older } = fresh;
	writeFileSync(join(dir, "older.json"), JSON.stringify({ ...older, slug: "older" }));
	const plain = readTask(dir, "older");
	check(
		"a task written before membership reads with no members, candidates, leads or findings",
		plain.members.length === 0 &&
			plain.candidates.length === 0 &&
			plain.led.length === 0 &&
			plain.closing === false &&
			plain.findings.length === 0 &&
			plain.register.length === 0,
	);
	writeFileSync(
		join(dir, "mixed.json"),
		JSON.stringify({
			...fresh,
			slug: "mixed",
			members: [null, { session: 1, joinedAt: 2 }, ...members],
			candidates: [
				{ session: "c", card: "x", state: "joined" },
				{ session: "c", card: 3, state: "proposed" },
				...candidates,
			],
			led: [4, ...led],
			findings: [
				{ ...findings[0], id: 5 },
				{ ...findings[0], kind: "gossip" },
				{ ...findings[0], sessions: "m" },
				{ ...findings[0], sessions: [1] },
				{ ...findings[0], subject: null },
				{ ...findings[0], text: 1 },
				{ ...findings[0], suggested: 1 },
				{ ...findings[0], messageId: "7" },
				{ ...findings[0], state: "lost" },
				{ ...findings[0], messageId: 42 },
			],
			register: [
				{ ...register[0], id: 5 },
				{ ...register[0], kind: "wish" },
				{ ...register[0], author: 1 },
				{ ...register[0], title: 1 },
				{ ...register[0], body: 1 },
				{ ...register[0], status: "lost" },
				{ ...register[0], supersedes: 1 },
				{ ...register[0], proposedAt: "1" },
				{ ...register[0], decidedAt: "0" },
				{ ...register[0], reason: 1 },
				{ ...register[0], kind: "decision", upheld: undefined },
			],
		}),
	);
	const mixed = readTask(dir, "mixed");
	check(
		"malformed members, candidates, leads and findings are dropped, well-formed ones kept",
		JSON.stringify(mixed.members) === JSON.stringify(members) &&
			JSON.stringify(mixed.candidates) === JSON.stringify(candidates) &&
			JSON.stringify(mixed.led) === JSON.stringify(led) &&
			JSON.stringify(mixed.findings) === JSON.stringify([{ ...findings[0], messageId: 42 }]) &&
			JSON.stringify(mixed.register) === JSON.stringify([{ ...register[0], kind: "decision", upheld: false }]),
	);
	rmSync(dir, { recursive: true, force: true });
}

heading("the conductor's role");
{
	const role = conductorRole({
		name: "Connetto quotas",
		slug: "connetto-quotas",
		brief: "Keep the server and client PRs in step.",
		conductor: "c",
		state: "live",
		launchedAt: 0,
	});
	check(
		"the role names the task and carries the brief",
		role.includes("Connetto quotas") && role.includes("Keep the server and client PRs in step."),
	);
	check(
		"the role says how to reach Luca and the sessions",
		role.includes("notify_status") && role.includes("session_message"),
	);
	check("the role names the command that reopens it", role.includes("/conduct Connetto quotas"));
}

heading("the member's instruction");
{
	const one = memberRole([{ name: "Docs", conductor: "🎼 docs (tag ab12c)" }]);
	check(
		"one task is named with its conductor's address",
		one.includes("a task:") && one.includes('"Docs", conducted by the session 🎼 docs (tag ab12c)'),
	);
	const two = memberRole([
		{ name: "Docs", conductor: "a" },
		{ name: "Quotas", conductor: "b" },
	]);
	check(
		"several tasks are counted and each listed",
		two.includes("2 tasks:") && two.includes('"Quotas", conducted by the session b'),
	);
	check(
		"the instruction says how to claim work and record decisions",
		one.includes("`claim`") && one.includes("`propose`"),
	);
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);

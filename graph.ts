/**
 * Pure dependency-graph helpers: status derivation, outcomes, selection, Mermaid and list rendering.
 * Nothing here touches the filesystem or the network, so `test/graph.test.mjs` drives it directly.
 */

export const GRAPH_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;

export const EDGE_TYPES = ["upstream", "waits-on", "follows-up", "related"] as const;
export type EdgeType = (typeof EDGE_TYPES)[number];

export const AGENT_STATUSES = ["working", "waiting", "blocked", "pushed", "done", "not-needed", "abandoned"] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

/** `gone` is a pull request GitHub no longer finds, with its repository or itself deleted. */
export type PrState =
	| "pr-open"
	| "draft"
	| "changes-requested"
	| "ci-failing"
	| "approved"
	| "merged"
	| "closed"
	| "gone";

/** `not-started` marks a launch whose child session never claimed it. */
export type DisplayStatus = AgentStatus | PrState | "not-started";

export type Outcome = "pushed" | "done" | "not-needed" | "abandoned" | "pr-opened" | "merged" | "closed" | "gone";

export interface GraphEdge {
	from: string;
	to: string;
	type: EdgeType;
	at: number;
}

export interface GraphNode {
	session: string;
	label: string;
	emoji: string;
	tag: string;
	cwd: string;
	/** `owner/name` of the repository whose PR this node's work lands in. */
	repo?: string;
	/** Head branch, as `owner:branch` when it lives on a fork. */
	branch?: string;
	status: AgentStatus | "not-started";
	note: string;
	pr?: string;
	edges: GraphEdge[];
	createdAt: number;
	updatedAt: number;
}

export interface PrRecord {
	url: string;
	number: number;
	state: PrState;
	checkedAt: number;
	/** When `state` last changed, which keeps a node with a moving PR inside the retention window. */
	changedAt: number;
	/** PR outcomes already sent to dependents, so a repeated poll sends nothing twice. */
	emitted: Outcome[];
}

const FINISHED: Partial<Record<DisplayStatus, true>> = {
	merged: true,
	closed: true,
	gone: true,
	"not-needed": true,
	abandoned: true,
	done: true,
};
const STATUS_OUTCOMES: Partial<Record<AgentStatus, Outcome>> = {
	pushed: "pushed",
	done: "done",
	"not-needed": "not-needed",
	abandoned: "abandoned",
};
const FAILED_CONCLUSIONS: Record<string, true> = {
	FAILURE: true,
	ERROR: true,
	TIMED_OUT: true,
	CANCELLED: true,
	ACTION_REQUIRED: true,
	STARTUP_FAILURE: true,
};

export function isFinished(status: DisplayStatus): boolean {
	return FINISHED[status] === true;
}

export function displayedStatus(node: GraphNode, pr?: PrRecord): DisplayStatus {
	if (node.status === "not-needed" || node.status === "abandoned") return node.status;
	return pr?.state ?? node.status;
}

export function outcomeOfStatus(before: string | undefined, after: AgentStatus): Outcome | null {
	const outcome = STATUS_OUTCOMES[after];
	return outcome !== undefined && before !== after ? outcome : null;
}

export function outcomeOfPr(before: PrState | undefined, after: PrState, emitted: readonly Outcome[]): Outcome | null {
	const outcome: Outcome =
		after === "merged" ? "merged" : after === "closed" ? "closed" : after === "gone" ? "gone" : "pr-opened";
	if (emitted.includes(outcome) || before === after) return null;
	return outcome;
}

/** A check run or status context on a head commit, typed by GitHub's GraphQL schema. */
export interface WatchCheckRun {
	__typename: "CheckRun";
	name: string;
	status: string;
	/** Null until the run completes. */
	conclusion: string | null;
}
export interface WatchStatusContext {
	__typename: "StatusContext";
	context: string;
	state: string;
}
export type WatchContext = WatchCheckRun | WatchStatusContext;

export interface WatchReview {
	id: string;
	/** Null when the reviewer's account was deleted. */
	author: string | null;
	state: string;
	body: string;
	submittedAt: string;
}

export interface WatchPrData {
	number: number;
	state: string;
	isDraft: boolean;
	headRefOid: string;
	/** The commit the checks belong to, null when the pull request has no checks. */
	commitOid: string | null;
	reviews: WatchReview[];
	contexts: WatchContext[];
}

export const PR_EVENTS = ["merged", "closed", "review", "ci-red", "ci-green", "gone"] as const;
export type PrEvent = (typeof PR_EVENTS)[number];

/** The stored state of one watch, one file per watching session per pull request. */
export interface PrWatch {
	url: string;
	owner: string;
	name: string;
	number: number;
	by: string;
	at: number;
	seeded: boolean;
	head: string | null;
	redSent: boolean;
	greenSent: boolean;
	reviews: string[];
}

export type WatchEvent =
	| { event: "merged" }
	| { event: "closed" }
	| { event: "gone" }
	| { event: "ci-green" }
	| { event: "ci-red"; checks: string[] }
	| { event: "review"; reviewer: string; verdict: string; body: string };

const OK_CONCLUSIONS: Record<string, true> = { SUCCESS: true, NEUTRAL: true, SKIPPED: true };

/** The verdict of the checks on a head commit, where null is nothing red and not fully green yet. */
export function ciVerdict(contexts: readonly WatchContext[]): "red" | "green" | null {
	if (contexts.length === 0) return null;
	let pending = false;
	for (const context of contexts) {
		if (context.__typename === "StatusContext") {
			if (context.state === "FAILURE" || context.state === "ERROR") return "red";
			if (context.state === "PENDING" || context.state === "EXPECTED") pending = true;
			continue;
		}
		if (context.status !== "COMPLETED") {
			pending = true;
			continue;
		}
		if (FAILED_CONCLUSIONS[String(context.conclusion)] === true) return "red";
		if (OK_CONCLUSIONS[String(context.conclusion)] !== true) pending = true;
	}
	return pending ? null : "green";
}

/** The CI verdict of a fetched pull request, counted only when its checks belong to its head commit. */
export function verdictOf(data: WatchPrData): "red" | "green" | null {
	if (data.commitOid !== data.headRefOid) return null;
	return ciVerdict(data.contexts);
}

/** The names of the checks that concluded a failure, for the red event. */
export function failingCheckNames(contexts: readonly WatchContext[]): string[] {
	const names: string[] = [];
	for (const context of contexts) {
		if (context.__typename === "StatusContext") {
			if (context.state === "FAILURE" || context.state === "ERROR") names.push(context.context);
		} else if (FAILED_CONCLUSIONS[String(context.conclusion)] === true) {
			names.push(context.name);
		}
	}
	return names;
}

export interface WatchQueryEntry {
	alias: string;
	owner: string;
	name: string;
	number: number;
}

/** One batched GraphQL query, with an aliased `repository { pullRequest }` per watched pull request. */
export function buildWatchQuery(entries: readonly WatchQueryEntry[]): string {
	const fields = [
		"number",
		"state",
		"isDraft",
		"headRefOid",
		"reviews(last: 50) { nodes { id author { login } state body submittedAt } }",
		"statusCheckRollup { commit { oid } contexts(first: 100) { nodes { __typename ... on CheckRun { name status conclusion } ... on StatusContext { context state } } } }",
	].join("\n");
	const aliases = entries.map(
		(entry) =>
			`${entry.alias}: repository(owner: "${entry.owner}", name: "${entry.name}") { pullRequest(number: ${entry.number}) { ${fields} } }`,
	);
	return `query {\n${aliases.join("\n")}\n}`;
}

export interface WatchFetch {
	/** The pull request, null when GitHub did not return it. */
	data: WatchPrData | null;
	/** GitHub no longer finds the pull request or its repository. */
	gone: boolean;
	/** GitHub's message for this alias, empty when it reported none. */
	error: string;
}

/** One pull request as the watch query returns it. */
interface GqlPullRequest {
	number: number;
	state: string;
	isDraft: boolean;
	headRefOid: string;
	reviews: {
		nodes: { id: string; author: { login: string } | null; state: string; body: string; submittedAt: string | null }[];
	};
	statusCheckRollup: { commit: { oid: string }; contexts: { nodes: WatchContext[] } } | null;
}

/** A GraphQL error. A query-level one, such as a rate limit, carries no path. */
interface GqlError {
	type?: string;
	path?: (string | number)[];
	message: string;
}

/** The answer of `gh api graphql`, absent `data` when the query as a whole failed. */
export interface WatchQueryAnswer {
	data?: Record<string, { pullRequest: GqlPullRequest | null } | null> | null;
	errors?: GqlError[];
}

/**
 * The per-alias result of one batched query, or null when the query as a whole failed and no stored state
 * may be trusted. An alias GitHub returned no pull request for keeps its stored state unless its error
 * says the pull request or its repository is gone.
 */
export function parseWatchQuery(answer: WatchQueryAnswer, aliases: readonly string[]): Map<string, WatchFetch> | null {
	const data = answer.data;
	if (!data) return null;
	const errors = answer.errors ?? [];
	const out = new Map<string, WatchFetch>();
	for (const alias of aliases) {
		const pr = data[alias]?.pullRequest ?? null;
		const error = errors.find((candidate) => candidate.path?.[0] === alias);
		out.set(alias, {
			data: pr === null ? null : watchPrOf(pr),
			gone: error?.type === "NOT_FOUND",
			error: error?.message ?? "",
		});
	}
	return out;
}

/** The pull request of one alias, without the reviews still pending, which only their author can see. */
function watchPrOf(pr: GqlPullRequest): WatchPrData {
	const reviews: WatchReview[] = [];
	for (const review of pr.reviews.nodes) {
		if (review.submittedAt === null) continue;
		reviews.push({
			id: review.id,
			author: review.author?.login ?? null,
			state: review.state,
			body: review.body,
			submittedAt: review.submittedAt,
		});
	}
	return {
		number: pr.number,
		state: pr.state,
		isDraft: pr.isDraft,
		headRefOid: pr.headRefOid,
		commitOid: pr.statusCheckRollup?.commit.oid ?? null,
		reviews,
		contexts: pr.statusCheckRollup?.contexts.nodes ?? [],
	};
}

/**
 * The new events of one poll of a watch and the stored state after them. A `data` of null is a pull
 * request GitHub no longer finds, and a merged or closed pull request ends the watch, so the state
 * comes back null.
 */
export function diffWatch(watch: PrWatch, data: WatchPrData | null): { events: WatchEvent[]; next: PrWatch | null } {
	if (data === null) return { events: [{ event: "gone" }], next: null };
	if (data.state === "MERGED") return { events: [{ event: "merged" }], next: null };
	if (data.state === "CLOSED") return { events: [{ event: "closed" }], next: null };
	const events: WatchEvent[] = [];
	const next: PrWatch = { ...watch, reviews: [...watch.reviews] };
	// The first poll of an unseeded watch only records what is already true.
	if (!watch.seeded) {
		next.seeded = true;
		next.head = data.headRefOid;
		next.reviews = data.reviews.map((review) => review.id);
		const verdict = verdictOf(data);
		next.redSent = verdict === "red";
		next.greenSent = verdict === "green";
		return { events, next };
	}
	if (data.headRefOid !== watch.head) {
		next.head = data.headRefOid;
		next.redSent = false;
		next.greenSent = false;
	}
	const fresh = data.reviews
		.filter((review) => !next.reviews.includes(review.id))
		.sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
	for (const review of fresh) {
		events.push({
			event: "review",
			reviewer: review.author ?? "an unknown author",
			verdict: review.state,
			body: review.body,
		});
		next.reviews.push(review.id);
	}
	const verdict = verdictOf(data);
	if (verdict === "red" && !next.redSent) {
		events.push({ event: "ci-red", checks: failingCheckNames(data.contexts) });
		next.redSent = true;
	}
	if (verdict === "green" && !next.greenSent) {
		events.push({ event: "ci-green" });
		next.greenSent = true;
	}
	return { events, next };
}

/** The base name of a watch file, from the pull request's validated parts. `+` keeps the parts apart, since GitHub names may hold dashes. */
export function prWatchName(owner: string, name: string, number: number): string {
	return `${owner}+${name}+${number}`;
}

interface GhCheck {
	__typename?: string;
	status?: string;
	conclusion?: string;
	state?: string;
}

export interface GhPr {
	state?: string;
	isDraft?: boolean;
	reviewDecision?: string;
	latestReviews?: { state?: string }[];
	statusCheckRollup?: GhCheck[];
}

/** Maps `gh pr view --json state,isDraft,reviewDecision,latestReviews,statusCheckRollup` onto a state. */
export function classifyPr(pr: GhPr): PrState | null {
	if (pr.state === "MERGED") return "merged";
	if (pr.state === "CLOSED") return "closed";
	if (pr.state !== "OPEN") return null;
	if (pr.isDraft === true) return "draft";
	const changes =
		pr.reviewDecision === "CHANGES_REQUESTED" ||
		(pr.latestReviews ?? []).some((review) => review.state === "CHANGES_REQUESTED");
	if (changes) return "changes-requested";
	const failing = (pr.statusCheckRollup ?? []).some((check) =>
		check.__typename === "StatusContext"
			? check.state === "FAILURE" || check.state === "ERROR"
			: FAILED_CONCLUSIONS[check.conclusion ?? ""] === true,
	);
	if (failing) return "ci-failing";
	if (pr.reviewDecision === "APPROVED") return "approved";
	return "pr-open";
}

function uniqueEdges(nodes: readonly GraphNode[]): GraphEdge[] {
	const seen = new Map<string, GraphEdge>();
	for (const node of nodes) {
		for (const edge of node.edges) seen.set(`${edge.type}\u0000${edge.from}\u0000${edge.to}`, edge);
	}
	return [...seen.values()];
}

/** Sessions that an outcome of `session` wakes: those with an `upstream` or `waits-on` edge to it. */
export function dependentsOf(nodes: readonly GraphNode[], session: string): string[] {
	const found = new Set<string>();
	for (const edge of uniqueEdges(nodes)) {
		if (edge.to === session && (edge.type === "upstream" || edge.type === "waits-on")) found.add(edge.from);
	}
	return [...found];
}

/**
 * The chain of blocking edges by which `to` already waits on `from`, from `to` to `from`, or null. A new
 * blocking edge from `from` to `to` would close exactly that loop, and neither side could ever be woken.
 */
export function blockingPath(nodes: readonly GraphNode[], from: string, to: string): string[] | null {
	const next = new Map<string, string[]>();
	for (const edge of uniqueEdges(nodes)) {
		if (edge.type !== "upstream" && edge.type !== "waits-on") continue;
		next.set(edge.from, [...(next.get(edge.from) ?? []), edge.to]);
	}
	const cameFrom = new Map<string, string>([[to, to]]);
	const queue = [to];
	while (queue.length > 0) {
		const at = queue.shift() as string;
		if (at === from) {
			const path = [at];
			for (let step = at; step !== to; step = cameFrom.get(step) as string) path.unshift(cameFrom.get(step) as string);
			return path;
		}
		for (const onward of next.get(at) ?? []) {
			if (cameFrom.has(onward)) continue;
			cameFrom.set(onward, at);
			queue.push(onward);
		}
	}
	return null;
}

function matches(node: GraphNode, needle: string): boolean {
	return [node.session, node.label, node.emoji, node.tag, node.cwd, node.repo ?? "", node.branch ?? ""].some((field) =>
		field.toLowerCase().includes(needle),
	);
}

/** Nodes touched within the retention window, narrowed to the components holding a match when filtered. */
export function selectNodes(nodes: readonly GraphNode[], filter: string, now: number): GraphNode[] {
	const kept = nodes.filter((node) => now - node.updatedAt <= GRAPH_RETENTION_MS);
	const needle = filter.trim().toLowerCase();
	if (needle.length === 0) return kept;
	const ids = new Set(kept.map((node) => node.session));
	const neighbours = new Map<string, string[]>();
	for (const edge of uniqueEdges(kept)) {
		if (!ids.has(edge.from) || !ids.has(edge.to)) continue;
		neighbours.set(edge.from, [...(neighbours.get(edge.from) ?? []), edge.to]);
		neighbours.set(edge.to, [...(neighbours.get(edge.to) ?? []), edge.from]);
	}
	const reached = new Set<string>();
	const queue = kept.filter((node) => matches(node, needle)).map((node) => node.session);
	while (queue.length > 0) {
		const next = queue.pop() as string;
		if (reached.has(next)) continue;
		reached.add(next);
		queue.push(...(neighbours.get(next) ?? []));
	}
	return kept.filter((node) => reached.has(node.session));
}

/** Mermaid entity codes for every character that could end a quoted label or start markup. */
function mermaidText(text: string): string {
	return text
		.replace(/\s+/gu, " ")
		.trim()
		.replace(/[#"<>&`%;|\\[\]{}()]/gu, (ch) => `#${ch.codePointAt(0)};`);
}

const STYLE: Record<DisplayStatus, string> = {
	working: "fill:#dbeafe,stroke:#2563eb,color:#1e3a8a",
	waiting: "fill:#fef3c7,stroke:#d97706,color:#78350f",
	blocked: "fill:#fee2e2,stroke:#dc2626,color:#7f1d1d",
	pushed: "fill:#fde68a,stroke:#b45309,color:#78350f",
	"not-started": "fill:#f3f4f6,stroke:#9ca3af,color:#4b5563,stroke-dasharray:4 3",
	"pr-open": "fill:#cffafe,stroke:#0891b2,color:#164e63",
	draft: "fill:#e5e7eb,stroke:#6b7280,color:#374151",
	"changes-requested": "fill:#fecaca,stroke:#b91c1c,color:#7f1d1d",
	"ci-failing": "fill:#fecaca,stroke:#b91c1c,color:#7f1d1d",
	approved: "fill:#d1fae5,stroke:#059669,color:#064e3b",
	merged: "fill:#bbf7d0,stroke:#15803d,color:#14532d",
	done: "fill:#bbf7d0,stroke:#15803d,color:#14532d",
	closed: "fill:#e5e7eb,stroke:#6b7280,color:#6b7280",
	gone: "fill:#e5e7eb,stroke:#6b7280,color:#6b7280,stroke-dasharray:4 3",
	"not-needed": "fill:#e5e7eb,stroke:#6b7280,color:#6b7280",
	abandoned: "fill:#e5e7eb,stroke:#6b7280,color:#6b7280",
};

/** How many ranks a packed row of components may span before the next row starts. */
const PACK_RANKS = 4;

interface Component {
	first: GraphNode;
	last: GraphNode;
	ranks: number;
}

/** Weakly connected components, each with a first-rank node, a last-rank node and its rank count. */
function components(nodes: readonly GraphNode[]): Component[] {
	const byId = new Map(nodes.map((node) => [node.session, node]));
	const edges = uniqueEdges(nodes).filter((edge) => byId.has(edge.from) && byId.has(edge.to) && edge.from !== edge.to);
	const around = new Map<string, string[]>();
	for (const edge of edges) {
		around.set(edge.from, [...(around.get(edge.from) ?? []), edge.to]);
		around.set(edge.to, [...(around.get(edge.to) ?? []), edge.from]);
	}
	const seen = new Set<string>();
	const found: Component[] = [];
	for (const node of nodes) {
		if (seen.has(node.session)) continue;
		const members: string[] = [];
		const queue = [node.session];
		seen.add(node.session);
		while (queue.length > 0) {
			const at = queue.pop() as string;
			members.push(at);
			for (const next of around.get(at) ?? []) {
				if (seen.has(next)) continue;
				seen.add(next);
				queue.push(next);
			}
		}
		// Longest-path ranks, capped at the member count so a cycle cannot raise them forever.
		const rank = new Map(members.map((id) => [id, 0]));
		const inside = edges.filter((edge) => rank.has(edge.from));
		for (let pass = 0; pass < members.length; pass++) {
			let moved = false;
			for (const edge of inside) {
				const next = Math.min((rank.get(edge.from) as number) + 1, members.length - 1);
				if (next > (rank.get(edge.to) as number)) {
					rank.set(edge.to, next);
					moved = true;
				}
			}
			if (!moved) break;
		}
		const ordered = [...members].sort((a, b) => (rank.get(a) as number) - (rank.get(b) as number));
		const first = byId.get(ordered[0] as string) as GraphNode;
		const last = byId.get(ordered.at(-1) as string) as GraphNode;
		found.push({ first, last, ranks: (rank.get(last.session) as number) + 1 });
	}
	return found;
}

const ARROW: Record<EdgeType, string> = {
	upstream: "==>|upstream|",
	"waits-on": "-->|waits on|",
	"follows-up": "-.->|follows up|",
	related: "-.-|related|",
};

function place(node: GraphNode): string {
	if (node.repo !== undefined) return node.repo;
	const parts = node.cwd.split("/").filter((part) => part.length > 0);
	return parts.at(-1) ?? node.cwd;
}

function styleClass(status: DisplayStatus): string {
	return `st_${status.replaceAll("-", "_")}`;
}

export function toMermaid(nodes: readonly GraphNode[], prs: ReadonlyMap<string, PrRecord>, _now: number): string {
	const lines = ["flowchart LR"];
	const ids = new Map(nodes.map((node, index) => [node.session, `n${index}`]));
	const used = new Set<DisplayStatus>();
	for (const node of nodes) {
		const status = displayedStatus(node, prs.get(node.session));
		used.add(status);
		const title = [node.emoji, node.label.length > 0 ? node.label : node.tag]
			.filter((part) => part.length > 0)
			.join(" ");
		lines.push(`  ${ids.get(node.session)}["${mermaidText(title)}<br/>${mermaidText(place(node))}<br/>${status}"]`);
	}
	for (const edge of uniqueEdges(nodes)) {
		const from = ids.get(edge.from);
		const to = ids.get(edge.to);
		if (from !== undefined && to !== undefined) lines.push(`  ${from} ${ARROW[edge.type]} ${to}`);
	}
	// A left-to-right layout stacks every component on its own row, so components are chained into rows,
	// each joined from its last rank to the next one's first so no drawn edge changes direction.
	const units = components(nodes).sort(
		(a, b) =>
			b.ranks - a.ranks || place(a.first).localeCompare(place(b.first)) || a.first.label.localeCompare(b.first.label),
	);
	let rowRanks = 0;
	let previous: GraphNode | null = null;
	for (const unit of units) {
		if (previous !== null && rowRanks + unit.ranks <= PACK_RANKS) {
			lines.push(`  ${ids.get(previous.session)} ~~~ ${ids.get(unit.first.session)}`);
			rowRanks += unit.ranks;
		} else {
			rowRanks = unit.ranks;
		}
		previous = unit.last;
	}
	for (const status of used) lines.push(`  classDef ${styleClass(status)} ${STYLE[status]}`);
	for (const node of nodes) {
		lines.push(`  class ${ids.get(node.session)} ${styleClass(displayedStatus(node, prs.get(node.session)))}`);
	}
	return `${lines.join("\n")}\n`;
}

const NEEDS_LUCA: Partial<Record<DisplayStatus, true>> = {
	blocked: true,
	pushed: true,
	"changes-requested": true,
	"ci-failing": true,
};

/** Markdown list of nodes, grouped so what needs the user comes first. */
export function statusList(nodes: readonly GraphNode[], prs: ReadonlyMap<string, PrRecord>): string {
	if (nodes.length === 0) return "No dependencies are recorded.";
	const line = (node: GraphNode): string => {
		const pr = prs.get(node.session);
		const title = [node.emoji, node.label.length > 0 ? node.label : node.tag].filter((p) => p.length > 0).join(" ");
		const link = pr?.url ?? node.pr;
		return `- ${title} \u2014 ${displayedStatus(node, pr)} \u2014 ${place(node)}${link === undefined ? "" : ` \u2014 ${link}`}`;
	};
	const groups: [string, (status: DisplayStatus) => boolean][] = [
		["Needs you", (status) => NEEDS_LUCA[status] === true],
		["In progress", (status) => NEEDS_LUCA[status] !== true && !isFinished(status)],
		["Finished", (status) => isFinished(status)],
	];
	const sections: string[] = [];
	for (const [title, belongs] of groups) {
		const members = nodes.filter((node) => belongs(displayedStatus(node, prs.get(node.session))));
		if (members.length > 0) sections.push(`**${title}**\n${members.map(line).join("\n")}`);
	}
	return sections.join("\n\n");
}

/** Flags that shape how a session runs and hold no secret, so a resume reproduces them. */
const RESUME_VALUE_FLAGS: Record<string, true> = {
	"--config": true,
	"--model": true,
	"--smol": true,
	"--slow": true,
	"--plan": true,
	"--models": true,
	"--provider": true,
	"--thinking": true,
	"--profile": true,
	"--session-dir": true,
	"--add-dir": true,
	"--approval-mode": true,
	"--extension": true,
	"-e": true,
	"--hook": true,
	"--trusted-extension": true,
	"--plugin-dir": true,
	"--skills": true,
	"--tools": true,
	"--service-tier": true,
	"--system-prompt": true,
	"--system-prompt-template": true,
	"--append-system-prompt": true,
	"--prewalk-into": true,
	"--plan-yolo-into": true,
};
const RESUME_SWITCHES: Record<string, true> = {
	"--allow-home": true,
	"--no-title": true,
	"--hide-thinking": true,
	"--no-extensions": true,
	"--no-skills": true,
	"--no-rules": true,
	"--no-tools": true,
	"--no-lsp": true,
	"--no-pty": true,
	"--advisor": true,
	"--auto-approve": true,
	"--yolo": true,
	"--prewalk": true,
	"--no-prewalk": true,
	"--external-thinking": true,
};

/** The subset of an omp command line worth repeating on `--resume`: an allowlist, so prompts and secrets drop out. */
export function resumeArgs(args: readonly string[]): string[] {
	const kept: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string;
		const eq = arg.indexOf("=");
		const flag = eq > 0 ? arg.slice(0, eq) : arg;
		if (RESUME_SWITCHES[flag] === true && eq < 0) {
			kept.push(arg);
		} else if (RESUME_VALUE_FLAGS[flag] === true) {
			if (eq > 0) kept.push(arg);
			else if (i + 1 < args.length) kept.push(arg, args[++i] as string);
		}
	}
	return kept;
}

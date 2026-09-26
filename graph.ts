/**
 * Pure dependency-graph helpers: status derivation, outcomes, selection, Mermaid and list rendering.
 * Nothing here touches the filesystem or the network, so `test/graph.test.mjs` drives it directly.
 */

export const GRAPH_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;

export const EDGE_TYPES = ["upstream", "waits-on", "follows-up", "related"] as const;
export type EdgeType = (typeof EDGE_TYPES)[number];

export const AGENT_STATUSES = ["working", "waiting", "blocked", "pushed", "done", "not-needed", "abandoned"] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export type PrState = "pr-open" | "draft" | "changes-requested" | "ci-failing" | "approved" | "merged" | "closed";

/** `not-started` marks a launch whose child session never claimed it. */
export type DisplayStatus = AgentStatus | PrState | "not-started";

export type Outcome = "pushed" | "done" | "not-needed" | "abandoned" | "pr-opened" | "merged" | "closed";

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
	const outcome: Outcome = after === "merged" ? "merged" : after === "closed" ? "closed" : "pr-opened";
	if (emitted.includes(outcome) || before === after) return null;
	return outcome;
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

/** Lowest `cpu.weight` the resource vote assigns, for a live session no ballot ranks. */
export const PRIORITY_WEIGHT_MIN = 25;
/** Highest `cpu.weight` the resource vote assigns, for the unanimous first and for a window the user marked. */
export const PRIORITY_WEIGHT_MAX = 400;
/** The kernel's own `cpu.weight` default, kept while no ballot counts. */
const KERNEL_WEIGHT = 100;

/**
 * The modified Borda count over the live sessions in `candidates`. A ballot is counted only when its voter is a
 * candidate, after dropping entries that name the voter, an ended session or a repeat. A counted ballot ranking
 * `m` sessions gives `m` points to its first, down to 1 to its last, and nothing to a session it leaves out.
 * `attainable` is the most points any one candidate could have earned, every other counted ballot ranking it first.
 */
export function bordaPoints(
	ballots: ReadonlyMap<string, readonly string[]>,
	candidates: readonly string[],
): { points: Map<string, number>; attainable: number } {
	const live = new Set(candidates);
	const points = new Map(candidates.map((id) => [id, 0]));
	const possible = new Map(candidates.map((id) => [id, 0]));
	for (const [voter, ranking] of ballots) {
		if (!live.has(voter)) continue;
		const counted = [...new Set(ranking)].filter((id) => id !== voter && live.has(id));
		counted.forEach((id, place) => {
			points.set(id, (points.get(id) as number) + counted.length - place);
		});
		for (const id of candidates) {
			if (id !== voter) possible.set(id, (possible.get(id) as number) + counted.length);
		}
	}
	return { points, attainable: Math.max(0, ...possible.values()) };
}

/**
 * Orders session ids with every window the user marked first, then by Borda points, and hands ties to `tie`, so
 * a view keeps its own order among sessions the vote does not separate.
 */
export function byPriority(
	points: ReadonlyMap<string, number>,
	marked: ReadonlySet<string>,
	tie: (a: string, b: string) => number,
): (a: string, b: string) => number {
	return (a, b) =>
		Number(marked.has(b)) - Number(marked.has(a)) || (points.get(b) ?? 0) - (points.get(a) ?? 0) || tie(a, b);
}

/**
 * The `cpu.weight` for a session holding `points` of `attainable`, spread geometrically from
 * `PRIORITY_WEIGHT_MIN` to `PRIORITY_WEIGHT_MAX` so equal score gaps give equal CPU ratios, the shape the kernel
 * gives nice levels. Half the attainable points lands on the kernel default.
 */
export function cpuWeight(points: number, attainable: number, marked: boolean): number {
	if (marked) return PRIORITY_WEIGHT_MAX;
	if (attainable <= 0) return KERNEL_WEIGHT;
	const share = Math.min(1, Math.max(0, points / attainable));
	return Math.round(PRIORITY_WEIGHT_MIN * (PRIORITY_WEIGHT_MAX / PRIORITY_WEIGHT_MIN) ** share);
}

/** How long memory pressure must stay under half its threshold before a backstop episode ends. */
export const BACKSTOP_CALM_MS = 5 * 60_000;

/** Whether lower-ranked scopes are capped right now, and since when pressure has stayed under half the threshold. */
export interface Backstop {
	active: boolean;
	calmSince: number;
}

/**
 * The next state of the memory backstop. Pressure at `threshold` starts an episode, pressure between half the
 * threshold and the threshold keeps it on and forgets any calm so far, and an episode ends once pressure has stayed
 * under half the threshold for `BACKSTOP_CALM_MS`, so a cap set at a peak is not lifted by the first quiet tick.
 */
export function backstopStep(prev: Backstop, pressure: number, threshold: number, now: number): Backstop {
	if (pressure >= threshold) return { active: true, calmSince: 0 };
	if (!prev.active || pressure >= threshold / 2) return { active: prev.active, calmSince: 0 };
	const calmSince = prev.calmSince > 0 ? prev.calmSince : now;
	return now - calmSince >= BACKSTOP_CALM_MS ? { active: false, calmSince: 0 } : { active: true, calmSince };
}

/**
 * The live sessions the memory backstop caps, the lower half of `order` by resource vote, rounding the middle
 * session up into the uncapped half, and never a window the user marked.
 */
export function cappedSessions(order: readonly string[], marked: ReadonlySet<string>): Set<string> {
	return new Set(order.slice(Math.ceil(order.length / 2)).filter((id) => !marked.has(id)));
}

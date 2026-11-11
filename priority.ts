/**
 * The modified Borda count over the live sessions in `candidates`. A ballot is counted only when its voter is a
 * candidate, after dropping entries that name the voter, an ended session or a repeat. A counted ballot ranking
 * `m` sessions gives `m` points to its first, down to 1 to its last, and nothing to a session it leaves out.
 */
export function bordaPoints(
	ballots: ReadonlyMap<string, readonly string[]>,
	candidates: readonly string[],
): Map<string, number> {
	const live = new Set(candidates);
	const points = new Map(candidates.map((id) => [id, 0]));
	for (const [voter, ranking] of ballots) {
		if (!live.has(voter)) continue;
		const counted = [...new Set(ranking)].filter((id) => id !== voter && live.has(id));
		counted.forEach((id, place) => {
			points.set(id, (points.get(id) as number) + counted.length - place);
		});
	}
	return points;
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

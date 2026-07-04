import { shardDb, isError } from '$lib/shard-db/client';
import type { QueryBody } from '$lib/shard-db/query-types';

/**
 * Live comment counts for a set of story ids, keyed on the already-indexed
 * `story_root` field on the `comments` object. One grouped aggregate call
 * covers every story on the page in a single round trip, instead of one
 * `count` query per story.
 *
 * Returns `null` on query failure — callers should keep each story's
 * existing stored `descendants` value as a fallback in that case. This is
 * distinct from an empty/partial `Map`: a story id absent from a
 * *successful* response legitimately has zero live comments (it just never
 * appears as a `group_by` row), so callers should treat "present in a
 * non-null map with no entry" as 0, not as "unknown, keep the stale value".
 */
export async function fetchLiveCommentCounts(
	storyIds: string[]
): Promise<Map<string, number> | null> {
	if (storyIds.length === 0) return new Map();

	const ids = storyIds.map((id) => Number(id)).filter((n) => Number.isFinite(n));
	if (ids.length === 0) return new Map();

	const resp = await shardDb.query({
		mode: 'aggregate',
		dir: 'hn',
		object: 'comments',
		group_by: ['story_root'],
		aggregates: [{ fn: 'count', alias: 'n' }],
		criteria: [{ field: 'story_root', op: 'in', value: ids }]
	} as unknown as QueryBody);

	if (isError(resp) || !Array.isArray(resp)) return null;

	const counts = new Map<string, number>();
	for (const row of resp as Array<Record<string, unknown>>) {
		const key = String(row.story_root);
		const n = typeof row.n === 'number' ? row.n : 0;
		counts.set(key, n);
	}
	return counts;
}

/**
 * Overwrites each story's `descendants` with its live comment count.
 * Stories with zero live comments correctly become 0 (they're simply
 * absent from the aggregate's group-by rows). On aggregate failure,
 * stories are returned unmodified — the stale stored value is still
 * better than failing the whole page load.
 */
export async function applyLiveCommentCounts<T extends { key: string; descendants?: number }>(
	stories: T[]
): Promise<T[]> {
	if (stories.length === 0) return stories;
	const counts = await fetchLiveCommentCounts(stories.map((s) => s.key));
	if (counts === null) return stories;
	return stories.map((s) => ({ ...s, descendants: counts.get(s.key) ?? 0 }));
}

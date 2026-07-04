import { isError } from '$lib/shard-db/client';
import { cachedQuery } from '$lib/refresh-cache';
import type { QueryBody } from '$lib/shard-db/query-types';

/** Injectable query function for tests — defaults to the real cached
 *  query path. Matches the `deps` pattern already used by `tick()`
 *  in `refresh-cache/refresh.ts`, so tests inject a stub instead of
 *  mocking the module loader. */
export interface CommentCountsDeps {
	query?: (q: QueryBody) => Promise<unknown>;
}

/**
 * Live comment counts for a set of story ids, keyed on the already-indexed
 * `story_root` field on the `comments` object. One grouped aggregate call
 * covers every requested story in a single round trip, instead of one
 * `count` query per story.
 *
 * Called from refresh-cache's `tick()` (via `syncStaleDescendants` in
 * `refresh.ts`), scoped to just the "old" story ids that received new
 * comments this tick but weren't themselves re-inserted — that's the
 * only case where the stored `descendants` on a story can drift, since
 * shard-db never re-fetches an old item's own HN record. Page routes
 * read `stories.descendants` directly and no longer call this at
 * request time.
 *
 * Returns `null` on query failure — callers should keep each story's
 * existing stored `descendants` value as a fallback in that case. This is
 * distinct from an empty/partial `Map`: a story id absent from a
 * *successful* response legitimately has zero live comments (it just never
 * appears as a `group_by` row), so callers should treat "present in a
 * non-null map with no entry" as 0, not as "unknown, keep the stale value".
 */
export async function fetchLiveCommentCounts(
	storyIds: string[],
	deps: CommentCountsDeps = {}
): Promise<Map<string, number> | null> {
	if (storyIds.length === 0) return new Map();

	const ids = storyIds.map((id) => Number(id)).filter((n) => Number.isFinite(n));
	if (ids.length === 0) return new Map();

	const query = deps.query ?? cachedQuery;
	const resp = await query({
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

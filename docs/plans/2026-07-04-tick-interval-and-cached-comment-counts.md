# Bump refresh-tick interval + cache live comment counts

## Execution rules

- Branch off `main`.
- Do tasks in order.
- Build/typecheck: `bun run check` (svelte-check). Test: `bun test`.
- Never claim a step passed without pasting the real command output.
- If a quoted anchor is not found exactly (byte-for-byte) in the target file, stop and write `PLAN_NOTES.md` in the repo root describing the mismatch — do not guess or reinterpret.

## Background

Two related but distinct slowdowns were diagnosed together:

1. **`fetchLiveCommentCounts`** (`src/lib/hn/comment-counts.ts`) is called from three routes — `/` (`src/routes/+page.server.ts:265`), `/trending` (`src/routes/trending/+page.server.ts:69`), `/u/[username]` (`src/routes/u/[username]/+page.server.ts:61`) — and today calls `shardDb.query(...)` **directly**, bypassing the app's existing write-through cache (`$lib/refresh-cache`). That means the grouped `aggregate` query re-runs against shard-db on **every single page visit** to those three routes, with no reuse across visitors even when they're looking at the same set of story ids (e.g. the front page's top 25).

2. **The 5-minute refresh tick** (`src/lib/refresh-cache/refresh.ts`, `REFRESH_INTERVAL_MS`) does the HN item ingest *and* a full `rewarmCache()` pass (~120 sequential queries) every 5 minutes. That rewarm has grown to take 2-3 minutes on its own. While it runs, it competes with live page-load traffic (including the uncached comment-count aggregate from #1) for shard-db's concurrent-query capacity — so page loads get slower specifically during that window, and that window now recurs every 5 minutes.

Fix #1 removes the actual per-visit query cost (the aggregate becomes cache-backed, same lazy "first visitor pays, everyone else hits" pattern already used for every other route query via `cachedQuery`). Fix #2 reduces how often the rewarm-contention window opens (4x fewer rewarms/hour). Both are independent and both are in scope for this plan.

Explicitly **out of scope** (noted for a possible follow-up, not part of this plan): `tick()` has no re-entrancy guard, unlike `warmSlowStats()`'s `state.warming` flag (`src/lib/refresh-cache/slow-stats.ts`). If a tick ever runs longer than `REFRESH_INTERVAL_MS`, `setInterval` could fire a second overlapping `tick()`. Bumping the interval to 20 minutes gives far more headroom (rewarm is ~2-3 min against a 20-min budget vs a 5-min one), so this isn't being touched here — leave it alone.

## Task 1 — Bump the refresh-tick interval from 5 to 20 minutes

**File:** `src/lib/refresh-cache/refresh.ts`

Find this exact anchor:

```ts
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
```

Replace with:

```ts
const REFRESH_INTERVAL_MS = 20 * 60 * 1000;
```

Do **not** touch `REWARM_BUCKET_MS` in `src/lib/refresh-cache/keys.ts` (`= 5 * 60 * 1000`) — that constant quantizes the `time gte` cutoffs used in cache keys for windowed queries (24h/7d/30d/hot) and is unrelated to how often the ingest+rewarm tick itself fires. Leaving it at 5 minutes means windowed queries still refresh their cutoff every 5 minutes (first visitor after each bucket boundary pays a live query, everyone else in that 5-min bucket hits cache) even though the full ingest/rewarm cadence is now 20 minutes. This is intentional — do not change it as part of this task.

No test changes needed for this task; it's a single constant with no test currently asserting its value (confirm via `grep -rn "REFRESH_INTERVAL_MS" src` — only the declaration and its use in `start()` should match).

## Task 2 — Route live comment counts through the existing cache

**File:** `src/lib/hn/comment-counts.ts`

Current full file:

```ts
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
```

Replace the **entire file contents** with:

```ts
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
 * covers every story on the page in a single round trip, instead of one
 * `count` query per story.
 *
 * Routed through `cachedQuery` (the same write-through cache every other
 * route query uses) rather than calling `shardDb.query` directly: the
 * first visitor for a given set of story ids pays the aggregate query,
 * everyone else requesting the same set hits the in-memory cache until
 * the next refresh-tick rewarm wipes it. Without this, the aggregate
 * re-ran on every single page visit to `/`, `/trending`, and
 * `/u/[username]` — this was the actual per-request cost, independent of
 * how often the refresh tick itself runs.
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

/**
 * Overwrites each story's `descendants` with its live comment count.
 * Stories with zero live comments correctly become 0 (they're simply
 * absent from the aggregate's group-by rows). On aggregate failure,
 * stories are returned unmodified — the stale stored value is still
 * better than failing the whole page load.
 */
export async function applyLiveCommentCounts<T extends { key: string; descendants?: number }>(
	stories: T[],
	deps: CommentCountsDeps = {}
): Promise<T[]> {
	if (stories.length === 0) return stories;
	const counts = await fetchLiveCommentCounts(stories.map((s) => s.key), deps);
	if (counts === null) return stories;
	return stories.map((s) => ({ ...s, descendants: counts.get(s.key) ?? 0 }));
}
```

Notes on this change:

- `shardDb` import is dropped (no longer called directly); `isError` is still needed and still comes from `$lib/shard-db/client`.
- `cachedQuery` is generic over the query shape (`canonicalKey` in `src/lib/refresh-cache/keys.ts` JSON-stringifies with sorted object keys and preserves array order) — it already handles arbitrary, non-enumerable query shapes today for things like `by=<user>` filters and search text, bounded by `MAX_ENTRIES = 8192` in `src/lib/refresh-cache/cache.ts`. No new cache infrastructure is needed; this task only changes which function performs the query.
- Cache entries for these aggregate queries are wiped wholesale on the next `rewarmCache()` swap (same as every other `cachedQuery`-backed entry), so comment counts still refresh at least once per tick and never go stale beyond one tick interval.
- Two requests for *overlapping-but-not-identical* id sets (e.g. two different sort orders that both include story #123 in their results) will not share a cache hit for story #123 — they're cached per exact `ids` array, not per individual story id. This is an accepted simplification: it still turns "N queries per N page visits" into "one query per distinct id-set per tick," which is the dominant win. Do not attempt to build a per-story-id cache as part of this task — that's a materially larger change (needs its own eviction/TTL design) and isn't what was asked for here.
- Production call sites (`src/routes/+page.server.ts`, `src/routes/trending/+page.server.ts`, `src/routes/u/[username]/+page.server.ts`) call `applyLiveCommentCounts(stories)` with no `deps` argument today — they need **no changes**, since `deps` defaults to `{}` and `fetchLiveCommentCounts` falls back to the real `cachedQuery`.

### Test file — create `src/lib/hn/comment-counts.test.ts`

There is no existing test file for this module. Create one:

```ts
import { describe, test, expect } from 'bun:test';
import { fetchLiveCommentCounts, applyLiveCommentCounts } from './comment-counts';
import type { QueryBody } from '$lib/shard-db/query-types';

describe('fetchLiveCommentCounts', () => {
	test('returns an empty Map without querying when storyIds is empty', async () => {
		let called = false;
		const counts = await fetchLiveCommentCounts([], {
			query: async () => { called = true; return []; }
		});
		expect(counts).toEqual(new Map());
		expect(called).toBe(false);
	});

	test('returns an empty Map without querying when no id is numeric', async () => {
		let called = false;
		const counts = await fetchLiveCommentCounts(['not-a-number', 'also-nope'], {
			query: async () => { called = true; return []; }
		});
		expect(counts).toEqual(new Map());
		expect(called).toBe(false);
	});

	test('maps story_root rows to counts, keyed by string id', async () => {
		const counts = await fetchLiveCommentCounts(['1', '2', '3'], {
			query: async () => [
				{ story_root: 1, n: 5 },
				{ story_root: 3, n: 0 }
			]
		});
		expect(counts).toEqual(new Map([['1', 5], ['3', 0]]));
		// story 2 legitimately absent — zero comments, not "unknown".
		expect(counts?.has('2')).toBe(false);
	});

	test('returns null on a query error response', async () => {
		const counts = await fetchLiveCommentCounts(['1'], {
			query: async () => ({ error: 'timeout' })
		});
		expect(counts).toBeNull();
	});

	test('returns null when response is not an array', async () => {
		const counts = await fetchLiveCommentCounts(['1'], {
			query: async () => ({ unexpected: 'shape' })
		});
		expect(counts).toBeNull();
	});

	test('passes an aggregate query grouped on story_root with an in-criteria on the numeric ids', async () => {
		let seen: QueryBody | null = null;
		await fetchLiveCommentCounts(['10', '20'], {
			query: async (q) => { seen = q; return []; }
		});
		expect(seen).toMatchObject({
			mode: 'aggregate',
			dir: 'hn',
			object: 'comments',
			group_by: ['story_root'],
			aggregates: [{ fn: 'count', alias: 'n' }],
			criteria: [{ field: 'story_root', op: 'in', value: [10, 20] }]
		});
	});
});

describe('applyLiveCommentCounts', () => {
	test('returns input unchanged for an empty array', async () => {
		const out = await applyLiveCommentCounts([]);
		expect(out).toEqual([]);
	});

	test('overwrites descendants with live counts, defaulting absent ids to 0', async () => {
		const stories = [
			{ key: '1', descendants: 99 },
			{ key: '2', descendants: 42 }
		];
		const out = await applyLiveCommentCounts(stories, {
			query: async () => [{ story_root: 1, n: 7 }]
		});
		expect(out).toEqual([
			{ key: '1', descendants: 7 },
			{ key: '2', descendants: 0 }
		]);
	});

	test('returns stories unmodified when the aggregate query fails', async () => {
		const stories = [{ key: '1', descendants: 99 }];
		const out = await applyLiveCommentCounts(stories, {
			query: async () => ({ error: 'timeout' })
		});
		expect(out).toEqual(stories);
	});
});
```

Run with `bun test src/lib/hn/comment-counts.test.ts` first to confirm the new file passes in isolation, then the full suite in Task 3.

## Task 3 — Full verification

1. `bun run check` — must report no new type errors.
2. `bun test` — paste the real output; every test must pass, including the new `comment-counts.test.ts` file and the untouched `refresh.test.ts` / `cache.test.ts` (these should be unaffected by either change — Task 1 only changes a constant `refresh.test.ts` doesn't assert on, Task 2 only changes `comment-counts.ts` which had no prior test file).
3. Grep-confirm no other production call site of `fetchLiveCommentCounts` / `applyLiveCommentCounts` was missed: `grep -rn "LiveCommentCounts" src` should show exactly the 3 route files + `comment-counts.ts` + the new test file.

Do not deploy as part of this plan — deployment (copy `build/` to the server, restart) is a separate, explicit step per the project's `CLAUDE.md` and is not implied by "plan approved."

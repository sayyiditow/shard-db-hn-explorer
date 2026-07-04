# Keep `stories.descendants` accurate from stored data instead of live per-page aggregates

## Execution rules (read first)

- Plans in this repo are executed by DeepSeek, outside of Claude.
- Branch off `main`: `git checkout -b fix/story-descendants-sync`.
- Test with `bun test`. Type-check with `bun run check`.
- Every edit below is located by **quoted anchor text**, not line numbers. If an anchor is not found character-for-character, stop and note what you found instead rather than guessing.
- Do the tasks in order — Task 2 depends on the import Task 2 itself adds; Task 3 depends on Task 2 already keeping `stories.descendants` fresh (removing the live per-page aggregate before Task 2 lands would make comment counts go stale with nothing keeping them in sync).
- Leave changes uncommitted when done — commit/push is handled outside this workflow.

## Background

`stories.descendants` is populated once, when a story's own HN item is first ingested (`refresh.ts`'s `tick()`, and `bulk-load.ts`/`sample-load.ts` for historical data). Because the refresh tick only ever fetches **new** HN item ids (`effectiveLastSeen + 1 .. thisTickEnd`), a story's own record is never re-fetched from HN after its initial ingest — so its stored `descendants` is a permanent snapshot from ingest time, almost always `0` for stories created via the live tick (comments arrive later).

That staleness is why `src/lib/hn/comment-counts.ts` was built: `applyLiveCommentCounts()` runs a live `aggregate` (`group_by: ["story_root"]`, `count`) over `comments` for whatever set of stories a page is about to render, routed through `cachedQuery` so repeat visitors within the same refresh window hit an in-memory cache instead of re-aggregating.

This works around the staleness instead of fixing it. `descendants` *is* the comment count for that story — nothing else should need to compute it separately. This plan:

1. **One-time backfill** (`scripts/backfill-descendants.ts`): recompute every story's `descendants` from the actual `comments` rows in the db, so the stored field starts out correct.
2. **Ongoing tick-time sync** (`refresh.ts`): each tick already knows which comments just arrived and what their `story_root` is. For any `story_root` that ISN'T one of the stories inserted in *this same tick* (i.e. an "old" story whose own `descendants` won't otherwise change), run one small aggregate scoped to just those ids and write the real count back onto `stories`. Stories inserted in the current tick already got their `descendants` straight from HN's own live item fetch (HN's API always returns the true current count for whatever id you query, regardless of ingestion lag), so they don't need this correction.
3. **Stop computing live counts per page view**: once (1) and (2) keep `stories.descendants` correct, `/`, `/trending`, and `/u/[username]` can read `descendants` straight off the story record they already fetched — no separate aggregate call needed at all, cached or not.

### Wire-protocol note: the `shard-db` npm package's `QueryBody` type is stale

`src/lib/shard-db/query-types.ts` re-exports `QueryBody` from the `shard-db` npm package's `index.d.ts`. That type is missing `bulk-update` entirely and declares `aggregate.group_by` as `string` instead of `string[]` — both mismatches vs. the actual JSON wire protocol the embedded engine accepts (see the shard-db repo's `docs/query-protocol/bulk.md` / `aggregate.md`). `comment-counts.ts` already works around the `group_by` mismatch with `as unknown as QueryBody`; every new `bulk-update` call added by this plan needs the same cast. This is a type-declaration gap only — the engine itself (native N-API binding, `EmbeddedShardDbClient.query` in `src/lib/shard-db/embedded.ts`) just `JSON.stringify`s the body and hands it to the C engine, so `bulk-update` works fine at runtime.

## Task 1 — One-time backfill script

### New file: `scripts/backfill-descendants.ts`

```ts
#!/usr/bin/env bun
/**
 * One-time (idempotent) backfill: recompute every story's `descendants`
 * from the actual comment count in shard-db instead of trusting
 * whatever `descendants` HN reported when the story's own item was
 * ingested (parquet snapshot time, or first-tick fetch — see
 * refresh.ts's tick()/resolveStoryRoot for why that value drifts, and
 * why a partial/sample load can leave a story's declared descendants
 * far higher than the comments we actually have for it).
 *
 * Two phases:
 *   1. Walk `comments` in story_root id-range batches, grouped by
 *      story_root, and overwrite each matching story's `descendants`
 *      with the real count. Also records which story ids have at
 *      least one local comment.
 *   2. Walk every story in `stories` (paginated) and zero out
 *      `descendants` on any story NOT seen in phase 1 — covers stories
 *      whose declared HN descendants count is stale-high because we
 *      never loaded (or later lost) their comments locally.
 *
 * Safe to re-run — every value written is recomputed from what's
 * currently in `comments`, not accumulated.
 *
 * Run:
 *   bun run scripts/backfill-descendants.ts
 */

import { shardDb, isError } from '../src/lib/shard-db/client';
import { read as readRefreshState } from '../src/lib/refresh-cache/state';
import type { QueryBody } from '../src/lib/shard-db/query-types';

const DIR = 'hn';
const COMMENT_ID_CHUNK = 200_000;
const STORY_FETCH_PAGE = 50_000;

interface AggRow { story_root: number; n: number }

/** Phase 1: aggregate comments.story_root in [lo, hi], write real counts
 *  back onto the matching stories. Returns the story ids it touched, so
 *  phase 2 knows which stories to leave alone. */
async function backfillRange(lo: number, hi: number): Promise<Set<number>> {
	const resp = await shardDb.query({
		mode: 'aggregate',
		dir: DIR,
		object: 'comments',
		group_by: ['story_root'],
		aggregates: [{ fn: 'count', alias: 'n' }],
		criteria: [{ field: 'story_root', op: 'between', value: lo, value2: hi }],
		limit: COMMENT_ID_CHUNK
	} as unknown as QueryBody);

	if (isError(resp)) {
		throw new Error(`aggregate [${lo}, ${hi}] failed: ${resp.error}`);
	}
	const rows = resp as AggRow[];
	const touched = new Set<number>();
	if (rows.length === 0) return touched;

	const records: Record<string, { descendants: number }> = {};
	for (const row of rows) {
		records[String(row.story_root)] = { descendants: row.n };
		touched.add(row.story_root);
	}

	const upd = await shardDb.query({
		mode: 'bulk-update', dir: DIR, object: 'stories', records
	} as unknown as QueryBody);
	if (isError(upd)) {
		throw new Error(`bulk-update (real counts) [${lo}, ${hi}] failed: ${upd.error}`);
	}
	return touched;
}

/** Phase 2: page through every story; zero out `descendants` on any
 *  story `hasComments` didn't see in phase 1 (and whose descendants
 *  isn't already 0 — skip the no-op write). */
async function zeroStoriesWithoutComments(hasComments: Set<number>): Promise<number> {
	let offset = 0;
	let zeroed = 0;

	for (;;) {
		const resp = await shardDb.query({
			mode: 'fetch', dir: DIR, object: 'stories',
			offset, limit: STORY_FETCH_PAGE, fields: ['descendants']
		} as QueryBody);
		if (isError(resp)) {
			throw new Error(`fetch stories @offset=${offset} failed: ${resp.error}`);
		}
		const rows = resp as Array<{ key: string; value: { descendants: number } }>;
		if (rows.length === 0) break;

		const zeroBatch: Record<string, { descendants: number }> = {};
		for (const row of rows) {
			const id = Number(row.key);
			if (!hasComments.has(id) && row.value.descendants !== 0) {
				zeroBatch[row.key] = { descendants: 0 };
			}
		}
		if (Object.keys(zeroBatch).length > 0) {
			const upd = await shardDb.query({
				mode: 'bulk-update', dir: DIR, object: 'stories', records: zeroBatch
			} as unknown as QueryBody);
			if (isError(upd)) {
				throw new Error(`bulk-update (zero) @offset=${offset} failed: ${upd.error}`);
			}
			zeroed += Object.keys(zeroBatch).length;
		}

		offset += rows.length;
		console.log(`  fetched ${offset} stories so far (${zeroed} zeroed)`);
	}
	return zeroed;
}

async function main() {
	const maxId = await readRefreshState();
	if (maxId <= 0) {
		console.error('No refresh state found (.hn-refresh-state.json missing or last_seen_id=0). ' +
			'Run the refresh tick / bulk-load at least once before backfilling.');
		process.exit(1);
	}

	console.log(`Phase 1: recomputing descendants from comments, id range [1, ${maxId}], chunk=${COMMENT_ID_CHUNK}`);
	const hasComments = new Set<number>();
	let realCount = 0;
	const t0 = performance.now();
	for (let lo = 1; lo <= maxId; lo += COMMENT_ID_CHUNK) {
		const hi = Math.min(lo + COMMENT_ID_CHUNK - 1, maxId);
		const touched = await backfillRange(lo, hi);
		for (const id of touched) hasComments.add(id);
		realCount += touched.size;
		console.log(`  [${lo}, ${hi}]: ${touched.size} stories updated (running total: ${realCount})`);
	}
	console.log(`Phase 1 done in ${((performance.now() - t0) / 1000).toFixed(1)}s — ${realCount} stories updated, ${hasComments.size} distinct story ids have local comments.`);

	console.log(`\nPhase 2: zeroing descendants on stories with no local comments`);
	const t1 = performance.now();
	const zeroed = await zeroStoriesWithoutComments(hasComments);
	console.log(`Phase 2 done in ${((performance.now() - t1) / 1000).toFixed(1)}s — ${zeroed} stories zeroed.`);

	console.log(`\nDone. ${realCount} stories corrected to real counts, ${zeroed} stories zeroed.`);
	shardDb.close();
}

main().catch((err) => {
	console.error('\nbackfill-descendants failed:', err);
	process.exit(1);
});
```

### File: `package.json`

Find this exact block:

```json
    "bulk-load": "bun run scripts/bulk-load.ts",
```

Replace it with:

```json
    "bulk-load": "bun run scripts/bulk-load.ts",
    "backfill-descendants": "bun run scripts/backfill-descendants.ts",
```

## Task 2 — Tick-time sync for old stories that received new comments

### File: `src/lib/refresh-cache/refresh.ts`

Find this exact block:

```ts
import { truncateBytes } from './truncate';
import { warmSlowStats } from './slow-stats';
```

Replace it with:

```ts
import { truncateBytes } from './truncate';
import { warmSlowStats } from './slow-stats';
import { fetchLiveCommentCounts } from '$lib/hn/comment-counts';
```

Find this exact block:

```ts
	return parentId;  // unknown — best-effort
}

interface ShardRecord { key: string; value: Record<string, unknown>; }
```

Replace it with:

```ts
	return parentId;  // unknown — best-effort
}

/** After ingesting this tick's comments, some of them belong to stories
 *  that were NOT re-fetched this tick (their own HN item id fell in an
 *  earlier tick's range) — the `descendants` stored on those stories is
 *  a stale snapshot from whenever they were first ingested, since
 *  refresh.ts never re-fetches an old item's own HN record. Recompute
 *  the live comment count for just those "old" story ids and write it
 *  back, so stored `descendants` stays accurate without a per-page-load
 *  aggregate query. Stories inserted THIS tick are skipped — their
 *  `descendants` already came straight from HN's own live item fetch. */
async function syncStaleDescendants(
	client: NonNullable<TickDeps['client']>,
	comments: ShardRecord[],
	storyIdsThisTick: Set<number>
): Promise<void> {
	const oldStoryRoots = new Set<number>();
	for (const c of comments) {
		const sr = c.value.story_root;
		if (typeof sr === 'number' && sr > 0 && !storyIdsThisTick.has(sr)) {
			oldStoryRoots.add(sr);
		}
	}
	if (oldStoryRoots.size === 0) return;

	const ids = Array.from(oldStoryRoots);
	const counts = await fetchLiveCommentCounts(ids.map(String), { query: client.query });
	if (counts === null) {
		logWarn(`syncStaleDescendants: aggregate failed for ${ids.length} old story ids, skipping`);
		return;
	}

	const records: Record<string, { descendants: number }> = {};
	for (const id of ids) {
		records[String(id)] = { descendants: counts.get(String(id)) ?? 0 };
	}

	const r = await client.query({
		mode: 'bulk-update', dir: DIR, object: 'stories', records
	} as unknown as QueryBody);
	if (isError(r)) {
		logWarn(`syncStaleDescendants: bulk-update failed: ${(r as { error: string }).error}`);
		return;
	}
	logInfo(`synced descendants for ${ids.length} old stories from ${comments.length} new comments`);
}

interface ShardRecord { key: string; value: Record<string, unknown>; }
```

Find this exact block:

```ts
			await Promise.all(tasks);
			logInfo(`upserted: stories=${storiesInserted} comments=${commentsInserted} users=${usersInserted} in ${Date.now() - tUpsert}ms`);
		} catch (e) {
			logErr(`upsert failed: ${(e as Error).message}`);
			return emptyResult(lastSeen, (e as Error).message);
		}
```

Replace it with:

```ts
			await Promise.all(tasks);
			logInfo(`upserted: stories=${storiesInserted} comments=${commentsInserted} users=${usersInserted} in ${Date.now() - tUpsert}ms`);

			if (comments.length) {
				const storyIdsThisTick = new Set(stories.map((s) => Number(s.key)));
				await syncStaleDescendants(client, comments, storyIdsThisTick);
			}
		} catch (e) {
			logErr(`upsert failed: ${(e as Error).message}`);
			return emptyResult(lastSeen, (e as Error).message);
		}
```

### Invariant this preserves

`syncStaleDescendants` never throws — every failure path (`fetchLiveCommentCounts` returning `null`, `bulk-update` erroring) is logged via `logWarn` and returns. That keeps it from tripping the surrounding `catch` block, so a descendants-sync hiccup never blocks `endOfTickId` from being persisted — worst case, the affected stories stay stale for one more tick and get corrected next time a new comment lands on them (or by re-running the Task 1 backfill).

### File: `src/lib/refresh-cache/refresh.test.ts`

Find this exact block:

```ts
function makeDeps(overrides: {
    getMaxItem?: () => Promise<number>;
    items?: HnItem[];
    parentLookups?: Record<string, { type?: string; story_root?: number }>;
} = {}): { deps: TickDeps; queries: Record<string, unknown>[] } {
    const queries: Record<string, unknown>[] = [];
    const parentLookups = overrides.parentLookups ?? {};
    return {
        queries,
        deps: {
            client: {
                query: async (q: Record<string, unknown>) => {
                    queries.push(q);
                    if (q.mode === 'get') {
                        const key = String(q.key);
                        const meta = parentLookups[key];
                        return meta ?? { error: 'missing key' };
                    }
                    if (q.mode === 'bulk-insert') {
                        return { inserted: (q.records as unknown[]).length };
                    }
                    return { ok: true };
                }
            },
            api: {
                getMaxItem: overrides.getMaxItem ?? (async () => 0),
                getItem: async () => null,
                getItemsConcurrent: async () => overrides.items ?? []
            }
        }
    };
}
```

Replace it with:

```ts
function makeDeps(overrides: {
    getMaxItem?: () => Promise<number>;
    items?: HnItem[];
    parentLookups?: Record<string, { type?: string; story_root?: number }>;
    aggregateResponse?: unknown;
} = {}): { deps: TickDeps; queries: Record<string, unknown>[] } {
    const queries: Record<string, unknown>[] = [];
    const parentLookups = overrides.parentLookups ?? {};
    return {
        queries,
        deps: {
            client: {
                query: async (q: Record<string, unknown>) => {
                    queries.push(q);
                    if (q.mode === 'get') {
                        const key = String(q.key);
                        const meta = parentLookups[key];
                        return meta ?? { error: 'missing key' };
                    }
                    if (q.mode === 'bulk-insert') {
                        return { inserted: (q.records as unknown[]).length };
                    }
                    if (q.mode === 'aggregate') {
                        return overrides.aggregateResponse ?? [];
                    }
                    if (q.mode === 'bulk-update') {
                        return { updated: Object.keys((q.records as Record<string, unknown>) ?? {}).length };
                    }
                    return { ok: true };
                }
            },
            api: {
                getMaxItem: overrides.getMaxItem ?? (async () => 0),
                getItem: async () => null,
                getItemsConcurrent: async () => overrides.items ?? []
            }
        }
    };
}
```

Find this exact block:

```ts
    test('idle tick with populated cache leaves cache unchanged', async () => {
        // Seed the cache with a sentinel marker we can detect afterwards.
        cache.swap(new Map([['sentinel', { result: 'untouched', mtime: 1 }]]));
        const before = cache.stats().lastSwapAt;
        await write(300);
        const { deps } = makeDeps({ getMaxItem: async () => 300 });
        await tick(deps);
        expect(cache.stats().lastSwapAt).toBe(before);
        expect(cache.get('sentinel')).toBe('untouched');
    });
});
```

Replace it with:

```ts
    test('idle tick with populated cache leaves cache unchanged', async () => {
        // Seed the cache with a sentinel marker we can detect afterwards.
        cache.swap(new Map([['sentinel', { result: 'untouched', mtime: 1 }]]));
        const before = cache.stats().lastSwapAt;
        await write(300);
        const { deps } = makeDeps({ getMaxItem: async () => 300 });
        await tick(deps);
        expect(cache.stats().lastSwapAt).toBe(before);
        expect(cache.get('sentinel')).toBe('untouched');
    });

    test('new comments on an old story trigger a targeted descendants sync', async () => {
        // Story 500 was inserted in an earlier tick — it's NOT part of
        // this tick's own `items`, so its stored `descendants` is stale
        // until this tick's new comment (parent=500) triggers a sync.
        await write(600);
        const { deps, queries } = makeDeps({
            getMaxItem: async () => 601,
            items: [
                { id: 601, type: 'comment', by: 'z', time: 1,
                  parent: 500, deleted: false, dead: false }
            ] as HnItem[],
            aggregateResponse: [{ story_root: 500, n: 12 }]
        });
        await tick(deps);

        const agg = queries.find((q) => q.mode === 'aggregate');
        expect(agg).toMatchObject({
            dir: 'hn', object: 'comments',
            group_by: ['story_root'],
            criteria: [{ field: 'story_root', op: 'in', value: [500] }]
        });

        const upd = queries.find((q) => q.mode === 'bulk-update');
        expect(upd).toMatchObject({
            dir: 'hn', object: 'stories',
            records: { '500': { descendants: 12 } }
        });
    });

    test('comments on a story inserted THIS tick are excluded from the sync', async () => {
        await write(700);
        const { deps, queries } = makeDeps({
            getMaxItem: async () => 702,
            items: [
                { id: 701, type: 'story', by: 'a', time: 1, title: 't', score: 1,
                  url: '', text: '', descendants: 3, deleted: false, dead: false },
                { id: 702, type: 'comment', by: 'b', time: 2,
                  parent: 701, deleted: false, dead: false }
            ] as HnItem[]
        });
        await tick(deps);
        // story 701 came in with the tick's own bulk-insert (descendants
        // straight from HN) — no separate aggregate/bulk-update needed.
        expect(queries.some((q) => q.mode === 'aggregate')).toBe(false);
        expect(queries.some((q) => q.mode === 'bulk-update')).toBe(false);
    });

    test('tick with no comments never fires a descendants sync', async () => {
        await write(800);
        const { deps, queries } = makeDeps({
            getMaxItem: async () => 801,
            items: [
                { id: 801, type: 'story', by: 'a', time: 1, title: 't', score: 1,
                  url: '', text: '', descendants: 0, deleted: false, dead: false }
            ] as HnItem[]
        });
        await tick(deps);
        expect(queries.some((q) => q.mode === 'aggregate')).toBe(false);
    });
});
```

## Task 3 — Read `descendants` straight off the story record; drop the live per-page aggregate

### File: `src/lib/hn/comment-counts.ts`

Find this exact block:

```ts
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
```

Replace it with:

```ts
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
```

Find this exact block:

```ts
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

Delete this block entirely (no replacement) — `applyLiveCommentCounts` has no callers left after this task.

### File: `src/lib/hn/comment-counts.test.ts`

Find this exact block:

```ts
import { describe, test, expect } from 'bun:test';
import { fetchLiveCommentCounts, applyLiveCommentCounts } from './comment-counts';
import type { QueryBody } from '$lib/shard-db/query-types';
```

Replace it with:

```ts
import { describe, test, expect } from 'bun:test';
import { fetchLiveCommentCounts } from './comment-counts';
import type { QueryBody } from '$lib/shard-db/query-types';
```

Find this exact block:

```ts
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

Delete this block entirely (no replacement).

### File: `src/routes/+page.server.ts`

Find this exact block:

```ts
import { isError } from '$lib/shard-db/client';
import { cachedQuery, windowAnchor } from '$lib/refresh-cache';
import { applyLiveCommentCounts } from '$lib/hn/comment-counts';
import type { Story, Comment } from '$lib/hn/types';
```

Replace it with:

```ts
import { isError } from '$lib/shard-db/client';
import { cachedQuery, windowAnchor } from '$lib/refresh-cache';
import type { Story, Comment } from '$lib/hn/types';
```

Find this exact block:

```ts
	let items: Array<Story | Comment> = rows.map((r) =>
		({ key: r.key, ...r.value } as Story | Comment)
	);
	if (sourceObject === 'stories') {
		items = await applyLiveCommentCounts(items as Story[]);
	}
	const totalCount: number | null = cr.total ?? null;
```

Replace it with:

```ts
	const items: Array<Story | Comment> = rows.map((r) =>
		({ key: r.key, ...r.value } as Story | Comment)
	);
	const totalCount: number | null = cr.total ?? null;
```

### File: `src/routes/trending/+page.server.ts`

Find this exact block:

```ts
import { isError } from '$lib/shard-db/client';
import { cachedQuery, windowAnchor } from '$lib/refresh-cache';
import { applyLiveCommentCounts } from '$lib/hn/comment-counts';
import type { Story } from '$lib/hn/types';
```

Replace it with:

```ts
import { isError } from '$lib/shard-db/client';
import { cachedQuery, windowAnchor } from '$lib/refresh-cache';
import type { Story } from '$lib/hn/types';
```

Find this exact block:

```ts
	const rows = topStoriesResp as Array<{ key: string; value: Omit<Story, 'key'> }>;
	const stories: Story[] = await applyLiveCommentCounts(
		rows.map((r) => ({ key: r.key, ...r.value }))
	);
	const totalCount = totalCountResp as number;
```

Replace it with:

```ts
	const rows = topStoriesResp as Array<{ key: string; value: Omit<Story, 'key'> }>;
	const stories: Story[] = rows.map((r) => ({ key: r.key, ...r.value }));
	const totalCount = totalCountResp as number;
```

### File: `src/routes/u/[username]/+page.server.ts`

Find this exact block:

```ts
import { error } from '@sveltejs/kit';
import { shardDb, isError } from '$lib/shard-db/client';
import { applyLiveCommentCounts } from '$lib/hn/comment-counts';
import type { UserProfile, Story, Comment } from '$lib/hn/types';
```

Replace it with:

```ts
import { error } from '@sveltejs/kit';
import { shardDb, isError } from '$lib/shard-db/client';
import type { UserProfile, Story, Comment } from '$lib/hn/types';
```

Find this exact block:

```ts
		const arr = storiesResp as Array<{ key: string; value: Omit<Story, 'key'> }>;
		stories = await applyLiveCommentCounts(arr.map((r) => ({ key: r.key, ...r.value })));
```

Replace it with:

```ts
		const arr = storiesResp as Array<{ key: string; value: Omit<Story, 'key'> }>;
		stories = arr.map((r) => ({ key: r.key, ...r.value }));
```

## Verification

1. `bun run check` — must complete with no type errors.
2. `bun test` — paste the real output; must show every `comment-counts.test.ts` and `refresh.test.ts` case passing, with no reference to `applyLiveCommentCounts` remaining anywhere in `src/`.
3. `grep -rn "applyLiveCommentCounts" src/` — must return no results.

Do not report this plan as complete without pasting the actual output of steps 1 and 2.

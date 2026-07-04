import { describe, test, expect, beforeEach } from 'bun:test';
import { unlinkSync, existsSync } from 'node:fs';
import { tick, type TickDeps } from './refresh';
import { STATE_PATH, read, write } from './state';
import * as cache from './cache';
import type { HnItem } from './hn-api';

/** Build a fresh set of in-memory test doubles for one test.  We
 *  inject these into `tick()` via the `deps` parameter rather than
 *  patching the module loader — keeps the test self-contained and
 *  avoids Bun's mock.module import-ordering footguns. */
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

describe('refresh tick', () => {
    beforeEach(() => {
        if (existsSync(STATE_PATH)) unlinkSync(STATE_PATH);
        cache.clearForTesting();
    });

    test('first run (no state file) seeds last_seen_id from current maxitem and skips backfill', async () => {
        const { deps, queries } = makeDeps({ getMaxItem: async () => 40_000_000 });
        const r = await tick(deps);
        expect(r.upserted.total).toBe(0);
        expect(await read()).toBe(40_000_000);
        // No backfill: zero bulk-insert calls.  (Task 7 will add cache
        // rewarm here which fires `count`/`find` queries — we only
        // care that no items were upserted.)
        const inserts = queries.filter((q) => q.mode === 'bulk-insert');
        expect(inserts).toHaveLength(0);
    });

    test('no new items: returns 0 upserts, state unchanged', async () => {
        await write(100);
        const { deps } = makeDeps({ getMaxItem: async () => 100 });
        const result = await tick(deps);
        expect(result.upserted.total).toBe(0);
        expect(await read()).toBe(100);
        // Cache rewarm semantics on this path are tested in Task 7.
    });

    test('new items: partitions by type, upserts, advances state', async () => {
        await write(100);
        const { deps, queries } = makeDeps({
            getMaxItem: async () => 103,
            items: [
                { id: 101, type: 'story', by: 'a', time: 1, title: 't', score: 5,
                  url: 'u', text: '', descendants: 0, deleted: false, dead: false },
                { id: 102, type: 'comment', by: 'b', time: 2, text: 'c',
                  parent: 101, deleted: false, dead: false },
                { id: 103, type: 'pollopt', by: 'c', time: 3 }   // dropped
            ] as HnItem[]
        });
        const r = await tick(deps);
        expect(r.upserted.stories).toBe(1);
        expect(r.upserted.comments).toBe(1);
        // users: `a` and `b` are unique posters → 2 upserts
        expect(r.upserted.users).toBeGreaterThanOrEqual(2);
        expect(await read()).toBe(103);
        const inserts = queries.filter((q) => q.mode === 'bulk-insert');
        expect(inserts.length).toBeGreaterThanOrEqual(2); // stories + comments + (maybe) users
    });

    test('hn fetch failure: aborts tick, state untouched', async () => {
        await write(100);
        const { deps } = makeDeps({
            getMaxItem: async () => { throw new Error('network'); }
        });
        const r = await tick(deps);
        expect(r.upserted.total).toBe(0);
        expect(await read()).toBe(100);
    });

    test('upserts > 0 triggers cache rewarm', async () => {
        await write(100);
        const { deps } = makeDeps({
            getMaxItem: async () => 101,
            items: [
                { id: 101, type: 'story', by: 'x', time: 1, title: 't', score: 1,
                  url: '', text: '', descendants: 0, deleted: false, dead: false }
            ] as HnItem[]
        });
        await tick(deps);
        // Cache should be populated.  Don't assert an exact size — the
        // unique-key count depends on canonicalKey collapse rules in
        // keys.ts.  Just confirm it grew above zero.
        expect(cache.stats().size).toBeGreaterThan(0);
    });

    test('cold-start (cache empty) rewarms even when upserts = 0', async () => {
        await write(200);
        const { deps } = makeDeps({ getMaxItem: async () => 200 });
        await tick(deps);
        expect(cache.stats().size).toBeGreaterThan(0);
    });

    test('large delta is capped to MAX_ITEMS_PER_TICK; state advances by cap, not maxItem', async () => {
        /* Stale bulk-load snapshot scenario: state at 1000, HN at 1,000,100
           (1M+ gap). Without the cap a single tick tries to fetch 1M items
           via HN Firebase, rate-limits, fails, and the next tick repeats.
           With the cap: tick processes 10k ids, advances state by 10k,
           remaining gap drains over future ticks. */
        await write(1000);
        const { deps } = makeDeps({
            getMaxItem: async () => 1_001_000,
            // Mock returns no real items — we're only checking the cap +
            // state-advance behaviour, not the per-item processing.
            items: []
        });
        await tick(deps);
        // MAX_ITEMS_PER_TICK = 10_000; lastSeen advances 1000 → 11_000
        expect(await read()).toBe(11_000);
    });

    test('small delta below MAX_ITEMS_PER_TICK advances state to maxItem', async () => {
        // Normal steady-state case — make sure the cap doesn't artificially
        // hold back state when the actual gap is smaller than the cap.
        await write(100);
        const { deps } = makeDeps({
            getMaxItem: async () => 105,
            items: []
        });
        await tick(deps);
        expect(await read()).toBe(105);
    });

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

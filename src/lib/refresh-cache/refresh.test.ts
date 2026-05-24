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
});

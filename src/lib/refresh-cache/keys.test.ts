import { describe, test, expect } from 'bun:test';
import { canonicalKey, enumerateKeys, windowAnchor, REWARM_BUCKET_MS } from './keys';

describe('canonicalKey', () => {
    test('produces stable strings regardless of object key order', () => {
        const k1 = canonicalKey({ a: 1, b: 2, c: [3, 4] });
        const k2 = canonicalKey({ c: [3, 4], a: 1, b: 2 });
        expect(k1).toBe(k2);
    });

    test('distinguishes different criteria', () => {
        const k1 = canonicalKey({ mode: 'count', object: 'stories' });
        const k2 = canonicalKey({ mode: 'count', object: 'comments' });
        expect(k1).not.toBe(k2);
    });

    test('handles nested arrays of objects', () => {
        const q = {
            mode: 'find',
            criteria: [{ field: 'a', op: 'eq', value: 1 }, { field: 'b', op: 'gte', value: 2 }]
        };
        // same structure, same string
        expect(canonicalKey(q)).toBe(canonicalKey(structuredClone(q)));
    });
});

describe('enumerateKeys', () => {
    const all = Array.from(enumerateKeys());

    test('yields 3 top-level count entries', () => {
        const tops = all.filter((e) => !('criteria' in (e.query as Record<string, unknown>)));
        expect(tops.length).toBe(3);
        const objects = tops.map((t) => (t.query as { object: string }).object).sort();
        expect(objects).toEqual(['comments', 'stories', 'users']);
    });

    test('yields some first-page query entries (count varies as duplicates collapse)', () => {
        const filtered = all.filter((e) => 'criteria' in (e.query as Record<string, unknown>));
        // Lower bound: at least one entry per unique non-comment category × {find, count}.
        expect(filtered.length).toBeGreaterThanOrEqual(50);
        // Upper bound: never more than 7 categories × 3 sorts × 4 windows × 2 shapes = 168.
        expect(filtered.length).toBeLessThanOrEqual(168);
    });

    test('every yielded key is unique (canonicalKey collapse handled by generator)', () => {
        const seen = new Set(all.map((e) => e.key));
        expect(seen.size).toBe(all.length);
    });

    test('every entry has a string key and a query payload', () => {
        for (const e of all) {
            expect(typeof e.key).toBe('string');
            expect(typeof e.query).toBe('object');
        }
    });
});

describe('windowAnchor', () => {
    test('snaps to floor(now / REWARM_BUCKET_MS) * REWARM_BUCKET_MS', () => {
        const t = REWARM_BUCKET_MS * 7 + 12345;
        expect(windowAnchor(t)).toBe(REWARM_BUCKET_MS * 7);
    });

    test('two calls inside the same bucket return the same anchor', () => {
        const t1 = REWARM_BUCKET_MS * 3 + 100;
        const t2 = REWARM_BUCKET_MS * 3 + REWARM_BUCKET_MS - 1;
        expect(windowAnchor(t1)).toBe(windowAnchor(t2));
    });

    test('crossing a bucket boundary advances the anchor', () => {
        const t1 = REWARM_BUCKET_MS * 5 + REWARM_BUCKET_MS - 1;
        const t2 = REWARM_BUCKET_MS * 5 + REWARM_BUCKET_MS;
        expect(windowAnchor(t1)).not.toBe(windowAnchor(t2));
    });
});

describe('keys time-window alignment', () => {
    test('enumerator and route produce identical canonical key for windowed find', () => {
        // Simulate: rewarm and route both fire inside the same bucket.
        const t = REWARM_BUCKET_MS * 100 + 12345;
        const anchor = windowAnchor(t);

        // What the enumerator would emit for (category='', sort='popularity', window='24h'):
        const enumerated = Array.from(enumerateKeys(t)).find((e) => {
            const q = e.query as Record<string, unknown>;
            if (q.mode !== 'find') return false;
            const criteria = q.criteria as Array<{ field: string; op: string; value: unknown }>;
            return criteria.some((c) => c.field === 'time' && c.op === 'gte');
        });
        expect(enumerated).toBeDefined();

        // What the route would build for the same combo at the same anchor.
        // Replicate the route's filter set verbatim — anchor minus 24h.
        const routeFindQuery = {
            mode: 'find',
            dir: 'hn',
            object: 'stories',
            criteria: [
                { field: 'dead',    op: 'eq', value: 'false' },
                { field: 'deleted', op: 'eq', value: 'false' },
                { field: 'type',    op: 'in', value: 'story,job,poll' },
                { field: 'time',    op: 'gte', value: anchor - 24 * 60 * 60 * 1000 }
            ],
            order_by: 'score',
            order: 'desc',
            limit: 25,
            cursor: null
        };

        expect(canonicalKey(routeFindQuery)).toBe(enumerated!.key);
    });
});

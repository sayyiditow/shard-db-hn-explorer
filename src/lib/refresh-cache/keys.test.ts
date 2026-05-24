import { describe, test, expect } from 'bun:test';
import { canonicalKey, enumerateKeys } from './keys';

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

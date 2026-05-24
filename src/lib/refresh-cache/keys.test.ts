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

    test('yields 168 first-page query entries (84 combos × {find, count})', () => {
        const filtered = all.filter((e) => 'criteria' in (e.query as Record<string, unknown>));
        expect(filtered.length).toBe(168);
    });

    test('total = 171 unique keys', () => {
        const seen = new Set(all.map((e) => e.key));
        expect(seen.size).toBe(all.length);
        expect(all.length).toBe(171);
    });

    test('every entry has a string key and a query payload', () => {
        for (const e of all) {
            expect(typeof e.key).toBe('string');
            expect(typeof e.query).toBe('object');
        }
    });
});

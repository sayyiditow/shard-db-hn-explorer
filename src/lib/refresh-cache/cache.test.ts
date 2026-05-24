import { describe, test, expect, beforeEach } from 'bun:test';
import { get, swap, stats, clearForTesting } from './cache';

describe('cache', () => {
    beforeEach(() => { clearForTesting(); });

    test('get() returns null when no map has been swapped in', () => {
        expect(get('anything')).toBeNull();
    });

    test('swap() installs a map readable via get()', () => {
        const m = new Map([
            ['k1', { result: { a: 1 }, mtime: 1000 }],
            ['k2', { result: [1, 2, 3], mtime: 1000 }]
        ]);
        swap(m);
        expect(get('k1')).toEqual({ a: 1 });
        expect(get('k2')).toEqual([1, 2, 3]);
        expect(get('missing')).toBeNull();
    });

    test('swap() replaces entirely (old keys gone)', () => {
        swap(new Map([['old', { result: 1, mtime: 1 }]]));
        swap(new Map([['new', { result: 2, mtime: 2 }]]));
        expect(get('old')).toBeNull();
        expect(get('new')).toBe(2);
    });

    test('stats() reports size and last_swap_at', () => {
        const before = stats();
        expect(before.size).toBe(0);
        expect(before.lastSwapAt).toBeNull();

        const swapTime = Date.now();
        swap(new Map([['k', { result: 1, mtime: swapTime }]]));
        const after = stats();
        expect(after.size).toBe(1);
        expect(after.lastSwapAt).not.toBeNull();
        expect(after.lastSwapAt!).toBeGreaterThanOrEqual(swapTime);
    });
});

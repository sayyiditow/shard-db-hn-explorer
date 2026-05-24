import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { getMaxItem, getItem, getItemsConcurrent } from './hn-api';

const realFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof mock>;

describe('hn-api', () => {
    beforeEach(() => {
        fetchMock = mock(async () => new Response(JSON.stringify(null)));
        globalThis.fetch = fetchMock as unknown as typeof fetch;
    });

    test('getMaxItem returns the integer from /v0/maxitem.json', async () => {
        fetchMock.mockImplementation(async () => new Response('40000000'));
        const v = await getMaxItem();
        expect(v).toBe(40000000);
        expect(fetchMock).toHaveBeenCalledWith(
            'https://hacker-news.firebaseio.com/v0/maxitem.json'
        );
    });

    test('getItem returns the parsed item', async () => {
        const item = { id: 42, type: 'story', by: 'pg', time: 1234, title: 'hi' };
        fetchMock.mockImplementation(async () => new Response(JSON.stringify(item)));
        const got = await getItem(42);
        expect(got).toEqual(item as never);
    });

    test('getItem returns null on null body (deleted item)', async () => {
        fetchMock.mockImplementation(async () => new Response('null'));
        expect(await getItem(99)).toBeNull();
    });

    test('getItem returns null on HTTP error', async () => {
        fetchMock.mockImplementation(async () => new Response('boom', { status: 500 }));
        expect(await getItem(99)).toBeNull();
    });

    test('getItemsConcurrent fetches all ids with bounded concurrency', async () => {
        let inflight = 0, peak = 0;
        fetchMock.mockImplementation(async (input) => {
            inflight++; peak = Math.max(peak, inflight);
            await new Promise((r) => setTimeout(r, 5));
            inflight--;
            const id = parseInt(String(input).match(/item\/(\d+)/)![1], 10);
            return new Response(JSON.stringify({ id, type: 'story' }));
        });
        const out = await getItemsConcurrent([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3);
        expect(out.length).toBe(10);
        expect(peak).toBeLessThanOrEqual(3);
    });

    // restore
    test('cleanup: restore fetch', () => {
        globalThis.fetch = realFetch;
        expect(typeof globalThis.fetch).toBe('function');
    });
});

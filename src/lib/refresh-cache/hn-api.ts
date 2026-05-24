/** HN Firebase API thin wrappers.
 *
 *  - `getMaxItem()` — highest item ID currently in HN (monotonically
 *    increasing across stories/comments/polls/jobs).
 *  - `getItem(id)` — full item record; returns null for deleted items
 *    or any non-2xx response so callers can skip-and-continue.
 *  - `getItemsConcurrent(ids, limit)` — fetches a batch with bounded
 *    in-flight count, dropping nulls.
 *
 *  HN's public API has no documented rate limit; their docs ask
 *  consumers to "be nice."  Concurrency of 16 is what their official
 *  examples suggest. */

const BASE = 'https://hacker-news.firebaseio.com/v0';

export interface HnItem {
    id: number;
    type?: 'story' | 'comment' | 'job' | 'poll' | 'pollopt';
    by?: string;
    time?: number;          // seconds since epoch
    text?: string;
    url?: string;
    title?: string;
    score?: number;
    parent?: number;
    descendants?: number;
    deleted?: boolean;
    dead?: boolean;
    kids?: number[];
}

export async function getMaxItem(): Promise<number> {
    const r = await fetch(`${BASE}/maxitem.json`);
    if (!r.ok) throw new Error(`maxitem fetch failed: ${r.status}`);
    return parseInt(await r.text(), 10);
}

export async function getItem(id: number): Promise<HnItem | null> {
    try {
        const r = await fetch(`${BASE}/item/${id}.json`);
        if (!r.ok) return null;
        const body = await r.text();
        if (body === 'null') return null;
        return JSON.parse(body) as HnItem;
    } catch {
        return null;
    }
}

/** Fetch ids in parallel with at most `limit` in-flight requests. */
export async function getItemsConcurrent(
    ids: number[],
    limit = 16
): Promise<HnItem[]> {
    const out: HnItem[] = [];
    let cursor = 0;

    async function worker(): Promise<void> {
        while (true) {
            const i = cursor++;
            if (i >= ids.length) return;
            const item = await getItem(ids[i]);
            if (item !== null) out.push(item);
        }
    }

    const workers = Array.from({ length: Math.min(limit, ids.length) }, worker);
    await Promise.all(workers);
    return out;
}

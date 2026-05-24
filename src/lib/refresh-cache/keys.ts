/** Cache-key enumeration + canonicalisation.
 *
 *  The route layer asks for queries via `canonicalKey(payload)`; the
 *  refresh re-warm pass iterates `enumerateKeys()` to populate every
 *  cacheable slot.
 *
 *  Coverage:
 *    3 top-level counts (stories, comments, users)
 *    + 7 categories × 3 sorts × 4 windows × 2 query shapes (find/count) = 168
 *    = 171 slots total.
 *
 *  Categories / sorts / windows mirror +page.server.ts; if those
 *  expand, this list must too. */

const PAGE_SIZE = 25;
const HN_DIR = 'hn';

const CATEGORIES = ['', 'story', 'job', 'poll', 'ask', 'show', 'comment'] as const;
const SORTS      = ['popularity', 'newest', 'hot'] as const;
const WINDOWS    = ['24h', '7d', '30d', 'all'] as const;

type Category = (typeof CATEGORIES)[number];
type Sort     = (typeof SORTS)[number];
type Win      = (typeof WINDOWS)[number];

const WINDOW_MS: Record<Win, number | null> = {
    '24h': 24 * 60 * 60 * 1000,
    '7d':  7  * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000,
    'all': null
};
const HOT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const SORT_FIELDS: Record<Sort, string> = { popularity: 'score', newest: 'time', hot: 'score' };

export interface CacheEntry {
    key: string;
    query: Record<string, unknown>;
}

/** Deterministic JSON-stringify with sorted object keys.  Arrays
 *  preserve order (positional semantics); plain objects sort. */
export function canonicalKey(value: unknown): string {
    return JSON.stringify(canonicalise(value));
}

function canonicalise(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(canonicalise);
    if (v !== null && typeof v === 'object') {
        const out: Record<string, unknown> = {};
        const keys = Object.keys(v as Record<string, unknown>).sort();
        for (const k of keys) out[k] = canonicalise((v as Record<string, unknown>)[k]);
        return out;
    }
    return v;
}

/** Build the criteria array for a (category, sort, window) combo on
 *  whichever source object the category targets. `referenceNowMs` is
 *  the timestamp used to anchor the relative time windows — passing
 *  it in (rather than calling Date.now() here) keeps keys stable
 *  within a single re-warm pass and makes tests reproducible. */
function buildCriteria(
    category: Category,
    sort: Sort,
    win: Win,
    referenceNowMs: number
): { source: 'stories' | 'comments'; criteria: object[]; order_by: string } {
    const source: 'stories' | 'comments' = category === 'comment' ? 'comments' : 'stories';
    const criteria: object[] = [
        { field: 'dead',    op: 'eq', value: 'false' },
        { field: 'deleted', op: 'eq', value: 'false' }
    ];

    switch (category) {
        case 'story': criteria.push({ field: 'type', op: 'eq', value: 'story' }); break;
        case 'job':   criteria.push({ field: 'type', op: 'eq', value: 'job'   }); break;
        case 'poll':  criteria.push({ field: 'type', op: 'eq', value: 'poll'  }); break;
        case 'ask':
            criteria.push({ field: 'type',  op: 'eq',     value: 'story' });
            criteria.push({ field: 'title', op: 'starts', value: 'Ask HN' });
            break;
        case 'show':
            criteria.push({ field: 'type',  op: 'eq',     value: 'story' });
            criteria.push({ field: 'title', op: 'starts', value: 'Show HN' });
            break;
        case 'comment':
            break;
        default:
            criteria.push({ field: 'type', op: 'in', value: 'story,job,poll' });
    }

    const windowMs = WINDOW_MS[win];
    if (windowMs !== null) {
        criteria.push({ field: 'time', op: 'gte', value: referenceNowMs - windowMs });
    } else if (sort === 'hot') {
        criteria.push({ field: 'time', op: 'gte', value: referenceNowMs - HOT_WINDOW_MS });
    }

    const order_by = SORT_FIELDS[sort];

    return { source, criteria, order_by };
}

/** Yields all cache entries (3 top-level + 168 first-page). The route
 *  layer hashes its own request with canonicalKey() and looks up by
 *  the same string; we don't expose the (category, sort, window)
 *  tuple — the key is the canonical query JSON. */
export function* enumerateKeys(referenceNowMs: number = Date.now()): Generator<CacheEntry> {
    // 3 top-level counts
    for (const object of ['stories', 'comments', 'users']) {
        const q = { mode: 'count', dir: HN_DIR, object };
        yield { key: canonicalKey(q), query: q };
    }

    // 168 first-page queries (84 combos × {find, count})
    for (const category of CATEGORIES) {
        for (const sort of SORTS) {
            for (const win of WINDOWS) {
                const { source, criteria, order_by } = buildCriteria(category, sort, win, referenceNowMs);

                const findQ = {
                    mode: 'find',
                    dir: HN_DIR,
                    object: source,
                    criteria,
                    order_by,
                    order: 'desc',
                    limit: PAGE_SIZE,
                    cursor: null,
                    _sort: sort,  // Metadata for cache differentiation
                    _window: win
                };
                yield { key: canonicalKey(findQ), query: findQ };

                const countQ = {
                    mode: 'count',
                    dir: HN_DIR,
                    object: source,
                    criteria,
                    _sort: sort,  // Metadata for cache differentiation
                    _window: win
                };
                yield { key: canonicalKey(countQ), query: countQ };
            }
        }
    }
}

/** Cache-key enumeration + canonicalisation.
 *
 *  The route layer asks for queries via `canonicalKey(payload)`; the
 *  refresh re-warm pass iterates `enumerateKeys()` to populate every
 *  cacheable slot.
 *
 *  Coverage:
 *    3 top-level counts (stories, comments, users)
 *    + every (category, sort, window) first-page query, deduped by
 *      canonical key.  Comment-source queries collapse aggressively
 *      because all three sorts map to order_by=time.  Actual yield
 *      is somewhere around 120 entries depending on time-window
 *      semantics.
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

/** Snap `now` to the most recent 5-min bucket boundary.  Both the
 *  cache rewarm and the route's request-time criteria construction
 *  call this so they produce identical `time gte` values within the
 *  bucket — otherwise the embedded epoch-ms drifts and every
 *  windowed cache key becomes a miss.  When the bucket advances
 *  between rewarm and a route call, lookups miss naturally until the
 *  next refresh tick rebuilds the cache. */
export const REWARM_BUCKET_MS = 5 * 60 * 1000;
export function windowAnchor(now: number = Date.now()): number {
    return Math.floor(now / REWARM_BUCKET_MS) * REWARM_BUCKET_MS;
}

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

    const anchor = windowAnchor(referenceNowMs);
    const windowMs = WINDOW_MS[win];
    if (windowMs !== null) {
        criteria.push({ field: 'time', op: 'gte', value: anchor - windowMs });
    } else if (sort === 'hot') {
        criteria.push({ field: 'time', op: 'gte', value: anchor - HOT_WINDOW_MS });
    }

    let order_by = SORT_FIELDS[sort];
    if (source === 'comments' && (sort === 'popularity' || sort === 'hot')) {
        order_by = 'time';
    }

    return { source, criteria, order_by };
}

/** Yields all cache entries (3 top-level + first-page queries, deduped).
 *  The route layer hashes its own request with canonicalKey() and looks
 *  up by the same string; we don't expose the (category, sort, window)
 *  tuple — the key is the canonical query JSON. Duplicate keys collapse
 *  naturally when comments queries rewrite sort to 'time'. */
export function* enumerateKeys(referenceNowMs: number = Date.now()): Generator<CacheEntry> {
    const seen = new Set<string>();

    // 3 top-level counts
    for (const object of ['stories', 'comments', 'users']) {
        const q = { mode: 'count', dir: HN_DIR, object };
        const key = canonicalKey(q);
        if (seen.has(key)) continue;
        seen.add(key);
        yield { key, query: q };
    }

    // First-page queries (duplicates collapse naturally — comment-source
    // queries rewrite popularity/hot → time so all three sorts map to
    // the same payload at most windows; we dedupe by canonical key).
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
                    cursor: null
                };
                const findKey = canonicalKey(findQ);
                if (!seen.has(findKey)) {
                    seen.add(findKey);
                    yield { key: findKey, query: findQ };
                }

                const countQ = {
                    mode: 'count',
                    dir: HN_DIR,
                    object: source,
                    criteria
                };
                const countKey = canonicalKey(countQ);
                if (!seen.has(countKey)) {
                    seen.add(countKey);
                    yield { key: countKey, query: countQ };
                }
            }
        }
    }

    // /trending panel — one find + one count per window-tab.  Time
    // thresholds use windowAnchor() so the route's request-time
    // computation lines up with the cache key.
    const trendingAnchor = windowAnchor(referenceNowMs);
    const TRENDING_LIMIT = 30;
    const trendingWindows: Array<{ name: string; ms: number | null }> = [
        { name: '1h',  ms: 60 * 60 * 1000 },
        { name: '24h', ms: 24 * 60 * 60 * 1000 },
        { name: '7d',  ms: 7  * 24 * 60 * 60 * 1000 },
        { name: 'all', ms: null }
    ];
    for (const win of trendingWindows) {
        const trCrit: object[] = [
            { field: 'type',    op: 'eq', value: 'story' },
            { field: 'dead',    op: 'eq', value: 'false' },
            { field: 'deleted', op: 'eq', value: 'false' }
        ];
        if (win.ms != null) {
            trCrit.push({ field: 'time', op: 'gte', value: trendingAnchor - win.ms });
        }
        const trFind = {
            mode: 'find',
            dir: HN_DIR,
            object: 'stories',
            criteria: trCrit,
            order_by: 'score',
            order: 'desc',
            limit: TRENDING_LIMIT
        };
        const trCount = {
            mode: 'count',
            dir: HN_DIR,
            object: 'stories',
            criteria: trCrit
        };
        for (const q of [trFind, trCount]) {
            const key = canonicalKey(q);
            if (!seen.has(key)) {
                seen.add(key);
                yield { key, query: q };
            }
        }
    }

    // /stats panel aggregates — stable queries (no URL params), perfect
    // cache candidates.  Same shape every page load → deterministic key.
    //
    // NOTE: the all-time rankings (top story authors, top commenters) are
    // deliberately NOT here. They're whole-history group_bys that don't move
    // minute to minute; recomputing them on this 5-min tick is waste (and the
    // commenter walk is ~95s). They live in slow-stats.ts on a 1-hour cadence
    // and the /stats page reads them cache-only from there.
    const statsQueries: Record<string, unknown>[] = [
        // Top users (find by karma desc — no aggregate, just an ordered scan)
        {
            mode: 'find',
            dir: HN_DIR,
            object: 'users',
            criteria: [],
            order_by: 'karma',
            order: 'desc',
            limit: 20,
            fields: ['karma', 'created', 'submitted_count'],
            format: 'dict'
        }
    ];
    for (const q of statsQueries) {
        const key = canonicalKey(q);
        if (!seen.has(key)) {
            seen.add(key);
            yield { key, query: q };
        }
    }
}

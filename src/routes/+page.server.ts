import { shardDb, isError } from '$lib/shard-db/client';
import type { Story } from '$lib/hn/types';
import type { PageServerLoad } from './$types';

/**
 * Home (/) — unified browse + search, modelled after Algolia's HN
 * homepage. Query params drive everything:
 *
 *   q       — substring filter (trigram on title); empty = browse all
 *   type    — story | job | poll | <empty> (enum filter via auto-bitmap)
 *   sort    — popularity (score desc) | newest (time desc)
 *   window  — 24h | 7d | 30d | all (time range filter)
 *   by      — author username (btree-eq filter)
 *   after   — opaque cursor JSON (forward pagination only — back via browser)
 *
 * Page size is fixed at 25 to match Algolia's UX. Cursor pagination
 * (shard-db's keyset cursor on the order_by field) is what makes
 * page-N as cheap as page-1 — no O(offset) skip cost at deep pages.
 */

const PAGE_SIZE = 25;

const WINDOW_MS: Record<string, number | null> = {
	'24h': 24 * 60 * 60 * 1000,
	'7d':  7  * 24 * 60 * 60 * 1000,
	'30d': 30 * 24 * 60 * 60 * 1000,
	'all': null
};

type Sort = 'popularity' | 'newest';
const SORT_FIELDS: Record<Sort, string> = {
	popularity: 'score',
	newest:     'time'
};

export const load: PageServerLoad = async ({ url }) => {
	const q      = (url.searchParams.get('q')      ?? '').trim();
	const type   = (url.searchParams.get('type')   ?? '').trim();
	const sortRaw = (url.searchParams.get('sort')  ?? 'popularity').trim();
	const winRaw  = (url.searchParams.get('window')?? 'all').trim();
	const by     = (url.searchParams.get('by')     ?? '').trim();
	const after  = (url.searchParams.get('after')  ?? '').trim();

	const sort: Sort = sortRaw === 'newest' ? 'newest' : 'popularity';
	const win  = winRaw in WINDOW_MS ? winRaw : 'all';
	const order_by = SORT_FIELDS[sort];

	// Build criteria. Filter-first planner (shard-db 2026.05.7.x)
	// composes these into a KeySet so the cursor walk of order_by
	// only fetches records that pass all filters.
	const criteria: object[] = [];

	// Skip dead/deleted by default (browse is "live" stories). bitmap
	// on bool fields → popcount intersect, cheap.
	criteria.push({ field: 'dead',    op: 'eq', value: 'false' });
	criteria.push({ field: 'deleted', op: 'eq', value: 'false' });

	if (type) {
		// `type` is an enum field → auto-bitmap. Selective when filtered
		// to job/poll/pollopt, broad when type=story (~99% of items).
		criteria.push({ field: 'type', op: 'eq', value: type });
	} else {
		// Default: hide pollopts (they're option entries of polls, not
		// independent items) when nothing else is filtered.
		criteria.push({ field: 'type', op: 'in', value: 'story,job,poll' });
	}

	if (q.length >= 3) {
		criteria.push({ field: 'title', op: 'icontains', value: q });
	}

	if (by) {
		criteria.push({ field: 'by', op: 'eq', value: by });
	}

	const windowMs = WINDOW_MS[win];
	if (windowMs != null) {
		const since = Date.now() - windowMs;
		criteria.push({ field: 'time', op: 'gte', value: since });
	}

	// Cursor: forward-only. The shard-db cursor carries (order_by_value,
	// primary_key) tying back to the order_by btree position. URL-encoded
	// here so it survives links. Parse failures fall back to page 1.
	let cursor: object | null = null;
	if (after) {
		try {
			cursor = JSON.parse(decodeURIComponent(after));
		} catch {
			cursor = null;
		}
	}

	// Always pass `cursor` so shard-db emits the {rows, cursor} envelope
	// (even on page 1) — that's the only way to get the next-page cursor
	// out of the response. Passing null means "start from page 1"; an
	// object means "resume from this position".
	const findQuery: Record<string, unknown> = {
		mode: 'find',
		dir: 'hn',
		object: 'stories',
		criteria,
		order_by,
		order: 'desc',
		limit: PAGE_SIZE,
		cursor: cursor ?? null
	};

	// Page number for display only — server doesn't use it; the cursor
	// is what actually drives pagination. UI increments on each `Older
	// →` click; browser back decrements naturally via URL history.
	const pageRaw = parseInt(url.searchParams.get('page') ?? '1', 10);
	const page = isNaN(pageRaw) || pageRaw < 1 ? 1 : pageRaw;

	const t0 = performance.now();

	// Five queries in parallel: page of results + page-scoped count +
	// three top-level "what's in the DB" counts for the stats strip.
	// The three top-level counts hit kf header metadata (O(1) per
	// object) so they're <10ms cold and basically free warm — cheap
	// enough to fire on every home-page load.
	const [pageResp, countResp, storiesTotal, commentsTotal, usersTotal] = await Promise.all([
		shardDb.query(findQuery),
		shardDb.query({ mode: 'count', dir: 'hn', object: 'stories', criteria }),
		shardDb.query<number>({ mode: 'count', dir: 'hn', object: 'stories' }),
		shardDb.query<number>({ mode: 'count', dir: 'hn', object: 'comments' }),
		shardDb.query<number>({ mode: 'count', dir: 'hn', object: 'users' })
	]);

	const queryMs = performance.now() - t0;

	const dbStats = {
		stories:  isError(storiesTotal)  ? 0 : (storiesTotal  as number),
		comments: isError(commentsTotal) ? 0 : (commentsTotal as number),
		users:    isError(usersTotal)    ? 0 : (usersTotal    as number)
	};

	if (isError(pageResp) || isError(countResp)) {
		const err = isError(pageResp) ? pageResp.error : (countResp as { error: string }).error;
		return {
			q, type, sort, window: win, by, page,
			stories: [], totalCount: 0, queryMs,
			pageSize: PAGE_SIZE,
			nextCursor: null as string | null,
			dbStats,
			error: err
		};
	}

	// Cursor mode returns {rows: [...], cursor: {...} | null}. Without
	// cursor it returns a bare array. Normalise both shapes.
	let rows: Array<{ key: string; value: Omit<Story, 'key'> }>;
	let nextCursor: string | null = null;
	if (Array.isArray(pageResp)) {
		rows = pageResp as Array<{ key: string; value: Omit<Story, 'key'> }>;
	} else {
		const cr = pageResp as { rows: Array<{ key: string; value: Omit<Story, 'key'> }>; cursor: object | null };
		rows = cr.rows;
		nextCursor = cr.cursor ? encodeURIComponent(JSON.stringify(cr.cursor)) : null;
	}

	const stories: Story[] = rows.map((r) => ({ key: r.key, ...r.value }));
	const totalCount = countResp as number;

	return {
		q, type, sort, window: win, by, page,
		stories, totalCount, queryMs,
		pageSize: PAGE_SIZE,
		nextCursor,
		dbStats,
		query: findQuery  // so /stats-style "show query" works if we want
	};
};

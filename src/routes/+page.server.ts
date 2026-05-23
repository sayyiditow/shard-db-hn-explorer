import { shardDb, isError } from '$lib/shard-db/client';
import type { Story, Comment } from '$lib/hn/types';
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

type Sort = 'popularity' | 'newest' | 'hot';
const SORT_FIELDS: Record<Sort, string> = {
	popularity: 'score',
	newest:     'time',
	hot:        'score'  // hot = score desc within an implicit recent window
};

/** "Hot" enforces a recency window. HN's real ranking is
 *  `score / (age_hours + 2)^1.8` — we approximate with the simpler
 *  "highest-scored items in the last N days" since we don't have a
 *  computed field. 30 days is enough to surface anything currently
 *  active without slipping into bygone-classics territory. */
const HOT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Category combines `type` (enum bitmap) with optional title prefix
 *  to surface HN's signature derived categories (Ask HN, Show HN).
 *  - story / job / poll → straight enum eq on stories object
 *  - ask  → stories WHERE title starts_with "Ask HN"
 *  - show → stories WHERE title starts_with "Show HN"
 *  - comment → switches source object to `comments` entirely
 *  - ''   → no category filter (stories, except pollopt) */
type Category = '' | 'story' | 'job' | 'poll' | 'ask' | 'show' | 'comment';
const CATEGORIES = new Set<Category>(['', 'story', 'job', 'poll', 'ask', 'show', 'comment']);

export const load: PageServerLoad = async ({ url }) => {
	const q         = (url.searchParams.get('q')         ?? '').trim();
	// `category` supersedes the previous `type` param. Old `?type=foo`
	// links still work via a fallback below — keeps deep-linked Algolia-
	// style URLs from breaking after this refactor.
	const catRaw    = (url.searchParams.get('category')  ?? url.searchParams.get('type') ?? '').trim();
	const sortRaw   = (url.searchParams.get('sort')      ?? 'popularity').trim();
	const winRaw    = (url.searchParams.get('window')    ?? 'all').trim();
	const by        = (url.searchParams.get('by')        ?? '').trim();
	const after     = (url.searchParams.get('after')     ?? '').trim();
	const scoreMinRaw = url.searchParams.get('score_min');
	const scoreMaxRaw = url.searchParams.get('score_max');
	const sinceRaw    = url.searchParams.get('since');
	const untilRaw    = url.searchParams.get('until');

	const scoreMin  = scoreMinRaw ? parseInt(scoreMinRaw, 10) : null;
	const scoreMax  = scoreMaxRaw ? parseInt(scoreMaxRaw, 10) : null;
	const sinceMs   = sinceRaw ? new Date(sinceRaw).getTime() : null;
	const untilMs   = untilRaw ? new Date(untilRaw).getTime() : null;

	const category: Category = CATEGORIES.has(catRaw as Category) ? (catRaw as Category) : '';

	// Source object depends on category. Comments live in their own
	// object with a different schema (no score, no title, no url) so
	// the rest of the load function branches on this.
	const sourceObject: 'stories' | 'comments' = category === 'comment' ? 'comments' : 'stories';

	const sort: Sort =
		sortRaw === 'newest' ? 'newest'
		: sortRaw === 'hot' ? 'hot'
		: 'popularity';
	const win  = winRaw in WINDOW_MS ? winRaw : 'all';

	// Comments don't carry a score field — fall back to time-desc for
	// any sort that's not explicitly "newest" on the comments source.
	// Otherwise we'd try to order_by score on the comments object and
	// shard-db would reject the missing field.
	let order_by = SORT_FIELDS[sort];
	if (sourceObject === 'comments' && (sort === 'popularity' || sort === 'hot')) {
		order_by = 'time';
	}

	// Build criteria. Filter-first planner (shard-db 2026.05.7.x)
	// composes these into a KeySet so the cursor walk of order_by
	// only fetches records that pass all filters.
	const criteria: object[] = [];

	// Skip dead/deleted by default (browse is "live" stories). bitmap
	// on bool fields → popcount intersect, cheap.
	criteria.push({ field: 'dead',    op: 'eq', value: 'false' });
	criteria.push({ field: 'deleted', op: 'eq', value: 'false' });

	// Category → up to two criteria (type eq + optional title starts_with),
	// OR routes to the comments object (which has no `type` field).
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
			// No type filter on comments — every record in the comments
			// object is by definition a comment.
			break;
		default:
			// Stories source, no explicit category — hide pollopts.
			criteria.push({ field: 'type', op: 'in', value: 'story,job,poll' });
	}

	// Substring filter target depends on source: title for stories,
	// text for comments. Same trigram index machinery on both fields.
	if (q.length >= 3) {
		const field = sourceObject === 'comments' ? 'text' : 'title';
		criteria.push({ field, op: 'icontains', value: q });
	}

	if (by) {
		criteria.push({ field: 'by', op: 'eq', value: by });
	}

	const windowMs = WINDOW_MS[win];
	if (windowMs != null) {
		const since = Date.now() - windowMs;
		criteria.push({ field: 'time', op: 'gte', value: since });
	} else if (sort === 'hot') {
		// `hot` carries an implicit recency window even when the visitor
		// hasn't picked one — "hot all time" is just "popularity all time".
		// Honour the explicit window if set; only inject the implicit one
		// for the default `all` selection.
		const since = Date.now() - HOT_WINDOW_MS;
		criteria.push({ field: 'time', op: 'gte', value: since });
	}

	// Advanced numeric/date filters. Score only applies to stories
	// (comments object lacks the score field). Custom date ranges
	// combine with (or replace) the window pill — both are gte/lte
	// on the same time field so the more restrictive always wins.
	if (sourceObject !== 'comments' && scoreMin != null && !isNaN(scoreMin)) {
		criteria.push({ field: 'score', op: 'gte', value: scoreMin });
	}
	if (sourceObject !== 'comments' && scoreMax != null && !isNaN(scoreMax)) {
		criteria.push({ field: 'score', op: 'lte', value: scoreMax });
	}
	if (sinceMs != null && !isNaN(sinceMs)) {
		criteria.push({ field: 'time', op: 'gte', value: sinceMs });
	}
	if (untilMs != null && !isNaN(untilMs)) {
		criteria.push({ field: 'time', op: 'lte', value: untilMs });
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
		object: sourceObject,
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
		shardDb.query({ mode: 'count', dir: 'hn', object: sourceObject, criteria }),
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
			q, category, sort, window: win, by, page,
			scoreMin, scoreMax, since: sinceRaw ?? null, until: untilRaw ?? null,
			source: sourceObject,
			items: [] as Array<Story | Comment>,
			totalCount: 0, queryMs,
			pageSize: PAGE_SIZE,
			nextCursor: null as string | null,
			dbStats,
			error: err
		};
	}

	// Cursor mode returns {rows: [...], cursor: {...} | null}. Without
	// cursor it returns a bare array. Normalise both shapes.
	type ValueRow = { key: string; value: Record<string, unknown> };
	let rows: ValueRow[];
	let nextCursor: string | null = null;
	if (Array.isArray(pageResp)) {
		rows = pageResp as ValueRow[];
	} else {
		const cr = pageResp as { rows: ValueRow[]; cursor: object | null };
		rows = cr.rows;
		nextCursor = cr.cursor ? encodeURIComponent(JSON.stringify(cr.cursor)) : null;
	}

	const items: Array<Story | Comment> = rows.map((r) =>
		({ key: r.key, ...r.value } as Story | Comment)
	);
	const totalCount = countResp as number;

	return {
		q, category, sort, window: win, by, page,
		scoreMin, scoreMax, since: sinceRaw ?? null, until: untilRaw ?? null,
		source: sourceObject,
		items, totalCount, queryMs,
		pageSize: PAGE_SIZE,
		nextCursor,
		dbStats,
		query: findQuery
	};
};

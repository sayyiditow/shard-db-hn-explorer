/** Slow, all-time stats — computed on a slow background cadence (hourly),
 *  served cache-only.
 *
 *  These are whole-history rankings (top commenters over 38.5M comments,
 *  top story authors over 5.6M stories). They barely change minute to
 *  minute, but they're expensive: the commenters group_by walks the full
 *  comment set (~95s cold), and even the authors group_by is ~860ms warm.
 *
 *  Recomputing either on the 5-min cache rewarm is pure waste — an all-time
 *  ranking doesn't shift in 5 minutes, and the commenters query is far too
 *  slow for that tick anyway. So they live here on a 1-hour cadence,
 *  deliberately OUT of the main swapped cache (which is rebuilt wholesale
 *  every 5 min and would drop them). The stats page reads the last good
 *  result; a cold result renders "computing" rather than blocking the
 *  request for ~95s. */
import { shardDb, isError } from '$lib/shard-db/client';
import type { QueryBody } from '$lib/shard-db/query-types';

export interface AggRow {
	[k: string]: string | number;
}

/** Exact queries — also surfaced on the stats panels for the "show query" UI.
 *  timeout_ms overrides the 30s server default; the cold commenter walk needs
 *  ~95s, and the author walk gets headroom for a cold btree. */
export const TOP_COMMENTERS_QUERY = {
	mode: 'aggregate',
	dir: 'hn',
	object: 'comments',
	group_by: ['by'],
	aggregates: [{ fn: 'count', alias: 'comments' }],
	order_by: 'comments',
	order: 'desc',
	limit: 20,
	timeout_ms: 120_000
} as const;

export const TOP_STORY_AUTHORS_QUERY = {
	mode: 'aggregate',
	dir: 'hn',
	object: 'stories',
	group_by: ['by'],
	aggregates: [{ fn: 'count', alias: 'stories' }],
	criteria: [{ field: 'type', op: 'eq', value: 'story' }],
	order_by: 'stories',
	order: 'desc',
	limit: 20,
	timeout_ms: 60_000
} as const;

export interface SlowEntry {
	data: AggRow[] | null;
	ms: number;
	ts: number;
	error?: string;
}

interface SlowState {
	commenters: SlowEntry;
	authors: SlowEntry;
	warming: boolean;
}

const empty = (): SlowEntry => ({ data: null, ms: 0, ts: 0 });

// globalThis-pinned so SSR requests + the refresh module + dev HMR share one
// instance (same pattern as the main cache).
const GKEY = Symbol.for('shardDb.slowStats.v1');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const G = globalThis as any;
G[GKEY] ??= { commenters: empty(), authors: empty(), warming: false } satisfies SlowState;
const state: SlowState = G[GKEY];

export function getTopCommenters(): SlowEntry {
	return state.commenters;
}
export function getTopStoryAuthors(): SlowEntry {
	return state.authors;
}

const ts = () => new Date().toISOString();

async function warmOne(
	label: string,
	query: QueryBody,
	slot: SlowEntry
): Promise<void> {
	const t0 = Date.now();
	try {
		const resp = await shardDb.query(query);
		const ms = Date.now() - t0;
		if (!isError(resp) && Array.isArray(resp)) {
			slot.data = resp as AggRow[];
			slot.ms = ms;
			slot.ts = Date.now();
			slot.error = undefined;
			console.log(`${ts()} INFO [slow-stats] ${label} warmed ${slot.data.length} rows in ${ms}ms`);
		} else {
			slot.error = isError(resp) ? resp.error : 'non-array response';
			console.warn(`${ts()} WARN [slow-stats] ${label} warm failed: ${slot.error}`);
		}
	} catch (e) {
		slot.error = (e as Error).message;
		console.warn(`${ts()} WARN [slow-stats] ${label} warm error: ${slot.error}`);
	}
}

/** Recompute both rankings. Authors first (fast — populates the panel quickly),
 *  then the heavy commenters walk. Sequential on purpose: we don't want two
 *  full-history scans hitting shard-db at once. Concurrency-guarded so
 *  overlapping warms can't pile up; last good result survives an error. */
export async function warmSlowStats(): Promise<void> {
	if (state.warming) return;
	state.warming = true;
	try {
		await warmOne('top-story-authors', TOP_STORY_AUTHORS_QUERY as unknown as QueryBody, state.authors);
		await warmOne('top-commenters', TOP_COMMENTERS_QUERY as unknown as QueryBody, state.commenters);
	} finally {
		state.warming = false;
	}
}

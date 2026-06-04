import { isError } from '$lib/shard-db/client';
import {
	cachedQuery,
	getTopCommenters,
	getTopStoryAuthors,
	TOP_COMMENTERS_QUERY,
	TOP_STORY_AUTHORS_QUERY,
	type SlowEntry
} from '$lib/refresh-cache';
import type { PageServerLoad } from './$types';

/** One panel = one shard-db query + the JSON we sent + the ms it took.
 *  Surfacing the actual query body is half the point of /stats: visitors
 *  see what aggregate JSON drove each panel and how long it ran. */
export interface Panel<T> {
	query: Record<string, unknown>;
	ms: number;
	data: T;
	error?: string;
}

interface AggRow {
	[k: string]: string | number;
}

interface UserRow {
	key: string;
	karma: number;
	created: number;
	submitted_count: number;
}

/** shard-db serialises typed numerics as quoted strings on the wire (so the
 *  full int64 range round-trips through JSON parsers that would otherwise
 *  clamp to 2^53). Coerce here on consumption. */
function toNum(v: unknown): number {
	if (typeof v === 'number') return v;
	if (typeof v === 'string') return Number(v) || 0;
	return 0;
}

async function timed<T>(query: Record<string, unknown>): Promise<Panel<T>> {
	const t0 = performance.now();
	// Cache-then-fallthrough with write-on-success — first /stats hit
	// after a cold start populates for everyone else; the refresh
	// re-warm (see keys.ts → enumerateKeys) keeps pre-known queries
	// hot regardless.
	const resp = await cachedQuery(query);
	const ms = performance.now() - t0;
	if (isError(resp)) {
		return { query, ms, data: [] as unknown as T, error: resp.error };
	}
	return { query, ms, data: resp as T };
}

/** Project a slow-stats cache entry (top commenters / authors) into a Panel.
 *  Cache-only: these are warmed hourly in the background (slow-stats.ts), never
 *  fired live — a cold entry renders "computing…" instead of blocking the page
 *  on a ~95s scan. */
function slowPanel(
	entry: SlowEntry,
	query: Record<string, unknown>
): Panel<AggRow[]> {
	if (entry.data) return { query, ms: entry.ms, data: entry.data };
	return {
		query,
		ms: 0,
		data: [],
		error: entry.error ?? 'computing… (warms hourly in the background)'
	};
}

export const load: PageServerLoad = async () => {
	/* All-time rankings (top story authors, top commenters) are served
	   cache-only from slow-stats.ts — warmed hourly in the background. They're
	   whole-history group_bys (5.6M stories, 38.5M comments); recomputing them
	   on every page load (or the 5-min cache tick) is waste, and the commenter
	   walk is ~95s, far too slow for a live request. The background warm uses a
	   high timeout_ms; here we just read the last good result. */
	const topStoryAuthors = slowPanel(getTopStoryAuthors(), TOP_STORY_AUTHORS_QUERY as Record<string, unknown>);
	const topCommenters = slowPanel(getTopCommenters(), TOP_COMMENTERS_QUERY as Record<string, unknown>);

	// Counts + top users fired in parallel. Each is a single round-trip.
	const [storyCount, commentCount, userCount, topUsers] = await Promise.all([
		timed<number>({ mode: 'count', dir: 'hn', object: 'stories' }),
		timed<number>({ mode: 'count', dir: 'hn', object: 'comments' }),
		timed<number>({ mode: 'count', dir: 'hn', object: 'users' }),
		timed<Record<string, Record<string, unknown>>>({
			mode: 'find',
			dir: 'hn',
			object: 'users',
			criteria: [],
			order_by: 'karma',
			order: 'desc',
			limit: 20,
			fields: ['karma', 'created', 'submitted_count'],
			format: 'dict'
		})
	]);

	// Flatten dict-form into UserRow[] + coerce numeric strings.
	const topUsersRows: UserRow[] = topUsers.error
		? []
		: Object.entries(topUsers.data).map(([key, v]) => ({
				key,
				karma: toNum(v.karma),
				created: toNum(v.created),
				submitted_count: toNum(v.submitted_count)
		  }));

	// Schema panel — describe-object on each. Same wire mode every shard-db
	// admin tool uses; we're just rendering the raw response.
	const [storiesSchema, commentsSchema, usersSchema] = await Promise.all([
		timed<unknown>({ mode: 'describe-object', dir: 'hn', object: 'stories' }),
		timed<unknown>({ mode: 'describe-object', dir: 'hn', object: 'comments' }),
		timed<unknown>({ mode: 'describe-object', dir: 'hn', object: 'users' })
	]);

	const totalRecords =
		(storyCount.data ?? 0) + (commentCount.data ?? 0) + (userCount.data ?? 0);
	const totalMs =
		storyCount.ms + commentCount.ms + userCount.ms +
		topStoryAuthors.ms + topCommenters.ms + topUsers.ms +
		storiesSchema.ms + commentsSchema.ms + usersSchema.ms;

	return {
		counts: {
			stories: storyCount,
			comments: commentCount,
			users: userCount,
			totalRecords
		},
		topStoryAuthors,
		topCommenters,
		topUsers: {
			query: topUsers.query,
			ms: topUsers.ms,
			error: topUsers.error,
			data: topUsersRows
		},
		schema: {
			stories: storiesSchema,
			comments: commentsSchema,
			users: usersSchema
		},
		totalMs
	};
};

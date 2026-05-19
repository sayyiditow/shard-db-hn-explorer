import { shardDb, isError } from '$lib/shard-db/client';
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
	const resp = await shardDb.query(query);
	const ms = performance.now() - t0;
	if (isError(resp)) {
		return { query, ms, data: [] as unknown as T, error: resp.error };
	}
	return { query, ms, data: resp as T };
}

export const load: PageServerLoad = async () => {
	// Six panels fired in parallel. Each is a single round-trip to shard-db,
	// so end-to-end wall time = max(panel ms) + connection overhead.
	const [
		storyCount,
		commentCount,
		userCount,
		topStoryAuthors,
		topCommenters,
		topUsers
	] = await Promise.all([
		timed<number>({ mode: 'count', dir: 'hn', object: 'stories' }),
		timed<number>({ mode: 'count', dir: 'hn', object: 'comments' }),
		timed<number>({ mode: 'count', dir: 'hn', object: 'users' }),
		// Aggregates intentionally omit dead/deleted filters. Neither
		// field is indexed on stories or comments, so adding them
		// forces a full-scan (5.6s on 789k comments) vs the indexed
		// group_by fast path (0.1s). Dead/deleted is <1% of HN traffic
		// so the visible ranking is unchanged.
		timed<AggRow[]>({
			mode: 'aggregate',
			dir: 'hn',
			object: 'stories',
			group_by: ['by'],
			aggregates: [
				{ fn: 'count', alias: 'stories' },
				{ fn: 'sum', field: 'score', alias: 'total_score' }
			],
			criteria: [{ field: 'type', op: 'eq', value: 'story' }],
			order_by: 'stories',
			order: 'desc',
			limit: 20
		}),
		timed<AggRow[]>({
			mode: 'aggregate',
			dir: 'hn',
			object: 'comments',
			group_by: ['by'],
			aggregates: [{ fn: 'count', alias: 'comments' }],
			order_by: 'comments',
			order: 'desc',
			limit: 20
		}),
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

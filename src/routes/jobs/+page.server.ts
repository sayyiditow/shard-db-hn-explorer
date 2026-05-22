import { shardDb, isError } from '$lib/shard-db/client';
import type { Story } from '$lib/hn/types';
import type { PageServerLoad } from './$types';

/**
 * /jobs — HN job postings.
 *
 * Jobs are stored alongside stories in the `stories` object (same
 * schema), distinguished by `type:enum(...)` = 'job'. We surface them
 * separately because HN's own UI treats them as a distinct stream
 * (linked from the top nav as "jobs"), and visitors searching for
 * jobs don't want to wade through 200K+ regular stories to find them.
 *
 * Query shape: `find type=job AND dead=false AND deleted=false
 * order_by time desc limit N`. With this release's filter-first
 * planner, the bitmap on `type` builds a small candidate set first
 * (~187 jobs in the 1M sample), then walks the time index against
 * that set — fast even when the result set is tiny.
 */

const LIMIT = 50;

export const load: PageServerLoad = async () => {
	const t0 = performance.now();

	const baseCrit = [
		{ field: 'type', op: 'eq', value: 'job' },
		{ field: 'dead', op: 'eq', value: 'false' },
		{ field: 'deleted', op: 'eq', value: 'false' }
	];

	const [jobsResp, totalResp] = await Promise.all([
		shardDb.query({
			mode: 'find',
			dir: 'hn',
			object: 'stories',
			criteria: baseCrit,
			order_by: 'time',
			order: 'desc',
			limit: LIMIT
		}),
		shardDb.query({
			mode: 'count',
			dir: 'hn',
			object: 'stories',
			criteria: baseCrit
		})
	]);

	const queryMs = performance.now() - t0;

	if (isError(jobsResp) || isError(totalResp)) {
		const err = isError(jobsResp) ? jobsResp.error : (totalResp as { error: string }).error;
		return { jobs: [], totalCount: 0, queryMs, error: err };
	}

	const rows = jobsResp as Array<{ key: string; value: Omit<Story, 'key'> }>;
	const jobs: Story[] = rows.map((r) => ({ key: r.key, ...r.value }));
	const totalCount = totalResp as number;

	return { jobs, totalCount, queryMs };
};

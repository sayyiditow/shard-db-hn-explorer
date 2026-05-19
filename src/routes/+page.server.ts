import { shardDb, isError } from '$lib/shard-db/client';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	const t0 = performance.now();
	const [stories, comments, users] = await Promise.all([
		shardDb.query<number>({ mode: 'count', dir: 'hn', object: 'stories' }),
		shardDb.query<number>({ mode: 'count', dir: 'hn', object: 'comments' }),
		shardDb.query<number>({ mode: 'count', dir: 'hn', object: 'users' })
	]);
	const totalMs = performance.now() - t0;

	// shard-db returns bare integers for `count` (2026.05.1+ response-shape
	// overhaul) and `{error: ...}` for any failure. The client wraps all
	// connection / parse / wire failures into the same shape.
	const firstError = [stories, comments, users].find(isError);
	if (firstError) {
		return { error: firstError.error, stories: 0, comments: 0, users: 0, totalMs };
	}

	return {
		stories: stories as number,
		comments: comments as number,
		users: users as number,
		totalMs
	};
};

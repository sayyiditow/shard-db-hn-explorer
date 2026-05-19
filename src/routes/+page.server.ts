import { shardDb, isError } from '$lib/shard-db/client';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	const t0 = performance.now();
	try {
		// Three parallel counts — exercises the JSON wire end to end.
		const [stories, comments, users] = await Promise.all([
			shardDb.query<number>({ mode: 'count', dir: 'hn', object: 'stories' }),
			shardDb.query<number>({ mode: 'count', dir: 'hn', object: 'comments' }),
			shardDb.query<number>({ mode: 'count', dir: 'hn', object: 'users' })
		]);

		const totalMs = performance.now() - t0;

		// shard-db returns bare integers for count (response-shape overhaul, 2026.05.1)
		// but `{"error": "..."}` on failure.
		if (isError(stories)) return { error: `stories: ${stories.error}`, stories: 0, comments: 0, users: 0, totalMs };
		if (isError(comments)) return { error: `comments: ${comments.error}`, stories: 0, comments: 0, users: 0, totalMs };
		if (isError(users)) return { error: `users: ${users.error}`, stories: 0, comments: 0, users: 0, totalMs };

		return {
			stories: stories as number,
			comments: comments as number,
			users: users as number,
			totalMs
		};
	} catch (err) {
		return {
			error: err instanceof Error ? err.message : String(err),
			stories: 0,
			comments: 0,
			users: 0,
			totalMs: performance.now() - t0
		};
	}
};

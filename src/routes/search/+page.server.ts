import { shardDb, isError } from '$lib/shard-db/client';
import type { Story, Comment } from '$lib/hn/types';
import type { PageServerLoad } from './$types';

const RESULT_LIMIT = 25;

interface SearchResult<T> {
	rows: T[];
	queryMs: number;
	error?: string;
}

async function searchObject<T>(object: string, field: string, q: string): Promise<SearchResult<T>> {
	const t0 = performance.now();
	const resp = await shardDb.query({
		mode: 'find',
		dir: 'hn',
		object,
		criteria: [{ field, op: 'icontains', value: q }],
		order_by: 'time',
		order: 'desc',
		limit: RESULT_LIMIT
	});
	const queryMs = performance.now() - t0;
	if (isError(resp)) {
		return { rows: [], queryMs, error: resp.error };
	}
	// Default array shape preserves shard-db's order_by; format:dict
	// would reshuffle by JS integer-key sort and lose newest-first.
	const arr = resp as Array<{ key: string; value: Omit<T, 'key'> }>;
	const rows: T[] = arr.map((r) => ({ key: r.key, ...r.value } as T));
	return { rows, queryMs };
}

export const load: PageServerLoad = async ({ url }) => {
	const q = (url.searchParams.get('q') ?? '').trim();
	if (!q) {
		return { q: '', stories: null, comments: null, totalMs: 0 };
	}

	const t0 = performance.now();
	const [stories, comments] = await Promise.all([
		searchObject<Story>('stories', 'title', q),
		searchObject<Comment>('comments', 'text', q)
	]);
	const totalMs = performance.now() - t0;

	return { q, stories, comments, totalMs };
};

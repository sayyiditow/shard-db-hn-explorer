import { shardDb, isError } from '$lib/shard-db/client';
import type { Story } from '$lib/hn/types';
import type { PageServerLoad } from './$types';

/** Lookback windows the user can switch between via ?window=. */
type Window = '1h' | '24h' | '7d' | 'all';
const WINDOW_MS: Record<Window, number | null> = {
	'1h': 60 * 60 * 1000,
	'24h': 24 * 60 * 60 * 1000,
	'7d': 7 * 24 * 60 * 60 * 1000,
	'all': null
};

const TOP_STORIES_LIMIT = 30;

export const load: PageServerLoad = async ({ url }) => {
	const win = (url.searchParams.get('window') ?? '24h') as Window;
	const windowMs = WINDOW_MS[win] ?? WINDOW_MS['24h'];

	const now = Date.now();
	const since = windowMs == null ? 0 : now - windowMs;

	const baseCrit: object[] = [
		{ field: 'type', op: 'eq', value: 'story' },
		{ field: 'dead', op: 'eq', value: 'false' },
		{ field: 'deleted', op: 'eq', value: 'false' }
	];
	if (windowMs != null) {
		baseCrit.push({ field: 'time', op: 'gte', value: since });
	}

	const t0 = performance.now();
	const [topStoriesResp, totalCountResp] = await Promise.all([
		// Top stories by score within the window
		shardDb.query({
			mode: 'find',
			dir: 'hn',
			object: 'stories',
			criteria: baseCrit,
			order_by: { field: 'score', dir: 'desc' },
			limit: TOP_STORIES_LIMIT,
			format: 'dict'
		}),
		// Total story count in the window — sanity figure for the timing badge
		shardDb.query({
			mode: 'count',
			dir: 'hn',
			object: 'stories',
			criteria: baseCrit
		})
	]);
	const queryMs = performance.now() - t0;

	if (isError(topStoriesResp) || isError(totalCountResp)) {
		const err = isError(topStoriesResp) ? topStoriesResp.error : (totalCountResp as { error: string }).error;
		return { window: win, since, stories: [], totalCount: 0, domains: [], queryMs, error: err };
	}

	const dict = topStoriesResp as Record<string, Omit<Story, 'key'>>;
	const stories: Story[] = Object.entries(dict).map(([key, value]) => ({ key, ...value }));
	const totalCount = totalCountResp as number;

	// Bucket by domain (URL host stripped of leading www.) for the
	// trending-domain widget. Built client-side over the top-N rather
	// than a server-side group-by because we want the SAME top-N to
	// drive both the table and the domain ranking; group-by on hostnames
	// would require a derived field shard-db doesn't have.
	type DomainBucket = { domain: string; count: number; totalScore: number };
	const buckets = new Map<string, DomainBucket>();
	for (const s of stories) {
		const host = extractHost(s.url);
		if (!host) continue;
		const b = buckets.get(host) ?? { domain: host, count: 0, totalScore: 0 };
		b.count += 1;
		b.totalScore += s.score ?? 0;
		buckets.set(host, b);
	}
	const domains = Array.from(buckets.values()).sort(
		(a, b) => b.totalScore - a.totalScore
	).slice(0, 15);

	return { window: win, since, stories, totalCount, domains, queryMs };
};

function extractHost(url: string | undefined): string | null {
	if (!url) return null;
	try {
		const h = new URL(url).hostname;
		return h.replace(/^www\./, '');
	} catch {
		return null;
	}
}

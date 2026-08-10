/** Refresh + cache module — see docs spec dated 2026-05-24.
 *
 *  Public API:
 *    start()                  — boot the ingest-drain and cache-refresh loops
 *                                (idempotent); both use REFRESH_INTERVAL_MINUTES
 *                                (default 15), but ingest drains batches without
 *                                sleeping when it is behind
 *    getCached(key)           — read cached query result, or null on miss
 *    cachedQuery(payload)     — get-or-fetch-and-store (cache-on-success)
 *    canonicalKey(payload)    — derive the cache key for a shard-db query
 *    stats()                  — diagnostics (size, last-swap timestamp) */

export { runRefreshCycle, start, REFRESH_INTERVAL_MINUTES } from './refresh';
export { get as getCached, stats } from './cache';
export { canonicalKey, windowAnchor } from './keys';
export { cachedQuery } from './cached-query';
export {
	getTopCommenters,
	getTopStoryAuthors,
	TOP_COMMENTERS_QUERY,
	TOP_STORY_AUTHORS_QUERY,
	type AggRow as SlowAggRow,
	type SlowEntry
} from './slow-stats';

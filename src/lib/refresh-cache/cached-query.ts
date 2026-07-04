/** Cache-then-fallthrough wrapper around shardDb.query.
 *
 *  - Cache hit  → return the cached value, no network round-trip
 *  - Cache miss → run the query, and on a non-error response store the
 *    result under the canonical key so the next visitor gets it free.
 *
 *  The refresh tick (cadence: REFRESH_INTERVAL_MINUTES) rebuilds the cache
 *  map wholesale, so mid-tick writes added here age out naturally on the
 *  next swap.  No TTL.
 *
 *  ShardDbError responses (`{ error: ... }`) are NOT cached — we don't
 *  want a one-off timeout to lock in a broken state until the next tick.
 *  Callers handle the error result and the next visitor retries live. */
import { shardDb, isError, type ShardDbError } from '$lib/shard-db/client';
import type { QueryBody } from '$lib/shard-db/query-types';
import { get as getCached, set as setCached } from './cache';
import { canonicalKey } from './keys';

/** Single-flight (request coalescing) keyed by canonical query key. On a cold
 *  cache — especially the window right after a restart when the in-memory cache
 *  is empty and the browser prefetches every category/sort tab at once —
 *  concurrent identical misses would each fire the same (often expensive) query
 *  at shard-db, stampeding it. Here the first caller for a key runs the query;
 *  everyone else awaits the same in-flight promise. The entry is dropped as soon
 *  as it settles, so it never caches errors or outlives the request. Stored on
 *  globalThis so all SSR requests (and dev HMR re-imports) share one map. */
const INFLIGHT_KEY = Symbol.for('shardDb.cachedQuery.inflight.v1');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const GI = globalThis as any;
GI[INFLIGHT_KEY] ??= new Map<string, Promise<unknown>>();
const inflight: Map<string, Promise<unknown>> = GI[INFLIGHT_KEY];

export async function cachedQuery<T = unknown>(
	payload: QueryBody
): Promise<T | ShardDbError> {
	const key = canonicalKey(payload);
	const hit = getCached(key);
	if (hit !== null) return hit as T;

	const pending = inflight.get(key);
	if (pending) return (await pending) as T | ShardDbError;

	const p = (async () => {
		const resp = await shardDb.query<T>(payload);
		if (!isError(resp)) setCached(key, resp);
		return resp;
	})();
	inflight.set(key, p);
	try {
		return await p;
	} finally {
		inflight.delete(key);
	}
}

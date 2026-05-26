/** Cache-then-fallthrough wrapper around shardDb.query.
 *
 *  - Cache hit  → return the cached value, no network round-trip
 *  - Cache miss → run the query, and on a non-error response store the
 *    result under the canonical key so the next visitor gets it free.
 *
 *  The 5-min refresh tick rebuilds the cache map wholesale, so mid-tick
 *  writes added here age out naturally on the next swap.  No TTL.
 *
 *  ShardDbError responses (`{ error: ... }`) are NOT cached — we don't
 *  want a one-off timeout to lock in a broken state for 5 minutes.
 *  Callers handle the error result and the next visitor retries live. */
import { shardDb, isError, type ShardDbError } from '$lib/shard-db/client';
import { get as getCached, set as setCached } from './cache';
import { canonicalKey } from './keys';

export async function cachedQuery<T = unknown>(
	payload: Record<string, unknown>
): Promise<T | ShardDbError> {
	const key = canonicalKey(payload);
	const hit = getCached(key);
	if (hit !== null) return hit as T;
	const resp = await shardDb.query<T>(payload);
	if (!isError(resp)) setCached(key, resp);
	return resp;
}

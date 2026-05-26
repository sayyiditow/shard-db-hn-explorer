/** Refresh + cache module — see docs spec dated 2026-05-24.
 *
 *  Public API:
 *    start()                  — boot the 5-min refresh loop (idempotent)
 *    getCached(key)           — read cached query result, or null on miss
 *    cachedQuery(payload)     — get-or-fetch-and-store (cache-on-success)
 *    canonicalKey(payload)    — derive the cache key for a shard-db query
 *    stats()                  — diagnostics (size, last-swap timestamp) */

export { start } from './refresh';
export { get as getCached, stats } from './cache';
export { canonicalKey, windowAnchor } from './keys';
export { cachedQuery } from './cached-query';

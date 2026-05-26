/** In-memory cache for pre-computed query results.
 *
 *  Single map, replaced atomically by `swap()`.  No TTL — entries
 *  remain valid until the next refresh tick with upserted > 0 builds
 *  a replacement map.  Rationale: if no new data reached shard-db,
 *  the cached results are still consistent with what shard-db would
 *  return; time-based expiry would just force re-warm work without
 *  changing what's served.
 *
 *  HMR-safe: state lives on globalThis behind a Symbol.for() key.
 *  When SvelteKit/Vite re-imports this module during dev (on source
 *  edits), the new module instance binds to the SAME shared state as
 *  the previous one, so the route layer's cache reads and the
 *  refresh layer's cache writes can't end up on separate module
 *  singletons.  Production builds don't HMR; the indirection is free.
 *
 *  Read path is lock-free: JS assignment to the shared `state.map`
 *  reference is atomic from the consumer's POV. */

export interface Entry {
    result: unknown;
    mtime: number;
}

interface CacheState {
    map: Map<string, Entry>;
    lastSwapAt: number | null;
}

const GLOBAL_KEY = Symbol.for('shardDb.refreshCache.state.v1');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const G = globalThis as any;
G[GLOBAL_KEY] ??= { map: new Map<string, Entry>(), lastSwapAt: null } satisfies CacheState;
const state: CacheState = G[GLOBAL_KEY];

export function get(key: string): unknown | null {
    const e = state.map.get(key);
    return e ? e.result : null;
}

/** Write-through on cache miss — first visitor pays, everyone else hits.
 *  The 5-min refresh swap() replaces the whole map so these mid-tick
 *  writes naturally age out; no separate eviction needed.  Bounded by
 *  MAX_ENTRIES to defend against query-shape explosion (e.g. /search
 *  with arbitrary text, /u/<random>) within a single tick. */
const MAX_ENTRIES = 8192;
export function set(key: string, result: unknown): void {
    if (state.map.size >= MAX_ENTRIES && !state.map.has(key)) return;
    state.map.set(key, { result, mtime: Date.now() });
}

export function swap(newMap: Map<string, Entry>): void {
    state.map = newMap;
    state.lastSwapAt = Date.now();
}

export interface Stats {
    size: number;
    lastSwapAt: number | null;
}

export function stats(): Stats {
    return { size: state.map.size, lastSwapAt: state.lastSwapAt };
}

/** Test-only — wipes the cache to a known empty state. */
export function clearForTesting(): void {
    state.map = new Map();
    state.lastSwapAt = null;
}

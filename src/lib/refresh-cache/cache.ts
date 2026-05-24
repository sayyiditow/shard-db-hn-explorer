/** In-memory cache for pre-computed query results.
 *
 *  Single map, replaced atomically by `swap()`.  No TTL — entries
 *  remain valid until the next refresh tick with upserted > 0 builds
 *  a replacement map.  Rationale: if no new data reached shard-db,
 *  the cached results are still consistent with what shard-db would
 *  return; time-based expiry would just force re-warm work without
 *  changing what's served.
 *
 *  Read path is lock-free: JS assignment to a module-level binding
 *  is atomic from the consumer's POV. */

export interface Entry {
    result: unknown;
    mtime: number;
}

let g_map: Map<string, Entry> = new Map();
let g_lastSwapAt: number | null = null;

export function get(key: string): unknown | null {
    const e = g_map.get(key);
    return e ? e.result : null;
}

export function swap(newMap: Map<string, Entry>): void {
    g_map = newMap;
    g_lastSwapAt = Date.now();
}

export interface Stats {
    size: number;
    lastSwapAt: number | null;
}

export function stats(): Stats {
    return { size: g_map.size, lastSwapAt: g_lastSwapAt };
}

/** Test-only — wipes the cache to a known empty state. */
export function clearForTesting(): void {
    g_map = new Map();
    g_lastSwapAt = null;
}

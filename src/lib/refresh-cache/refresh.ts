/** Refresh orchestration.  See spec dated 2026-05-24.
 *
 *  tick(): single cycle — fetch new HN items, partition by type,
 *  bulk-insert per object, advance last_seen_id.  The cache re-warm
 *  step is layered on top in Task 7.
 *
 *  Dependency injection: `tick()` accepts an optional `deps` argument
 *  carrying the shard-db client and HN API.  Production callers pass
 *  nothing (defaults to the real module-level instances); tests inject
 *  doubles.  This keeps unit tests free of module-loader patching. */

import { shardDb as defaultClient, isError } from '$lib/shard-db/client';
import * as state from './state';
import * as defaultHn from './hn-api';
import type { HnItem } from './hn-api';
import * as cache from './cache';
import { enumerateKeys } from './keys';
import { truncateBytes } from './truncate';

// Field byte-budgets mirror scripts/setup-schema.ts. Keep in sync:
// shard-db rejects inserts with varchar content > N bytes, so we
// pre-truncate every potentially-long field here. The ellipsis ("...")
// added by truncateBytes is the user-visible "this was cut off" signal.
const MAX_STORY_URL    = 512;
const MAX_STORY_TITLE  = 128;
const MAX_STORY_TEXT   = 4096;
const MAX_COMMENT_TEXT = 4096;

const DIR = 'hn';

/** yyyy-MM-dd HH:mm:ss timestamp for log lines.  Cheap (no
 *  Intl.DateTimeFormat round-trip); fits the existing console.log
 *  shape without pulling in a logger dependency. */
function logTs(): string {
	const d = new Date();
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
const logInfo = (msg: string): void => console.log(`${logTs()} INFO [refresh] ${msg}`);
const logWarn = (msg: string): void => console.warn(`${logTs()} WARN [refresh] ${msg}`);
const logErr  = (msg: string): void => console.error(`${logTs()} ERROR [refresh] ${msg}`);

export interface TickResult {
	upserted: { stories: number; comments: number; users: number; total: number };
	maxItem: number;
	error?: string;
}

export interface TickDeps {
	client?: { query: (q: Record<string, unknown>) => Promise<unknown> };
	api?: {
		getMaxItem: () => Promise<number>;
		getItem: (id: number) => Promise<HnItem | null>;
		getItemsConcurrent: (ids: number[], limit?: number) => Promise<HnItem[]>;
	};
}

function emptyResult(maxItem: number, error?: string): TickResult {
	return { upserted: { stories: 0, comments: 0, users: 0, total: 0 }, maxItem, error };
}

/** Convert HN seconds → epoch ms (shard-db `timestamp` is ms). */
const toMs = (sec?: number): number => (typeof sec === 'number' ? sec * 1000 : 0);

/** Resolve `story_root` for a freshly-fetched comment via shard-db.
 *  Parents are normally already in shard-db (we ingest in id order);
 *  the lookup is one get-by-key per comment — cheap because the
 *  kfcache is warm. */
async function resolveStoryRoot(
	client: NonNullable<TickDeps['client']>,
	parentId: number
): Promise<number> {
	if (parentId === 0) return 0;
	const r = await client.query({ mode: 'get', dir: DIR, object: 'stories', key: String(parentId) });
	if (!isError(r)) return parentId;  // parent is a story → root = parent
	const c = await client.query({ mode: 'get', dir: DIR, object: 'comments', key: String(parentId) });
	if (!isError(c)) {
		const sr = (c as Record<string, unknown>).story_root;
		return typeof sr === 'number' ? sr : parentId;
	}
	return parentId;  // unknown — best-effort
}

interface ShardRecord { key: string; value: Record<string, unknown>; }

/** Rebuild the entire cache map from shard-db.  Sequential per-query
 *  is fine (~120 queries × ~5 ms warmed = under a second total); we
 *  don't need Promise.all here.  Per-slot errors are logged-and-
 *  dropped so a single broken query doesn't poison the whole cache. */
async function rewarmCache(client: NonNullable<TickDeps['client']>): Promise<void> {
	const t0 = Date.now();
	const newMap = new Map<string, cache.Entry>();
	let failed = 0;
	for (const entry of enumerateKeys()) {
		const r = await client.query(entry.query);
		if (isError(r)) {
			logWarn(`rewarm: query failed for ${entry.key}: ${(r as { error: string }).error}`);
			failed++;
			continue;
		}
		newMap.set(entry.key, { result: r, mtime: Date.now() });
	}
	cache.swap(newMap);
	logInfo(`rewarmed cache: ${newMap.size} slots (${failed} failed) in ${Date.now() - t0}ms`);
}

export async function tick(deps: TickDeps = {}): Promise<TickResult> {
	const client = deps.client ?? defaultClient;
	const api = deps.api ?? defaultHn;

	const t0 = Date.now();
	const lastSeen = await state.read();
	logInfo(`tick start: last_seen_id=${lastSeen}`);

	let maxItem: number;
	try {
		maxItem = await api.getMaxItem();
	} catch (e) {
		logErr(`tick aborted: getMaxItem failed: ${(e as Error).message}`);
		return emptyResult(lastSeen, `getMaxItem failed: ${(e as Error).message}`);
	}

	/* First-run seed: state file missing → lastSeen=0.  We do NOT
	 * backfill from id=1; the existing shard-db data was populated
	 * via a parquet bulk-load snapshot and the gap between snapshot
	 * date and "now" can be millions of items.  Persist current
	 * maxitem and treat it as the effective last_seen so the id
	 * range is empty — function falls through cleanly to the
	 * cache-rewarm tail (added in Task 7), exactly as an idle tick
	 * would. */
	let effectiveLastSeen = lastSeen;
	if (lastSeen === 0) {
		effectiveLastSeen = maxItem;
		await state.write(maxItem);
		logInfo(`first run: seeded last_seen_id=${maxItem} (no backfill)`);
	} else {
		logInfo(`HN maxitem=${maxItem} (delta=${maxItem - lastSeen})`);
	}

	let storiesInserted = 0, commentsInserted = 0, usersInserted = 0;
	/* Tick processes at most MAX_ITEMS_PER_TICK ids — see refresh-cache
	   header for the rationale. With a stale parquet snapshot the
	   delta to "now" can be millions of items; without this cap the
	   first post-bulk-load tick tries to fetch all of them at
	   concurrency=16, hits HN Firebase rate limits, fails, and makes
	   no progress on the next tick either. Cap means each tick makes
	   bounded progress; backfill catches up over multiple ticks. */
	const MAX_ITEMS_PER_TICK = 10_000;
	/* The id we'll persist to state at the end of this tick. Starts at
	   effectiveLastSeen and advances when we successfully process. */
	let endOfTickId = effectiveLastSeen;

	if (maxItem > effectiveLastSeen) {
		const pending = maxItem - effectiveLastSeen;
		const thisTickEnd = Math.min(effectiveLastSeen + MAX_ITEMS_PER_TICK, maxItem);
		const ids: number[] = [];
		for (let i = effectiveLastSeen + 1; i <= thisTickEnd; i++) ids.push(i);
		endOfTickId = thisTickEnd;

		if (pending > MAX_ITEMS_PER_TICK) {
			logInfo(
				`catch-up: ${pending} items pending, processing ${ids.length} this tick ` +
				`(remaining after this tick: ${pending - ids.length})`
			);
		}
		logInfo(`fetching ${ids.length} items from HN (concurrency=16)...`);
		const tFetch = Date.now();
		const items = await api.getItemsConcurrent(ids, 16);
		logInfo(`fetched ${items.length} items in ${Date.now() - tFetch}ms (${ids.length - items.length} dropped/deleted)`);

		const stories: ShardRecord[] = [];
		const comments: ShardRecord[] = [];
		const uniqueUsers = new Set<string>();

		for (const it of items) {
			if (!it.id) continue;
			const idStr = String(it.id);
			if (it.by) uniqueUsers.add(it.by);

			if (it.type === 'story' || it.type === 'job' || it.type === 'poll') {
				stories.push({
					key: idStr,
					value: {
						by: it.by ?? '',
						time: toMs(it.time),
						score: it.score ?? 0,
						url: truncateBytes(it.url ?? '', MAX_STORY_URL),
						title: truncateBytes(it.title ?? '', MAX_STORY_TITLE),
						text: truncateBytes(it.text ?? '', MAX_STORY_TEXT),
						descendants: it.descendants ?? 0,
						type: it.type,
						deleted: !!it.deleted,
						dead: !!it.dead
					}
				});
			} else if (it.type === 'comment') {
				const story_root = await resolveStoryRoot(client, it.parent ?? 0);
				comments.push({
					key: idStr,
					value: {
						by: it.by ?? '',
						time: toMs(it.time),
						parent: it.parent ?? 0,
						story_root,
						text: truncateBytes(it.text ?? '', MAX_COMMENT_TEXT),
						deleted: !!it.deleted,
						dead: !!it.dead
					}
				});
			}
			// pollopt and unknown types are dropped — they're not in
			// the landing-page model.
		}

		// Users — minimal record (only `by` is known; karma/created/
		// about come from /v0/user/<name>.json which we'd need a
		// separate fetch for. Empty placeholder values keep the
		// schema happy until a later background user-refresh fills
		// them in.
		const users: ShardRecord[] = Array.from(uniqueUsers).map((name) => ({
			key: name,
			value: { karma: 0, created: 0, about: '', submitted_count: 0 }
		}));

		logInfo(`partitioned: ${stories.length} stories, ${comments.length} comments, ${uniqueUsers.size} unique users`);

		try {
			const tUpsert = Date.now();
			const tasks: Promise<unknown>[] = [];
			if (stories.length) {
				tasks.push((async () => {
					const r = await client.query({
						mode: 'bulk-insert', dir: DIR, object: 'stories', records: stories
					});
					if (isError(r)) throw new Error(`stories bulk-insert: ${(r as { error: string }).error}`);
					storiesInserted = stories.length;
				})());
			}
			if (comments.length) {
				tasks.push((async () => {
					const r = await client.query({
						mode: 'bulk-insert', dir: DIR, object: 'comments', records: comments
					});
					if (isError(r)) throw new Error(`comments bulk-insert: ${(r as { error: string }).error}`);
					commentsInserted = comments.length;
				})());
			}
			if (users.length) {
				tasks.push((async () => {
					const r = await client.query({
						mode: 'bulk-insert', dir: DIR, object: 'users', records: users
					});
					if (isError(r)) throw new Error(`users bulk-insert: ${(r as { error: string }).error}`);
					usersInserted = users.length;
				})());
			}
			await Promise.all(tasks);
			logInfo(`upserted: stories=${storiesInserted} comments=${commentsInserted} users=${usersInserted} in ${Date.now() - tUpsert}ms`);
		} catch (e) {
			logErr(`upsert failed: ${(e as Error).message}`);
			return emptyResult(lastSeen, (e as Error).message);
		}

		/* Persist endOfTickId (not maxItem). When MAX_ITEMS_PER_TICK
		   caps the tick, endOfTickId is the last id WE processed —
		   next tick continues from endOfTickId+1. Persisting maxItem
		   here would skip the unprocessed gap. */
		await state.write(endOfTickId);
	}

	const total = storiesInserted + commentsInserted + usersInserted;
	if (total > 0 || cache.stats().size === 0) {
		await rewarmCache(client);
	}
	logInfo(`tick done in ${Date.now() - t0}ms (upserted=${total})`);
	return {
		upserted: { stories: storiesInserted, comments: commentsInserted, users: usersInserted, total },
		maxItem
	};
}

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
let g_started = false;
let g_interval: ReturnType<typeof setInterval> | null = null;

/** Begin the refresh loop.  Idempotent — calling repeatedly is safe;
 *  only the first call schedules anything.  Run an immediate tick so
 *  cold-start cache priming doesn't wait the full interval. */
export function start(): void {
	if (g_started) return;
	g_started = true;

	/* Warm the cache immediately, BEFORE the first tick's HN-item fetch+insert
	 * phase. After a restart the in-memory cache is empty, so until something
	 * fills it every request stampedes shard-db (combined with single-flight in
	 * cachedQuery, this keeps the cold window tiny). The first tick re-warms
	 * again with any freshly-fetched data; rewarmCache builds + swaps wholesale,
	 * so the redundant early warm is harmless. */
	void rewarmCache(defaultClient).catch((e) => logErr(`startup warm: ${(e as Error).message}`));
	void tick().catch((e) => logErr(`initial tick: ${(e as Error).message}`));
	g_interval = setInterval(
		() => { void tick().catch((e) => logErr(`tick: ${(e as Error).message}`)); },
		REFRESH_INTERVAL_MS
	);
}

/** Test-only — stops the interval so the process exits cleanly. */
export function stopForTesting(): void {
	if (g_interval) {
		clearInterval(g_interval);
		g_interval = null;
	}
	g_started = false;
}

/** HMR cleanup: when SvelteKit/Vite hot-reloads this module, the old
 *  module instance's `setInterval` would otherwise keep firing in the
 *  background — and on top of that, the new module instance would
 *  schedule its own.  `import.meta.hot.dispose` runs right before
 *  the old module is unloaded, so we cancel the timer there.  The
 *  shared cache state on globalThis is untouched (good — the new
 *  module instance binds to the same singleton). */
if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		if (g_interval) clearInterval(g_interval);
		g_interval = null;
		g_started = false;
	});
}

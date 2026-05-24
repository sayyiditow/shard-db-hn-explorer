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

const DIR = 'hn';

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
	const newMap = new Map<string, cache.Entry>();
	for (const entry of enumerateKeys()) {
		const r = await client.query(entry.query);
		if (isError(r)) {
			console.warn(`[refresh] rewarm: query failed for ${entry.key}: ${(r as { error: string }).error}`);
			continue;
		}
		newMap.set(entry.key, { result: r, mtime: Date.now() });
	}
	cache.swap(newMap);
}

export async function tick(deps: TickDeps = {}): Promise<TickResult> {
	const client = deps.client ?? defaultClient;
	const api = deps.api ?? defaultHn;

	const lastSeen = await state.read();

	let maxItem: number;
	try {
		maxItem = await api.getMaxItem();
	} catch (e) {
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
	}

	let storiesInserted = 0, commentsInserted = 0, usersInserted = 0;

	if (maxItem > effectiveLastSeen) {
		const ids: number[] = [];
		for (let i = effectiveLastSeen + 1; i <= maxItem; i++) ids.push(i);

		const items = await api.getItemsConcurrent(ids, 16);

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
						url: it.url ?? '',
						title: it.title ?? '',
						text: it.text ?? '',
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
						text: it.text ?? '',
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

		try {
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
		} catch (e) {
			return emptyResult(lastSeen, (e as Error).message);
		}

		await state.write(maxItem);
	}

	const total = storiesInserted + commentsInserted + usersInserted;
	if (total > 0 || cache.stats().size === 0) {
		await rewarmCache(client);
	}
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

	void tick().catch((e) => console.error('[refresh] initial tick:', e));
	g_interval = setInterval(
		() => { void tick().catch((e) => console.error('[refresh] tick:', e)); },
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

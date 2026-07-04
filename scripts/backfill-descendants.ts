#!/usr/bin/env bun
/**
 * One-time (idempotent) backfill: recompute every story's `descendants`
 * from the actual comment count in shard-db instead of trusting
 * whatever `descendants` HN reported when the story's own item was
 * ingested (parquet snapshot time, or first-tick fetch — see
 * refresh.ts's tick()/resolveStoryRoot for why that value drifts, and
 * why a partial/sample load can leave a story's declared descendants
 * far higher than the comments we actually have for it).
 *
 * Two phases:
 *   1. Walk `comments` in story_root id-range batches, grouped by
 *      story_root, and overwrite each matching story's `descendants`
 *      with the real count. Also records which story ids have at
 *      least one local comment.
 *   2. Walk every story in `stories` (paginated) and zero out
 *      `descendants` on any story NOT seen in phase 1 — covers stories
 *      whose declared HN descendants count is stale-high because we
 *      never loaded (or later lost) their comments locally.
 *
 * Safe to re-run — every value written is recomputed from what's
 * currently in `comments`, not accumulated.
 *
 * Run:
 *   bun run scripts/backfill-descendants.ts
 */

import { shardDb, isError } from '../src/lib/shard-db/client';
import { read as readRefreshState } from '../src/lib/refresh-cache/state';
import type { QueryBody } from '../src/lib/shard-db/query-types';

const DIR = 'hn';
const COMMENT_ID_CHUNK = 200_000;
const STORY_FETCH_PAGE = 50_000;

interface AggRow { story_root: number; n: number }

/** Phase 1: aggregate comments.story_root in [lo, hi], write real counts
 *  back onto the matching stories. Returns the story ids it touched, so
 *  phase 2 knows which stories to leave alone. */
async function backfillRange(lo: number, hi: number): Promise<Set<number>> {
	const resp = await shardDb.query({
		mode: 'aggregate',
		dir: DIR,
		object: 'comments',
		group_by: ['story_root'],
		aggregates: [{ fn: 'count', alias: 'n' }],
		criteria: [{ field: 'story_root', op: 'between', value: lo, value2: hi }],
		limit: COMMENT_ID_CHUNK
	} as unknown as QueryBody);

	if (isError(resp)) {
		throw new Error(`aggregate [${lo}, ${hi}] failed: ${resp.error}`);
	}
	const rows = resp as AggRow[];
	const touched = new Set<number>();
	if (rows.length === 0) return touched;

	const records: Record<string, { descendants: number }> = {};
	for (const row of rows) {
		records[String(row.story_root)] = { descendants: row.n };
		touched.add(row.story_root);
	}

	const upd = await shardDb.query({
		mode: 'bulk-update', dir: DIR, object: 'stories', records
	} as unknown as QueryBody);
	if (isError(upd)) {
		throw new Error(`bulk-update (real counts) [${lo}, ${hi}] failed: ${upd.error}`);
	}
	return touched;
}

/** Phase 2: page through every story; zero out `descendants` on any
 *  story `hasComments` didn't see in phase 1 (and whose descendants
 *  isn't already 0 — skip the no-op write). */
async function zeroStoriesWithoutComments(hasComments: Set<number>): Promise<number> {
	let offset = 0;
	let zeroed = 0;

	for (;;) {
		const resp = await shardDb.query({
			mode: 'fetch', dir: DIR, object: 'stories',
			offset, limit: STORY_FETCH_PAGE, fields: ['descendants']
		} as QueryBody);
		if (isError(resp)) {
			throw new Error(`fetch stories @offset=${offset} failed: ${resp.error}`);
		}
		const rows = resp as Array<{ key: string; value: { descendants: number } }>;
		if (rows.length === 0) break;

		const zeroBatch: Record<string, { descendants: number }> = {};
		for (const row of rows) {
			const id = Number(row.key);
			if (!hasComments.has(id) && row.value.descendants !== 0) {
				zeroBatch[row.key] = { descendants: 0 };
			}
		}
		if (Object.keys(zeroBatch).length > 0) {
			const upd = await shardDb.query({
				mode: 'bulk-update', dir: DIR, object: 'stories', records: zeroBatch
			} as unknown as QueryBody);
			if (isError(upd)) {
				throw new Error(`bulk-update (zero) @offset=${offset} failed: ${upd.error}`);
			}
			zeroed += Object.keys(zeroBatch).length;
		}

		offset += rows.length;
		console.log(`  fetched ${offset} stories so far (${zeroed} zeroed)`);
	}
	return zeroed;
}

async function main() {
	const maxId = await readRefreshState();
	if (maxId <= 0) {
		console.error('No refresh state found (.hn-refresh-state.json missing or last_seen_id=0). ' +
			'Run the refresh tick / bulk-load at least once before backfilling.');
		process.exit(1);
	}

	console.log(`Phase 1: recomputing descendants from comments, id range [1, ${maxId}], chunk=${COMMENT_ID_CHUNK}`);
	const hasComments = new Set<number>();
	let realCount = 0;
	const t0 = performance.now();
	for (let lo = 1; lo <= maxId; lo += COMMENT_ID_CHUNK) {
		const hi = Math.min(lo + COMMENT_ID_CHUNK - 1, maxId);
		const touched = await backfillRange(lo, hi);
		for (const id of touched) hasComments.add(id);
		realCount += touched.size;
		console.log(`  [${lo}, ${hi}]: ${touched.size} stories updated (running total: ${realCount})`);
	}
	console.log(`Phase 1 done in ${((performance.now() - t0) / 1000).toFixed(1)}s — ${realCount} stories updated, ${hasComments.size} distinct story ids have local comments.`);

	console.log(`\nPhase 2: zeroing descendants on stories with no local comments`);
	const t1 = performance.now();
	const zeroed = await zeroStoriesWithoutComments(hasComments);
	console.log(`Phase 2 done in ${((performance.now() - t1) / 1000).toFixed(1)}s — ${zeroed} stories zeroed.`);

	console.log(`\nDone. ${realCount} stories corrected to real counts, ${zeroed} stories zeroed.`);
	shardDb.close();
}

main().catch((err) => {
	console.error('\nbackfill-descendants failed:', err);
	process.exit(1);
});

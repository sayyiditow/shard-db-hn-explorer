#!/usr/bin/env bun
/**
 * Bulk-load HN snapshot from Hugging Face (anantn/hacker-news) into shard-db.
 *
 * - Replaces existing data (truncate stories/comments/users first).
 * - Loads users.parquet wholesale (~321 MB, ~853k rows).
 * - Streams items.parquet via HTTP-range row-group reads until BULK_TARGET
 *   items are processed; defaults to 1,000,000 for local dev.
 * - Resolves `story_root` per-comment by walking the parent chain in memory.
 *   Comments whose parent falls outside our slice land with story_root set
 *   to the parent itself (best-effort — matches HN's `top_level_parent`
 *   semantics for the items we don't have).
 *
 * Run:
 *   bun run scripts/bulk-load.ts                # 1M items
 *   BULK_TARGET=10_000_000 bun run scripts/bulk-load.ts
 *   BULK_TARGET=0          bun run scripts/bulk-load.ts   # full snapshot
 */

import {
	asyncBufferFromUrl,
	parquetMetadataAsync,
	parquetReadObjects,
	byteLengthFromUrl
} from 'hyparquet';
import { shardDb } from '../src/lib/shard-db/client';
import { write as writeRefreshState, STATE_PATH as REFRESH_STATE_PATH } from '../src/lib/refresh-cache/state';
import { truncateBytes } from '../src/lib/refresh-cache/truncate';
import { bulkInsert, dropIndexes, addIndexes, truncate, loadUsers, n, toMs, fmtCount } from './lib/bulk-ops';

// Field byte-budgets mirror scripts/setup-schema.ts and refresh.ts.
// shard-db rejects inserts with varchar content > N bytes; we
// pre-truncate (with a trailing "...") to stay within bounds.
const MAX_STORY_URL    = 512;
const MAX_STORY_TITLE  = 128;
const MAX_STORY_TEXT   = 4096;
const MAX_COMMENT_TEXT = 4096;

const HF_BASE = 'https://huggingface.co/datasets/anantn/hacker-news/resolve/main';
const ITEMS_URL = `${HF_BASE}/items.parquet`;

const BULK_TARGET = parseTarget(process.env.BULK_TARGET ?? '1000000');

/* Items pipeline flushes stories + comments to shard-db every
   FLUSH_EVERY_ITEMS records read, so peak Bun heap stays bounded
   regardless of total item count. At 44M items × ~500 B/row the
   accumulate-then-insert approach blew past 16 GB RAM and got OOM-
   killed at ~32% during the first full-snapshot attempt (2026-05-25
   on the Netcup deploy). 1M flush threshold = ~500 MB peak for the
   batch arrays; itemMeta Map still grows monotonically (~3 GB at
   44M items) but that's bounded by the dataset size, not by the
   batch arrays. */
const FLUSH_EVERY_ITEMS = 1_000_000;

interface ItemRow {
	id: bigint | number;
	type: string;
	by?: string;
	time?: bigint | number;
	title?: string;
	text?: string;
	url?: string;
	score?: bigint | number;
	parent?: bigint | number;
	descendants?: bigint | number;
	deleted?: boolean;
	dead?: boolean;
}

/* Item type codes for the compact typed-array itemMeta replacement.
 * Mapping a string type to a uint8 keeps the parent-chain walker
 * branch-free on the type check. 0 = unknown / out-of-slice. */
const TYPE_UNKNOWN = 0;
const TYPE_STORY   = 1;
const TYPE_COMMENT = 2;
const TYPE_JOB     = 3;
const TYPE_POLL    = 4;
const TYPE_POLLOPT = 5;

function typeCode(t: string | undefined): number {
	switch (t) {
		case 'story':   return TYPE_STORY;
		case 'comment': return TYPE_COMMENT;
		case 'job':     return TYPE_JOB;
		case 'poll':    return TYPE_POLL;
		case 'pollopt': return TYPE_POLLOPT;
		default:        return TYPE_UNKNOWN;
	}
}

function isStoryLike(code: number): boolean {
	return code === TYPE_STORY || code === TYPE_JOB || code === TYPE_POLL;
}

function parseTarget(s: string): number {
	const n = Number(s.replace(/_/g, ''));
	return Number.isFinite(n) && n >= 0 ? n : 1_000_000;
}

async function loadItems(): Promise<{
	stories: number;
	comments: number;
	droppedStories: number;
	droppedComments: number;
	maxId: number;
}> {
	console.log('\nItems — fetching items.parquet metadata...');
	const byteLength = await byteLengthFromUrl(ITEMS_URL);
	console.log(`  items.parquet: ${(byteLength / 1e9).toFixed(2)} GB`);

	const file = await asyncBufferFromUrl({ url: ITEMS_URL, byteLength });
	const metadata = await parquetMetadataAsync(file);
	const totalRows = Number(metadata.num_rows);
	const rowGroups = metadata.row_groups.length;
	console.log(`  ${fmtCount(totalRows)} rows in ${rowGroups} row groups`);

	// We slurp items in row-group-sized windows. parquetReadObjects accepts
	// rowStart/rowEnd; hyparquet only pulls the row groups that overlap.
	const targetRows = BULK_TARGET === 0 ? totalRows : Math.min(BULK_TARGET, totalRows);
	const ROW_GROUP_HINT = Math.ceil(totalRows / rowGroups); // approx rows per group
	console.log(`  target: ${fmtCount(targetRows)} items (≈${rowGroups > 0 ? Math.ceil(targetRows / ROW_GROUP_HINT) : 0} row groups)`);

	/* Item-meta storage: id → (type, parent), needed for resolving
	   comment story_root across the WHOLE dataset (a comment's parent
	   may have come from any earlier row group). HN's parquet is sorted
	   ascending by id and parents always have lower ids than children,
	   so by the time we see a comment its parent chain is already in
	   the arrays — resolution can happen inline.

	   Pre-2026-05-25 used Map<number, {type, parent}> which OOM'd at
	   ~56% (25M items). V8 Map entries are ~120 B each so 44M items
	   pushed the JS heap past V8's default 4 GB cap. Typed arrays live
	   OFF the V8 heap (raw backing buffers), so the cap doesn't apply
	   AND they're 12× smaller per entry. */
	const arraySize = totalRows + 1_000_000;  // headroom for any id gaps
	console.log(`  allocating itemMeta typed arrays (${fmtCount(arraySize)} slots, ~${((arraySize * 5) / 1e6).toFixed(0)} MB)...`);
	const itemType = new Uint8Array(arraySize);    // 1 B per id
	const itemParent = new Uint32Array(arraySize); // 4 B per id

	/* findStoryRoot — walks the parent chain to the top-level story id.
	   Closure so it hot-accesses local typed arrays without param plumbing. */
	const findStoryRoot = (commentId: number): number => {
		if (commentId >= arraySize || itemType[commentId] === TYPE_UNKNOWN) return commentId;
		let parent = itemParent[commentId];
		// HN comment chains are typically ≤ 20 deep; 64 is the safety belt.
		for (let i = 0; i < 64; i++) {
			if (parent === 0) break;
			if (parent >= arraySize) return parent;
			if (itemType[parent] === TYPE_UNKNOWN) return parent;
			if (isStoryLike(itemType[parent])) return parent;
			parent = itemParent[parent];
		}
		return parent || commentId;
	};

	/* Batch arrays are flushed every FLUSH_EVERY_ITEMS rows read so
	   peak Bun heap from these stays bounded (~500 MB at the 1M
	   threshold). Pre-2026-05-25 the loop accumulated all 44M items
	   in these arrays and OOM-killed at ~32%. */
	let stories: { key: string; value: Record<string, unknown> }[] = [];
	let comments: { key: string; value: Record<string, unknown> }[] = [];
	let totalStories = 0;
	let totalComments = 0;
	let droppedStories = 0;
	let droppedComments = 0;
	let maxId = 0;

	const flushIfFull = async (final: boolean): Promise<void> => {
		const have = stories.length + comments.length;
		if (have === 0) return;
		if (!final && have < FLUSH_EVERY_ITEMS) return;
		if (stories.length > 0) {
			const stats = await bulkInsert('stories', stories);
			totalStories += stats.inserted;
			droppedStories += stats.dropped;
			stories = [];
		}
		if (comments.length > 0) {
			const stats = await bulkInsert('comments', comments);
			totalComments += stats.inserted;
			droppedComments += stats.dropped;
			comments = [];
		}
	};

	let cursor = 0;
	const t0 = performance.now();

	while (cursor < targetRows) {
		const rowEnd = Math.min(cursor + ROW_GROUP_HINT, targetRows);

		const rows = (await parquetReadObjects({
			file,
			metadata,
			columns: ['id', 'type', 'by', 'time', 'title', 'text', 'url', 'score', 'parent', 'descendants', 'deleted', 'dead'],
			rowStart: cursor,
			rowEnd
		})) as unknown as ItemRow[];

		// Build parent-resolution arrays for THIS row group's ids; later
		// rows in the same group may reference earlier rows in the
		// group, so populate the whole group before classifying.
		for (const r of rows) {
			const id = n(r.id);
			if (id < arraySize) {
				itemType[id] = typeCode(r.type);
				itemParent[id] = n(r.parent);
			}
		}

		for (const r of rows) {
			const id = n(r.id);
			if (id > maxId) maxId = id;
			const idStr = String(id);
			if (r.type === 'story' || r.type === 'job' || r.type === 'poll' || r.type === 'pollopt') {
				stories.push({
					key: idStr,
					value: {
						by: r.by ?? '',
						time: toMs(r.time),
						score: n(r.score),
						url: truncateBytes(r.url ?? '', MAX_STORY_URL),
						title: truncateBytes(r.title ?? '', MAX_STORY_TITLE),
						// Self-post body — Ask HN / poll / job listings often have
						// content in `text` instead of (or alongside) `url`. Empty
						// string for link-only stories.
						text: truncateBytes(r.text ?? '', MAX_STORY_TEXT),
						descendants: n(r.descendants),
						type: r.type ?? 'story',
						deleted: !!r.deleted,
						dead: !!r.dead
					}
				});
			} else if (r.type === 'comment') {
				// Resolve story_root inline — parquet is sorted by id
				// ascending and parents have lower ids, so the typed
				// arrays already contain the parent chain.
				comments.push({
					key: idStr,
					value: {
						by: r.by ?? '',
						time: toMs(r.time),
						parent: n(r.parent),
						story_root: findStoryRoot(id),
						text: truncateBytes(r.text ?? '', MAX_COMMENT_TEXT),
						deleted: !!r.deleted,
						dead: !!r.dead
					}
				});
			}
		}

		cursor = rowEnd;
		const elapsed = (performance.now() - t0) / 1000;
		const pct = ((cursor / targetRows) * 100).toFixed(1);
		console.log(
			`  read ${fmtCount(cursor)} / ${fmtCount(targetRows)} (${pct}%) · ` +
			`pending stories=${fmtCount(stories.length)} comments=${fmtCount(comments.length)} · ` +
			`flushed stories=${fmtCount(totalStories)} comments=${fmtCount(totalComments)} · ` +
			`${elapsed.toFixed(1)}s`
		);

		await flushIfFull(false);
	}

	// Final flush — anything left under the threshold.
	await flushIfFull(true);

	const readMs = performance.now() - t0;
	console.log(`  items pipeline: ${(readMs / 1000).toFixed(1)}s total`);

	return {
		stories: totalStories,
		comments: totalComments,
		droppedStories,
		droppedComments,
		maxId
	};
}

async function main() {
	console.log(`Bulk-load — anantn/hacker-news → shard-db`);
	console.log(`  target items: ${BULK_TARGET === 0 ? 'FULL SNAPSHOT' : fmtCount(BULK_TARGET)}`);
	console.log(`  shard-db root: ${process.env.SHARD_DB_ROOT ?? '(not set)'}`);

	console.log('\nTruncating existing data:');
	await truncate('stories');
	await truncate('comments');
	await truncate('users');

	/* Load-then-index pattern. At full-HN scale (hundreds of millions
	   of items) the per-(field, shard) merge cost on indexed bulk-insert
	   scales O(R²) in chunk count and dominates total wall time. We
	   trade it for one extra pass (add-indexes at the end) that walks
	   the data ONCE and builds every index in parallel per shard.
	   Net win is ~2× at 25M and grows with scale. See docs/operations/
	   bulk-loading.md in the shard-db repo. */
	console.log('\nDropping indexes (load-then-index pattern):');
	await dropIndexes('stories');
	await dropIndexes('comments');
	await dropIndexes('users');

	const totalStart = performance.now();
	const userStats = await loadUsers();
	const { stories, comments, droppedStories, droppedComments, maxId } = await loadItems();
	const insertMs = performance.now() - totalStart;
	console.log(`\nInsert phase total: ${(insertMs / 1000).toFixed(1)}s`);

	console.log('\nBuilding indexes (one scan per object):');
	const indexStart = performance.now();
	await addIndexes('users');
	await addIndexes('stories');
	await addIndexes('comments');
	const indexMs = performance.now() - indexStart;
	const totalMs = insertMs + indexMs;
	console.log(`Index phase total: ${(indexMs / 1000).toFixed(1)}s`);

	// Seed the refresh state file so the 5-min loop picks up where the
	// parquet leaves off.  Without this, the first refresh tick on a
	// fresh deployment would seed last_seen_id at "current HN maxitem"
	// and skip every item between the snapshot date and "now."
	//
	// ONLY for full snapshots (BULK_TARGET=0).  Sample loads read the
	// parquet's *oldest* N rows (ancient IDs), so seeding state from
	// their maxId would cause the refresh tick to try backfilling tens
	// of millions of items.  Operators doing a sample load can manage
	// .hn-refresh-state.json manually.
	if (BULK_TARGET === 0 && maxId > 0) {
		await writeRefreshState(maxId);
		console.log(`  Wrote ${REFRESH_STATE_PATH} with last_seen_id=${maxId}`);
	} else if (maxId > 0) {
		console.log(`  Skipped ${REFRESH_STATE_PATH} write (partial load, BULK_TARGET=${BULK_TARGET}) — manage refresh state manually if you want the 5-min loop to backfill from here`);
	}

	console.log('\nDone.');
	console.log(`  Stories:   ${fmtCount(stories)} inserted, ${fmtCount(droppedStories)} dropped`);
	console.log(`  Comments:  ${fmtCount(comments)} inserted, ${fmtCount(droppedComments)} dropped`);
	console.log(`  Users:     ${fmtCount(userStats.inserted)} inserted, ${fmtCount(userStats.dropped)} dropped`);
	console.log(`  Max ID:    ${fmtCount(maxId)}`);
	console.log(`  Total:     ${(totalMs / 1000).toFixed(1)}s`);

	shardDb.close();
}

if (import.meta.main) {
	main().catch((err) => {
		console.error('\nbulk-load failed:', err);
		process.exit(1);
	});
}

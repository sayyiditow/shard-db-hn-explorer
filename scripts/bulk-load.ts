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
import { ShardDbClient, isError } from '../src/lib/shard-db/client';
import { write as writeRefreshState, STATE_PATH as REFRESH_STATE_PATH } from '../src/lib/refresh-cache/state';
import { truncateBytes } from '../src/lib/refresh-cache/truncate';
import { INDEX_LISTS, indexFieldName } from './lib/hn-schema';

// Field byte-budgets mirror scripts/setup-schema.ts and refresh.ts.
// shard-db rejects inserts with varchar content > N bytes; we
// pre-truncate (with a trailing "...") to stay within bounds.
const MAX_STORY_URL    = 512;
const MAX_STORY_TITLE  = 128;
const MAX_STORY_TEXT   = 4096;
const MAX_COMMENT_TEXT = 4096;
const MAX_USER_ABOUT   = 1024;

const HF_BASE = 'https://huggingface.co/datasets/anantn/hacker-news/resolve/main';
const ITEMS_URL = `${HF_BASE}/items.parquet`;
const USERS_URL = `${HF_BASE}/users.parquet`;

const BULK_TARGET = parseTarget(process.env.BULK_TARGET ?? '1000000');

/* Rows per bulk-insert call. At full-HN scale (44M items) the previous
 * 5000-row chunks meant 8800 daemon round-trips for items alone, each
 * paying parse + write + msync + tcp overhead. Daemon logs showed
 * per-chunk timing 150-360ms — total ~30-40 min just in fixed
 * per-call cost. Going to 100k cuts that to ~440 calls and amortises
 * the overhead.
 *
 * Trade-off: each call holds more rows in the daemon's request buffer
 * (~50 MB per call at 500 B/row). Bounded by MAX_REQUEST_SIZE in
 * db.env (default 100MB) — we set it to 100MB on the Netcup deploy
 * so this fits with headroom. */
const BULK_CHUNK = Number(process.env.BULK_CHUNK ?? 100_000);
const PARALLEL_CONNS = 5;            // shard-db client pool size

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

interface UserRow {
	id: string;
	created?: bigint | number;
	karma?: bigint | number;
	about?: string;
	submitted?: (bigint | number)[];
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

function n(v: bigint | number | undefined): number {
	if (v === undefined || v === null) return 0;
	if (typeof v === 'bigint') return Number(v);
	return v;
}

function toMs(unixSec: bigint | number | undefined): number {
	const s = n(unixSec);
	return s > 0 ? s * 1000 : 0;
}

// One connected client per worker. Each bulk-insert call is sequential
// on a single connection; we get parallelism by holding N connections
// open and round-robining work across them.
// Default to the shard-db binary's own default (9199) so a manually
// started daemon Just Works — matches setup-schema.ts + sample-load.ts.
// When running on top of `bun run app`'s dev daemon (which uses 19199
// to avoid clobbering any 9199 daemon), set SHARD_DB_PORT=19199
// explicitly before invoking bulk-load.
const DEFAULT_PORT = 9199;
const SHARD_HOST = process.env.SHARD_DB_HOST ?? '127.0.0.1';
const SHARD_PORT = process.env.SHARD_DB_PORT ? Number(process.env.SHARD_DB_PORT) : DEFAULT_PORT;
const SHARD_TOKEN = process.env.SHARD_DB_TOKEN;

function buildPool(size: number): ShardDbClient[] {
	const pool: ShardDbClient[] = [];
	for (let i = 0; i < size; i++) {
		pool.push(
			new ShardDbClient({
				host: SHARD_HOST,
				port: SHARD_PORT,
				token: SHARD_TOKEN,
				timeoutMs: 120_000
			})
		);
	}
	return pool;
}

async function bulkInsertParallel(
	pool: ShardDbClient[],
	object: string,
	records: { key: string; value: Record<string, unknown> }[]
): Promise<void> {
	const chunks: typeof records[] = [];
	for (let off = 0; off < records.length; off += BULK_CHUNK) {
		chunks.push(records.slice(off, off + BULK_CHUNK));
	}

	// Round-robin chunks across connections, BATCH parallel
	for (let i = 0; i < chunks.length; i += pool.length) {
		const batch = chunks.slice(i, i + pool.length);
		const results = await Promise.all(
			batch.map((chunk, k) =>
				pool[k].query({
					mode: 'bulk-insert',
					dir: 'hn',
					object,
					records: chunk
				})
			)
		);
		for (const r of results) {
			if (isError(r)) {
				throw new Error(`bulk-insert ${object} failed: ${r.error}`);
			}
		}
	}
}

/**
 * Strip every index off `object` so the subsequent bulk-insert pays
 * zero per-(field, shard) merge cost. The per-chunk insert rate stays
 * flat across the run instead of degrading O(R²) with chunk count
 * — proven against shard-db at 25M with the same R = ~25 we'll see
 * here at low-tens-of-millions and beyond. See docs/operations/
 * bulk-loading.md in shard-db for the crossover rule.
 *
 * Idempotent: indexes already missing are ignored by the server.
 */
async function dropIndexes(client: ShardDbClient, object: string): Promise<void> {
	const specs = INDEX_LISTS[object];
	if (!specs || specs.length === 0) return;
	const fields = specs.map(indexFieldName);
	process.stdout.write(`  drop ${fields.length} indexes on hn/${object} ... `);
	const resp = await client.query({
		mode: 'remove-index',
		dir: 'hn',
		object,
		fields
	});
	if (isError(resp)) {
		// "no index" / "not found" is fine on first run or partial state
		if (!/not found|no index|doesn't exist/i.test(resp.error)) {
			throw new Error(`drop indexes on ${object}: ${resp.error}`);
		}
	}
	console.log('ok');
}

/**
 * Build all indexes in ONE storage scan. The plural add-index form
 * (cmd_add_indexes server-side) accumulates entries for every listed
 * field during a single walk over the data shards — versus N separate
 * add-index calls which would each do their own full scan.
 *
 * Type suffixes (`title:trigram`, etc.) are preserved end-to-end; the
 * server reads them from the JSON array and writes them into
 * index.conf so the planner picks the right index type per op.
 */
async function addIndexes(client: ShardDbClient, object: string): Promise<void> {
	const specs = INDEX_LISTS[object];
	if (!specs || specs.length === 0) return;
	process.stdout.write(`  add ${specs.length} indexes on hn/${object} (one scan) ... `);
	const t0 = performance.now();
	const resp = await client.query({
		mode: 'add-index',
		dir: 'hn',
		object,
		fields: specs
	});
	if (isError(resp)) throw new Error(`add indexes on ${object}: ${resp.error}`);
	const ms = performance.now() - t0;
	console.log(`${(ms / 1000).toFixed(1)}s`);
}

async function truncate(client: ShardDbClient, object: string): Promise<void> {
	process.stdout.write(`  truncate hn/${object} ... `);
	const resp = await client.query({ mode: 'truncate', dir: 'hn', object });
	if (isError(resp)) {
		console.log(`FAILED: ${resp.error}`);
		throw new Error(resp.error);
	}
	console.log('ok');
}

function fmtCount(n: number): string {
	return n.toLocaleString();
}

async function loadUsers(pool: ShardDbClient[]): Promise<number> {
	console.log('\nUsers — fetching users.parquet metadata...');
	const byteLength = await byteLengthFromUrl(USERS_URL);
	console.log(`  users.parquet: ${(byteLength / 1e6).toFixed(1)} MB`);

	const file = await asyncBufferFromUrl({ url: USERS_URL, byteLength });
	const metadata = await parquetMetadataAsync(file);
	const totalRows = Number(metadata.num_rows);
	console.log(`  ${fmtCount(totalRows)} rows in users.parquet`);

	const allRows = (await parquetReadObjects({
		file,
		metadata,
		columns: ['id', 'created', 'karma', 'about', 'submitted']
	})) as unknown as UserRow[];

	console.log(`  parsed ${fmtCount(allRows.length)} users, bulk-inserting ...`);

	const records = allRows
		.filter((u) => u.id && typeof u.id === 'string')
		.map((u) => ({
			key: u.id,
			value: {
				karma: n(u.karma),
				created: toMs(u.created),
				about: truncateBytes(u.about ?? '', MAX_USER_ABOUT),
				submitted_count: Array.isArray(u.submitted) ? u.submitted.length : 0
			}
		}));

	const t0 = performance.now();
	await bulkInsertParallel(pool, 'users', records);
	const ms = performance.now() - t0;
	console.log(`  inserted ${fmtCount(records.length)} users in ${(ms / 1000).toFixed(1)}s`);
	return records.length;
}

async function loadItems(pool: ShardDbClient[]): Promise<{ stories: number; comments: number; maxId: number }> {
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
	let maxId = 0;

	const flushIfFull = async (final: boolean): Promise<void> => {
		const have = stories.length + comments.length;
		if (have === 0) return;
		if (!final && have < FLUSH_EVERY_ITEMS) return;
		if (stories.length > 0) {
			await bulkInsertParallel(pool, 'stories', stories);
			totalStories += stories.length;
			stories = [];
		}
		if (comments.length > 0) {
			await bulkInsertParallel(pool, 'comments', comments);
			totalComments += comments.length;
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

	return { stories: totalStories, comments: totalComments, maxId };
}

function findStoryRoot(commentId: number, items: Map<number, ItemMeta>): number {
	const self = items.get(commentId);
	if (!self) return commentId;
	let parent = self.parent;
	// HN comment chains are typically <= ~20 deep. Cap at 64 as a safety
	// belt against pathological cycles in malformed data.
	for (let i = 0; i < 64; i++) {
		if (!parent || parent === 0) break;
		const p = items.get(parent);
		if (!p) return parent;       // parent outside our slice — best effort
		if (p.type === 'story' || p.type === 'job' || p.type === 'poll') return parent;
		parent = p.parent;
	}
	return parent || commentId;
}

async function main() {
	const adminClient = new ShardDbClient({
		host: SHARD_HOST,
		port: SHARD_PORT,
		token: SHARD_TOKEN,
		timeoutMs: 60_000
	});

	console.log(`Bulk-load — anantn/hacker-news → shard-db`);
	console.log(`  target items: ${BULK_TARGET === 0 ? 'FULL SNAPSHOT' : fmtCount(BULK_TARGET)}`);
	console.log(`  shard-db:     ${SHARD_HOST}:${SHARD_PORT}`);

	console.log('\nTruncating existing data:');
	await truncate(adminClient, 'stories');
	await truncate(adminClient, 'comments');
	await truncate(adminClient, 'users');

	/* Load-then-index pattern. At full-HN scale (hundreds of millions
	   of items) the per-(field, shard) merge cost on indexed bulk-insert
	   scales O(R²) in chunk count and dominates total wall time. We
	   trade it for one extra pass (add-indexes at the end) that walks
	   the data ONCE and builds every index in parallel per shard.
	   Net win is ~2× at 25M and grows with scale. See docs/operations/
	   bulk-loading.md in the shard-db repo. */
	console.log('\nDropping indexes (load-then-index pattern):');
	await dropIndexes(adminClient, 'stories');
	await dropIndexes(adminClient, 'comments');
	await dropIndexes(adminClient, 'users');

	const pool = buildPool(PARALLEL_CONNS);

	const totalStart = performance.now();
	const userCount = await loadUsers(pool);
	const { stories, comments, maxId } = await loadItems(pool);
	const insertMs = performance.now() - totalStart;
	console.log(`\nInsert phase total: ${(insertMs / 1000).toFixed(1)}s`);

	console.log('\nBuilding indexes (one scan per object):');
	const indexStart = performance.now();
	await addIndexes(adminClient, 'users');
	await addIndexes(adminClient, 'stories');
	await addIndexes(adminClient, 'comments');
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
	console.log(`  Stories:   ${fmtCount(stories)}`);
	console.log(`  Comments:  ${fmtCount(comments)}`);
	console.log(`  Users:     ${fmtCount(userCount)}`);
	console.log(`  Max ID:    ${fmtCount(maxId)}`);
	console.log(`  Total:     ${(totalMs / 1000).toFixed(1)}s`);

	// Drain every pooled socket so Bun's event loop can exit; without
	// this the idle pool keeps the process alive after the work is done.
	adminClient.close();
	for (const c of pool) c.close();
}

main().catch((err) => {
	console.error('\nbulk-load failed:', err);
	process.exit(1);
});

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

const HF_BASE = 'https://huggingface.co/datasets/anantn/hacker-news/resolve/main';
const ITEMS_URL = `${HF_BASE}/items.parquet`;
const USERS_URL = `${HF_BASE}/users.parquet`;

const BULK_TARGET = parseTarget(process.env.BULK_TARGET ?? '1000000');
const BULK_CHUNK = 5000;             // rows per bulk-insert call
const PARALLEL_CONNS = 5;            // shard-db client pool size

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

interface ItemMeta {
	type: string;
	parent: number;
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
function buildPool(size: number): ShardDbClient[] {
	const pool: ShardDbClient[] = [];
	for (let i = 0; i < size; i++) {
		pool.push(
			new ShardDbClient({
				host: process.env.SHARD_DB_HOST ?? '127.0.0.1',
				port: process.env.SHARD_DB_PORT ? Number(process.env.SHARD_DB_PORT) : 9199,
				token: process.env.SHARD_DB_TOKEN,
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
				about: u.about ?? '',
				submitted_count: Array.isArray(u.submitted) ? u.submitted.length : 0
			}
		}));

	const t0 = performance.now();
	await bulkInsertParallel(pool, 'users', records);
	const ms = performance.now() - t0;
	console.log(`  inserted ${fmtCount(records.length)} users in ${(ms / 1000).toFixed(1)}s`);
	return records.length;
}

async function loadItems(pool: ShardDbClient[]): Promise<{ stories: number; comments: number }> {
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

	const itemMeta = new Map<number, ItemMeta>();
	const stories: { key: string; value: Record<string, unknown> }[] = [];
	const comments: { key: string; value: Record<string, unknown> }[] = [];

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

		// Build parent-resolution map first; we walk it below for story_root.
		for (const r of rows) {
			itemMeta.set(n(r.id), { type: r.type ?? 'unknown', parent: n(r.parent) });
		}

		// Then split + shape
		for (const r of rows) {
			const id = n(r.id);
			const idStr = String(id);
			if (r.type === 'story' || r.type === 'job' || r.type === 'poll' || r.type === 'pollopt') {
				stories.push({
					key: idStr,
					value: {
						by: r.by ?? '',
						time: toMs(r.time),
						score: n(r.score),
						url: r.url ?? '',
						title: r.title ?? '',
						descendants: n(r.descendants),
						type: r.type ?? 'story',
						deleted: !!r.deleted,
						dead: !!r.dead
					}
				});
			} else if (r.type === 'comment') {
				comments.push({
					key: idStr,
					value: {
						by: r.by ?? '',
						time: toMs(r.time),
						parent: n(r.parent),
						// story_root resolved in second pass below
						story_root: 0,
						text: r.text ?? '',
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
			`stories=${fmtCount(stories.length)} comments=${fmtCount(comments.length)} · ` +
			`${elapsed.toFixed(1)}s`
		);
	}

	const readMs = performance.now() - t0;
	console.log(`  parquet read+shape: ${(readMs / 1000).toFixed(1)}s`);

	// Resolve story_root per-comment via parent walk. O(n × chain) but chains
	// are short on HN; this finishes in single-digit seconds even at 1M.
	console.log(`  resolving story_root for ${fmtCount(comments.length)} comments ...`);
	const tResolve = performance.now();
	for (const c of comments) {
		const id = Number(c.key);
		c.value.story_root = findStoryRoot(id, itemMeta);
	}
	console.log(`    done in ${((performance.now() - tResolve) / 1000).toFixed(1)}s`);

	// Free the meta map before the bulk-insert phase — it can be 50 MB+.
	itemMeta.clear();

	// Insert stories first, then comments. Order matters for ref integrity
	// only on the read side; shard-db doesn't enforce it.
	console.log(`  bulk-insert stories (${fmtCount(stories.length)}) ...`);
	const tStories = performance.now();
	await bulkInsertParallel(pool, 'stories', stories);
	console.log(`    ${((performance.now() - tStories) / 1000).toFixed(1)}s`);

	console.log(`  bulk-insert comments (${fmtCount(comments.length)}) ...`);
	const tComments = performance.now();
	await bulkInsertParallel(pool, 'comments', comments);
	console.log(`    ${((performance.now() - tComments) / 1000).toFixed(1)}s`);

	return { stories: stories.length, comments: comments.length };
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
		host: process.env.SHARD_DB_HOST ?? '127.0.0.1',
		port: process.env.SHARD_DB_PORT ? Number(process.env.SHARD_DB_PORT) : 9199,
		token: process.env.SHARD_DB_TOKEN,
		timeoutMs: 60_000
	});

	console.log(`Bulk-load — anantn/hacker-news → shard-db`);
	console.log(`  target items: ${BULK_TARGET === 0 ? 'FULL SNAPSHOT' : fmtCount(BULK_TARGET)}`);
	console.log(`  shard-db:     ${process.env.SHARD_DB_HOST ?? '127.0.0.1'}:${process.env.SHARD_DB_PORT ?? 9199}`);

	console.log('\nTruncating existing data:');
	await truncate(adminClient, 'stories');
	await truncate(adminClient, 'comments');
	await truncate(adminClient, 'users');

	const pool = buildPool(PARALLEL_CONNS);

	const totalStart = performance.now();
	const userCount = await loadUsers(pool);
	const { stories, comments } = await loadItems(pool);
	const totalMs = performance.now() - totalStart;

	console.log('\nDone.');
	console.log(`  Stories:  ${fmtCount(stories)}`);
	console.log(`  Comments: ${fmtCount(comments)}`);
	console.log(`  Users:    ${fmtCount(userCount)}`);
	console.log(`  Total:    ${(totalMs / 1000).toFixed(1)}s`);
}

main().catch((err) => {
	console.error('\nbulk-load failed:', err);
	process.exit(1);
});

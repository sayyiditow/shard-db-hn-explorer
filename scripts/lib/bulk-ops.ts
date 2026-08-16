/**
 * Shared shard-db bulk-load primitives (insert batching, index drop/add,
 * truncate, users load). Pulled out of bulk-load.ts so that scripts which
 * only need a subset (e.g. reload-users.ts) can import them without also
 * pulling in bulk-load.ts's own top-level `if (import.meta.main)` entry
 * point — bundling two entry-point files together via `bun build` inlines
 * both files' module code into one output, and `import.meta.main` is
 * bundle-wide rather than per-source-file, so the importer's build would
 * otherwise also execute bulk-load's full main() as an unguarded side
 * effect. No top-level side effects belong in this file.
 */

import {
	asyncBufferFromUrl,
	parquetMetadataAsync,
	parquetReadObjects,
	byteLengthFromUrl
} from 'hyparquet';
import { shardDb, isError, type IShardDbClient } from '../../src/lib/shard-db/client';
import { truncateBytes } from '../../src/lib/refresh-cache/truncate';
import { INDEX_LISTS } from './hn-schema';

// Field byte-budgets mirror scripts/setup-schema.ts and refresh.ts.
export const MAX_USER_ABOUT = 1024;

const HF_BASE = 'https://huggingface.co/datasets/anantn/hacker-news/resolve/main';
const USERS_URL = `${HF_BASE}/users.parquet`;

/* Rows per bulk-insert call. See bulk-load.ts for the sizing rationale. */
export const BULK_CHUNK = Number(process.env.BULK_CHUNK ?? 100_000);

export interface UserRow {
	id: string;
	created?: bigint | number;
	karma?: bigint | number;
	about?: string;
	submitted?: (bigint | number)[];
}

export type BulkRecord = { key: string; value: Record<string, unknown> };
export interface BulkInsertStats {
	inserted: number;
	dropped: number;
}

const PARTIAL_INSERT_ERROR = 'some_records_dropped';

export function n(v: bigint | number | undefined): number {
	if (v === undefined || v === null) return 0;
	if (typeof v === 'bigint') return Number(v);
	return v;
}

export function toMs(unixSec: bigint | number | undefined): number {
	const s = n(unixSec);
	return s > 0 ? s * 1000 : 0;
}

export function fmtCount(n: number): string {
	return n.toLocaleString();
}

async function insertBatch(
	object: string,
	records: BulkRecord[],
	client: Pick<IShardDbClient, 'query'>,
	log: (message: string) => void
): Promise<BulkInsertStats> {
	const result = await client.query({
		mode: 'bulk-insert',
		dir: 'hn',
		object,
		records
	});
	if (!isError(result)) return { inserted: records.length, dropped: 0 };
	if (result.error !== PARTIAL_INSERT_ERROR) {
		throw new Error(`bulk-insert ${object} failed: ${result.error}`);
	}

	if (records.length === 1) {
		const record = records[0];
		log(
			`bulk-insert dropped record: object=${object} key=${record.key} ` +
			`record=${JSON.stringify(record)} error=${result.error}`
		);
		return { inserted: 0, dropped: 1 };
	}

	const midpoint = Math.floor(records.length / 2);
	const left = await insertBatch(object, records.slice(0, midpoint), client, log);
	const right = await insertBatch(object, records.slice(midpoint), client, log);
	return {
		inserted: left.inserted + right.inserted,
		dropped: left.dropped + right.dropped
	};
}

export async function bulkInsert(
	object: string,
	records: BulkRecord[],
	client: Pick<IShardDbClient, 'query'> = shardDb,
	log: (message: string) => void = (message) => console.error(message)
): Promise<BulkInsertStats> {
	let inserted = 0;
	let dropped = 0;
	for (let off = 0; off < records.length; off += BULK_CHUNK) {
		const chunk = records.slice(off, off + BULK_CHUNK);
		const stats = await insertBatch(object, chunk, client, log);
		inserted += stats.inserted;
		dropped += stats.dropped;
	}
	return { inserted, dropped };
}

/**
 * Strip every index off `object` so the subsequent bulk-insert pays
 * zero per-(field, shard) merge cost. Idempotent: indexes already
 * missing are ignored by the server.
 */
export async function dropIndexes(object: string): Promise<void> {
	const specs = INDEX_LISTS[object];
	if (!specs || specs.length === 0) return;
	process.stdout.write(`  drop ${specs.length} indexes on hn/${object} ... `);
	const resp = await shardDb.query({
		mode: 'remove-index',
		dir: 'hn',
		object,
		fields: specs
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
 * Build all indexes in ONE storage scan via the plural add-index form.
 */
export async function addIndexes(object: string): Promise<void> {
	const specs = INDEX_LISTS[object];
	if (!specs || specs.length === 0) return;
	process.stdout.write(`  add ${specs.length} indexes on hn/${object} (one scan) ... `);
	const t0 = performance.now();
	const resp = await shardDb.query({
		mode: 'add-index',
		dir: 'hn',
		object,
		fields: specs
	});
	if (isError(resp)) throw new Error(`add indexes on ${object}: ${resp.error}`);
	const ms = performance.now() - t0;
	console.log(`${(ms / 1000).toFixed(1)}s`);
}

export async function truncate(object: string): Promise<void> {
	process.stdout.write(`  truncate hn/${object} ... `);
	const resp = await shardDb.query({ mode: 'truncate', dir: 'hn', object });
	if (isError(resp)) {
		console.log(`FAILED: ${resp.error}`);
		throw new Error(resp.error);
	}
	console.log('ok');
}

export async function loadUsers(): Promise<BulkInsertStats> {
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
	const stats = await bulkInsert('users', records);
	const ms = performance.now() - t0;
	console.log(
		`  inserted ${fmtCount(stats.inserted)} users` +
		(stats.dropped > 0 ? `, dropped ${fmtCount(stats.dropped)}` : '') +
		` in ${(ms / 1000).toFixed(1)}s`
	);
	return stats;
}

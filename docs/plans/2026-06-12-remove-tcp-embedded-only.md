# Remove TCP — Embedded-Only Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove all TCP/daemon code from the explorer so shard-db runs exclusively in-process via the npm native addon — no daemon, no `SHARD_DB_MODE` switch.

**Architecture:** `client.ts` drops `ShardDbClient` and the mode-switch; the `shardDb` singleton is always an `EmbeddedShardDbClient` keyed off `SHARD_DB_ROOT`. `bulk-load.ts` drops its 5-connection TCP pool and uses the same singleton with sequential chunk inserts (shard_db's internal thread pool handles parallel I/O). `dev.sh` shrinks to the embedded-only path. `dev-up.sh` is deleted.

**Tech Stack:** Bun 1.x, SvelteKit + `@sveltejs/adapter-node`, `shard-db` npm native addon (N-API), TypeScript 6

---

## Context

| File | Current state | What changes |
|---|---|---|
| `src/lib/shard-db/client.ts` | `ShardDbClient` (TCP pool) + mode-switched singleton | Delete TCP class; singleton always embedded |
| `src/lib/shard-db/embedded.ts` | `EmbeddedShardDbClient` wrapping native addon | No change |
| `scripts/bulk-load.ts` | 5-connection TCP pool + parallel chunks | Drop pool; sequential inserts via singleton |
| `scripts/setup-schema.ts` | Uses `shardDb` singleton; logs TCP vs embedded | Remove TCP branch from log line |
| `scripts/sample-load.ts` | Uses `shardDb` singleton | No change |
| `scripts/dev.sh` | TCP-first with embedded branch | Keep only embedded path |
| `scripts/dev-up.sh` | Daemon startup script | Delete |

**Key invariant:** `shard_db_query` is thread-safe but synchronous (blocks the event loop thread). For the web server this is fine — queries are fast. For `bulk-load`, sequential 100k-row chunks still benefit from the C engine's internal thread pools for parallel disk I/O.

**`SHARD_DB_ROOT`** must be set (absolute path to data dir) for all scripts and the app. `SHARD_DB_MODE` is no longer used — remove it everywhere.

---

## Task 1: Strip `client.ts` to embedded-only

**Files:**
- Modify: `src/lib/shard-db/client.ts`

- [ ] **Step 1: Run baseline tests**

```bash
bun test
```
Expected: all pass.

- [ ] **Step 2: Replace `src/lib/shard-db/client.ts` in full**

```ts
import type { QueryBody } from './query-types';
import { EmbeddedShardDbClient } from './embedded';

export interface ShardDbError {
	error: string;
}

export interface IShardDbClient {
	query<T = unknown>(body: QueryBody): Promise<T | ShardDbError>;
	close(): void;
}

export const shardDb: IShardDbClient = new EmbeddedShardDbClient(
	process.env.SHARD_DB_ROOT
		?? (() => { throw new Error('SHARD_DB_ROOT must be set'); })()
);

export function isError(resp: unknown): resp is ShardDbError {
	return typeof resp === 'object' && resp !== null && 'error' in resp;
}
```

- [ ] **Step 3: Run tests**

```bash
bun test
```
Expected: all pass. `embedded.test.ts` imports from `./client` for `isError` — it should still resolve.

- [ ] **Step 4: Type-check**

```bash
bun run check
```
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/shard-db/client.ts
git commit -m "feat: remove TCP client — shardDb singleton is always embedded"
```

---

## Task 2: Convert `bulk-load.ts` — drop TCP pool

**Files:**
- Modify: `scripts/bulk-load.ts`

`bulk-load.ts` has a 5-connection `ShardDbClient` pool and a dead `findStoryRoot` function (line ~466, references undefined `ItemMeta`, never called — leftover from a prior refactor). Both are removed.

- [ ] **Step 1: Replace the import block at the top**

Current (lines 26–29):
```ts
import { ShardDbClient, isError } from '../src/lib/shard-db/client';
import { write as writeRefreshState, STATE_PATH as REFRESH_STATE_PATH } from '../src/lib/refresh-cache/state';
import { truncateBytes } from '../src/lib/refresh-cache/truncate';
import { INDEX_LISTS, indexFieldName } from './lib/hn-schema';
```

Replace with:
```ts
import { shardDb, isError } from '../src/lib/shard-db/client';
import { write as writeRefreshState, STATE_PATH as REFRESH_STATE_PATH } from '../src/lib/refresh-cache/state';
import { truncateBytes } from '../src/lib/refresh-cache/truncate';
import { INDEX_LISTS, indexFieldName } from './lib/hn-schema';
```

- [ ] **Step 2: Delete the TCP constants block**

Delete these lines (after the `FLUSH_EVERY_ITEMS` constant):
```ts
const DEFAULT_PORT = 9199;
const SHARD_HOST = process.env.SHARD_DB_HOST ?? '127.0.0.1';
const SHARD_PORT = process.env.SHARD_DB_PORT ? Number(process.env.SHARD_DB_PORT) : DEFAULT_PORT;
const SHARD_TOKEN = process.env.SHARD_DB_TOKEN;
```

And delete the `PARALLEL_CONNS` constant:
```ts
const PARALLEL_CONNS = 5;            // shard-db client pool size
```

- [ ] **Step 3: Delete `buildPool()`**

Delete the entire function:
```ts
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
```

- [ ] **Step 4: Replace `bulkInsertParallel` with sequential `bulkInsert`**

Delete:
```ts
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
```

Add in its place:
```ts
async function bulkInsert(
	object: string,
	records: { key: string; value: Record<string, unknown> }[]
): Promise<void> {
	for (let off = 0; off < records.length; off += BULK_CHUNK) {
		const chunk = records.slice(off, off + BULK_CHUNK);
		const result = await shardDb.query({
			mode: 'bulk-insert',
			dir: 'hn',
			object,
			records: chunk
		});
		if (isError(result)) {
			throw new Error(`bulk-insert ${object} failed: ${result.error}`);
		}
	}
}
```

- [ ] **Step 5: Update `dropIndexes` — remove `client` parameter**

Replace:
```ts
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
```

With:
```ts
async function dropIndexes(object: string): Promise<void> {
	const specs = INDEX_LISTS[object];
	if (!specs || specs.length === 0) return;
	const fields = specs.map(indexFieldName);
	process.stdout.write(`  drop ${fields.length} indexes on hn/${object} ... `);
	const resp = await shardDb.query({
		mode: 'remove-index',
		dir: 'hn',
		object,
		fields
	});
```

- [ ] **Step 6: Update `addIndexes` — remove `client` parameter**

Replace:
```ts
async function addIndexes(client: ShardDbClient, object: string): Promise<void> {
	const specs = INDEX_LISTS[object];
	if (!specs || specs.length === 0) return;
	process.stdout.write(`  add ${specs.length} indexes on hn/${object} (one scan) ... `);
	const t0 = performance.now();
	const resp = await client.query({
```

With:
```ts
async function addIndexes(object: string): Promise<void> {
	const specs = INDEX_LISTS[object];
	if (!specs || specs.length === 0) return;
	process.stdout.write(`  add ${specs.length} indexes on hn/${object} (one scan) ... `);
	const t0 = performance.now();
	const resp = await shardDb.query({
```

- [ ] **Step 7: Update `truncate` — remove `client` parameter**

Replace:
```ts
async function truncate(client: ShardDbClient, object: string): Promise<void> {
	process.stdout.write(`  truncate hn/${object} ... `);
	const resp = await client.query({ mode: 'truncate', dir: 'hn', object });
```

With:
```ts
async function truncate(object: string): Promise<void> {
	process.stdout.write(`  truncate hn/${object} ... `);
	const resp = await shardDb.query({ mode: 'truncate', dir: 'hn', object });
```

- [ ] **Step 8: Update `loadUsers` — remove `pool` parameter**

Replace:
```ts
async function loadUsers(pool: ShardDbClient[]): Promise<number> {
```
With:
```ts
async function loadUsers(): Promise<number> {
```

Replace the `await bulkInsertParallel(pool, 'users', records)` call inside `loadUsers` with:
```ts
await bulkInsert('users', records);
```

- [ ] **Step 9: Update `loadItems` — remove `pool` parameter**

Replace:
```ts
async function loadItems(pool: ShardDbClient[]): Promise<{ stories: number; comments: number; maxId: number }> {
```
With:
```ts
async function loadItems(): Promise<{ stories: number; comments: number; maxId: number }> {
```

Inside `flushIfFull`, replace:
```ts
await bulkInsertParallel(pool, 'stories', stories);
```
With:
```ts
await bulkInsert('stories', stories);
```

And replace:
```ts
await bulkInsertParallel(pool, 'comments', comments);
```
With:
```ts
await bulkInsert('comments', comments);
```

- [ ] **Step 10: Rewrite `main()` — drop `adminClient` and `pool`**

Replace the opening block of `main()`:
```ts
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

	/* Load-then-index pattern. ... */
	console.log('\nDropping indexes (load-then-index pattern):');
	await dropIndexes(adminClient, 'stories');
	await dropIndexes(adminClient, 'comments');
	await dropIndexes(adminClient, 'users');

	const pool = buildPool(PARALLEL_CONNS);

	const totalStart = performance.now();
	const userCount = await loadUsers(pool);
	const { stories, comments, maxId } = await loadItems(pool);
```

With:
```ts
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
	const userCount = await loadUsers();
	const { stories, comments, maxId } = await loadItems();
```

- [ ] **Step 11: Update the index phase and tail of `main()`**

Replace:
```ts
	console.log('\nBuilding indexes (one scan per object):');
	const indexStart = performance.now();
	await addIndexes(adminClient, 'users');
	await addIndexes(adminClient, 'stories');
	await addIndexes(adminClient, 'comments');
```
With:
```ts
	console.log('\nBuilding indexes (one scan per object):');
	const indexStart = performance.now();
	await addIndexes('users');
	await addIndexes('stories');
	await addIndexes('comments');
```

Replace the pool drain at the very end of `main()`:
```ts
	adminClient.close();
	for (const c of pool) c.close();
```
With:
```ts
	shardDb.close();
```

- [ ] **Step 12: Delete the dead `findStoryRoot` overload**

Delete the entire dead function below `loadItems` (it references an undefined `ItemMeta` type and is never called — leftover from a prior refactor):
```ts
function findStoryRoot(commentId: number, items: Map<number, ItemMeta>): number {
	const self = items.get(commentId);
	if (!self) return commentId;
	let parent = self.parent;
	for (let i = 0; i < 64; i++) {
		if (!parent || parent === 0) break;
		const p = items.get(parent);
		if (!p) return parent;
		if (p.type === 'story' || p.type === 'job' || p.type === 'poll') return parent;
		parent = p.parent;
	}
	return parent || commentId;
}
```

- [ ] **Step 13: Update the comment about BULK_CHUNK / MAX_REQUEST_SIZE**

The comment at the `BULK_CHUNK` constant references `MAX_REQUEST_SIZE in db.env` (daemon config). Replace the whole block comment:

```ts
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
```

With:
```ts
/* Rows per bulk-insert call. At full-HN scale (44M items) 100k-row
 * chunks give ~440 calls total. The C engine's internal thread pool
 * parallelises disk I/O within each call; larger chunks amortise the
 * per-call overhead (~50 MB per call at 500 B/row, well within the
 * 256 MB default query buffer). */
```

- [ ] **Step 14: Type-check**

```bash
bun run check
```
Expected: no errors.

- [ ] **Step 15: Commit**

```bash
git add scripts/bulk-load.ts
git commit -m "feat: bulk-load uses embedded shardDb singleton — drop TCP pool"
```

---

## Task 3: Clean up `setup-schema.ts` log line

**Files:**
- Modify: `scripts/setup-schema.ts`

- [ ] **Step 1: Replace the connection log block**

Replace:
```ts
	const connDesc = process.env.SHARD_DB_MODE === 'embedded'
		? `embedded (root: ${process.env.SHARD_DB_ROOT})`
		: `TCP ${process.env.SHARD_DB_HOST ?? '127.0.0.1'}:${process.env.SHARD_DB_PORT ?? 9199}`;
	console.log(`shard-db connection: ${connDesc}`);
```

With:
```ts
	console.log(`shard-db root: ${process.env.SHARD_DB_ROOT ?? '(not set)'}`);
```

- [ ] **Step 2: Type-check**

```bash
bun run check
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add scripts/setup-schema.ts
git commit -m "chore: remove TCP branch from setup-schema log line"
```

---

## Task 4: Delete `dev-up.sh`, rewrite `dev.sh`

**Files:**
- Delete: `scripts/dev-up.sh`
- Modify: `scripts/dev.sh`

- [ ] **Step 1: Delete `dev-up.sh`**

```bash
git rm scripts/dev-up.sh
```

- [ ] **Step 2: Replace `scripts/dev.sh` in full**

```bash
#!/usr/bin/env bash
# dev.sh — single-terminal local dev (embedded mode, no daemon).
#
# SHARD_DB_ROOT is auto-set to $(pwd)/db/dev/data if not provided.
#
# Run: bun run app

set -euo pipefail

cd "$(dirname "$0")/.."

DB_ROOT_ABS="${SHARD_DB_ROOT:-$(pwd)/db/dev/data}"
SAMPLE_SIZE="${SAMPLE_SIZE:-10000}"

mkdir -p "$DB_ROOT_ABS"

if [ ! -d "$DB_ROOT_ABS/hn" ]; then
    echo "→ First run: seeding schema..."
    SHARD_DB_ROOT="$DB_ROOT_ABS" bun run scripts/setup-schema.ts

    echo "→ First run: loading $SAMPLE_SIZE sample items..."
    SHARD_DB_ROOT="$DB_ROOT_ABS" SAMPLE_SIZE=$SAMPLE_SIZE bun run scripts/sample-load.ts
else
    echo "✓ schema already seeded. To force re-seed: rm -rf db/dev/data"
fi

echo ""
echo "→ Starting SvelteKit dev server (embedded mode)"
echo "  Open http://localhost:5173"
echo "  Ctrl-C to stop"
echo ""
exec env SHARD_DB_ROOT="$DB_ROOT_ABS" bun run dev
```

- [ ] **Step 3: Make executable + syntax check**

```bash
chmod +x scripts/dev.sh
bash -n scripts/dev.sh
```
Expected: exits 0, no output.

- [ ] **Step 4: Commit**

```bash
git add scripts/dev.sh
git commit -m "feat: dev.sh — embedded-only, delete dev-up.sh daemon script"
```

---

## Task 5: Full verification

- [ ] **Step 1: Run all tests**

```bash
bun test
```
Expected: all pass, no references to `ShardDbClient` or TCP in any output.

- [ ] **Step 2: Type-check**

```bash
bun run check
```
Expected: no errors.

- [ ] **Step 3: Grep for any TCP/SHARD_DB_MODE remnants**

```bash
grep -rn "ShardDbClient\|SHARD_DB_MODE\|SHARD_DB_HOST\|SHARD_DB_PORT\|SHARD_DB_TOKEN\|ShardDbClientOptions\|dev-up" \
  src scripts --include="*.ts" --include="*.sh"
```
Expected: no output. (These env vars and types no longer exist.)

- [ ] **Step 4: Smoke test — embedded dev from scratch**

```bash
rm -rf db/dev/data
SHARD_DB_ROOT=$(pwd)/db/dev/data bun run scripts/setup-schema.ts
```
Expected: prints `shard-db root: <path>`, creates schema, exits 0.

```bash
SHARD_DB_ROOT=$(pwd)/db/dev/data SAMPLE_SIZE=100 bun run scripts/sample-load.ts
```
Expected: fetches 100 items, inserts them, exits 0.

---

## Self-review checklist

### Spec coverage

| Requirement | Task |
|---|---|
| Remove `ShardDbClient` TCP class | Task 1 |
| `shardDb` singleton always embedded | Task 1 |
| `SHARD_DB_MODE` env var gone | Tasks 1, 3, 4 |
| `bulk-load.ts` uses singleton, sequential inserts | Task 2 |
| Dead `findStoryRoot` overload removed | Task 2, Step 12 |
| Stale `db.env`/daemon comment in bulk-load | Task 2, Step 13 |
| `setup-schema.ts` TCP log branch removed | Task 3 |
| `dev-up.sh` deleted | Task 4 |
| `dev.sh` embedded-only | Task 4 |
| Regression tests pass | Task 5 |

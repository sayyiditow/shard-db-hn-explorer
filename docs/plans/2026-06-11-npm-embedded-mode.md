# shard-db npm Embedded Mode: Direct Import Conversion

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `SHARD_DB_MODE=embedded` support to shard-db-hn-explorer so the SvelteKit server runs the database in-process via the `shard-db` npm native addon — no external daemon needed — with full TypeScript autocomplete on all query bodies.

**Architecture:** Install the `shard-db` file dependency; re-export `QueryBody` from a local `query-types.ts` so the type is available without importing the native module everywhere; create `EmbeddedShardDbClient` wrapping the synchronous native binding with the same typed `query<T>()` interface; mode-switch the `shardDb` singleton in `client.ts`; update scripts for embedded-mode support; update `dev.sh` for a daemon-free dev path.

**Tech Stack:** NAPI native addon (`shard-db` npm package built at `../shard-db/npm`), `node-gyp-build`, Bun 1.x, SvelteKit + `@sveltejs/adapter-node`, Vite 8, TypeScript 6

---

## Prerequisites

**`docs/plans/2026-06-11-npm-typed-query.md` in the `shard-db` repo must be executed first.**

That plan adds the `QueryBody` discriminated union to `../shard-db/npm/index.d.ts` and updates `query()` to accept objects. This plan depends on those types being present.

---

## Context: what already exists

| Location | What it is |
|---|---|
| `../shard-db/npm/` | Built npm package: `package.json`, `index.js` (CJS), `index.d.ts` with `ShardDb.QueryBody`, `prebuilds/linux-x64/shard-db.node` |
| `../shard-db/npm/src/binding.c` | NAPI wrapper: `open(dbRoot)`, `query(handle, json)`, `close(handle)` — synchronous |
| `src/lib/shard-db/client.ts` | TCP client (`ShardDbClient`) + singleton `shardDb` + `isError()` |
| `src/lib/refresh-cache/refresh.ts` | Imports `shardDb` from `$lib/shard-db/client` |
| `src/lib/refresh-cache/cached-query.ts` | Imports `shardDb` from `$lib/shard-db/client` |
| `scripts/setup-schema.ts` | Creates its own `ShardDbClient` — must switch to shared singleton |
| `scripts/sample-load.ts` | Creates its own `ShardDbClient` — must switch to shared singleton |
| `scripts/bulk-load.ts` | Creates its own pool of 5 parallel `ShardDbClient` — **leave as-is** |

The native `ShardDb` class after the prerequisite plan:
```ts
class ShardDb {
  constructor(dbRoot: string)
  query(body: ShardDb.QueryBody): string  // object form — no JSON.stringify needed
  query(json: string): string             // string passthrough — backward compat
  close(): void
}
// ShardDb.QueryBody, ShardDb.Aggregate, ShardDb.Criteria available as types
```

`SHARD_DB_ROOT` must be an **absolute path** to the data directory (e.g. `/abs/path/to/db/dev/data`). Scripts must call `close()` before exit so the per-process single-instance guard resets.

---

## File map

| Action | Path | Purpose |
|---|---|---|
| Modify | `package.json` | Add `"shard-db": "file:../shard-db/npm"` dependency |
| Modify | `vite.config.ts` | Exclude `shard-db` from Vite/Rollup SSR bundling |
| Create | `src/lib/shard-db/query-types.ts` | Re-export `QueryBody` / `Aggregate` / `Criteria` types — type-only import of `shard-db` so no native load in TCP mode |
| Create | `src/lib/shard-db/embedded.ts` | `EmbeddedShardDbClient` + `INativeShardDb` injection interface |
| Create | `src/lib/shard-db/embedded.test.ts` | Unit tests using a mock native object |
| Modify | `src/lib/shard-db/client.ts` | Add `IShardDbClient` (uses `QueryBody`); mode-switch `shardDb` singleton; update `ShardDbClient.query()` signature |
| Modify | `scripts/setup-schema.ts` | Use shared `shardDb` singleton |
| Modify | `scripts/sample-load.ts` | Use shared `shardDb` singleton |
| Modify | `scripts/dev.sh` | Add embedded mode path (skip daemon, seed in-process) |

---

## Task 1: Add the shard-db npm dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Confirm the package is not yet installed**

```bash
ls node_modules/shard-db 2>/dev/null || echo "not-installed"
```
Expected: `not-installed`

- [ ] **Step 2: Add to `"dependencies"` in `package.json`**

```json
"dependencies": {
	"hyparquet": "^1.25.8",
	"shard-db": "file:../shard-db/npm"
}
```

- [ ] **Step 3: Install**

```bash
bun install
```
Expected: no errors; `node_modules/shard-db` symlink appears.

- [ ] **Step 4: Verify the native binding and QueryBody types are present**

```bash
bun -e "const ShardDb = require('./node_modules/shard-db'); console.log(typeof ShardDb)"
```
Expected: `function`

```bash
grep -c 'QueryBody' node_modules/shard-db/index.d.ts
```
Expected: a number greater than 0 (confirms the typed-query prerequisite plan ran).

- [ ] **Step 5: Commit**

```bash
git add package.json bun.lockb
git commit -m "feat: add shard-db npm file dependency"
```

---

## Task 2: Configure Vite for the native addon

**Files:**
- Modify: `vite.config.ts`

`shard-db` is a native CJS addon. Vite must not try to bundle it for SSR — the Node.js loader handles it at runtime.

- [ ] **Step 1: Run type-check baseline**

```bash
bun run check
```
Expected: no errors.

- [ ] **Step 2: Replace `vite.config.ts`**

```ts
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit()],
	optimizeDeps: {
		exclude: ['shard-db']
	},
	ssr: {
		external: ['shard-db']
	}
});
```

- [ ] **Step 3: Verify type-check still passes**

```bash
bun run check
```
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add vite.config.ts
git commit -m "feat: mark shard-db native addon as SSR external in Vite config"
```

---

## Task 3: Create query-types.ts

**Files:**
- Create: `src/lib/shard-db/query-types.ts`

This file does a **type-only** import of `shard-db` and re-exports the query types. Type-only imports are erased at compile time — the native `.node` file is never loaded just because something imports a type from here.

- [ ] **Step 1: Create `src/lib/shard-db/query-types.ts`**

```ts
import type ShardDb from 'shard-db';

export type QueryBody = ShardDb.QueryBody;
export type Aggregate = ShardDb.Aggregate;
export type Criteria  = ShardDb.Criteria;
```

- [ ] **Step 2: Verify TypeScript resolves the types**

```bash
bun run check
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/shard-db/query-types.ts
git commit -m "feat: re-export QueryBody types from shard-db npm (type-only, no native load)"
```

---

## Task 4: Write the failing tests for EmbeddedShardDbClient

**Files:**
- Create: `src/lib/shard-db/embedded.test.ts`

Tests use a mock native object — no daemon, no disk I/O. The mock receives raw JSON strings (the real native binding does too), so `INativeShardDb` stays string-based even though `EmbeddedShardDbClient.query()` accepts `QueryBody`.

- [ ] **Step 1: Create `src/lib/shard-db/embedded.test.ts`**

```ts
import { describe, test, expect } from 'bun:test';
import { EmbeddedShardDbClient } from './embedded';
import type { INativeShardDb } from './embedded';
import { isError } from './client';

function makeFakeNative(responses: Record<string, unknown>): {
	native: INativeShardDb;
	calls: string[];
} {
	const calls: string[] = [];
	const native: INativeShardDb = {
		query(json: string): string {
			calls.push(json);
			const body = JSON.parse(json) as Record<string, unknown>;
			const resp = responses[body.mode as string] ?? { ok: true };
			return JSON.stringify(resp);
		},
		close() { calls.push('__close__'); }
	};
	return { native, calls };
}

describe('EmbeddedShardDbClient', () => {
	test('query() serializes QueryBody to JSON and parses the response', async () => {
		const { native } = makeFakeNative({ get: { title: 'hello' } });
		const client = new EmbeddedShardDbClient('', native);

		const result = await client.query({ mode: 'get', dir: 'hn', object: 'stories', key: '1' });

		expect(result).toEqual({ title: 'hello' });
	});

	test('query() passes all body fields to native.query() as JSON', async () => {
		const { native, calls } = makeFakeNative({});
		const client = new EmbeddedShardDbClient('', native);

		await client.query({ mode: 'count', dir: 'hn', object: 'stories' });

		expect(calls).toHaveLength(1);
		const sent = JSON.parse(calls[0]) as Record<string, unknown>;
		expect(sent.mode).toBe('count');
		expect(sent.dir).toBe('hn');
		expect(sent.object).toBe('stories');
	});

	test('query() returns shard-db error objects without throwing', async () => {
		const { native } = makeFakeNative({ get: { error: 'missing key' } });
		const client = new EmbeddedShardDbClient('', native);

		const result = await client.query({ mode: 'get', dir: 'hn', object: 'stories', key: 'x' });

		expect(isError(result)).toBe(true);
		expect((result as { error: string }).error).toBe('missing key');
	});

	test('close() delegates to native.close()', () => {
		const { native, calls } = makeFakeNative({});
		const client = new EmbeddedShardDbClient('', native);

		client.close();

		expect(calls).toContain('__close__');
	});
});
```

- [ ] **Step 2: Run tests — expect failure (module not yet created)**

```bash
bun test src/lib/shard-db/embedded.test.ts
```
Expected: error importing `./embedded` — file does not exist yet.

---

## Task 5: Implement EmbeddedShardDbClient

**Files:**
- Create: `src/lib/shard-db/embedded.ts`

- [ ] **Step 1: Create `src/lib/shard-db/embedded.ts`**

```ts
/**
 * EmbeddedShardDbClient — wraps the shard-db native npm addon.
 *
 * ShardDb.query() is synchronous (in-process C engine call). We wrap it
 * in Promise.resolve() to match the async interface of ShardDbClient (TCP).
 *
 * SHARD_DB_ROOT must be the absolute path to the data directory
 * (e.g. /abs/path/to/db/dev/data). shard_db_open uses built-in
 * defaults for THREADS/FCACHE_MAX/etc. — db.env is not loaded
 * (daemon path only).
 */

import ShardDb from 'shard-db';
import type { ShardDbError } from './client';
import type { QueryBody } from './query-types';

/** Minimal contract of the native ShardDb object — used for unit-test injection.
 *  The native binding always receives raw JSON strings (object serialisation
 *  happens in EmbeddedShardDbClient.query before this is called). */
export interface INativeShardDb {
	query(json: string): string;
	close(): void;
}

export class EmbeddedShardDbClient {
	private db: INativeShardDb;

	/**
	 * @param dbRoot   Absolute path to the shard-db data directory.
	 * @param _native  Inject a fake native object for unit tests; omit in production.
	 */
	constructor(dbRoot: string, _native?: INativeShardDb) {
		this.db = _native ?? new ShardDb(dbRoot);
	}

	async query<T = unknown>(body: QueryBody): Promise<T | ShardDbError> {
		const raw = this.db.query(JSON.stringify(body));
		return JSON.parse(raw) as T | ShardDbError;
	}

	close(): void {
		this.db.close();
	}
}
```

- [ ] **Step 2: Run the failing tests — expect them to pass now**

```bash
bun test src/lib/shard-db/embedded.test.ts
```
Expected:
```
✓ EmbeddedShardDbClient > query() serializes QueryBody to JSON and parses the response
✓ EmbeddedShardDbClient > query() passes all body fields to native.query() as JSON
✓ EmbeddedShardDbClient > query() returns shard-db error objects without throwing
✓ EmbeddedShardDbClient > close() delegates to native.close()
4 pass, 0 fail
```

- [ ] **Step 3: Run type-check**

```bash
bun run check
```
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/shard-db/embedded.ts src/lib/shard-db/embedded.test.ts
git commit -m "feat: add EmbeddedShardDbClient wrapping shard-db npm native addon"
```

---

## Task 6: Mode-switch the shardDb singleton in client.ts

**Files:**
- Modify: `src/lib/shard-db/client.ts`

Add `IShardDbClient` (using `QueryBody`), update `ShardDbClient.query()` signature, add `EmbeddedShardDbClient` import, and mode-switch the singleton.

- [ ] **Step 1: Run all existing tests as baseline**

```bash
bun test
```
Expected: all pass.

- [ ] **Step 2: Add the `QueryBody` type import at the top of `client.ts`**

After `import net from 'node:net';`, add:

```ts
import type { QueryBody } from './query-types';
import { EmbeddedShardDbClient } from './embedded';
```

- [ ] **Step 3: Add `IShardDbClient` interface after `ShardDbError`**

After `export interface ShardDbError { error: string; }`, add:

```ts
/** Shared interface implemented by ShardDbClient (TCP) and EmbeddedShardDbClient. */
export interface IShardDbClient {
	query<T = unknown>(body: QueryBody): Promise<T | ShardDbError>;
	close(): void;
}
```

- [ ] **Step 4: Update `ShardDbClient.query()` signature**

In the `ShardDbClient` class, replace the `query` method signature from:

```ts
async query<T = unknown>(body: Record<string, unknown>): Promise<T | ShardDbError> {
```

With:

```ts
async query<T = unknown>(body: QueryBody): Promise<T | ShardDbError> {
```

(The method body is unchanged — it still does `JSON.stringify(...)` internally for the TCP wire.)

- [ ] **Step 5: Replace the `shardDb` singleton export at the bottom of `client.ts`**

Replace:
```ts
/** Default singleton; reads HOST / PORT / TOKEN from env for prod. */
export const shardDb = new ShardDbClient({
	host: process.env.SHARD_DB_HOST,
	port: process.env.SHARD_DB_PORT ? Number(process.env.SHARD_DB_PORT) : undefined,
	token: process.env.SHARD_DB_TOKEN
});
```

With:
```ts
/** Default singleton — mode-switched via SHARD_DB_MODE.
 *
 *  SHARD_DB_MODE=embedded → in-process via npm native addon (no daemon).
 *    Requires SHARD_DB_ROOT to be set to the absolute data dir path.
 *  SHARD_DB_MODE unset    → TCP connection pool (default). */
export const shardDb: IShardDbClient = process.env.SHARD_DB_MODE === 'embedded'
	? new EmbeddedShardDbClient(
		process.env.SHARD_DB_ROOT
			?? (() => { throw new Error('SHARD_DB_ROOT must be set when SHARD_DB_MODE=embedded'); })()
	  )
	: new ShardDbClient({
		host: process.env.SHARD_DB_HOST,
		port: process.env.SHARD_DB_PORT ? Number(process.env.SHARD_DB_PORT) : undefined,
		token: process.env.SHARD_DB_TOKEN
	  });
```

- [ ] **Step 6: Run all tests**

```bash
bun test
```
Expected: all pass (no regressions — existing callers pass `QueryBody`-compatible objects already).

- [ ] **Step 7: Run type-check**

```bash
bun run check
```
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/lib/shard-db/client.ts
git commit -m "feat: mode-switch shardDb singleton via SHARD_DB_MODE=embedded; type query() with QueryBody"
```

---

## Task 7: Update scripts to use the shared singleton

**Files:**
- Modify: `scripts/setup-schema.ts`
- Modify: `scripts/sample-load.ts`

`scripts/bulk-load.ts` is **not changed** — it uses its own 5-connection TCP pool for high-throughput loading.

### setup-schema.ts

- [ ] **Step 1: Replace import and client construction in `setup-schema.ts`**

Replace:
```ts
import { ShardDbClient, isError } from '../src/lib/shard-db/client';

const client = new ShardDbClient({
	host: process.env.SHARD_DB_HOST ?? '127.0.0.1',
	port: process.env.SHARD_DB_PORT ? Number(process.env.SHARD_DB_PORT) : 9199,
	token: process.env.SHARD_DB_TOKEN
});
```

With:
```ts
import { shardDb as client, isError } from '../src/lib/shard-db/client';
```

- [ ] **Step 2: Replace the startup log line in `setup-schema.ts`**

Replace:
```ts
console.log(`Connecting to shard-db at ${process.env.SHARD_DB_HOST ?? '127.0.0.1'}:${process.env.SHARD_DB_PORT ?? 9199}`);
```

With:
```ts
const connDesc = process.env.SHARD_DB_MODE === 'embedded'
	? `embedded (root: ${process.env.SHARD_DB_ROOT})`
	: `TCP ${process.env.SHARD_DB_HOST ?? '127.0.0.1'}:${process.env.SHARD_DB_PORT ?? 9199}`;
console.log(`shard-db connection: ${connDesc}`);
```

### sample-load.ts

- [ ] **Step 3: Replace import and client construction in `sample-load.ts`**

Replace:
```ts
import { ShardDbClient, isError } from '../src/lib/shard-db/client';

const client = new ShardDbClient({
	host: process.env.SHARD_DB_HOST ?? '127.0.0.1',
	port: process.env.SHARD_DB_PORT ? Number(process.env.SHARD_DB_PORT) : 9199,
	token: process.env.SHARD_DB_TOKEN
});
```

With:
```ts
import { shardDb as client, isError } from '../src/lib/shard-db/client';
```

- [ ] **Step 4: Run type-check**

```bash
bun run check
```
Expected: no errors.

- [ ] **Step 5: Run all tests**

```bash
bun test
```
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add scripts/setup-schema.ts scripts/sample-load.ts
git commit -m "feat: setup-schema and sample-load use shared shardDb singleton (supports embedded mode)"
```

---

## Task 8: Update dev.sh for embedded mode

**Files:**
- Modify: `scripts/dev.sh`

When `SHARD_DB_MODE=embedded` is set, skip the daemon entirely. First-run check looks for `db/dev/data/hn/` (created by `setup-schema`). Existing TCP/daemon path is preserved unchanged.

- [ ] **Step 1: Replace `scripts/dev.sh`**

```bash
#!/usr/bin/env bash
# dev.sh — single-terminal local dev orchestration.
#
# TCP mode (default, SHARD_DB_MODE unset):
#   Spins up shard-db daemon on a dev port, seeds schema + sample data on
#   first run, then starts the SvelteKit dev server. Ctrl-C stops both.
#
# Embedded mode (SHARD_DB_MODE=embedded):
#   No daemon. Opens the data directory in-process via the shard-db npm
#   native addon. First-run seeding also uses embedded mode.
#   SHARD_DB_ROOT is auto-set to $(pwd)/db/dev/data if not provided.
#
# Run: bun run app  (alias for ./scripts/dev.sh)

set -euo pipefail

cd "$(dirname "$0")/.."

PORT="${SHARD_DB_PORT:-19199}"
SAMPLE_SIZE="${SAMPLE_SIZE:-10000}"

# ── Embedded mode ─────────────────────────────────────────────────────────────
if [ "${SHARD_DB_MODE:-}" = "embedded" ]; then
    DB_ROOT_ABS="${SHARD_DB_ROOT:-$(pwd)/db/dev/data}"
    mkdir -p "$DB_ROOT_ABS"

    if [ ! -d "$DB_ROOT_ABS/hn" ]; then
        echo "→ First run (embedded): seeding schema..."
        SHARD_DB_MODE=embedded SHARD_DB_ROOT="$DB_ROOT_ABS" \
            bun run scripts/setup-schema.ts

        echo "→ First run (embedded): loading $SAMPLE_SIZE sample items..."
        SHARD_DB_MODE=embedded SHARD_DB_ROOT="$DB_ROOT_ABS" \
            SAMPLE_SIZE=$SAMPLE_SIZE bun run scripts/sample-load.ts
    else
        echo "✓ schema already seeded. To force re-seed: rm -rf db/dev/data"
    fi

    echo ""
    echo "→ Starting SvelteKit dev server (embedded mode — no daemon needed)"
    echo "  Open http://localhost:5173"
    echo "  Ctrl-C to stop"
    echo ""
    exec env SHARD_DB_MODE=embedded SHARD_DB_ROOT="$DB_ROOT_ABS" bun run dev
fi

# ── TCP / daemon mode (default) ───────────────────────────────────────────────
SHARD_DB_BIN="${SHARD_DB_BIN:-../shard-db/build/bin/shard-db}"

if [ ! -x "$SHARD_DB_BIN" ]; then
    echo "shard-db binary not found at $SHARD_DB_BIN" >&2
    echo "Build it first: (cd ../shard-db && ./build.sh)" >&2
    exit 1
fi

SHARD_PID=""
DEV_PID=""

cleanup() {
    local code=$?
    if [ -n "$SHARD_PID" ] && kill -0 "$SHARD_PID" 2>/dev/null; then
        echo ""
        echo "Stopping shard-db (pid=$SHARD_PID)..."
        kill "$SHARD_PID" 2>/dev/null || true
        wait "$SHARD_PID" 2>/dev/null || true
    fi
    if [ -n "$DEV_PID" ] && kill -0 "$DEV_PID" 2>/dev/null; then
        kill "$DEV_PID" 2>/dev/null || true
        wait "$DEV_PID" 2>/dev/null || true
    fi
    exit $code
}
trap cleanup EXIT INT TERM

echo "→ Starting shard-db on port $PORT..."
PORT=$PORT ./scripts/dev-up.sh > /tmp/shard-db-dev.log 2>&1 &
SHARD_PID=$!

for i in {1..50}; do
    if (echo > /dev/tcp/127.0.0.1/$PORT) 2>/dev/null; then
        echo "✓ shard-db ready (pid=$SHARD_PID, port=$PORT)"
        break
    fi
    if ! kill -0 "$SHARD_PID" 2>/dev/null; then
        echo "✗ shard-db died during startup. Last log lines:" >&2
        tail -20 /tmp/shard-db-dev.log >&2 || true
        exit 1
    fi
    sleep 0.2
    if [ "$i" = "50" ]; then
        echo "✗ shard-db didn't bind to port $PORT within 10s" >&2
        tail -20 /tmp/shard-db-dev.log >&2 || true
        exit 1
    fi
done

if [ ! -s "db/dev/data/schema.conf" ] || ! grep -q "^hn:" "db/dev/data/schema.conf" 2>/dev/null; then
    echo "→ First run: seeding schema + $SAMPLE_SIZE sample items"
    SHARD_DB_PORT=$PORT bun run scripts/setup-schema.ts
    SHARD_DB_PORT=$PORT SAMPLE_SIZE=$SAMPLE_SIZE bun run scripts/sample-load.ts
else
    echo "✓ schema already seeded (skip re-seed). To force, rm -rf db/"
fi

echo ""
echo "→ Starting SvelteKit dev server"
echo "  Open http://localhost:5173"
echo "  Ctrl-C to stop both shard-db and the dev server"
echo ""

SHARD_DB_PORT=$PORT exec bun run dev
```

- [ ] **Step 2: Make executable**

```bash
chmod +x scripts/dev.sh
```

- [ ] **Step 3: Bash syntax check**

```bash
bash -n scripts/dev.sh
```
Expected: exits 0, no output.

- [ ] **Step 4: Commit**

```bash
git add scripts/dev.sh
git commit -m "feat: dev.sh supports SHARD_DB_MODE=embedded — daemon-free dev mode"
```

---

## Self-review checklist

### Spec coverage

| Requirement | Covered by |
|---|---|
| `shard-db` npm package installed | Task 1 |
| Vite won't bundle native `.node` addon | Task 2 |
| `QueryBody` types available without loading native module | Task 3 (`query-types.ts` type-only import) |
| `EmbeddedShardDbClient` with typed `query<T>(body: QueryBody)` | Tasks 4–5 |
| Unit tests for embedded client (no daemon, no real files) | Task 4 (tests) + Task 5 (impl) |
| `IShardDbClient` uses `QueryBody` (autocomplete in both modes) | Task 6 |
| `ShardDbClient.query()` signature updated to `QueryBody` | Task 6, Step 4 |
| Mode switch via `SHARD_DB_MODE=embedded` | Task 6 |
| Existing TCP mode unaffected | Task 6, Step 6 |
| `setup-schema.ts` works in embedded mode | Task 7 |
| `sample-load.ts` works in embedded mode | Task 7 |
| `bulk-load.ts` untouched (TCP-only, parallel pool) | Explicitly excluded |
| `dev.sh` daemon-free embedded mode path | Task 8 |
| First-run seeding in embedded mode | Task 8 |

### Notes for executor

- `query-types.ts` uses `import type` — zero runtime cost; the `.node` file is not loaded by anything that only imports types from there.
- `INativeShardDb` in `embedded.ts` still takes a raw JSON string — the mock in tests calls `JSON.parse` internally to dispatch responses. `EmbeddedShardDbClient.query()` does the `JSON.stringify` before hitting the native layer.
- `SHARD_DB_ROOT` must be an **absolute path**. `dev.sh` sets it via `$(pwd)/db/dev/data`.
- Scripts call `client.close()` in their `main().then(...)` tail — this resets the single-instance guard so a subsequent script open (setup → sample-load) works correctly.
- `bulk-load.ts` creates its own `ShardDbClient` pool and is left in TCP-only mode intentionally.

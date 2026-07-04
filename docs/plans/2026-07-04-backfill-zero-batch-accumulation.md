# Accumulate phase-2 zero-candidates across pages instead of flushing per fetch page

## Execution rules (read first)

- Plans in this repo are executed by DeepSeek, outside of Claude.
- Branch off `main`: `git checkout -b perf/backfill-zero-batch-accumulation`.
- Test with `bun test`. Type-check with `bun run check`.
- The single edit below is located by **quoted anchor text**, not line
  numbers. If the anchor is not found character-for-character, stop and note
  what was found instead rather than guessing.
- Leave changes uncommitted when done — commit/push is handled outside this
  workflow.

## Background

`scripts/backfill-descendants.ts` phase 2 (`zeroStoriesWithoutComments`)
pages through the entire `stories` object in blocks of `STORY_FETCH_PAGE`
(50,000), and for each page immediately issues a `bulk-update` for whatever
zero-candidates it found on that page — even if that's only 1 or 2 records.

The script is designed to be idempotent and safe to re-run ("Safe to
re-run — every value written is recomputed from what's currently in
`comments`, not accumulated"). On a re-run against a corpus that's already
mostly correct (e.g. after a previous full run, or after the
`agg_ht_resize` engine bug fix lands and the script is re-run to correct
data written while that bug was active), the overwhelming majority of
50,000-row pages will yield only a couple of real zero-candidates — but
each page still round-trips a `bulk-update` call regardless of how small
the resulting batch is. Across a corpus of millions of stories that's
potentially thousands of tiny (1-2 record) `bulk-update` round trips
instead of a much smaller number of large ones.

Fix: decouple the flush cadence from the fetch cadence. Accumulate
zero-candidates into a `pending` buffer across pages, and only flush
(`bulk-update`) once `pending` reaches `ZERO_FLUSH_SIZE` (matching
`STORY_FETCH_PAGE`, 50,000) records, plus one final flush after the fetch
loop ends for whatever remainder didn't reach the threshold. This turns
"one bulk-update per fetch page" into "one bulk-update per ~50,000 real
zero-candidates found," which on a mostly-clean re-run collapses thousands
of tiny round trips into a handful of large ones (or just the one final
flush, if the total number of real candidates never reaches 50,000).

This does not change what gets written or the final `zeroed` count — only
when/how the writes are batched. Phase 1 (`backfillRange`) is unaffected;
it already writes exactly once per `COMMENT_ID_CHUNK` range and doesn't
have this problem (each range's aggregate result is written in one
`bulk-update` regardless of size).

## Task 1 — Accumulate and batch-flush phase-2 zero writes

In `scripts/backfill-descendants.ts`, find this exact anchor (the current
`zeroStoriesWithoutComments` function, including its doc comment):

```ts
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
		const dict = resp as Record<string, { descendants: number }>;
		const entries = Object.entries(dict);
		if (entries.length === 0) break;

		const zeroBatch: Record<string, { descendants: number }> = {};
		for (const [key, value] of entries) {
			const id = Number(key);
			if (!hasComments.has(id) && value.descendants !== 0) {
				zeroBatch[key] = { descendants: 0 };
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

		offset += entries.length;
		console.log(`  fetched ${offset} stories so far (${zeroed} zeroed)`);
	}
	return zeroed;
}
```

Replace it with:

```ts
/** Phase 2: page through every story; zero out `descendants` on any
 *  story `hasComments` didn't see in phase 1 (and whose descendants
 *  isn't already 0 — skip the no-op write). Zero-candidates are
 *  accumulated across fetch pages into `pending` and only flushed via
 *  `bulk-update` once ~ZERO_FLUSH_SIZE records are pending (plus one
 *  final flush for the remainder). On a re-run against an already-mostly
 *  -correct corpus, most 50k-row pages yield only a handful of real
 *  candidates — flushing per-page would turn this into thousands of
 *  tiny round trips instead of a much smaller number of large ones. */
async function zeroStoriesWithoutComments(hasComments: Set<number>): Promise<number> {
	let offset = 0;
	let zeroed = 0;
	let pending: Record<string, { descendants: number }> = {};

	const flushPending = async (): Promise<void> => {
		const n = Object.keys(pending).length;
		if (n === 0) return;
		const upd = await shardDb.query({
			mode: 'bulk-update', dir: DIR, object: 'stories', records: pending
		} as unknown as QueryBody);
		if (isError(upd)) {
			throw new Error(`bulk-update (zero) @offset=${offset} failed: ${upd.error}`);
		}
		zeroed += n;
		pending = {};
	};

	for (;;) {
		const resp = await shardDb.query({
			mode: 'fetch', dir: DIR, object: 'stories',
			offset, limit: STORY_FETCH_PAGE, fields: ['descendants']
		} as QueryBody);
		if (isError(resp)) {
			throw new Error(`fetch stories @offset=${offset} failed: ${resp.error}`);
		}
		const dict = resp as Record<string, { descendants: number }>;
		const entries = Object.entries(dict);
		if (entries.length === 0) break;

		for (const [key, value] of entries) {
			const id = Number(key);
			if (!hasComments.has(id) && value.descendants !== 0) {
				pending[key] = { descendants: 0 };
			}
		}
		if (Object.keys(pending).length >= ZERO_FLUSH_SIZE) {
			await flushPending();
		}

		offset += entries.length;
		console.log(`  fetched ${offset} stories so far (${zeroed} zeroed, ${Object.keys(pending).length} pending)`);
	}

	await flushPending();
	return zeroed;
}
```

Also, find this exact anchor (the existing constants block):

```ts
const DIR = 'hn';
const COMMENT_ID_CHUNK = 200_000;
const STORY_FETCH_PAGE = 50_000;
```

and replace it with:

```ts
const DIR = 'hn';
const COMMENT_ID_CHUNK = 200_000;
const STORY_FETCH_PAGE = 50_000;
const ZERO_FLUSH_SIZE = 50_000;
```

## Invariants / edge cases

- The final `zeroed` count returned by `zeroStoriesWithoutComments` must be
  identical to what the pre-change code would have produced for the same
  corpus — this change only batches the writes differently, it does not
  change which records get zeroed or what value they're set to.
- `pending` must be flushed once more after the fetch loop exits (the
  `await flushPending();` call right after the `for (;;) { ... }` loop) —
  otherwise a trailing partial batch under `ZERO_FLUSH_SIZE` would be
  silently dropped and never written, undercounting `zeroed` and leaving
  those stories un-zeroed.
- `pending` keys are story-id strings; if the same story id is somehow
  re-added to `pending` before a flush (not expected — each story id
  appears at most once across all fetch pages, since `offset` strictly
  advances and `stories` isn't being mutated concurrently by this script)
  the later `pending[key] = ...` assignment would simply overwrite, same
  as the pre-change per-page `zeroBatch` behavior.
- The `>= ZERO_FLUSH_SIZE` check happens once per page, after merging that
  page's candidates into `pending` — `pending` can therefore briefly exceed
  `ZERO_FLUSH_SIZE` by up to one page's worth of candidates before it's
  flushed. That's fine; `ZERO_FLUSH_SIZE` is a batching target, not a hard
  cap enforced by shard-db.

## Task 2 — Verify

- `bun run check` (type-check) must pass.
- `bun test` must pass with no regressions.
- If there's an existing test file covering `backfill-descendants.ts` (e.g.
  a unit test exercising `zeroStoriesWithoutComments` against a fake
  `INativeShardDb`), it must still pass and should be extended (or a new
  test added) to assert that with N fetch pages each producing few
  zero-candidates (fewer than `ZERO_FLUSH_SIZE` combined), only ONE
  `bulk-update` call is made in total (the final flush) — not one per
  page. If no such test file exists yet, note that in `PLAN_NOTES.md`
  rather than inventing test infrastructure not already present in the
  repo.

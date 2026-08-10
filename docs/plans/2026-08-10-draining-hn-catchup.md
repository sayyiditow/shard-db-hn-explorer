# Draining HN catch-up independently of cache refresh

## Goal

When the HN snapshot is behind by more than 10,000 item IDs, the refresh
worker should drain the backlog continuously in bounded 10,000-ID batches
until it reaches the `maxitem` captured at the beginning of that run. It
should not use a shorter catch-up interval or rewarm the application cache
after every batch. Cache-backed application data, including the `/stats`
panels, should continue to rewarm every 15 minutes.

New HN IDs arriving while a drain is in progress are left for the next
15-minute ingestion run. This fixed target prevents an unbounded drain if HN
continues producing IDs faster than the worker can process them.

## Design decision

The existing `tick()` module is doing two jobs behind one cadence: ingesting
HN IDs and rewarming the query cache. Deepen the refresh orchestration around
two small internal seams:

1. A single-batch ingest seam that accepts a fixed target max ID and an
   explicit cache-rewarm decision. It preserves the existing checkpoint
   invariant: state advances only after the batch's database writes succeed.
2. A refresh-run seam that captures HN `maxitem`, repeatedly invokes the
   single-batch ingest seam while the captured target is more than one batch
   away, and invokes it once when the remaining gap fits in one batch.

The production scheduler will run the ingest drain and cache rewarm on
separate 15-minute timers. The ingest drain has a single-flight guard so a
long drain cannot overlap the next scheduled run. Cache rewarm remains
independent and continues every 15 minutes even while ingestion is draining.
The existing hourly slow-stat warm remains unchanged.

No new catch-up environment variable is needed. `REFRESH_INTERVAL_MINUTES`
continues to configure the 15-minute schedule for both ordinary ingestion and
cache/stat refresh; the drain itself has no sleep between its bounded
batches.

## TDD seams

Tests will cross the exported refresh-run interface using injected HN and
shard-db adapters, matching the existing `TickDeps` seam. They will not test
private timers or inspect implementation-only helpers.

## Tasks

### 1. Add failing scheduler/ingest tests

In `src/lib/refresh-cache/refresh.test.ts`, after the existing test
`'large delta is capped to MAX_ITEMS_PER_TICK; state advances by cap, not maxItem'`,
add tests for the refresh-run interface:

- A gap larger than 10,000 fetches several batches back-to-back, calls HN's
  `getMaxItem()` once for the run, stops at that captured target, and writes
  the target ID to state.
- A gap of 10,000 or less performs exactly one batch.
- A later HN max-item value that appears while the drain is running is not
  fetched in that same run.
- Batch-level cache rewarming is disabled during a drain, while the normal
  single-tick interface retains its existing cold-start and successful-write
  rewarm behavior.

Use the existing injected adapters and record requested ID ranges as the
independent observable behavior. Run the focused test command and confirm
these tests fail before implementation.

### 2. Refactor one-batch ingestion behind the fixed-target seam

In `src/lib/refresh-cache/refresh.ts`, replace the implementation below the
quoted anchor `export async function tick(deps: TickDeps = {}): Promise<TickResult> {`
with a shared single-batch implementation that:

- accepts the captured target ID and a `rewarm` choice;
- fetches no more than `MAX_ITEMS_PER_TICK` IDs;
- persists only the final successfully processed ID for that batch;
- reports whether the captured target has been reached; and
- keeps the existing HN item partitioning, bulk-upsert, comment-root sync,
  error handling, and cache-rewarm behavior for the public one-tick path.

Keep `tick()` as the compatibility wrapper used by existing callers and
tests. Do not change the on-disk `.hn-refresh-state.json` format.

Run the focused refresh tests after this vertical slice.

### 3. Add the continuous drain run

At the quoted anchor `/* Configurable via REFRESH_INTERVAL_MINUTES so the
cadence can be tuned`, add the refresh-run orchestration that:

- reads HN `maxitem` once;
- reads the persisted checkpoint;
- runs one or more no-rewarm batches up to the captured max ID;
- performs no wait between batches;
- returns immediately after one batch when the initial gap is within the
  10,000-ID bound; and
- leaves newly arriving IDs for the next scheduled run.

Add a single-flight guard around this run at the quoted anchor
`export function start(): void {`. A failure must release the guard so the
next scheduled run can retry. A failed database write must not advance the
checkpoint past the failed batch.

Run the full refresh-cache test file.

### 4. Separate cache rewarming from ingestion scheduling

At the quoted anchor `const REFRESH_INTERVAL_MS = REFRESH_INTERVAL_MINUTES * 60 * 1000;`,
schedule cache rewarming independently at the configured 15-minute cadence.
Preserve the immediate cold-start cache warm, but ensure the ingest drain
does not trigger a rewarm after every 10,000-ID batch.

Update the refresh-module documentation and `src/lib/refresh-cache/index.ts`
comments at the quoted anchor `start()                  — boot the refresh loop`
to describe the two schedules accurately. Keep the layout's displayed
`REFRESH_INTERVAL_MINUTES` value unchanged.

Run `bun test` and `bun run check`.

## Edge cases and invariants

- A missing state file retains the existing first-run behavior: seed to the
  current max item and do not historical-backfill from ID 1.
- A batch containing deleted, unavailable, or unsupported HN items still
  advances its ID checkpoint, matching current behavior.
- A bulk-write or `maxitem` failure leaves the checkpoint at the last
  successful batch and allows a later run to retry.
- The captured target is inclusive; a new max item observed after the run
  starts is not part of that run.
- At most one ingest drain may run in a process at a time. Cache rewarming
  may occur concurrently with ingestion because it is the requested
  independent 15-minute activity.
- The existing descendant synchronization remains part of each successful
  ingest batch; only full cache rewarming is separated.

## Verification

- `bun test`
- `bun run check`
- Inspect the final diff for scheduler overlap, checkpoint ordering, and
  accidental cache rewarming inside the drain loop.
- Confirm logs show consecutive 10,000-ID batches during catch-up and cache
  rewarm messages only on the 15-minute cache schedule.

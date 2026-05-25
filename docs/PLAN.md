# Build plan

Source of truth for build state. The design memo (decisions,
rationale) lives in the shard-db repo at
`docs/superpowers/specs/2026-05-19-showcase-hn-explorer.md` —
that's gitignored / internal; this PLAN.md is the public version
of "what's done, what's next."

## Locked architecture

- **Database:** shard-db, localhost-only TCP (no public exposure)
- **Server:** SvelteKit on Bun
- **Wire:** JSON-over-TCP via a small Bun client in `src/lib/shard-db/`
- **Reverse proxy:** Caddy with automatic LE cert
- **Host:** Netcup VPS (single tenant)
- **Data:** Hugging Face HN snapshot → initial bulk; HN Firebase API → 5-min delta
- **Refresh job:** server-side cron / interval inside the SvelteKit
  process via `src/lib/refresh-cache/` (no external scheduler dependency)

## Phases

### Phase 1 — Local dev scaffolding ✅
- [x] Repo created (`sayyiditow/shard-db-hn-explorer`, public)
- [x] README + PLAN.md
- [x] SvelteKit + Bun scaffold
- [x] Bun-side shard-db client (`src/lib/shard-db/client.ts`)
- [x] Schema setup script (`scripts/setup-schema.ts`)
- [x] Sample-data loader (`scripts/sample-load.ts`)
- [x] `bun run app` one-command dev (daemon + vite)

### Phase 2 — Routes + UI ✅
- [x] `/` landing — search bar + trending widget + perf badge
- [x] `/search` results page (trigram-backed substring search)
- [x] `/u/[username]` profile (stories + comments paginated)
- [x] `/item/[id]` thread view with cursor pagination
- [x] `/trending` live dashboard (5-min refresh in lockstep with ingest)
- [x] `/jobs` Ask/Show/Job feed split
- [x] `/stats` internal — daemon stats, cache hit-rate, ingest lag

### Phase 3 — Bulk-load story ✅
- [x] Hugging Face dataset (anantn/hacker-news) confirmed + licensing OK
- [x] `scripts/bulk-load.ts` — stream-parse via hyparquet + chunked bulk-insert
- [x] **Load-then-index pattern** — drop indexes before bulk-insert,
      re-add via single multi-field call after. Avoids O(R²) merge
      cost at full-HN scale. See `docs/operations/bulk-loading.md`
      in shard-db.
- [x] Local rehearsal on the 1M sample
- [ ] Full bulk-load on Netcup (gated on Phase 5 provisioning)

### Phase 4 — Delta refresh ✅
- [x] `src/lib/refresh-cache/` — in-process refresh (Bun timer; no
      external cron dependency)
- [x] State-file persistence for `last_seen_id`
- [x] Projection cache for /trending and per-route hot reads
- [x] Test coverage (`bun test` green)

### Phase 5 — Deployment (in progress)
- [ ] Provision Netcup VPS — SSH access confirmed working via
      key auth as root; see shard-db memory `netcup-server-access`
- [ ] systemd units for shard-db daemon + hn-explorer node process
- [ ] Caddy config + LE cert
- [ ] Domain decision — pending; can launch under a placeholder
      hostname if needed
- [ ] Deploy workflow on push to main (GitHub Actions → ssh
      pull-and-restart, or rsync-based)
- [ ] Initial bulk-load on the VPS (BULK_TARGET=0)
- [ ] Smoke-test all 7 routes against production data

### Phase 6 — Pre-launch polish
- [ ] Capture bench numbers from THIS VPS (not lab) for the post —
      crucially `bench-cache-pollution` at full-HN scale to see if
      eviction bites (the 25M-scale run was within noise; full-HN
      working set > RAM is the real test)
- [ ] Screenshot + interactive GIF
- [ ] "How it works" page linking to shard-db perf docs
- [ ] Backup plan for traffic spike — Caddy + the daemon's
      `MAX_CONCURRENT_QUERIES` cap should be enough; document the
      degradation envelope so a HN front-page doesn't blow it up

### Phase 7 — Launch
- [ ] Post "Show HN" with title pattern: "Show HN: Search 41M HN
      items in <Xms> on a single VPS (open-source DB)"

## Current next step

Phase 5 deployment: provision Netcup, install shard-db `2026.05.8`
binary, set up systemd + Caddy, run the initial bulk-load.

## Out of scope

See the internal design memo for the full list. The big ones:

- Binary protocol — JSON stays. Binary is for the future bank-niche
  showcase (separate repo).
- Distributed shard-db — single VPS for this demo.
- Auth / multi-tenant — public read-only.

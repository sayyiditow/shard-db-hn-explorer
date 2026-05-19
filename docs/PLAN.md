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
- **Host:** Hetzner CX22 (2 vCPU, 4 GB RAM, 40 GB NVMe)
- **Data:** Hugging Face HN snapshot → initial bulk; HN Firebase API → 5-min delta
- **Refresh job:** GitHub Actions cron, SSH into VPS

## Phases

### Phase 1 — Local dev scaffolding (in progress)
- [x] Repo created (`sayyiditow/shard-db-hn-explorer`, public)
- [x] README + PLAN.md
- [ ] `bun create svelte-app` scaffold
- [ ] Bun-side shard-db client (`src/lib/shard-db/client.ts`)
- [ ] Schema setup script (`scripts/setup-schema.ts`)
- [ ] Sample-data loader (`scripts/sample-load.ts`) — small subset for fast dev iter

### Phase 2 — Routes + UI
- [ ] `/` landing — search bar + trending widget + perf-badge
- [ ] `/search` results page
- [ ] `/u/[username]` profile
- [ ] `/item/[id]` thread view with cursor pagination
- [ ] `/trending` live dashboard
- [ ] `/stats` internal page

### Phase 3 — Bulk-load story
- [ ] Identify the HF dataset slug and licensing
- [ ] `scripts/bulk-load.ts` — stream-parse + chunked `bulk-insert`
- [ ] Local rehearsal on a subset
- [ ] Full bulk on Hetzner

### Phase 4 — Delta refresh
- [ ] `scripts/delta-refresh.ts` — Bun script, batched fetches
- [ ] GitHub Actions workflow with cron + SSH secret
- [ ] State-file persistence for `last_seen_id`
- [ ] Verify lag stays under 6 min

### Phase 5 — Deployment
- [ ] Provision Hetzner VPS
- [ ] systemd units for shard-db + hn-explorer
- [ ] Caddy config + LE cert
- [ ] Domain decision (pre-launch) — register if going custom
- [ ] Deploy workflow on push to main

### Phase 6 — Pre-launch polish
- [ ] Capture bench numbers from THIS VPS (not lab) for the post
- [ ] Screenshot + interactive GIF
- [ ] "How it works" page linking to shard-db perf docs
- [ ] Backup plan for traffic spike

### Phase 7 — Launch
- [ ] Post "Show HN" with title pattern: "Show HN: Search 41M HN items in 4ms on a $5 VPS (open-source DB I wrote)"

## Current next step

Phase 1: `bun create` the SvelteKit scaffold and wire up the
shard-db client.

## Out of scope

See the internal design memo for the full list. The big ones:

- Binary protocol — JSON stays. Binary is for the future bank-niche
  showcase (separate repo).
- Distributed shard-db — single VPS for this demo.
- Auth / multi-tenant — public read-only.

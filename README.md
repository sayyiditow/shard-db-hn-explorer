# shard-db HN Explorer

Hacker News explorer powered by [shard-db](https://github.com/sayyiditow/shard-db) —
search, trending, threads, profiles, and live stats over the full HN
corpus (stories + comments + users, ~41M items at full scale), all
backed by a single shard-db daemon on one Netcup VPS.

> **Status:** deployment-ready. All routes built, full-HN bulk-load
> path validated end-to-end, schema + refresh loop running on local
> dev DB. Launch pending Netcup provisioning + initial bulk-load run.
> See [`docs/PLAN.md`](docs/PLAN.md) for the launch punch-list.

## Stack

| Layer | Choice |
|---|---|
| Database | shard-db (JSON over TCP, localhost-only on the VPS) |
| Server | SvelteKit on Bun, `adapter-node` build |
| Reverse proxy | Caddy (automatic Let's Encrypt) |
| Host | Netcup VPS (single tenant) |
| Initial data | Hugging Face HN snapshot (anantn/hacker-news) |
| Live data | HN Firebase API, 5-min refresh into the local DB |

## Routes

- `/` — landing: search bar, trending widget, perf badge under every result count
- `/search` — full-text search across story titles (trigram-backed)
- `/u/[username]` — user profile + their stories & comments paginated
- `/item/[id]` — story or comment thread with cursor pagination
- `/trending` — live top-N dashboard (refreshed in lockstep with the 5-min ingest)
- `/jobs` — Ask HN / Show HN / Jobs feed split
- `/stats` — internal — daemon stats, cache hit-rate, ingest lag

## Local dev

```bash
# One-time setup
git clone git@github.com:sayyiditow/shard-db.git ../shard-db
(cd ../shard-db && ./build.sh)
bun install

# Run the app (one command, one terminal)
bun run app
```

Open <http://localhost:5173>. `Ctrl-C` stops both the SvelteKit dev
server and the local shard-db daemon.

`bun run app` is `./scripts/dev.sh` — it starts a local shard-db on
port 19199 with **relative paths only**, waits for it to bind, seeds
the schema + a 10k-item sample on first run (skipped on subsequent
runs unless you `rm -rf db/`), then runs the SvelteKit dev server in
the foreground.

To wipe the local DB and re-seed from scratch:

```bash
rm -rf db/ && bun run app
```

## Bulk-load (initial seed, full HN snapshot)

```bash
# 1M-item sample (default — quick smoke-test)
bun run bulk-load

# Full snapshot (hundreds of millions of items, will take hours)
BULK_TARGET=0 bun run bulk-load
```

`scripts/bulk-load.ts` uses the **load-then-index** pattern: truncate
→ drop indexes → bulk-insert (flat per-chunk rate, no degradation) →
add all indexes via a single multi-field call (one storage scan per
object). At full-HN scale this is significantly faster than inserting
into pre-existing indexes, where per-(field, shard) merge cost scales
`O(R²)` in chunk count. See
[`docs/operations/bulk-loading.md`](https://github.com/sayyiditow/shard-db/blob/main/docs/operations/bulk-loading.md)
in the shard-db repo for the crossover rule.

## Repo layout

```
.
├── src/
│   ├── routes/                # SvelteKit routes (see Routes above)
│   ├── lib/
│   │   ├── shard-db/          # Bun TCP client for shard-db's JSON wire
│   │   ├── refresh-cache/     # 5-min HN Firebase ingest + projection cache
│   │   ├── hn/                # HN-specific helpers (item-type rendering, parent-walk)
│   │   ├── components/        # shared Svelte components
│   │   ├── styles/            # CSS modules
│   │   └── assets/            # static images bundled via Vite
│   └── app.html
├── scripts/
│   ├── lib/
│   │   └── hn-schema.ts       # INDEX_LISTS — single source of truth for
│   │                          #   create-object indexes and bulk-load's
│   │                          #   drop / re-add cycle
│   ├── setup-schema.ts        # create-object × 3 (stories, comments, users)
│   ├── bulk-load.ts           # Hugging Face → shard-db bulk-insert
│   │                          #   (load-then-index pattern)
│   ├── sample-load.ts         # 10k-item subset for dev iteration
│   ├── dev.sh                 # bun run app — daemon + vite in one
│   └── dev-up.sh              # daemon only (background)
├── docs/
│   └── PLAN.md                # launch punch-list
├── static/
├── svelte.config.js           # adapter-node
├── vite.config.ts
├── tsconfig.json              # includes @types/bun for bun:test typings
└── package.json
```

## Why this exists

shard-db needs a public showcase that demonstrates the perf claim in
a way HN readers can grok in 30 seconds: search their own data, see
the timing badge under every result count, click around. Initial
launch goes up as "Show HN" once the bulk-load is stable on Netcup.

The full design memo is in shard-db's internal docs (not in this
repo). For implementation status, see
[`docs/PLAN.md`](docs/PLAN.md).

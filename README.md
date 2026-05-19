# shard-db HN Explorer

Hacker News explorer showcasing [shard-db](https://github.com/sayyiditow/shard-db) on
~41M HN items (stories + comments + users) — sub-10ms search,
trending dashboards, full thread browsing, user profiles, all from
a single small VPS.

> **Status:** scaffolding. Not yet deployed. See [`docs/PLAN.md`](docs/PLAN.md)
> for the current state of the build.

## Stack

| Layer | Choice |
|---|---|
| Database | shard-db (JSON over TCP, localhost-only) |
| Server | SvelteKit on Bun |
| Reverse proxy | Caddy (automatic LE) |
| Host | Hetzner VPS (CX22 target) |
| Data | Hugging Face HN snapshot + HN Firebase API delta (5-min refresh) |

## Local dev

```bash
# 1. Get shard-db running locally
git clone git@github.com:sayyiditow/shard-db.git ../shard-db
cd ../shard-db && ./build.sh && ./shard-db start
cd -

# 2. Install deps + seed schema
bun install
bun run scripts/setup-schema.ts

# 3. Bulk-load a sample (10K items, fast — full bulk is a separate flow)
bun run scripts/sample-load.ts

# 4. Start the dev server
bun run dev
```

Open <http://localhost:5173>.

## Repo layout

```
.
├── src/
│   ├── routes/         # SvelteKit routes (/, /u/[user], /item/[id], /trending, /search)
│   ├── lib/
│   │   └── shard-db/   # Bun TCP client for shard-db's JSON wire
│   └── components/
├── scripts/
│   ├── setup-schema.ts # create-object × 3
│   ├── bulk-load.ts    # Hugging Face → shard-db bulk-insert
│   ├── sample-load.ts  # tiny subset for local dev
│   └── delta-refresh.ts# HN Firebase API → shard-db (every 5 min)
├── docs/
│   └── PLAN.md         # current build status, decisions, next steps
└── .github/
    └── workflows/
        ├── delta-refresh.yml  # cron every 5 min, SSH into VPS
        └── deploy.yml         # build + ship on push to main
```

## Why this exists

shard-db needs a public showcase that demonstrates the perf claim
in a way HN readers can grok in 30 seconds: search their own data,
see the timing badge under the search bar, click around. The post
goes up as "Show HN" once it's stable.

Design memo lives in shard-db's internal docs (not in this repo).
For implementation status, see [`docs/PLAN.md`](docs/PLAN.md).

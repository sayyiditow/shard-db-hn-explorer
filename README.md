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
| Server | SvelteKit on Bun, `adapter-node` build |
| Reverse proxy | Caddy (automatic LE) |
| Host | Hetzner VPS (CX22 target) |
| Data | Hugging Face HN snapshot (initial bulk) + HN Firebase API (5-min delta) |

## Local dev

```bash
# 1. Clone + build shard-db as a sibling directory
git clone git@github.com:sayyiditow/shard-db.git ../shard-db
(cd ../shard-db && ./build.sh)

# 2. Install showcase deps
bun install

# 3. Spin up a clean local shard-db daemon (port 19199, relative paths only)
./scripts/dev-up.sh                      # leaves it running in the foreground
# OR launch in background:
# ./scripts/dev-up.sh &

# 4. In a second terminal: seed the schema + sample data
SHARD_DB_PORT=19199 bun run scripts/setup-schema.ts
SHARD_DB_PORT=19199 bun run scripts/sample-load.ts

# 5. Start the SvelteKit dev server
SHARD_DB_PORT=19199 bun run dev
```

Open <http://localhost:5173>.

`./scripts/dev-up.sh` writes a fresh `db/dev/db.env` with only
relative paths (`DB_ROOT="data"`, `LOG_DIR="logs"`) and runs
shard-db with `cwd=db/dev`. The whole `db/` tree is gitignored, so
your local daemon state never leaks into the repo.

## Repo layout

```
.
├── src/
│   ├── routes/         # SvelteKit routes (/, /u/[user], /item/[id], /trending, /search)
│   ├── lib/
│   │   └── shard-db/   # Bun TCP client for shard-db's JSON wire
│   └── app.html
├── scripts/
│   ├── setup-schema.ts # create-object × 3
│   ├── bulk-load.ts    # Hugging Face → shard-db bulk-insert (initial load)
│   ├── sample-load.ts  # tiny subset for local dev
│   └── delta-refresh.ts# HN Firebase API → shard-db (every 5 min)
├── docs/
│   └── PLAN.md         # current build status + checkboxes
├── static/
├── svelte.config.js    # adapter-node
├── vite.config.ts
├── tsconfig.json
└── package.json
```

## Why this exists

shard-db needs a public showcase that demonstrates the perf claim
in a way HN readers can grok in 30 seconds: search their own data,
see the timing badge under the search bar, click around. The post
goes up as "Show HN" once it's stable.

Design memo lives in shard-db's internal docs (not in this repo).
For implementation status, see [`docs/PLAN.md`](docs/PLAN.md).

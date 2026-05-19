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
# One-time setup
git clone git@github.com:sayyiditow/shard-db.git ../shard-db
(cd ../shard-db && ./build.sh)
bun install

# Run the app (one command, one terminal)
bun run app
```

Open <http://localhost:5173>. `Ctrl-C` stops both the SvelteKit
dev server and the local shard-db daemon.

`bun run app` is `./scripts/dev.sh` — it starts a local shard-db
on port 19199 with **relative paths only**, waits for it to bind,
seeds the schema + a 10k-item sample on first run (skipped on
subsequent runs unless you `rm -rf db/`), then runs the SvelteKit
dev server in the foreground.

To wipe the local DB and re-seed:

```bash
rm -rf db/ && bun run app
```

To run individual steps separately (useful for tweaking schema or
bulk-load logic), see `scripts/dev-up.sh`, `scripts/setup-schema.ts`,
`scripts/sample-load.ts`.

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

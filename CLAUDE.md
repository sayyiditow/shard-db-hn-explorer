# shard-db-hn-explorer

@docs/CORE-PROCESS.md

## Hard override for this repo — Git Safety does NOT apply here

This is a showcase app: single maintainer, no collaborators, disposable/demo
content, no production blast radius. By deliberate, explicit decision this
repo does **not** follow `docs/CORE-PROCESS.md`'s Git Safety section:

- No feature branches. Plans are executed **directly on `main`** and
  committed there.
- No PRs. Do not tell the executing model to branch off `main` or open a
  PR — that's unnecessary process overhead for a single-maintainer
  showcase repo.
- Everything else in `docs/CORE-PROCESS.md` (plan → approve → execute →
  review, Definition of Done, "never weaken a test," review checklist)
  still applies as written.

## Workflow

- Plans go to `docs/plans/YYYY-MM-DD-<feature>.md`.
- Plans are executed by DeepSeek outside of Claude — after writing a plan,
  just confirm it's saved. Do NOT offer execution options
  (subagent-driven / inline).
- **Co-author line(s):** commits get two lines — `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` for whichever Claude model planned/reviewed, plus `Co-Authored-By: DeepSeek <noreply@deepseek.com>` for the execution pass.
- Build/deploy: `bun run build`, then copy `build/` to the server and
  restart the app (see the deployment convention in the sibling `shard-db`
  repo's `CLAUDE.md` if this app depends on a shard-db instance).

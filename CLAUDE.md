# shard-db-hn-explorer

## Workflow

- Plans go to `docs/plans/YYYY-MM-DD-<feature>.md`
- Plans are executed by DeepSeek outside of Claude — after writing a plan, just confirm it's saved. Do NOT offer execution options (subagent-driven / inline).
- This is a showcase app: no feature branches, no PRs. Plans are executed directly on `main` and committed there. Do not tell the executing model to branch off main or open a PR — that's unnecessary noise for this repo.

#!/usr/bin/env bash
# dev.sh — single-terminal local dev (embedded mode, no daemon).
#
# SHARD_DB_ROOT is auto-set to $(pwd)/db/dev/data if not provided.
#
# Run: bun run app

set -euo pipefail

cd "$(dirname "$0")/.."

DB_ROOT_ABS="${SHARD_DB_ROOT:-$(pwd)/db/dev/data}"
SAMPLE_SIZE="${SAMPLE_SIZE:-10000}"

mkdir -p "$DB_ROOT_ABS"

if [ ! -d "$DB_ROOT_ABS/hn" ]; then
    echo "→ First run: seeding schema..."
    SHARD_DB_ROOT="$DB_ROOT_ABS" bun run scripts/setup-schema.ts

    echo "→ First run: loading $SAMPLE_SIZE sample items..."
    SHARD_DB_ROOT="$DB_ROOT_ABS" SAMPLE_SIZE=$SAMPLE_SIZE bun run scripts/sample-load.ts
else
    echo "✓ schema already seeded. To force re-seed: rm -rf db/dev/data"
fi

echo ""
echo "→ Starting SvelteKit dev server (embedded mode)"
echo "  Open http://localhost:5173"
echo "  Ctrl-C to stop"
echo ""
exec env SHARD_DB_ROOT="$DB_ROOT_ABS" bun run dev

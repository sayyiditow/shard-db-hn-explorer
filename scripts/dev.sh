#!/usr/bin/env bash
# dev.sh — single-terminal local dev orchestration.
#
# TCP mode (default, SHARD_DB_MODE unset):
#   Spins up shard-db daemon on a dev port, seeds schema + sample data on
#   first run, then starts the SvelteKit dev server. Ctrl-C stops both.
#
# Embedded mode (SHARD_DB_MODE=embedded):
#   No daemon. Opens the data directory in-process via the shard-db npm
#   native addon. First-run seeding also uses embedded mode.
#   SHARD_DB_ROOT is auto-set to $(pwd)/db/dev/data if not provided.
#
# Run: bun run app  (alias for ./scripts/dev.sh)

set -euo pipefail

cd "$(dirname "$0")/.."

PORT="${SHARD_DB_PORT:-19199}"
SAMPLE_SIZE="${SAMPLE_SIZE:-10000}"

# ── Embedded mode ─────────────────────────────────────────────────────────────
if [ "${SHARD_DB_MODE:-}" = "embedded" ]; then
    DB_ROOT_ABS="${SHARD_DB_ROOT:-$(pwd)/db/dev/data}"
    mkdir -p "$DB_ROOT_ABS"

    if [ ! -d "$DB_ROOT_ABS/hn" ]; then
        echo "→ First run (embedded): seeding schema..."
        SHARD_DB_MODE=embedded SHARD_DB_ROOT="$DB_ROOT_ABS" \
            bun run scripts/setup-schema.ts

        echo "→ First run (embedded): loading $SAMPLE_SIZE sample items..."
        SHARD_DB_MODE=embedded SHARD_DB_ROOT="$DB_ROOT_ABS" \
            SAMPLE_SIZE=$SAMPLE_SIZE bun run scripts/sample-load.ts
    else
        echo "✓ schema already seeded. To force re-seed: rm -rf db/dev/data"
    fi

    echo ""
    echo "→ Starting SvelteKit dev server (embedded mode — no daemon needed)"
    echo "  Open http://localhost:5173"
    echo "  Ctrl-C to stop"
    echo ""
    exec env SHARD_DB_MODE=embedded SHARD_DB_ROOT="$DB_ROOT_ABS" bun run dev
fi

# ── TCP / daemon mode (default) ───────────────────────────────────────────────
SHARD_DB_BIN="${SHARD_DB_BIN:-../shard-db/build/bin/shard-db}"

if [ ! -x "$SHARD_DB_BIN" ]; then
    echo "shard-db binary not found at $SHARD_DB_BIN" >&2
    echo "Build it first: (cd ../shard-db && ./build.sh)" >&2
    exit 1
fi

SHARD_PID=""
DEV_PID=""

cleanup() {
    local code=$?
    if [ -n "$SHARD_PID" ] && kill -0 "$SHARD_PID" 2>/dev/null; then
        echo ""
        echo "Stopping shard-db (pid=$SHARD_PID)..."
        kill "$SHARD_PID" 2>/dev/null || true
        wait "$SHARD_PID" 2>/dev/null || true
    fi
    if [ -n "$DEV_PID" ] && kill -0 "$DEV_PID" 2>/dev/null; then
        kill "$DEV_PID" 2>/dev/null || true
        wait "$DEV_PID" 2>/dev/null || true
    fi
    exit $code
}
trap cleanup EXIT INT TERM

echo "→ Starting shard-db on port $PORT..."
PORT=$PORT ./scripts/dev-up.sh > /tmp/shard-db-dev.log 2>&1 &
SHARD_PID=$!

for i in {1..50}; do
    if (echo > /dev/tcp/127.0.0.1/$PORT) 2>/dev/null; then
        echo "✓ shard-db ready (pid=$SHARD_PID, port=$PORT)"
        break
    fi
    if ! kill -0 "$SHARD_PID" 2>/dev/null; then
        echo "✗ shard-db died during startup. Last log lines:" >&2
        tail -20 /tmp/shard-db-dev.log >&2 || true
        exit 1
    fi
    sleep 0.2
    if [ "$i" = "50" ]; then
        echo "✗ shard-db didn't bind to port $PORT within 10s" >&2
        tail -20 /tmp/shard-db-dev.log >&2 || true
        exit 1
    fi
done

if [ ! -s "db/dev/data/schema.conf" ] || ! grep -q "^hn:" "db/dev/data/schema.conf" 2>/dev/null; then
    echo "→ First run: seeding schema + $SAMPLE_SIZE sample items"
    SHARD_DB_PORT=$PORT bun run scripts/setup-schema.ts
    SHARD_DB_PORT=$PORT SAMPLE_SIZE=$SAMPLE_SIZE bun run scripts/sample-load.ts
else
    echo "✓ schema already seeded (skip re-seed). To force, rm -rf db/"
fi

echo ""
echo "→ Starting SvelteKit dev server"
echo "  Open http://localhost:5173"
echo "  Ctrl-C to stop both shard-db and the dev server"
echo ""

SHARD_DB_PORT=$PORT exec bun run dev

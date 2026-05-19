#!/usr/bin/env bash
# dev.sh — single-terminal local dev orchestration.
#
# Spins up shard-db in the background, seeds schema + sample data
# on first run, then runs the SvelteKit dev server in the
# foreground. Ctrl-C cleanly stops both.
#
# Run: bun run app  (alias for ./scripts/dev.sh)

set -euo pipefail

cd "$(dirname "$0")/.."

PORT="${SHARD_DB_PORT:-19199}"
SAMPLE_SIZE="${SAMPLE_SIZE:-10000}"
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

# 1. Start shard-db in the background. dev-up.sh handles relative
#    paths + db.env generation; we just background it and capture
#    its PID for cleanup.
echo "→ Starting shard-db on port $PORT..."
PORT=$PORT ./scripts/dev-up.sh > /tmp/shard-db-dev.log 2>&1 &
SHARD_PID=$!

# 2. Wait for the daemon to be ready (TCP-accept check). Timeout
#    after 10s with a useful error message + log dump.
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

# 3. First-run seeding: only if the schema isn't there yet.
#    `db/dev/data/schema.conf` is the canonical first-run marker.
if [ ! -s "db/dev/data/schema.conf" ] || ! grep -q "^hn:" "db/dev/data/schema.conf" 2>/dev/null; then
    echo "→ First run: seeding schema + $SAMPLE_SIZE sample items"
    SHARD_DB_PORT=$PORT bun run scripts/setup-schema.ts
    SHARD_DB_PORT=$PORT SAMPLE_SIZE=$SAMPLE_SIZE bun run scripts/sample-load.ts
else
    echo "✓ schema already seeded (skip re-seed). To force, rm -rf db/"
fi

# 4. Run the dev server in the foreground. Ctrl-C here triggers the
#    EXIT trap which stops the daemon too.
echo ""
echo "→ Starting SvelteKit dev server"
echo "  Open http://localhost:5173"
echo "  Ctrl-C to stop both shard-db and the dev server"
echo ""

SHARD_DB_PORT=$PORT exec bun run dev

#!/usr/bin/env bash
# dev-up.sh — spin up a clean local shard-db for this showcase.
#
# Uses RELATIVE paths throughout so the same db.env works on any
# machine. Run from the repo root.
#
# Assumes ../shard-db has been cloned + built. Adjust SHARD_DB_BIN
# if your build lives elsewhere.

set -euo pipefail

cd "$(dirname "$0")/.."   # always operate from repo root

SHARD_DB_BIN="${SHARD_DB_BIN:-../shard-db/build/bin/shard-db}"
DB_ROOT_REL="db/dev"      # all paths in db.env stay relative
PORT="${PORT:-19199}"

if [ ! -x "$SHARD_DB_BIN" ]; then
    echo "shard-db binary not found at $SHARD_DB_BIN" >&2
    echo "Build it: (cd ../shard-db && ./build.sh)" >&2
    exit 1
fi

mkdir -p "$DB_ROOT_REL/data" "$DB_ROOT_REL/logs"

# db.env stays committed-NOT (see .gitignore) and uses only relative
# paths. The daemon reads it from CWD, so we cd into $DB_ROOT_REL/..
# before exec'ing it.
cat > "$DB_ROOT_REL/db.env" <<EOF
export DB_ROOT="data"
export PORT=$PORT
export TIMEOUT=0
export LOG_DIR="logs"
export LOG_LEVEL=2
export THREADS=0
export FCACHE_MAX=4096
export TLS_ENABLE=0
EOF

echo "Starting shard-db (port $PORT, root $DB_ROOT_REL/data, relative paths)..."
echo "Stop it with: pkill -f 'shard-db server' OR Ctrl-C if foregrounded."
echo ""

cd "$DB_ROOT_REL"
exec "$(realpath ../../$SHARD_DB_BIN)" server

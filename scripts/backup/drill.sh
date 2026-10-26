#!/usr/bin/env bash
# Restore drill (docs/DEPLOY.md, "Backups"): proves a backup brings the site
# back. Restores it into a fresh PGlite folder, starts a real server on that
# folder, and checks the restored server gives the same answers as the site the
# backup came from:
#
#   scripts/backup/drill.sh <backup.jsonl.gz> <expected.json> [port]
#
# expected.json is what the source site said just before the backup (see
# scripts/backup/expect.sh): its all-time leaderboard (null to skip it), and
# its newest public record entry. The restored server's log stays in the work folder, never in
# the output: it is the players' data.
set -euo pipefail

backup=$1
expected=$2
port=${3:-3099}
root=$(cd "$(dirname "$0")/../.." && pwd)
work=$(mktemp -d)
server=
cleanup() {
  if [ -n "$server" ]; then kill "$server" 2>/dev/null || true; wait "$server" 2>/dev/null || true; fi
  rm -rf "$work"
}
trap cleanup EXIT

echo "Restoring into a fresh database"
(cd "$root" && npx tsx apps/server/src/restore.ts "$backup" "$work/pglite") > "$work/summary.json"
jq -r '"Restored \([.rows[]] | add) rows in \(.rows | length) tables, from a backup taken \(.at)"' "$work/summary.json"

echo "Starting a server on the restored data"
(cd "$root/apps/server" && PGLITE_DIR="$work/pglite" PORT=$port NODE_ENV=production exec node --import tsx src/index.ts) > "$work/server.log" 2>&1 &
server=$!
for i in $(seq 1 60); do
  curl -sf "localhost:$port/api/health" > /dev/null && break
  kill -0 "$server" 2>/dev/null || { echo "The restored server stopped while starting"; exit 1; }
  sleep 1
done
curl -sf "localhost:$port/api/health" > /dev/null || { echo "The restored server didn't answer"; exit 1; }

fail=0
# Same leaderboard: every player's hands and results came back.
if [ "$(jq '.leaderboard == null' "$expected")" = true ]; then
  echo "Leaderboard: not compared (the site changed during the backup)"
elif [ "$(jq -S .leaderboard "$expected")" = "$(curl -sf "localhost:$port/api/leaderboard?period=all" | jq -S .rows)" ]; then
  echo "Leaderboard: same as the site ($(jq '.leaderboard | length' "$expected") players)"
else
  echo "Leaderboard: different from the site"; fail=1
fi
# Same public record: the newest entry the site had saved is there, with the same hash (so every one before it is too).
seq=$(jq -r '.record.seq // 0' "$expected")
if [ "$seq" = 0 ]; then
  echo "Public record: the site had none yet"
elif [ "$(jq -c .record "$expected")" = "$(curl -sf "localhost:$port/api/audit/entries?after=$((seq - 1))&limit=1" | jq -c '.entries[0] | {seq, hash}')" ]; then
  echo "Public record: entry $seq and its hash match the site"
else
  echo "Public record: entry $seq is missing or different"; fail=1
fi
exit $fail

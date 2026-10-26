#!/usr/bin/env bash
# What a restore should give back (scripts/backup/drill.sh): the site's all-time
# leaderboard and its newest saved public record entry, read just before a backup.
#   scripts/backup/expect.sh <site> > expected.json
set -euo pipefail
site=$1
board=$(curl -sf --retry 3 --retry-delay 5 "$site/api/leaderboard?period=all" | jq .rows)
seq=$(curl -sf --retry 3 --retry-delay 5 "$site/api/audit/head" | jq '.seq // 0')
# The newest saved entry (the head can be a moment ahead of what is saved).
record=$(curl -sf --retry 3 --retry-delay 5 "$site/api/audit/entries?after=$((seq > 50 ? seq - 50 : 0))" | jq -c '.entries | last | if . then {seq, hash} else null end')
jq -n --argjson leaderboard "$board" --argjson record "$record" '{leaderboard: $leaderboard, record: $record}'

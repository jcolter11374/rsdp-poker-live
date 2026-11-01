#!/usr/bin/env node
// Upgrade rehearsal (.github/workflows/upgrade.yml): does a server started on
// existing data still give the answers the server before it gave? Compares
// two outputs of scripts/backup/expect.sh, read before and after the switch:
//   node scripts/upgrade/compare.mjs before.json after.json
//
// Must be exactly the same:
// - The all-time leaderboard: the same players, each with every field the
//   server before gave (profit, games, hands, biggest pot, each game's
//   result). A newer server may add fields to a row: only the old ones count.
// - The public record can't go back: its newest entry is the same or later.
//   mirror.mjs, run next, checks every entry before it is unchanged.
// May differ:
// - Which entry is newest: every start adds a "boot" entry naming the build,
//   and a tournament left running keeps dealing.
// - Anything expect.sh doesn't read, such as the build commit (/api/version).
// A release that changes the leaderboard on purpose fails here: check the
// differences printed are the intended ones, and say so in the release pull request.

import { readFileSync } from 'node:fs';
import { canonical } from '../transparency/chain.mjs';

const [beforeFile, afterFile] = process.argv.slice(2);
if (!beforeFile || !afterFile) {
  console.error('usage: node scripts/upgrade/compare.mjs <before.json> <after.json>');
  process.exit(2);
}
const before = JSON.parse(readFileSync(beforeFile, 'utf8'));
const after = JSON.parse(readFileSync(afterFile, 'utf8'));
let ok = true;

const changes = [];
const old = new Map(before.leaderboard.map((r) => [r.key, r]));
const now = new Map(after.leaderboard.map((r) => [r.key, r]));
const fields = [...new Set(before.leaderboard.flatMap((r) => Object.keys(r)))];
for (const [key, was] of old) {
  const is = now.get(key);
  if (!is) {
    changes.push(`${was.name} (${key}) is no longer on it`);
    continue;
  }
  for (const f of fields) {
    if (canonical(was[f]) !== canonical(is[f])) changes.push(`${was.name}: ${f} was ${JSON.stringify(was[f])}, now ${JSON.stringify(is[f])}`);
  }
}
for (const [key, is] of now) if (!old.has(key)) changes.push(`${is.name} (${key}) is new on it`);
if (changes.length) {
  ok = false;
  console.log('✗ Leaderboard: different from before');
  for (const c of changes) console.log(`  ${c}`);
} else console.log(`✓ Leaderboard: the same for all ${old.size} players (${fields.join(', ')})`);

const was = before.record?.seq ?? 0;
const is = after.record?.seq ?? 0;
if (is < was) {
  ok = false;
  console.log(`✗ Public record: ends at entry ${is}, but went up to ${was} before`);
} else console.log(`✓ Public record: up to entry ${was} before, ${is} now`);

process.exit(ok ? 0 : 1);

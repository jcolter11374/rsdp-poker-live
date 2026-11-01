#!/usr/bin/env node
// Upgrade rehearsal (.github/workflows/upgrade.yml): does a server started on
// existing data still give the answers the server before it gave? Compares
// what was read before and after the switch, each one file joining the output
// of scripts/backup/expect.sh (leaderboard, public record) and of
// scripts/upgrade/saved.mjs (saved tables and tournaments):
//   node scripts/upgrade/compare.mjs before.json after.json
//
// Must be exactly the same:
// - The all-time leaderboard: the same players, each with every field the
//   server before gave (profit, games, hands, biggest pot, each game's
//   result). A newer server may add fields to a row: only the old ones count.
// - Every saved table the server before could read: the new server must still
//   read it, with every field the server before gave (name, mode, hands,
//   players). A server that can't read a saved snapshot (for example after a
//   RUNTIME_VERSION change) drops that table at deploy, while the leaderboard
//   still adds up the same.
// - Every saved tournament: its page must still show its own name (it shows
//   the site's own title when the server can't read the saved tournament,
//   for example after a STATE_VERSION change), and one that had finished or
//   been cancelled the same result and player count.
// - The public record can't go back: its newest entry is the same or later.
//   mirror.mjs, run next, checks every entry before it is unchanged.
// May differ:
// - Which entry is newest: every start adds a "boot" entry naming the build,
//   the backup saved.mjs downloads adds one, and a tournament left running
//   keeps dealing.
// - Whether a table is loaded ("live"): a restart leaves a cash table saved
//   until someone opens it.
// - At the tables of a tournament still under way: more hands and more
//   players (it keeps dealing, and can move players between tables); and that
//   tournament's page, which shows how far it has got.
// - Anything neither script reads, such as the build commit (/api/version).
// A release that changes any of these on purpose fails here: check the
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

function report(what, changes, same) {
  if (!changes.length) return console.log(`✓ ${what}: ${same}`);
  ok = false;
  console.log(`✗ ${what}: different from before`);
  for (const c of changes) console.log(`  ${c}`);
}

{
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
  report('Leaderboard', changes, `the same for all ${old.size} players (${fields.join(', ')})`);
}

// A tournament's tables are named after it: <tournament id>-t1, -t2...
const ENDED = new Set(['finished', 'cancelled']);
const status = new Map((before.tournaments ?? []).map((t) => [t.id, t.status]));
const underWay = (tableId) => {
  const tn = /^([0-9a-f]{16})-t\d+$/.exec(tableId)?.[1];
  return !!tn && status.has(tn) && !ENDED.has(status.get(tn));
};
// Players are listed in whatever order the saved snapshot keeps them, which a reload can change.
const names = (list) => (Array.isArray(list) ? [...list].sort() : list);

if (before.tables) {
  const changes = [];
  const now = new Map((after.tables ?? []).map((t) => [t.id, t]));
  const read = before.tables.filter((t) => !t.missing);
  for (const was of read) {
    const is = now.get(was.id);
    const label = `${was.name} (${was.id})`;
    if (!is || is.missing) {
      changes.push(`${label} can't be read any more: the server would lose it`);
      continue;
    }
    const playing = underWay(was.id);
    for (const f of Object.keys(was)) {
      if (f === 'live') continue;
      if (playing && f === 'hands' && is.hands >= was.hands) continue;
      if (playing && f === 'players' && was.players.every((p) => is.players?.includes(p))) continue;
      const [a, b] = f === 'players' ? [names(was[f]), names(is[f])] : [was[f], is[f]];
      if (canonical(a) !== canonical(b)) changes.push(`${label}: ${f} was ${JSON.stringify(was[f])}, now ${JSON.stringify(is[f])}`);
    }
  }
  const unread = before.tables.length - read.length;
  report('Saved tables', changes, `all ${read.length} read back the same${unread ? ` (${unread} the server before couldn't read either)` : ''}`);
}

if (before.tournaments) {
  const changes = [];
  const now = new Map((after.tournaments ?? []).map((t) => [t.id, t]));
  for (const was of before.tournaments) {
    const is = now.get(was.id);
    if (!is || is.title !== was.title) changes.push(`${was.id}: its page showed "${was.title}", now ${is ? `"${is.title}"` : 'nothing'}`);
    else if (ENDED.has(was.status) && is.description !== was.description) changes.push(`${was.title} (${was.status}): its page said "${was.description}", now "${is.description}"`);
  }
  report('Saved tournaments', changes, `all ${before.tournaments.length} read back`);
}

const was = before.record?.seq ?? 0;
const is = after.record?.seq ?? 0;
if (is < was) {
  ok = false;
  console.log(`✗ Public record: ends at entry ${is}, but went up to ${was} before`);
} else console.log(`✓ Public record: up to entry ${was} before, ${is} now`);

process.exit(ok ? 0 : 1);

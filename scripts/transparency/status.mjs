#!/usr/bin/env node
// Remembers, on the transparency branch, when each of the watcher's checks
// last managed to run. A check that can't reach the site, Fly or GitHub on one
// run is a hiccup; for STALE_HOURS in a row it is a problem, since switching a
// check off (say, by breaking the site's record routes or removing the Fly
// token) would look just like that. Exits 1, writing STALE.md, when a check is
// stale.
//   node scripts/transparency/status.mjs <folder> <record exit code> <deploy exit code>

import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// The watcher is scheduled hourly, but GitHub starts it late: gaps of 3 to 8
// hours are normal. Twelve hours leaves room for that without a false alarm.
const STALE_HOURS = 12;
const [dir, ...codes] = process.argv.slice(2);
const names = { record: 'Copying the public record', deploy: 'Checking what the live machine runs' };
const file = path.join(dir, 'status.json');
let status = {};
try {
  status = JSON.parse(readFileSync(file, 'utf8'));
} catch {}
const now = new Date();
const stale = [];
for (const [i, name] of Object.keys(names).entries()) {
  const s = (status[name] ??= { since: now.toISOString(), lastRan: null });
  // 0 and 1 both mean the check ran to the end (1 found a problem, reported on its own).
  if (codes[i] === '0' || codes[i] === '1') s.lastRan = now.toISOString();
  const from = new Date(s.lastRan ?? s.since);
  if (now - from > STALE_HOURS * 3_600_000) stale.push(`${names[name]} hasn't managed to run since ${from.toISOString()} (it last exited with ${codes[i] || 'nothing'}).`);
}
writeFileSync(file, `${JSON.stringify(status, null, 2)}\n`);
if (stale.length) {
  writeFileSync(path.join(dir, 'STALE.md'), `# A check has stopped running\n\nChecked ${now.toISOString()}.\n\n${stale.map((p) => `- ${p}`).join('\n')}\n\nThe site, Fly or GitHub may be down for a while, or the check may have been switched off.\n`);
  console.error(stale.join('\n'));
  process.exit(1);
}
rmSync(path.join(dir, 'STALE.md'), { force: true });
console.log(`every check ran within the last ${STALE_HOURS} hours`);

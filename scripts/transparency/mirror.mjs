#!/usr/bin/env node
// Copies the site's public record into a folder (the repo's transparency
// branch), checking that it follows on from the copy made last time.
//   node scripts/transparency/mirror.mjs https://rsdp-poker-live.fly.dev transparency/
// Exits 1, and writes PROBLEM.md in the folder, when the site's record no longer
// agrees with the copy: an entry already copied was changed or removed.

import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chainProblem, fetchEntries } from './chain.mjs';

const [site, dir] = process.argv.slice(2);
if (!site || !dir) {
  console.error('usage: node scripts/transparency/mirror.mjs <site> <folder>');
  process.exit(2);
}
const folder = path.join(dir, 'audit');
mkdirSync(folder, { recursive: true });
const headFile = path.join(folder, 'head.json');
let head = null;
try {
  head = JSON.parse(readFileSync(headFile, 'utf8'));
} catch {}

function fail(problem) {
  const text = `# The public record changed\n\nFound ${new Date().toISOString()} by the hourly copy.\n\n${problem}\n\nThe copy in this folder is the record as it was. Compare it with ${site}/api/audit/entries.\n`;
  writeFileSync(path.join(dir, 'PROBLEM.md'), text);
  console.error(problem);
  process.exit(1);
}

const siteHead = await (await fetch(`${site}/api/audit/head`)).json();
if (head && siteHead.seq < head.seq) fail(`The site's record ends at entry ${siteHead.seq}, but entries up to ${head.seq} were copied before (last hash ${head.hash}).`);

// The last entry copied comes again, so a changed one is caught.
const entries = await fetchEntries(site, head ? head.seq - 1 : 0, siteHead.seq);
if (head) {
  const again = entries.shift();
  if (!again || again.seq !== head.seq || again.hash !== head.hash) fail(`Entry ${head.seq} on the site no longer matches the copy: it was ${head.hash}, now ${again?.hash ?? 'missing'}.`);
}
const problem = chainProblem(entries, head);
if (problem) fail(`The site's record is broken: ${problem}.`);

for (const e of entries) appendFileSync(path.join(folder, `${new Date(e.at).toISOString().slice(0, 7)}.jsonl`), `${JSON.stringify(e)}\n`);
const last = entries.at(-1);
if (last) writeFileSync(headFile, `${JSON.stringify({ seq: last.seq, hash: last.hash, at: new Date(last.at).toISOString(), copied: new Date().toISOString() }, null, 2)}\n`);
rmSync(path.join(dir, 'PROBLEM.md'), { force: true });
console.log(entries.length ? `copied entries ${entries[0].seq} to ${last.seq}` : 'nothing new');

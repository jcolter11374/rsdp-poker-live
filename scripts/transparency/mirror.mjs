#!/usr/bin/env node
// Copies the site's public record into a folder (the repo's transparency
// branch). Every run reads the whole record again and checks it against the
// whole copy, so an entry changed in place, removed or rewritten is caught
// however long ago it was copied.
//   node scripts/transparency/mirror.mjs https://rsdp-poker-live.fly.dev transparency/
// Exits 1, and writes PROBLEM.md in the folder, when the site's record no
// longer agrees with the copy; the old copy is then kept aside, in
// audit-replaced-<time>/, and the next run starts copying the record as it is
// now. Exits 2 when the site can't be reached (not a problem with the record:
// the next run tries again), and 3 when this script itself went wrong.

import { appendFileSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { canonical, chainProblem, fetchEntries, fetchJson, readMirror, Unreachable } from './chain.mjs';

const [site, dir] = process.argv.slice(2);
if (!site || !dir) {
  console.error('usage: node scripts/transparency/mirror.mjs <site> <folder>');
  process.exit(3);
}
const waits = process.env.MIRROR_WAITS ? JSON.parse(process.env.MIRROR_WAITS) : undefined;
const folder = path.join(dir, 'audit');

function fail(problem) {
  const now = new Date().toISOString();
  const aside = `audit-replaced-${now.replace(/[:.]/g, '-')}`;
  const text = `# The public record changed\n\nFound ${now} by the hourly copy.\n\n${problem}\n\nThe copy as it was is kept in ${aside}/. Compare it with ${site}/api/audit/entries. From the next run, the copy starts again from the record as the site has it now.\n`;
  writeFileSync(path.join(dir, 'PROBLEM.md'), text);
  renameSync(folder, path.join(dir, aside));
  console.error(problem);
  process.exit(1);
}

try {
  mkdirSync(folder, { recursive: true });
  const copy = readMirror(dir);

  let siteHead;
  let entries;
  try {
    siteHead = await fetchJson(`${site}/api/audit/head`, waits);
    entries = await fetchEntries(site, 0, siteHead.seq, waits);
  } catch (e) {
    if (!(e instanceof Unreachable)) throw e;
    console.error(`Couldn't reach the site: ${e.message}`);
    process.exit(2);
  }

  // The copy itself must be whole: a broken copy means the branch was edited.
  const copyProblem = chainProblem(copy);
  if (copyProblem) fail(`The copy on this branch is broken: ${copyProblem}. Someone edited the branch; its history shows who.`);
  const last = copy.at(-1);
  if (last && siteHead.seq < last.seq) fail(`The site's record ends at entry ${siteHead.seq}, but entries up to ${last.seq} were copied before (last hash ${last.hash}).`);
  // Every entry ever copied must still be on the site, unchanged.
  const bySeq = new Map(entries.map((e) => [e.seq, e]));
  for (const old of copy) {
    const now = bySeq.get(old.seq);
    if (!now || now.hash !== old.hash || canonical(now) !== canonical(old)) {
      fail(`Entry ${old.seq} on the site no longer matches the copy: it was ${old.hash}, now ${now ? `${now.hash}${now.hash === old.hash ? ' with different contents' : ''}` : 'missing'}.`);
    }
  }
  const problem = chainProblem(entries);
  if (problem) fail(`The site's record is broken: ${problem}.`);

  const fresh = entries.filter((e) => !last || e.seq > last.seq);
  for (const e of fresh) appendFileSync(path.join(folder, `${new Date(e.at).toISOString().slice(0, 7)}.jsonl`), `${JSON.stringify(e)}\n`);
  const top = entries.at(-1);
  if (top) writeFileSync(path.join(folder, 'head.json'), `${JSON.stringify({ seq: top.seq, hash: top.hash, at: new Date(top.at).toISOString(), copied: new Date().toISOString() }, null, 2)}\n`);
  rmSync(path.join(dir, 'PROBLEM.md'), { force: true });
  console.log(fresh.length ? `checked ${entries.length} entries, copied ${fresh[0].seq} to ${top.seq}` : `checked ${entries.length} entries, nothing new`);
} catch (e) {
  console.error('The copy went wrong:', e);
  process.exit(3);
}

#!/usr/bin/env node
// Checks the site's public record on its own, with Node's built-in SHA-256 and
// nothing from the app. See docs/FAIRNESS.md ("Checking John").
//   git clone -b transparency https://github.com/jcolter11374/rsdp-poker-live copy
//   node scripts/verify-audit.mjs --copy copy [--site https://rsdp-poker-live.fly.dev] [--proof hand-12-proof.json]
// Checks that the record is one unbroken chain, that the site still has every
// entry GitHub copied, unchanged, and (with --proof) that a hand you downloaded
// is the one the record holds.

import { readFileSync } from 'node:fs';
import { chainProblem, fetchEntries, handDigest, readMirror } from './transparency/chain.mjs';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const site = (opt('site') ?? 'https://rsdp-poker-live.fly.dev').replace(/\/$/, '');
const copyDir = opt('copy');
const proofFile = opt('proof');
if (args.includes('--help')) {
  console.log('usage: node scripts/verify-audit.mjs [--copy <transparency branch folder>] [--site <url>] [--proof <proof.json>]');
  process.exit(0);
}

const problems = [];
const ok = (text) => console.log(`✓ ${text}`);
const bad = (text) => (problems.push(text), console.log(`✗ ${text}`));

const live = await fetchEntries(site);
const liveProblem = chainProblem(live);
liveProblem ? bad(`the site's record is broken: ${liveProblem}`) : ok(`the site's record is one unbroken chain of ${live.length} entries`);

const bySeq = new Map(live.map((e) => [e.seq, e]));
if (copyDir) {
  const copy = readMirror(copyDir);
  const copyProblem = chainProblem(copy);
  copyProblem ? bad(`the GitHub copy is broken: ${copyProblem}`) : ok(`the GitHub copy is one unbroken chain of ${copy.length} entries`);
  const changed = copy.filter((e) => bySeq.get(e.seq)?.hash !== e.hash);
  changed.length
    ? bad(`${changed.length} entries GitHub copied are different or missing on the site now, the first being entry ${changed[0].seq}`)
    : ok('every entry GitHub copied is still on the site, unchanged');
}

if (proofFile) {
  const proof = JSON.parse(readFileSync(proofFile, 'utf8'));
  if (!proof.record) bad('this proof file was made before hands were recorded publicly');
  else {
    const digest = handDigest({ handId: proof.record.handId, commit: proof.commit, button: proof.button, seats: proof.record.seats, events: proof.events });
    const saved = live.filter((e) => e.kind === 'hand' && e.data.table === proof.record.table && e.data.hand === proof.record.handNumber);
    if (!saved.length) bad(`hand ${proof.record.handNumber} is not in the record`);
    else if (saved.at(-1).data.digest !== digest) bad(`hand ${proof.record.handNumber} in the record is not the hand in this file (entry ${saved.at(-1).seq})`);
    else ok(`hand ${proof.record.handNumber} is in the record as entry ${saved.at(-1).seq}, exactly as in this file`);
  }
}

console.log(problems.length ? `\n${problems.length} problem(s) found.` : '\nAll checks passed.');
process.exit(problems.length ? 1 : 0);

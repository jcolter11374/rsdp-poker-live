#!/usr/bin/env node
// Checks the site's public record on its own, with Node's built-in SHA-256 and
// nothing from the app. See docs/FAIRNESS.md ("Checking John").
//   git clone -b transparency https://github.com/jcolter11374/rsdp-poker-live copy
//   node scripts/verify-audit.mjs --copy copy [--site https://rsdp-poker-live.fly.dev] [--proof hand-12-proof.json]
// Checks that the record is one unbroken chain, that the site still has every
// entry GitHub copied, unchanged, and (with --proof) that a hand you downloaded
// is the one the record holds.

import { readFileSync } from 'node:fs';
import { canonical, chainProblem, fetchEntries, handDigest, readMirror } from './transparency/chain.mjs';

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
// Checks that can't pass or fail yet: a card shown after a hand, still to go in the record.
const waiting = [];
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
  const changed = copy.filter((e) => !bySeq.has(e.seq) || canonical(bySeq.get(e.seq)) !== canonical(e));
  changed.length
    ? bad(`${changed.length} entries GitHub copied are different or missing on the site now, the first being entry ${changed[0].seq}`)
    : ok('every entry GitHub copied is still on the site, unchanged');
}

if (proofFile) {
  const proof = JSON.parse(readFileSync(proofFile, 'utf8'));
  if (!proof.record) bad('this proof file was made before hands were recorded publicly');
  else {
    const digest = handDigest({ handId: proof.record.handId, commit: proof.commit, serverSeed: proof.serverSeed, button: proof.button, seats: proof.record.seats, events: proof.events });
    const saved = live.filter((e) => e.kind === 'hand' && e.data.table === proof.record.table && e.data.hand === proof.record.handNumber);
    // A hand shown after it ended is recorded again: the file may hold either version.
    const match = saved.find((e) => e.data.digest === digest);
    // At a table watched on a delay, a card shown after the hand ended goes in the record up to 10 minutes after it
    // was shown (D38). So the newest entry may be the hand as it was before such a card, but only while no later hand
    // of that table is in the record: a card can't be shown once the next hand is dealt, and entries go in in order.
    const newest = saved.at(-1);
    const end = proof.events.findIndex((e) => e.t === 'hand-end');
    const before = end < 0 ? [] : proof.events.flatMap((e, i) => (i > end && e.t === 'show' ? [handDigest({ handId: proof.record.handId, commit: proof.commit, serverSeed: proof.serverSeed, button: proof.button, seats: proof.record.seats, events: proof.events.slice(0, i) })] : []));
    const later = live.some((e) => e.kind === 'hand' && e.data.table === proof.record.table && Number(e.data.hand) > proof.record.handNumber);
    if (!saved.length) bad(`hand ${proof.record.handNumber} is not in the record`);
    else if (match) ok(`hand ${proof.record.handNumber} is in the record as entry ${match.seq}, exactly as in this file`);
    else if (!later && before.includes(newest.data.digest)) {
      // Not a pass: it waits, and if it is still waiting more than 10 minutes after the card was shown, the record is wrong.
      waiting.push(proof.record.handNumber);
      console.log(`… hand ${proof.record.handNumber}: entry ${newest.seq} has it as it was before a card shown after it ended. That card goes in the record up to 10 minutes after it was shown: run this again then. If it still isn't there more than 10 minutes after the card was shown, the record is wrong.`);
    }
    else bad(`hand ${proof.record.handNumber} in the record is not the hand in this file (entry ${newest.seq})`);
  }
}

console.log(
  problems.length
    ? `\n${problems.length} problem(s) found.`
    : waiting.length
      ? `\nNothing wrong found yet, but ${waiting.length} check(s) are still waiting: run this again in 10 minutes.`
      : '\nAll checks passed.',
);
// 2: nothing wrong yet, but not everything could be checked.
process.exit(problems.length ? 1 : waiting.length ? 2 : 0);

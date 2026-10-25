#!/usr/bin/env node
// Checks a hand's proof file (from "Check this hand" > Download proof) on its own,
// with Node's built-in OpenSSL SHA-256 and nothing from the app. See docs/FAIRNESS.md.
//   node scripts/verify-hand.mjs hand-12-proof.json

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/verify-hand.mjs <proof.json>');
  process.exit(2);
}
const proof = JSON.parse(readFileSync(file, 'utf8'));
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest();
const hex = (text) => sha256(text).toString('hex');

/** Integers in [0, n) from SHA-256(seed|label|block), big-endian 32-bit words, rejection sampled. */
function seededRng(seed, label) {
  let block = 0;
  let words = [];
  return (n) => {
    const limit = Math.floor(0x100000000 / n) * n;
    for (;;) {
      if (!words.length) {
        const bytes = sha256(`${seed}|${label}|${block++}`);
        words = Array.from({ length: 8 }, (_, i) => bytes.readUInt32BE(i * 4));
      }
      const x = words.shift();
      if (x < limit) return x % n;
    }
  };
}

function deckFromSeed(handSeed) {
  const deck = [];
  for (const r of '23456789TJQKA') for (const s of 'cdhs') deck.push(r + s);
  const rng = seededRng(handSeed, 'deck');
  for (let i = deck.length - 1; i > 0; i--) {
    const j = rng(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

let ok = true;
const report = (pass, label, detail = '') => {
  ok &&= pass;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n      ${detail}` : ''}`);
};

if (!proof.serverSeed) {
  console.log('This hand is still sealed: its server seed has not been revealed yet.');
  process.exit(1);
}
report(hex(proof.serverSeed) === proof.commit, 'server seed matches the commitment shown before the deal', `sha256(${proof.serverSeed}) = ${hex(proof.serverSeed)}`);
const handSeed = hex(`rsdp-fair-v1|${proof.serverSeed}|${proof.handId}|${[...proof.clientSeeds].sort().join(',')}`);
if (proof.handSeed) report(handSeed === proof.handSeed, 'hand seed follows from the server seed and the players’ seeds', handSeed);
const deck = deckFromSeed(handSeed);

const used = new Map();
let matched = 0;
let hidden = 0;
let unplaced = 0;
for (const e of proof.events) {
  if (!['deal', 'board', 'draw'].includes(e.t) || !e.cards) continue;
  const cards = e.cards.map((c) => (typeof c === 'string' ? c : c.card));
  if (!e.pos) {
    unplaced += cards.length;
    continue;
  }
  cards.forEach((card, i) => {
    const at = e.pos[i];
    used.set(at, (used.get(at) ?? 0) + 1);
    if (card === '??') hidden++;
    else if (deck[at] === card) matched++;
    else report(false, `${card} was dealt from place ${at + 1}, but the deck has ${deck[at]} there`);
  });
}
const last = Math.max(-1, ...used.keys());
const gaps = Array.from({ length: last + 1 }, (_, i) => i).filter((i) => !used.has(i));
const twice = [...used].filter(([, n]) => n > 1).map(([p]) => p);
report(!gaps.length && !twice.length, 'cards were dealt in order from the top, none skipped or used twice', gaps.length || twice.length ? `skipped ${gaps.map((p) => p + 1)} reused ${twice.map((p) => p + 1)}` : `places 1 to ${last + 1}`);

console.log(`\n${matched} visible cards matched, ${hidden} face-down cards checked by place only${unplaced ? `, ${unplaced} cards from a draw-game reshuffle not checked` : ''}.`);
console.log(`Deck, top first: ${deck.join(' ')}`);
console.log(ok ? '\nThis hand checks out.' : '\nThis hand does NOT check out.');
process.exit(ok ? 0 : 1);

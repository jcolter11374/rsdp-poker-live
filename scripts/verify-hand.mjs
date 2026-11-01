#!/usr/bin/env node
// Checks a hand's proof file (from "Check this hand" > Download proof) on its own,
// with Node's built-in OpenSSL SHA-256 and nothing from the app. See docs/FAIRNESS.md.
//   node scripts/verify-hand.mjs hand-12-proof.json
// The file may also hold a list of proofs; then each is checked and summed up.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/verify-hand.mjs <proof.json>');
  process.exit(2);
}
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

/** Fisher-Yates from the last card down: swap card i with card rng(i + 1). */
function shuffle(items, rng) {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function freshDeck() {
  const deck = [];
  for (const r of '23456789TJQKA') for (const s of 'cdhs') deck.push(r + s);
  return deck;
}

/**
 * Draw games: replacements come off the top of the stub, but its last card is
 * never dealt. When the stub runs short, that card and the muck are shuffled
 * into a new stub. The drawer's own discards join the muck afterwards.
 */
function drawReplacements(discards, stub, muck, rng) {
  const cards = [];
  if (discards.length >= stub.length && muck.length > 0) {
    cards.push(...stub.slice(0, stub.length - 1));
    stub = shuffle([...stub.slice(stub.length - 1), ...muck], rng);
    muck = [];
  }
  const rest = discards.length - cards.length;
  if (rest > stub.length) throw new Error('not enough cards');
  cards.push(...stub.slice(0, rest));
  return { cards, stub: stub.slice(rest), muck: [...muck, ...discards] };
}

const cardOf = (c) => (typeof c === 'string' ? c : c.card);

/** Deals the hand again from the seeds and compares every card. Returns a list of problems. */
function check(proof, say) {
  const problems = [];
  if (!proof.serverSeed) return ['this hand is still sealed: its server seed has not been revealed yet'];
  if (hex(proof.serverSeed) !== proof.commit) problems.push(`the server seed does not match the commitment (sha256 = ${hex(proof.serverSeed)})`);
  const handSeed = hex(`rsdp-fair-v1|${proof.serverSeed}|${[...proof.clientSeeds].sort().join(',')}`);
  if (proof.handSeed && proof.handSeed !== handSeed) problems.push(`the hand seed should be ${handSeed}`);
  // At most one fresh seed per player dealt in: a copy or an extra seed changes the deck with nobody vouching for it.
  for (const s of new Set(proof.clientSeeds)) {
    const times = proof.clientSeeds.filter((c) => c === s).length;
    if (times > 1) problems.push(`the seed ${s} is listed ${times} times, but each player sends one fresh seed`);
  }
  if (proof.seats && proof.clientSeeds.length > proof.seats.length) problems.push(`${proof.clientSeeds.length} seeds are listed for ${proof.seats.length} seats dealt in`);
  const original = shuffle(freshDeck(), seededRng(handSeed, 'deck'));
  say(`Deck, top first: ${original.join(' ')}`);

  let deck = original.slice();
  let next = 0;
  let muck = [];
  let matched = 0;
  let lost = false;
  const hands = new Map();
  const board = new Set();
  const hand = (seat) => (hands.has(seat) || hands.set(seat, []), hands.get(seat));
  const dealt = (card, at) => {
    if (lost || card === '??') return problems.push(`${card === '??' ? 'a face-down card' : card} could not be checked`);
    if (deck[at] === card) matched++;
    else problems.push(`${card} was dealt from place ${at + 1}, but the deck has ${deck[at]} there`);
  };
  const clockwise = (seat) => (seat > proof.button ? seat - proof.button : seat + 1000 - proof.button);

  const events = proof.events;
  if (proof.seats) {
    const first = events.findIndex((e) => e.t === 'deal');
    let end = first;
    while (end >= 0 && end < events.length && events[end].t === 'deal') end++;
    const got = first < 0 ? [] : events.slice(first, end).map((e) => e.seat).sort((a, b) => a - b);
    if (got.join() !== [...proof.seats].sort((a, b) => a - b).join()) problems.push('the first cards did not go to exactly the seats dealt in');
  }
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.t === 'deal') {
      let end = i;
      while (end < events.length && events[end].t === 'deal') end++;
      const group = events.slice(i, end);
      i = end - 1;
      const n = group.length;
      const k = group[0].cards.length;
      for (let g = 1; g < n; g++) if (clockwise(group[g].seat) <= clockwise(group[g - 1].seat)) problems.push(`seat ${group[g].seat + 1} was dealt out of turn`);
      if (group.some((d) => d.cards.length !== k)) problems.push('players were dealt different numbers of cards on one street');
      group.forEach((d, idx) =>
        d.cards.forEach((c, j) => {
          dealt(cardOf(c), next + j * n + idx);
          hand(d.seat).push(cardOf(c));
        }),
      );
      next += n * k;
    } else if (e.t === 'board') {
      e.cards.forEach((c, j) => {
        dealt(c, next + j);
        board.add(c);
      });
      next += e.cards.length;
    } else if (e.t === 'action' && e.action === 'fold') {
      muck.push(...hand(e.seat));
    } else if (e.t === 'draw') {
      const mine = hand(e.seat);
      if (lost || !e.positions || e.cards.includes('??') || mine.includes('??')) {
        problems.push(`seat ${e.seat + 1}'s draw could not be checked`);
        mine.push(...e.cards);
        lost = true;
        continue;
      }
      const thrown = e.positions.map((p) => mine.splice(p, 1)[0]);
      let result;
      try {
        result = drawReplacements(thrown, deck.slice(next), muck, seededRng(handSeed, `reshuffle:${next}`));
      } catch {
        problems.push(`seat ${e.seat + 1}'s draw can't be dealt from this deck`);
        continue;
      }
      if (result.cards.join() === e.cards.join()) matched += e.cards.length;
      else problems.push(`seat ${e.seat + 1} drew ${e.cards.join(' ')}, but the deck gives ${result.cards.join(' ')}`);
      deck = [...deck.slice(0, next), ...result.cards, ...result.stub];
      next += result.cards.length;
      muck = result.muck;
      mine.push(...e.cards);
    } else if ((e.t === 'show' || e.t === 'award') && e.cards) {
      for (const c of e.cards.map(cardOf)) {
        if (c === '??') continue;
        if (hand(e.seat).includes(c) || (e.t === 'award' && board.has(c))) matched++;
        else problems.push(`seat ${e.seat + 1} ${e.t === 'show' ? 'showed' : 'won with'} ${c}, which it was never dealt`);
      }
    }
  }
  say(`${matched} cards matched.`);
  return problems;
}

const data = JSON.parse(readFileSync(file, 'utf8'));
if (Array.isArray(data)) {
  let bad = 0;
  data.forEach((proof, i) => {
    const problems = check(proof, () => {});
    if (problems.length) {
      bad++;
      console.log(`Hand ${i + 1}: ${problems.join('; ')}`);
    }
  });
  console.log(bad ? `${bad} of ${data.length} hands do NOT check out.` : `All ${data.length} hands check out.`);
  process.exit(bad ? 1 : 0);
}
const problems = check(data, console.log);
for (const p of problems) console.log(`FAIL  ${p}`);
console.log(problems.length ? '\nThis hand does NOT check out.' : '\nThis hand checks out.');
process.exit(problems.length ? 1 : 0);

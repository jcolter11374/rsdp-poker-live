// Provably fair dealing (docs/FAIRNESS.md). Everything here is pure and
// synchronous so the server, the browser's "verify this hand" view and the
// standalone checker (scripts/verify-hand.mjs) compute exactly the same deck.

import { freshDeck, shuffle, type Card, type Rng } from './cards';
import { drawReplacements } from './variants/draw';

/** Version tag mixed into every hash, so a future scheme can't be confused with this one. */
export const FAIR_VERSION = 'rsdp-fair-v1';

// ---------------------------------------------------------------- SHA-256 (FIPS 180-4)

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function sha256(data: Uint8Array): Uint8Array {
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  // Padding: 0x80, zeros, then the bit length as a 64-bit big-endian number.
  const blocks = Math.ceil((data.length + 9) / 64);
  const msg = new Uint8Array(blocks * 64);
  msg.set(data);
  msg[data.length] = 0x80;
  const bits = data.length * 8;
  const view = new DataView(msg.buffer);
  view.setUint32(msg.length - 8, Math.floor(bits / 0x100000000));
  view.setUint32(msg.length - 4, bits >>> 0);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < msg.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] += a;
    h[1] += b;
    h[2] += c;
    h[3] += d;
    h[4] += e;
    h[5] += f;
    h[6] += g;
    h[7] += hh;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, h[i]);
  return out;
}

export const utf8 = (s: string) => new TextEncoder().encode(s);
export const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export const sha256Hex = (s: string) => toHex(sha256(utf8(s)));

/** A server seed or client seed: lowercase hex, 16 to 64 characters. */
export const SEED_RE = /^[0-9a-f]{16,64}$/;

// ---------------------------------------------------------------- the scheme

/**
 * What the table publishes before a hand: SHA-256 of the server seed's hex
 * text, so anyone can check it with `printf %s <seed> | sha256sum`.
 */
export function commitmentOf(serverSeed: string): string {
  return sha256Hex(serverSeed);
}

/**
 * The hand's seed. The server seed was committed to before any player picked
 * a client seed, so the server can't steer the deck; players can't predict it
 * either, because they never see the server seed until it is revealed.
 * Client seeds are sorted so the order they arrived in doesn't matter. Nothing
 * else goes in: every input is either committed or chosen by a player, so the
 * server has nothing left to vary.
 */
export function handSeedOf(serverSeed: string, clientSeeds: string[]): string {
  return sha256Hex(`${FAIR_VERSION}|${serverSeed}|${[...clientSeeds].sort().join(',')}`);
}

/**
 * A deterministic, cryptographically strong stream of integers: SHA-256 in
 * counter mode over (seed, label, block number), read as big-endian 32-bit
 * words, with rejection sampling so every value in [0, n) is equally likely.
 */
export function seededRng(seed: string, label: string): Rng {
  let block = 0;
  let words = new Uint32Array(0);
  let at = 0;
  const next = () => {
    if (at === words.length) {
      const bytes = sha256(utf8(`${seed}|${label}|${block++}`));
      const v = new DataView(bytes.buffer);
      words = new Uint32Array(8).map((_, i) => v.getUint32(i * 4));
      at = 0;
    }
    return words[at++];
  };
  return (n) => {
    if (!Number.isInteger(n) || n < 1 || n > 0x100000000) throw new RangeError(`bad range ${n}`);
    const limit = Math.floor(0x100000000 / n) * n;
    for (;;) {
      const x = next();
      if (x < limit) return x % n;
    }
  };
}

/** The hand's whole deck: a Fisher-Yates shuffle of a fresh deck (2c 2d 2h 2s 3c ... As) driven by seededRng(handSeed, 'deck'). */
export function deckFromSeed(handSeed: string): Card[] {
  return shuffle(freshDeck(), seededRng(handSeed, 'deck'));
}

/** Draw games: the stream for a reshuffle of the muck, keyed by where in the deck it happened. */
export function reshuffleRng(handSeed: string, deckPos: number): Rng {
  return seededRng(handSeed, `reshuffle:${deckPos}`);
}

// ---------------------------------------------------------------- checking a hand

/** A hand event as the checker reads it: only the fields that carry or move cards. */
export interface CardEvent {
  t: string;
  seat?: number;
  cards?: (Card | { card: Card })[];
  pos?: number[];
  /** Draw events: the hand indexes thrown away, highest first. */
  positions?: number[];
  action?: string;
}

export interface FairCheck {
  /** Every check passed and every card was checked. */
  ok: boolean;
  checks: { label: string; ok: boolean; detail: string }[];
  /** The deck rebuilt from the seeds, top card first (null if the server seed doesn't match the commitment). */
  deck: Card[] | null;
  /** Cards compared with the deck. */
  matched: number;
  /** Cards that couldn't be compared (face down in the events given): 0 when checking a revealed hand's full events. */
  unchecked: number;
}

const cardOf = (c: Card | { card: Card }) => (typeof c === 'string' ? c : c.card);
const HIDDEN = '??';

/**
 * Checks a revealed hand by dealing it again. The server seed must match the
 * commitment published before the deal, and the deck is rebuilt from it and
 * the players' seeds. Then the hand is replayed the way the engine deals:
 * hole cards one at a time clockwise from the left of the button, boards and
 * draws off the top, draw-game reshuffles from the same seed and the real
 * muck. Every dealt card must be the card at its place, and every card shown
 * or awarded must be one that seat was really dealt (or on the board).
 */
export function verifyHand(args: {
  commit: string;
  serverSeed: string;
  clientSeeds: string[];
  /** The hand seed the server says it used, if given; it must match. */
  handSeed?: string | null;
  button: number;
  /** Seats dealt in, if known: the first deal must go to exactly these. */
  seats?: number[];
  events: CardEvent[];
}): FairCheck {
  const checks: FairCheck['checks'] = [];
  const add = (label: string, ok: boolean, detail: string) => checks.push({ label, ok, detail });
  const commitOk = commitmentOf(args.serverSeed) === args.commit;
  add('Server seed matches the commitment shown before the deal', commitOk, `SHA-256(${args.serverSeed}) = ${commitmentOf(args.serverSeed)}`);
  const handSeed = handSeedOf(args.serverSeed, args.clientSeeds);
  if (args.handSeed != null) add('Hand seed comes from the server seed and the players\u2019 seeds', handSeed === args.handSeed, handSeed);
  // An honest server lists at most one seed per player dealt in, all fresh. A copy or an extra seed changes the deck
  // without anyone's browser vouching for it, so it could have been picked to steer the deal. Shown only when it fails.
  const copies = [...new Set(args.clientSeeds)].filter((s) => args.clientSeeds.indexOf(s) !== args.clientSeeds.lastIndexOf(s));
  const extra: string[] = copies.map((s) => `${s} is listed ${args.clientSeeds.filter((c) => c === s).length} times`);
  if (args.seats && args.clientSeeds.length > args.seats.length) extra.push(`${args.clientSeeds.length} seeds are listed for ${args.seats.length} seats dealt in`);
  if (extra.length) add('Each seed is listed once, at most one per seat dealt in', false, extra.join('; '));
  const original = deckFromSeed(handSeed);

  let deck = original.slice();
  let next = 0;
  let muck: Card[] = [];
  const hands = new Map<number, Card[]>();
  const board = new Set<Card>();
  const wrong: string[] = [];
  const order: string[] = [];
  const unseen: string[] = [];
  let matched = 0;
  let unchecked = 0;
  /** A draw hid which cards were thrown, so the deck after it can't be followed. */
  let lost = false;
  const hand = (seat: number) => hands.get(seat) ?? (hands.set(seat, []), hands.get(seat)!);
  /** One dealt card at deck place `at`. */
  const dealt = (card: Card, at: number, recorded: number | undefined) => {
    if (lost) return void unchecked++;
    if (recorded !== undefined && recorded !== at) wrong.push(`${card} is recorded at place ${recorded + 1} but was dealt from place ${at + 1}`);
    if (card === HIDDEN) unchecked++;
    else if (deck[at] === card) matched++;
    else wrong.push(`${card} at place ${at + 1} (the deck has ${deck[at] ?? 'nothing'} there)`);
  };
  // Clockwise from the seat after the button.
  const clockwise = (seat: number) => (seat > args.button ? seat - args.button : seat + 1000 - args.button);

  const events = args.events;
  if (args.seats) {
    const first = events.findIndex((e) => e.t === 'deal');
    let end = first;
    while (end >= 0 && end < events.length && events[end].t === 'deal') end++;
    const got = first < 0 ? [] : events.slice(first, end).map((e) => e.seat!);
    const want = [...args.seats].sort((a, b) => a - b);
    if (got.slice().sort((a, b) => a - b).join() !== want.join()) order.push(`the first cards went to seats ${got.map((x) => x + 1).join(', ') || 'none'}, not to the seats dealt in`);
  }
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.t === 'deal') {
      // One street's deal: consecutive deal events, one per player, a card at a time around the table.
      let end = i;
      while (end < events.length && events[end].t === 'deal') end++;
      const group = events.slice(i, end);
      i = end - 1;
      const n = group.length;
      const k = group[0].cards?.length ?? 0;
      for (let g = 1; g < n; g++) {
        if (clockwise(group[g].seat!) <= clockwise(group[g - 1].seat!)) order.push(`seat ${group[g].seat! + 1} was dealt out of turn`);
      }
      if (group.some((d) => (d.cards?.length ?? 0) !== k)) order.push('players were dealt different numbers of cards on one street');
      group.forEach((d, idx) => {
        (d.cards ?? []).forEach((c, j) => {
          dealt(cardOf(c), next + j * n + idx, d.pos?.[j]);
          hand(d.seat!).push(cardOf(c));
        });
      });
      next += n * k;
    } else if (e.t === 'board') {
      (e.cards ?? []).forEach((c, j) => {
        dealt(cardOf(c), next + j, e.pos?.[j]);
        board.add(cardOf(c));
      });
      next += e.cards?.length ?? 0;
    } else if (e.t === 'action' && e.action === 'fold') {
      // Draw games reshuffle folded hands; other games never read the muck.
      muck.push(...hand(e.seat!));
    } else if (e.t === 'draw') {
      const mine = hand(e.seat!);
      const cards = (e.cards ?? []).map(cardOf);
      if (lost || !e.positions || cards.includes(HIDDEN) || mine.includes(HIDDEN)) {
        // Without the full hand there is no knowing what went to the muck: nothing after this can be dealt again.
        unchecked += cards.length;
        unseen.push(`seat ${e.seat! + 1}'s draw`);
        mine.push(...cards);
        lost = true;
        continue;
      }
      const thrown = e.positions.map((p) => mine.splice(p, 1)[0]);
      let result;
      try {
        result = drawReplacements({ discards: thrown, stub: deck.slice(next), muck, rng: reshuffleRng(handSeed, next) });
      } catch {
        wrong.push(`seat ${e.seat! + 1}'s draw can't be dealt from this deck`);
        continue;
      }
      cards.forEach((card, j) => {
        if (result.cards[j] === card) matched++;
        else wrong.push(`${card} in seat ${e.seat! + 1}'s draw (the deck gives ${result.cards[j] ?? 'nothing'})`);
        if (e.pos && e.pos[j] !== next + j) wrong.push(`${card} is recorded at place ${e.pos[j] + 1} but was dealt from place ${next + j + 1}`);
      });
      if (cards.length !== result.cards.length) wrong.push(`seat ${e.seat! + 1} drew ${cards.length} cards for ${thrown.length} thrown`);
      deck = [...deck.slice(0, next), ...result.cards, ...result.stub];
      next += result.cards.length;
      muck = result.muck;
      mine.push(...cards);
    } else if ((e.t === 'show' || e.t === 'award') && e.cards) {
      for (const c of e.cards.map(cardOf)) {
        if (c === HIDDEN) continue;
        if (hand(e.seat!).includes(c) || (e.t === 'award' && board.has(c))) matched++;
        else wrong.push(`seat ${e.seat! + 1} ${e.t === 'show' ? 'showed' : 'won with'} ${c}, which it was never dealt`);
      }
    }
  }
  add('Every card is the one at its place in the deck', wrong.length === 0, wrong.length ? wrong.join('; ') : `${matched} cards matched`);
  add('Cards were dealt in turn from the top, none skipped', order.length === 0, order.length ? order.join('; ') : 'one at a time, clockwise from the left of the button');
  if (unseen.length) add('Every card could be checked', false, `${unseen.join(', ')} hid which cards were thrown, so later cards weren't checked`);
  return { ok: checks.every((c) => c.ok) && unchecked === 0, checks, deck: commitOk ? original : null, matched, unchecked };
}

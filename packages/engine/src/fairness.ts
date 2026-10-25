// Provably fair dealing (docs/FAIRNESS.md). Everything here is pure and
// synchronous so the server, the browser's "verify this hand" view and the
// standalone checker (scripts/verify-hand.mjs) compute exactly the same deck.

import { freshDeck, shuffle, type Card, type Rng } from './cards';

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
 * Client seeds are sorted so the order they arrived in doesn't matter.
 */
export function handSeedOf(serverSeed: string, handId: string, clientSeeds: string[]): string {
  return sha256Hex(`${FAIR_VERSION}|${serverSeed}|${handId}|${[...clientSeeds].sort().join(',')}`);
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

/** The parts of a hand event that carry cards (deal, board and draw events). */
export interface CardEvent {
  t: string;
  cards?: (Card | { card: Card })[];
  pos?: number[];
}

export interface FairCheck {
  /** Every check passed. */
  ok: boolean;
  checks: { label: string; ok: boolean; detail: string }[];
  /** The deck rebuilt from the seeds, top card first (null if the seeds didn't match). */
  deck: Card[] | null;
  /** Cards the viewer saw that were compared with the deck. */
  matched: number;
  /** Cards dealt face down to others and never shown: their place in the deck is checked, not their face. */
  hidden: number;
  /** Cards with no recorded place (dealt from a draw-game reshuffle): not checked. */
  unplaced: number;
}

/**
 * Checks a revealed hand: the server seed matches the commitment published
 * before the deal, the hand seed follows from it and the client seeds, and
 * every card the viewer saw sat at its recorded place in the deck rebuilt from
 * that seed, with no card skipped or used twice. Hidden cards show as '??'.
 */
export function verifyHand(args: {
  handId: string;
  commit: string;
  serverSeed: string;
  clientSeeds: string[];
  /** The hand seed the server says it used, if given; it must match. */
  handSeed?: string | null;
  events: CardEvent[];
}): FairCheck {
  const checks: FairCheck['checks'] = [];
  const add = (label: string, ok: boolean, detail: string) => checks.push({ label, ok, detail });
  const commitOk = commitmentOf(args.serverSeed) === args.commit;
  add('Server seed matches the commitment shown before the deal', commitOk, `SHA-256(${args.serverSeed}) = ${commitmentOf(args.serverSeed)}`);
  const handSeed = handSeedOf(args.serverSeed, args.handId, args.clientSeeds);
  if (args.handSeed != null) add('Hand seed comes from the server seed and the players’ seeds', handSeed === args.handSeed, handSeed);
  const deck = deckFromSeed(handSeed);

  let matched = 0;
  let hidden = 0;
  let unplaced = 0;
  const mismatches: string[] = [];
  const used = new Map<number, number>();
  for (const e of args.events) {
    if (!e.cards || !['deal', 'board', 'draw'].includes(e.t)) continue;
    const cards = e.cards.map((c) => (typeof c === 'string' ? c : c.card));
    if (!e.pos) {
      unplaced += cards.length;
      continue;
    }
    cards.forEach((card, i) => {
      const at = e.pos![i];
      used.set(at, (used.get(at) ?? 0) + 1);
      if (card === '??') hidden++;
      else if (deck[at] === card) matched++;
      else mismatches.push(`${card} at place ${at + 1} (the deck has ${deck[at] ?? 'nothing'} there)`);
    });
  }
  add('Every card seen is the one at its place in the deck', mismatches.length === 0, mismatches.length ? mismatches.join('; ') : `${matched} cards matched`);
  const places = [...used.keys()].sort((a, b) => a - b);
  const twice = [...used].filter(([, n]) => n > 1).map(([p]) => p + 1);
  const gaps = places.length ? Array.from({ length: places[places.length - 1] + 1 }, (_, i) => i).filter((i) => !used.has(i)).map((i) => i + 1) : [];
  add(
    'Cards were dealt in order from the top, none skipped or used twice',
    twice.length === 0 && gaps.length === 0,
    twice.length || gaps.length ? `${gaps.length ? `skipped places ${gaps.join(', ')}` : ''}${twice.length ? ` reused places ${twice.join(', ')}` : ''}`.trim() : `places 1 to ${places.length}`,
  );
  return { ok: checks.every((c) => c.ok), checks, deck: commitOk ? deck : null, matched, hidden, unplaced };
}

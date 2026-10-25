import { freshDeck } from '@rsdp/engine';
import { awardPortion, getVariant } from '@rsdp/engine/variants';

/*
 * Each live hand's share of the pot when every hand is face up and only
 * cards are left to come (an all-in run-out): exact when few cards are left,
 * sampled otherwise. Hi-lo halves and ties count as the share they would win.
 */

export interface EquityInput {
  gameId: string;
  /** Every live hand, all cards known. */
  hands: { seat: number; cards: string[] }[];
  /** The boards of the first run so far (one, or two for double board). Empty for stud. */
  boards: string[][];
  /** Other cards known to be out of the deck (folded players' up cards). */
  dead: string[];
  /** Most run-outs to try when there are too many to count. */
  samples?: number;
}

/** Seat → share of the pot, 0 to 1. Null when it can't be worked out (draw games, too few cards left). */
export type Equity = Record<number, number>;

/** Run-outs counted one by one up to this many; beyond it they are sampled. */
const EXACT_LIMIT = 2500;
const SAMPLES = 2500;
const BOARD = 5;

const FULL_DECK = freshDeck();

function choose(n: number, k: number) {
  let c = 1;
  for (let i = 0; i < k; i++) c = (c * (n - i)) / (i + 1);
  return Math.round(c);
}

/** Every way to pick k of the items, in order. */
function* combinations<T>(items: T[], k: number, start = 0, picked: T[] = []): Generator<T[]> {
  if (picked.length === k) {
    yield picked;
    return;
  }
  for (let i = start; i <= items.length - (k - picked.length); i++) {
    picked.push(items[i]);
    yield* combinations(items, k, i + 1, picked);
    picked.pop();
  }
}

/** A small fast seeded generator, so the same spot always shows the same numbers. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hash = (s: string) => [...s].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261);

export function equity(input: EquityInput): Equity | null {
  let spec;
  try {
    spec = getVariant(input.gameId);
  } catch {
    return null;
  }
  if (spec.family === 'draw' || input.hands.length < 2) return null;
  const stud = spec.family === 'stud';
  const known = new Set([...input.hands.flatMap((h) => h.cards), ...input.boards.flat(), ...input.dead]);
  if (known.has('??')) return null;
  const deck = FULL_DECK.filter((c) => !known.has(c));
  // What each run-out has to fill: the boards up to five, or each stud hand up to seven.
  const boardNeeds = stud ? [] : input.boards.map((b) => BOARD - b.length);
  const handNeeds = stud ? input.hands.map((h) => Math.max(0, spec.cardsPerPlayer - h.cards.length)) : input.hands.map(() => 0);
  const need = boardNeeds.reduce((a, b) => a + b, 0) + handNeeds.reduce((a, b) => a + b, 0);
  if (need === 0 || need > deck.length) return null;

  const AMOUNT = 1_000_000;
  const won = new Map<number, number>(input.hands.map((h) => [h.seat, 0]));
  const eligible = input.hands.map((h) => h.seat);
  const boardCount = stud ? 1 : input.boards.length;
  /** Scores one complete run-out: `extra` fills the boards first, then the stud hands, in order. */
  const score = (extra: string[]) => {
    let i = 0;
    const holes: Record<number, string[]> = {};
    const boards = stud ? [[]] : input.boards.map((b, n) => [...b, ...extra.slice(i, (i += boardNeeds[n]))]);
    input.hands.forEach((h, n) => (holes[h.seat] = handNeeds[n] ? [...h.cards, ...extra.slice(i, (i += handNeeds[n]))] : h.cards));
    for (const board of boards) for (const a of awardPortion(spec, AMOUNT, eligible, holes, board as string[])) won.set(a.seat, won.get(a.seat)! + a.amount / AMOUNT / boardCount);
  };

  let runs = 0;
  if (choose(deck.length, need) <= EXACT_LIMIT) {
    for (const extra of combinations(deck, need)) {
      score(extra);
      runs++;
    }
  } else {
    const random = rng(hash(JSON.stringify(input)));
    const pool = [...deck];
    const total = input.samples ?? SAMPLES;
    for (; runs < total; runs++) {
      // A partial shuffle: the first `need` cards of the pool are the run-out.
      for (let i = 0; i < need; i++) {
        const j = i + Math.floor(random() * (pool.length - i));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      score(pool.slice(0, need));
    }
  }
  return Object.fromEntries([...won].map(([seat, w]) => [seat, w / runs]));
}

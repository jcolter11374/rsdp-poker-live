import { RANKS, type Card } from '../../cards';

/**
 * Shared machinery for every evaluator: rank parsing, grouping cards into
 * pairs/trips/quads, score encoding and readable names.
 *
 * A "code" orders hands from worst to best for a *high* game. Low games reuse
 * the same codes and invert them, so every public score is "higher wins".
 */

export const DIGIT = 16;
/** One category step. Five rank digits fit below it. */
export const CATEGORY_SPAN = DIGIT ** 5;
/** Larger than any code, so CODE_LIMIT - code is always positive. */
export const CODE_LIMIT = 9 * CATEGORY_SPAN;

export const HIGH_CATEGORY = {
  highCard: 0,
  pair: 1,
  twoPair: 2,
  trips: 3,
  straight: 4,
  flush: 5,
  fullHouse: 6,
  quads: 7,
  straightFlush: 8,
} as const;

const SINGULAR = ['', 'Ace', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Jack', 'Queen', 'King', 'Ace'];
const PLURAL = ['', 'Aces', 'Twos', 'Threes', 'Fours', 'Fives', 'Sixes', 'Sevens', 'Eights', 'Nines', 'Tens', 'Jacks', 'Queens', 'Kings', 'Aces'];
const SYMBOL = ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];

/** Rank 2-14 with aces high, or 1-13 with aces low. */
export function rankValue(card: Card, aceLow = false): number {
  const r = RANKS.indexOf(card[0]) + 2;
  if (r < 2 || card.length !== 2 || !'cdhs'.includes(card[1])) throw new Error(`bad card: ${card}`);
  return aceLow && r === 14 ? 1 : r;
}

export const rankName = (r: number) => SINGULAR[r];
export const rankPlural = (r: number) => PLURAL[r];
/** "8-6-4-2-A": ranks as given, joined. */
export const rankList = (ranks: number[]) => ranks.map((r) => SYMBOL[r]).join('-');

export function assertDistinct(cards: Card[]) {
  if (new Set(cards).size !== cards.length) throw new Error(`duplicate cards: ${cards.join(' ')}`);
}

export interface Shape {
  category: number;
  /** Ranks in order of significance (group size, then rank). */
  ranks: number[];
  /** The cards, reordered to match `ranks` for display. */
  cards: Card[];
}

export interface ShapeRules {
  aceLow: boolean;
  /** Straights and flushes only exist in hands of exactly five cards. */
  straightsAndFlushes: boolean;
  /** A-2-3-4-5 counts as a straight (not in deuce-to-seven). */
  wheel: boolean;
}

/** Classifies 1-5 cards. Fewer than five cards only make pairs, trips and quads. */
export function shapeOf(cards: Card[], rules: ShapeRules): Shape {
  const items = cards.map((c) => ({ c, r: rankValue(c, rules.aceLow) }));
  const count = new Map<number, number>();
  for (const { r } of items) count.set(r, (count.get(r) ?? 0) + 1);
  const groups = [...count.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const ranks = groups.map((g) => g[0]);
  const order = new Map(ranks.map((r, i) => [r, i]));
  const sorted = items.sort((a, b) => order.get(a.r)! - order.get(b.r)!).map((i) => i.c);

  if (rules.straightsAndFlushes && cards.length === 5) {
    const flush = cards.every((c) => c[1] === cards[0][1]);
    let straightHigh = 0;
    if (ranks.length === 5) {
      if (ranks[0] - ranks[4] === 4) straightHigh = ranks[0];
      else if (rules.wheel && ranks[0] === 14 && ranks[1] === 5) straightHigh = 5;
    }
    if (straightHigh) {
      // The wheel reads 5-4-3-2-A, so move the ace to the end.
      const display = straightHigh === 5 && ranks[0] === 14 ? [...sorted.slice(1), sorted[0]] : sorted;
      return {
        category: flush ? HIGH_CATEGORY.straightFlush : HIGH_CATEGORY.straight,
        ranks: [straightHigh],
        cards: display,
      };
    }
    if (flush) return { category: HIGH_CATEGORY.flush, ranks, cards: sorted };
  }

  const [a, b = 0] = groups.map((g) => g[1]);
  let category: number = HIGH_CATEGORY.highCard;
  if (a === 4) category = HIGH_CATEGORY.quads;
  else if (a === 3 && b === 2) category = HIGH_CATEGORY.fullHouse;
  else if (a === 3) category = HIGH_CATEGORY.trips;
  else if (a === 2 && b === 2) category = HIGH_CATEGORY.twoPair;
  else if (a === 2) category = HIGH_CATEGORY.pair;
  return { category, ranks, cards: sorted };
}

/** Comparable integer: category first, then up to five rank digits. */
export function codeOf(shape: Shape): number {
  let code = shape.category;
  for (let i = 0; i < 5; i++) code = code * DIGIT + (shape.ranks[i] ?? 0);
  return code;
}

/** Name of a made hand in high terms ("Full House, Kings full of Fives"). */
export function madeHandName(shape: Shape): string {
  const [r0, r1] = shape.ranks;
  switch (shape.category) {
    case HIGH_CATEGORY.straightFlush:
      return r0 === 14 ? 'Royal Flush' : `Straight Flush, ${rankName(r0)} high`;
    case HIGH_CATEGORY.quads:
      return `Four of a Kind, ${rankPlural(r0)}`;
    case HIGH_CATEGORY.fullHouse:
      return `Full House, ${rankPlural(r0)} full of ${rankPlural(r1)}`;
    case HIGH_CATEGORY.flush:
      return `Flush, ${rankName(r0)} high`;
    case HIGH_CATEGORY.straight:
      return `Straight, ${rankName(r0)} high`;
    case HIGH_CATEGORY.trips:
      return `Three of a Kind, ${rankPlural(r0)}`;
    case HIGH_CATEGORY.twoPair:
      return `Two Pair, ${rankPlural(r0)} and ${rankPlural(r1)}`;
    case HIGH_CATEGORY.pair:
      return `Pair of ${rankPlural(r0)}`;
    default:
      return `${rankName(r0)} high`;
  }
}

/** All k-element subsets, in a stable order. */
export function combinations<T>(items: T[], k: number): T[][] {
  const out: T[][] = [];
  const pick: T[] = [];
  const walk = (start: number) => {
    if (pick.length === k) {
      out.push(pick.slice());
      return;
    }
    for (let i = start; i <= items.length - (k - pick.length); i++) {
      pick.push(items[i]);
      walk(i + 1);
      pick.pop();
    }
  };
  walk(0);
  return out;
}

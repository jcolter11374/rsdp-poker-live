import { Card, rankOf, suitOf } from './cards';

export const CATEGORY_NAMES = [
  'High Card',
  'Pair',
  'Two Pair',
  'Three of a Kind',
  'Straight',
  'Flush',
  'Full House',
  'Four of a Kind',
  'Straight Flush',
] as const;

export interface HandValue {
  /** Higher is better. Comparable across any two hands. */
  score: number;
  category: number;
  name: string;
  /** The five cards that make the hand. */
  cards: Card[];
}

function encode(category: number, ranks: number[]): number {
  let score = category;
  for (let i = 0; i < 5; i++) score = score * 16 + (ranks[i] ?? 0);
  return score;
}

/** Highest card of a straight in these ranks (5 for the wheel), or 0. */
function straightHigh(ranksDesc: number[]): number {
  const uniq = [...new Set(ranksDesc)];
  if (uniq.length !== 5) return 0;
  if (uniq[0] - uniq[4] === 4) return uniq[0];
  if (uniq[0] === 14 && uniq[1] === 5 && uniq[4] === 2) return 5;
  return 0;
}

export function evaluate5(cards: Card[]): number {
  const ranks = cards.map(rankOf).sort((a, b) => b - a);
  const flush = cards.every((c) => suitOf(c) === suitOf(cards[0]));
  const high = straightHigh(ranks);

  if (flush && high) return encode(8, [high]);

  const counts = new Map<number, number>();
  for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1);
  // Group ranks by count, then by rank, both descending.
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const ordered = groups.map((g) => g[0]);
  const shape = groups.map((g) => g[1]).join('');

  if (shape === '41') return encode(7, ordered);
  if (shape === '32') return encode(6, ordered);
  if (flush) return encode(5, ranks);
  if (high) return encode(4, [high]);
  if (shape === '311') return encode(3, ordered);
  if (shape === '221') return encode(2, ordered);
  if (shape === '2111') return encode(1, ordered);
  return encode(0, ranks);
}

/** Best five-card hand from 5 to 7 cards. */
export function evaluate(cards: Card[]): HandValue {
  if (cards.length < 5) throw new Error('need at least 5 cards');
  let best = -1;
  let bestCards: Card[] = [];
  const n = cards.length;
  for (let a = 0; a < n; a++)
    for (let b = a + 1; b < n; b++)
      for (let c = b + 1; c < n; c++)
        for (let d = c + 1; d < n; d++)
          for (let e = d + 1; e < n; e++) {
            const five = [cards[a], cards[b], cards[c], cards[d], cards[e]];
            const s = evaluate5(five);
            if (s > best) {
              best = s;
              bestCards = five;
            }
          }
  const category = Math.floor(best / 16 ** 5);
  return { score: best, category, name: CATEGORY_NAMES[category], cards: bestCards };
}

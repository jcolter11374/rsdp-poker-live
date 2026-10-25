import type { Card } from '../../cards';
import { assertDistinct, combinations, DIGIT, rankList, rankName, rankValue } from './shape';
import type { HandRank } from './types';

const SIZE_NAME = ['', 'One-card', 'Two-card', 'Three-card', 'Badugi'];

/**
 * Badugi: the largest set of cards with no repeated suit or rank wins, then the
 * lowest such set, compared highest card first. Aces are low.
 */
export function bestBadugi(cards: Card[]): HandRank {
  if (cards.length === 0 || cards.length > 4) throw new Error('badugi needs 1 to 4 cards');
  assertDistinct(cards);
  for (let size = cards.length; size >= 1; size--) {
    let best: HandRank | null = null;
    for (const set of combinations(cards, size)) {
      const ranks = set.map((c) => rankValue(c, true));
      if (new Set(ranks).size !== size || new Set(set.map((c) => c[1])).size !== size) continue;
      const order = set.map((c, i) => ({ c, r: ranks[i] })).sort((a, b) => b.r - a.r);
      const desc = order.map((o) => o.r);
      // Size first, then each rank from the top; a lower rank earns a bigger digit.
      let score = size;
      for (let i = 0; i < 4; i++) score = score * DIGIT + (i < size ? 14 - desc[i] : 0);
      if (!best || score > best.score) {
        best = {
          score,
          name: size === 4 ? `Badugi, ${rankName(desc[0])} high` : `${SIZE_NAME[size]}, ${rankName(desc[0])} high`,
          detail: rankList(desc),
          cards: order.map((o) => o.c),
        };
      }
    }
    if (best) return best;
  }
  throw new Error('unreachable');
}

export const evaluateBadugi = (hole: Card[], board: Card[]) => bestBadugi([...hole, ...board]);

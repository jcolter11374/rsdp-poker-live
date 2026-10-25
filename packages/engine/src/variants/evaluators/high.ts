import type { Card } from '../../cards';
import { assertDistinct, codeOf, combinations, madeHandName, shapeOf, type ShapeRules } from './shape';
import type { HandRank } from './types';

const HIGH: ShapeRules = { aceLow: false, straightsAndFlushes: true, wheel: true };

function rankFive(cards: Card[]): HandRank {
  const shape = shapeOf(cards, HIGH);
  return { score: codeOf(shape), name: madeHandName(shape), cards: shape.cards };
}

/**
 * Best high hand from any cards (Hold'em, Stud, the high half of Stud Hi-Lo).
 * With fewer than five cards (stud up cards) only pairs, trips and quads count.
 */
export function bestHigh(cards: Card[]): HandRank {
  if (cards.length === 0) throw new Error('no cards');
  assertDistinct(cards);
  if (cards.length <= 5) return rankFive(cards);
  let best: HandRank | null = null;
  for (const five of combinations(cards, 5)) {
    const r = rankFive(five);
    if (!best || r.score > best.score) best = r;
  }
  return best!;
}

/** Any five of hole + board. */
export const evaluateHigh = (hole: Card[], board: Card[]): HandRank => bestHigh([...hole, ...board]);

/** Omaha: exactly two hole cards and exactly three board cards. */
export function evaluateOmahaHigh(hole: Card[], board: Card[]): HandRank {
  checkOmaha(hole, board);
  let best: HandRank | null = null;
  for (const two of combinations(hole, 2))
    for (const three of combinations(board, 3)) {
      const r = rankFive([...two, ...three]);
      if (!best || r.score > best.score) best = r;
    }
  return best!;
}

export function checkOmaha(hole: Card[], board: Card[]) {
  if (hole.length < 2) throw new Error('Omaha needs at least 2 hole cards');
  if (board.length < 3) throw new Error('Omaha needs at least 3 board cards');
  assertDistinct([...hole, ...board]);
}

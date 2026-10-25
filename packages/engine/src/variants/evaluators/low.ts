import type { Card } from '../../cards';
import { checkOmaha } from './high';
import {
  assertDistinct,
  CODE_LIMIT,
  codeOf,
  combinations,
  HIGH_CATEGORY,
  madeHandName,
  rankList,
  rankName,
  shapeOf,
  type Shape,
  type ShapeRules,
} from './shape';
import type { HandRank } from './types';

/** Ace-to-five: aces low, straights and flushes ignored (Razz, the low half of hi-lo games). */
const ACE_TO_FIVE: ShapeRules = { aceLow: true, straightsAndFlushes: false, wheel: false };
/** Deuce-to-seven: aces high, straights and flushes count, A-2-3-4-5 is not a straight. */
const DEUCE_TO_SEVEN: ShapeRules = { aceLow: false, straightsAndFlushes: true, wheel: false };

/** "Seven-Five low" for an unpaired hand, the made-hand name otherwise. */
function lowName(shape: Shape): string {
  if (shape.category !== HIGH_CATEGORY.highCard) return madeHandName(shape);
  if (shape.ranks.length === 1) return `${rankName(shape.ranks[0])} low`;
  return `${rankName(shape.ranks[0])}-${rankName(shape.ranks[1])} low`;
}

/** Inverts the high code so the lowest hand gets the highest score. */
function rankLow(cards: Card[], rules: ShapeRules): HandRank {
  return lowFromShape(shapeOf(cards, rules));
}

function lowFromShape(shape: Shape): HandRank {
  const unpaired = shape.category === HIGH_CATEGORY.highCard;
  return {
    score: CODE_LIMIT - codeOf(shape),
    name: lowName(shape),
    detail: unpaired ? rankList(shape.ranks) : undefined,
    cards: shape.cards,
  };
}

function bestOf(cards: Card[], rank: (five: Card[]) => HandRank | null): HandRank | null {
  if (cards.length === 0) throw new Error('no cards');
  assertDistinct(cards);
  if (cards.length <= 5) return rank(cards);
  let best: HandRank | null = null;
  for (const five of combinations(cards, 5)) {
    const r = rank(five);
    if (r && (!best || r.score > best.score)) best = r;
  }
  return best;
}

/** Five unpaired cards, all `qualifier` or lower (aces count as 1). */
function rankQualifiedLow(five: Card[], qualifier: number): HandRank | null {
  if (five.length !== 5) return null;
  const shape = shapeOf(five, ACE_TO_FIVE);
  return shape.category === HIGH_CATEGORY.highCard && shape.ranks[0] <= qualifier ? lowFromShape(shape) : null;
}

/**
 * Razz: best ace-to-five low from any five cards, with no qualifier. Pairs are
 * bad but still play. With fewer than five cards (up cards) it ranks what is there.
 */
export function bestLowAceToFive(cards: Card[]): HandRank {
  return bestOf(cards, (five) => rankLow(five, ACE_TO_FIVE))!;
}

/** Stud Hi-Lo low half: five unpaired cards 8 or lower from any five, or null. */
export function bestLowEight(cards: Card[]): HandRank | null {
  if (cards.length < 5) return null;
  return bestOf(cards, (five) => rankQualifiedLow(five, 8));
}

/** 2-7 lowball: best deuce-to-seven low from five (or more) cards. */
export function bestLowDeuceToSeven(cards: Card[]): HandRank {
  if (cards.length < 5) throw new Error('deuce-to-seven needs 5 cards');
  return bestOf(cards, (five) => rankLow(five, DEUCE_TO_SEVEN))!;
}

/** Omaha Hi-Lo low half: exactly two hole and three board cards, 8 or better, or null. */
export function evaluateOmahaLowEight(hole: Card[], board: Card[]): HandRank | null {
  checkOmaha(hole, board);
  let best: HandRank | null = null;
  for (const two of combinations(hole, 2))
    for (const three of combinations(board, 3)) {
      const r = rankQualifiedLow([...two, ...three], 8);
      if (r && (!best || r.score > best.score)) best = r;
    }
  return best;
}

export const evaluateRazz = (hole: Card[], board: Card[]) => bestLowAceToFive([...hole, ...board]);
export const evaluateLowEight = (hole: Card[], board: Card[]) => bestLowEight([...hole, ...board]);
export const evaluateDeuceToSeven = (hole: Card[], board: Card[]) => bestLowDeuceToSeven([...hole, ...board]);

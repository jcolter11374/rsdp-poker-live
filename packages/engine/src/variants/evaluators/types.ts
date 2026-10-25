import type { Card } from '../../cards';

/** One evaluated hand. Within one evaluator, the higher score always wins. */
export interface HandRank {
  score: number;
  /** Readable label, e.g. "Full House, Kings full of Fives" or "Seven-Five low". */
  name: string;
  /** Low and badugi hands: ranks highest first, e.g. "8-6-4-2-A". */
  detail?: string;
  /** The cards that make the hand, in display order. */
  cards: Card[];
}

/**
 * Every evaluator takes a player's own cards and the board. Stud and draw games
 * pass every card the player holds as `hole` and an empty board. Returns null
 * when the player has no qualifying hand (e.g. no 8-or-better low).
 */
export type Evaluator = (hole: Card[], board: Card[]) => HandRank | null;

export function compareHands(a: HandRank | null, b: HandRank | null): number {
  return (a?.score ?? -1) - (b?.score ?? -1);
}

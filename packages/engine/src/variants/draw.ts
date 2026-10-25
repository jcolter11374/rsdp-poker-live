import { shuffle, type Card } from '../cards';
import type { Rng } from '../core/types';

export interface DrawResult {
  /** Replacement cards, in the order dealt. */
  cards: Card[];
  /** What is left to deal, next card first. */
  stub: Card[];
  /** Discards waiting to be reshuffled, now including this player's. */
  muck: Card[];
  /** True when the muck was shuffled back in to finish this draw. */
  reshuffled: boolean;
}

/**
 * Deals replacements for one player's discards in a draw game.
 *
 * Cards come off the top of the stub. The last card of the stub is never dealt:
 * when the stub runs short, that card and the muck (earlier discards and folded
 * hands, but not this player's discards from this draw) are shuffled into a new
 * stub. This player's discards join the muck afterwards. Throws if even the
 * reshuffle cannot cover the draw.
 */
export function drawReplacements(args: {
  discards: Card[];
  stub: Card[];
  muck: Card[];
  rng: Rng;
  maxDiscard?: number;
}): DrawResult {
  const { discards, rng, maxDiscard } = args;
  if (maxDiscard !== undefined && discards.length > maxDiscard) {
    throw new Error(`at most ${maxDiscard} discards`);
  }
  if (new Set(discards).size !== discards.length) throw new Error('duplicate discards');
  let stub = args.stub.slice();
  let muck = args.muck.slice();
  let reshuffled = false;
  const need = discards.length;
  const cards: Card[] = [];

  if (need >= stub.length && muck.length > 0) {
    // Deal all but the last card, then rebuild the stub from it and the muck.
    cards.push(...stub.slice(0, stub.length - 1));
    stub = shuffle([...stub.slice(stub.length - 1), ...muck], rng);
    muck = [];
    reshuffled = true;
  }
  const rest = need - cards.length;
  if (rest > stub.length) throw new Error(`not enough cards to draw ${need}`);
  cards.push(...stub.slice(0, rest));
  stub = stub.slice(rest);
  return { cards, stub, muck: [...muck, ...discards], reshuffled };
}

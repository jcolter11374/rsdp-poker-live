import { describe, expect, it } from 'vitest';
// @ts-expect-error no types published
import { Hand as SolverHand } from 'pokersolver';
import { evaluate, freshDeck, shuffle } from '../src';

/** Cross-checks our evaluator against an independent open-source one on random deals. */
describe('evaluator vs pokersolver', () => {
  it('agrees on who wins 20,000 random heads-up showdowns', () => {
    let seed = 7;
    const rng = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let i = 0; i < 20000; i++) {
      const d = shuffle(freshDeck(), rng);
      const board = d.slice(0, 5);
      const a = [...d.slice(5, 7), ...board];
      const b = [...d.slice(7, 9), ...board];
      const ours = Math.sign(evaluate(a).score - evaluate(b).score);
      const ha = SolverHand.solve(a);
      const hb = SolverHand.solve(b);
      const winners = SolverHand.winners([ha, hb]);
      const theirs = winners.length === 2 ? 0 : winners[0] === ha ? 1 : -1;
      if (ours !== theirs) throw new Error(`disagree on ${a.join(' ')} vs ${b.join(' ')}: ours ${ours}, theirs ${theirs}`);
    }
    expect(true).toBe(true);
  });
});

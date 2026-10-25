import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  evaluateBadugi,
  evaluateDeuceToSeven,
  evaluateHigh,
  evaluateLowEight,
  evaluateOmahaHigh,
  evaluateOmahaLowEight,
  evaluateRazz,
  type Evaluator,
} from '../../src/variants';

/**
 * Random showdowns ranked by pokerkit (see fixtures/crosscheck.py). For every
 * pair of hands in a group, our evaluator must agree on better, worse, tie, or
 * no qualifying hand. CROSSCHECK_FIXTURE points at a bigger generated file.
 */
const EVALUATORS: Record<string, Evaluator> = {
  high7: evaluateHigh,
  'stud-high': evaluateHigh,
  'omaha4-high': evaluateOmahaHigh,
  'omaha5-high': evaluateOmahaHigh,
  'omaha6-high': evaluateOmahaHigh,
  'omaha4-low8': evaluateOmahaLowEight,
  'omaha5-low8': evaluateOmahaLowEight,
  'omaha6-low8': evaluateOmahaLowEight,
  'stud-low8': evaluateLowEight,
  razz: evaluateRazz,
  'deuce-seven': evaluateDeuceToSeven,
  badugi: evaluateBadugi,
};

interface Group {
  board: string[];
  holes: string[][];
  ranks: (number | null)[];
}

const path = process.env.CROSSCHECK_FIXTURE ?? new URL('./fixtures/crosscheck.json', import.meta.url);
const data: { kinds: Record<string, Group[]> } = JSON.parse(readFileSync(path, 'utf8'));

describe('cross-check against pokerkit', () => {
  it('covers every evaluator', () => {
    expect(Object.keys(data.kinds).sort()).toEqual(Object.keys(EVALUATORS).sort());
  });

  for (const [kind, groups] of Object.entries(data.kinds)) {
    it(kind, () => {
      const evaluate = EVALUATORS[kind];
      let mismatches = 0;
      for (const g of groups) {
        const scores = g.holes.map((h) => evaluate(h, g.board)?.score ?? null);
        for (let i = 0; i < scores.length; i++) {
          expect(scores[i] === null, `${kind} qualify ${g.holes[i]} | ${g.board}`).toBe(g.ranks[i] === null);
          for (let j = i + 1; j < scores.length; j++) {
            const [a, b, ra, rb] = [scores[i], scores[j], g.ranks[i], g.ranks[j]];
            if (a === null || b === null || ra === null || rb === null) continue;
            if (Math.sign(a - b) !== Math.sign(ra - rb)) {
              mismatches++;
              expect.fail(`${kind}: ${g.holes[i]} vs ${g.holes[j]} on ${g.board}`);
            }
          }
        }
      }
      expect(mismatches).toBe(0);
    });
  }
});

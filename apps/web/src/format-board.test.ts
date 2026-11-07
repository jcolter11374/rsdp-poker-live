import { describe, expect, it } from 'vitest';
import { engine, type HandState } from '@rsdp/engine/core';
import { start } from '../../../packages/engine/test/core/harness';
import { eventLines } from './format';

/** Heads up, run twice: check and call until `boardCards` are out, then all in and called. */
function ranTwice(boardCards: number): HandState {
  const s = start({ stacks: [100, 100], options: { runItTwice: 'always' } });
  while (s.runs[0][0].length < boardCards) {
    const legal = engine.legalActions(s, s.toAct!)!;
    engine.act(s, s.toAct!, legal.canCheck ? { type: 'check' } : { type: 'call' });
  }
  engine.act(s, s.toAct!, { type: 'raise', to: engine.legalActions(s, s.toAct!)!.maxTo });
  engine.act(s, s.toAct!, { type: 'call' });
  return s;
}

/** The log's board lines, without the cards. */
const boardLines = (s: HandState) =>
  eventLines(s.events, (seat) => `P${seat}`, String)
    .filter((l) => /^(Flop|Turn|River|Board)\b/.test(l))
    .map((l) => l.split(':')[0]);

describe('log lines for run it twice (#372)', () => {
  it("names the second run's turn and river after an all in on the flop", () => {
    expect(boardLines(ranTwice(3))).toEqual(['Flop', 'Turn (run 1)', 'River (run 1)', 'Turn (run 2)', 'River (run 2)']);
  });

  it("names the second run's river after an all in on the turn", () => {
    expect(boardLines(ranTwice(4))).toEqual(['Flop', 'Turn', 'River (run 1)', 'River (run 2)']);
  });

  it('names both runs from the flop after an all in before it', () => {
    expect(boardLines(ranTwice(0))).toEqual(['Flop (run 1)', 'Turn (run 1)', 'River (run 1)', 'Flop (run 2)', 'Turn (run 2)', 'River (run 2)']);
  });
});

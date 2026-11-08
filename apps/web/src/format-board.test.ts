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

describe('stud streets in the log', () => {
  it("names the street before its cards, also when the deck runs short and seventh street's card is shared", () => {
    const deal = (seat: number, card: string, up = true) => ({ t: 'deal', seat, cards: [{ card, up }], pos: [] });
    const events = [
      { t: 'hand-start', handNumber: 1, gameId: 'stud', betting: 'fixed-limit', stakes: { smallBet: 2, bigBet: 4, ante: 0, bringIn: 1 } },
      { t: 'deal', seat: 0, cards: [{ card: 'As', up: false }, { card: 'Ad', up: false }, { card: '9c', up: true }], pos: [] },
      { t: 'action', seat: 0, action: 'check', amount: 0, to: 0, allIn: false, auto: false },
      deal(0, '8c'),
      { t: 'street', street: 1, name: 'Fourth Street' },
      deal(0, '7c'),
      { t: 'street', street: 2, name: 'Fifth Street' },
      deal(0, '6c'),
      { t: 'street', street: 3, name: 'Sixth Street' },
      { t: 'board', run: 0, board: 0, cards: ['5h'], pos: [48] },
      { t: 'street', street: 4, name: 'Seventh Street' },
    ] as unknown as Parameters<typeof eventLines>[0];
    const lines = eventLines(events, (seat) => `P${seat}`, String, 0).slice(1);
    expect(lines).toEqual([
      'You are dealt [As] [Ad] [9c]',
      'P0 checks',
      '— Fourth Street —',
      'You are dealt [8c]',
      '— Fifth Street —',
      'You are dealt [7c]',
      '— Sixth Street —',
      'You are dealt [6c]',
      '— Seventh Street —',
      'Board: [5h]',
    ]);
    // Cut short anywhere, it reads the same as far as it goes (a replay's step, a runout shown a street at a time).
    for (let n = 1; n <= events.length; n++) expect(lines.slice(0, Math.max(0, eventLines(events.slice(0, n), (seat) => `P${seat}`, String, 0).length - 1))).toEqual(eventLines(events.slice(0, n), (seat) => `P${seat}`, String, 0).slice(1));
  });
});

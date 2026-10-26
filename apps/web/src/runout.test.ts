import { describe, expect, it } from 'vitest';
import type { HandEvent } from '@rsdp/engine/core';
import type { TableView } from '@rsdp/engine/wire';
import { holdBack } from './runout';

/** Two players all in before the flop, run twice: run 1 is 3h 4h 5h / 6h / 7h, run 2 shares nothing. */
function finished(): TableView {
  const events = [
    { seq: 1, t: 'action', seat: 0, action: 'call', amount: 100, to: 100, allIn: true, auto: false },
    { seq: 2, t: 'run-it', times: 2 },
    { seq: 3, t: 'board', run: 0, board: 0, cards: ['3h', '4h', '5h'] },
    { seq: 4, t: 'board', run: 0, board: 0, cards: ['6h'] },
    { seq: 5, t: 'board', run: 0, board: 0, cards: ['7h'] },
    { seq: 6, t: 'board', run: 1, board: 0, cards: ['3c', '4c', '5c'] },
    { seq: 7, t: 'board', run: 1, board: 0, cards: ['6c'] },
    { seq: 8, t: 'board', run: 1, board: 0, cards: ['Kd'] },
    { seq: 9, t: 'award', pot: 0, run: 0, board: 0, half: null, seat: 0, amount: 100 },
  ] as unknown as HandEvent[];
  const seat = (n: number, stack: number, won: number) => ({ seat: n, stack, won, handName: 'Straight', allIn: false });
  return {
    hand: {
      handNumber: 4,
      phase: 'complete',
      showdown: true,
      boards: [[['3h', '4h', '5h', '6h', '7h']], [['3c', '4c', '5c', '6c', 'Kd']]],
      pots: [],
      potTotal: 0,
      awards: [{ seat: 0, amount: 100 }, { seat: 1, amount: 100 }],
      events,
    },
    seats: [seat(0, 100, 100), seat(1, 100, 100)],
    log: [{ at: 10, text: 'Rosa calls' }, { at: 20, text: 'John wins 100' }],
    history: [{ handNumber: 3 }, { handNumber: 4 }],
    canShow: [0, 1],
    nextHandAt: 99,
    rabbit: { available: false, cards: null },
  } as unknown as TableView;
}

describe('holdBack', () => {
  it('shows no runout cards before the first step, and keeps the result back', () => {
    const v = holdBack(finished(), { logCut: 10 }, 0);
    expect(v.hand!.boards).toEqual([[[]], [[]]]);
    expect(v.hand!.phase).toBe('betting');
    expect(v.hand!.awards).toEqual([]);
    expect(v.hand!.pots).toEqual([{ amount: 200, eligible: [] }]);
    expect(v.hand!.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(v.seats.map((s) => [s!.stack, s!.won, s!.handName])).toEqual([[0, 0, null], [0, 0, null]]);
    expect(v.log).toHaveLength(1);
    expect(v.history.map((h) => h.handNumber)).toEqual([3]);
    expect(v.nextHandAt).toBeNull();
  });

  it('finishes the first run before the second appears', () => {
    expect(holdBack(finished(), { logCut: 10 }, 2).hand!.boards).toEqual([[['3h', '4h', '5h', '6h']], [[]]]);
    expect(holdBack(finished(), { logCut: 10 }, 4).hand!.boards).toEqual([[['3h', '4h', '5h', '6h', '7h']], [['3c', '4c', '5c']]]);
    const all = holdBack(finished(), { logCut: 10 }, 6);
    expect(all.hand!.boards).toEqual(finished().hand!.boards);
    expect(all.hand!.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

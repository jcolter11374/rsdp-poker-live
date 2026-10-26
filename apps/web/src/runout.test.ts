import { describe, expect, it } from 'vitest';
import type { HandEvent } from '@rsdp/engine/core';
import type { TableView } from '@rsdp/engine/wire';
import { holdBack, type Frozen } from './runout';

/** Two players all in before the flop, run twice: run 1 is 3h 4h 5h / 6h / 7h, run 2 shares nothing. */
function finished(): TableView {
  const events = [
    { seq: 0, t: 'hand-start', seats: [{ seat: 0, playerId: 'a', stack: 100 }, { seat: 1, playerId: 'b', stack: 120 }] },
    { seq: 1, t: 'action', seat: 0, action: 'call', amount: 100, to: 100, allIn: true, auto: false },
    { seq: 1.5, t: 'action', seat: 1, action: 'raise', amount: 120, to: 120, allIn: true, auto: false },
    { seq: 1.7, t: 'uncalled', seat: 1, amount: 20 },
    { seq: 2, t: 'run-it', times: 2 },
    { seq: 3, t: 'board', run: 0, board: 0, cards: ['3h', '4h', '5h'] },
    { seq: 4, t: 'board', run: 0, board: 0, cards: ['6h'] },
    { seq: 5, t: 'board', run: 0, board: 0, cards: ['7h'] },
    { seq: 6, t: 'board', run: 1, board: 0, cards: ['3c', '4c', '5c'] },
    { seq: 7, t: 'board', run: 1, board: 0, cards: ['6c'] },
    { seq: 8, t: 'board', run: 1, board: 0, cards: ['Kd'] },
    { seq: 9, t: 'award', pot: 0, run: 0, board: 0, half: null, seat: 0, amount: 100 },
  ] as unknown as HandEvent[];
  const seat = (n: number, stack: number, won: number) => ({ seat: n, playerId: 'ab'[n], stack, won, handName: 'Straight', allIn: false, inHand: true, folded: false, sittingOut: false, sitOutReason: null, leaving: false, waiting: false });
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
    seats: [seat(0, 100, 100), seat(1, 120, 100)],
    ledger: [{ playerId: 'a', net: 0 }],
    log: [{ at: 10, text: 'Rosa calls' }, { at: 20, text: 'John wins 100' }],
    history: [{ handNumber: 3 }, { handNumber: 4 }],
    me: { playerId: 'a', seat: 0 },
    nit: null,
    canShow: [0, 1],
    nextHandAt: 99,
    rabbit: { available: false, cards: null },
  } as unknown as TableView;
}

/** The table just before the runout. */
const before = (): Frozen => ({ logCut: 10, seats: finished().seats, ledger: [], me: { playerId: 'a', seat: 0 }, nit: null });

describe('holdBack', () => {
  it('shows no runout cards before the first step, and keeps the result back', () => {
    const v = holdBack(finished(), before(), 0);
    expect(v.hand!.boards).toEqual([[[]], [[]]]);
    expect(v.hand!.phase).toBe('betting');
    expect(v.hand!.awards).toEqual([]);
    expect(v.hand!.pots).toEqual([{ amount: 200, eligible: [] }]);
    expect(v.hand!.events.map((e) => e.seq)).toEqual([0, 1, 1.5, 1.7, 2]);
    expect(v.seats.map((s) => [s!.stack, s!.won, s!.handName, s!.allIn])).toEqual([[0, 0, null, true], [20, 0, null, false]]);
    expect(v.ledger).toEqual([]);
    expect(v.log).toHaveLength(1);
    expect(v.history.map((h) => h.handNumber)).toEqual([3]);
    expect(v.nextHandAt).toBeNull();
  });

  it('finishes the first run before the second appears', () => {
    expect(holdBack(finished(), before(), 2).hand!.boards).toEqual([[['3h', '4h', '5h', '6h']], [[]]]);
    expect(holdBack(finished(), before(), 4).hand!.boards).toEqual([[['3h', '4h', '5h', '6h', '7h']], [['3c', '4c', '5c']]]);
    const all = holdBack(finished(), before(), 6);
    expect(all.hand!.boards).toEqual(finished().hand!.boards);
    expect(all.hand!.events.map((e) => e.seq)).toEqual([0, 1, 1.5, 1.7, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('keeps players at the table who bust or leave when the hand ends', () => {
    const done = finished();
    const busted = { ...done.seats[0]!, stack: 0, won: 0, sittingOut: true, sitOutReason: 'busted' as const };
    const v = holdBack({ ...done, seats: [busted, null], me: { playerId: 'a', seat: null } }, before(), 0);
    expect(v.me.seat).toBe(0);
    expect(v.seats[0]).toMatchObject({ playerId: 'a', sittingOut: false, sitOutReason: null, stack: 0, allIn: true });
    expect(v.seats[1]).toMatchObject({ playerId: 'b', stack: 20 });
  });
});

// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runoutMs, type HandEvent } from '@rsdp/engine/core';
import type { TableView } from '@rsdp/engine/wire';
import { DEPART_FADE_MS, useShownTable } from './runout';

/** A tournament table: b (seat 1) is all in against a (seat 0) and is knocked out, c (seat 2) folded. */
function table() {
  const allIn = [
    { seq: 0, t: 'hand-start', seats: [{ seat: 0, playerId: 'a', stack: 300 }, { seat: 1, playerId: 'b', stack: 100 }, { seat: 2, playerId: 'c', stack: 300 }] },
    { seq: 1, t: 'show', seat: 0, cards: ['As', 'Ad'] },
    { seq: 2, t: 'show', seat: 1, cards: ['Kc', 'Kd'] },
  ];
  const result = [
    ...allIn,
    { seq: 3, t: 'run-it', times: 1 },
    { seq: 4, t: 'board', run: 0, board: 0, cards: ['2h', '7c', '9d'] },
    { seq: 5, t: 'board', run: 0, board: 0, cards: ['Js'] },
    { seq: 6, t: 'board', run: 0, board: 0, cards: ['3s'] },
    { seq: 7, t: 'hand-end', stacks: { 0: 400, 1: 0, 2: 300 } },
  ] as unknown as HandEvent[];
  const seat = (n: number, extra = {}) => ({ seat: n, playerId: 'abc'[n], name: 'P' + n, stack: 300, won: 0, handName: null, allIn: false, inHand: true, folded: false, cards: [{ card: '??', up: false }, { card: '??', up: false }], ...extra });
  const base = { mode: 'tournament', tournamentId: 'T', nextHandAt: 9000, serverNow: 1000, me: { playerId: 'c', seat: 2 }, log: [], history: [], ledger: [], nit: null, canShow: [], rabbit: { available: false, cards: null } };
  const before = {
    ...base,
    hand: { handNumber: 9, phase: 'betting', showdown: false, boards: [[[]]], pots: [], potTotal: 400, awards: [], events: allIn },
    seats: [seat(0), seat(1, { stack: 0, allIn: true }), seat(2, { folded: true })],
  } as unknown as TableView;
  const hand = { handNumber: 9, phase: 'complete', showdown: true, boards: [[['2h', '7c', '9d', 'Js', '3s']]], pots: [], potTotal: 0, awards: [{ seat: 0, amount: 200 }], events: result };
  const after = { ...base, hand, seats: [seat(0), null, seat(2, { folded: true })] } as unknown as TableView;
  // The table breaks after that hand: everyone left is moved to other tables, and it never deals again.
  const broken = { ...after, seats: [null, null, null], nextHandAt: null, me: { playerId: 'c', seat: null } } as unknown as TableView;
  return { before, after, broken };
}

describe('the table as shown, and what waits for it', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('holds back only while a runout is being dealt, not while a knocked-out player stays in their seat', () => {
    const { before, after, broken } = table();
    const { result, rerender } = renderHook(({ live }) => useShownTable(live), { initialProps: { live: before } });
    expect(result.current).toEqual({ view: before, runningOut: false });

    rerender({ live: after });
    expect(result.current.runningOut).toBe(true);
    expect(result.current.view!.hand!.boards[0][0]).toEqual([]);

    // Each street, then the settle beat.
    for (let i = 0; i < 10 && result.current.runningOut; i++) act(() => void vi.advanceTimersByTime(5_000));
    expect(result.current.runningOut).toBe(false);
    // Still shown in their seat, which is why the table shown isn't the server's.
    expect(result.current.view).not.toBe(after);
    expect(result.current.view!.seats[1]).toMatchObject({ playerId: 'b', departed: expect.any(String) });

    // A table that breaks never deals the hand that would clear them, and nothing waits on them.
    rerender({ live: broken });
    act(() => void vi.advanceTimersByTime(60_000));
    expect(result.current.view!.seats[1]).toMatchObject({ playerId: 'b' });
    expect(result.current.runningOut).toBe(false);
  });

  it("keeps a knocked-out player's seat through the result of a long runout, and fades it just before the next deal", () => {
    const { before, after } = table();
    // The server holds the next deal for the runout and the result; its view of the result is as old as the runout by
    // the time the result shows here.
    vi.setSystemTime(1000);
    const ms = runoutMs(after.hand!.events);
    const late = { ...after, nextHandAt: 1000 + ms + 6000 } as TableView;
    const { result, rerender } = renderHook(({ live }) => useShownTable(live, 0), { initialProps: { live: before } });
    rerender({ live: late });
    let t = 0;
    while (result.current.runningOut && t < 60_000) {
      act(() => void vi.advanceTimersByTime(100));
      t += 100;
      // Never fading while the cards are still coming.
      expect(result.current.view!.seats[1]?.departed).not.toBe('fading');
    }
    expect(result.current.view!.seats[1]).toMatchObject({ playerId: 'b', departed: 'out' });
    // Fades about a second before the next deal, by this clock.
    act(() => void vi.advanceTimersByTime(late.nextHandAt! - DEPART_FADE_MS - Date.now() - 200));
    expect(result.current.view!.seats[1]?.departed).toBe('out');
    act(() => void vi.advanceTimersByTime(400));
    expect(result.current.view!.seats[1]?.departed).toBe('fading');
  });

  it('shows a player knocked out in a hand dealt and run out in one update with that hand, not the last one', () => {
    const { before, after } = table();
    // The table before is the last hand's finished table: b folded it, and showed nothing new since.
    const seat = (n: number, extra = {}) => ({ ...before.seats[n]!, cards: [{ card: '6c', up: false }, { card: 'Qd', up: false }], ...extra });
    const last = {
      ...before,
      hand: { handNumber: 8, phase: 'complete', showdown: false, boards: [[[]]], pots: [], potTotal: 0, awards: [{ seat: 0, amount: 30 }], events: [] },
      seats: [seat(0), seat(1, { folded: true, lastAction: 'Fold', stack: 100, allIn: false }), seat(2, { folded: true })],
    } as unknown as TableView;
    const deals = [0, 1, 2].map((n, i) => ({ seq: 0.1 + i / 10, t: 'deal', seat: n, cards: [{ card: '??', up: false }, { card: '??', up: false }] }));
    const events = [after.hand!.events[0], ...deals, ...after.hand!.events.slice(1)] as unknown as HandEvent[];
    const now = { ...after, hand: { ...after.hand!, events } } as TableView;
    const { result, rerender } = renderHook(({ live }) => useShownTable(live), { initialProps: { live: last } });
    rerender({ live: now });
    expect(result.current.runningOut).toBe(true);
    // During the runout: this hand's cards (turned up as shown), in the hand, not folded.
    expect(result.current.view!.seats[1]).toMatchObject({ playerId: 'b', folded: false, inHand: true, lastAction: null });
    expect(result.current.view!.seats[1]!.cards.map((c) => c.card)).toEqual(['Kc', 'Kd']);
    for (let i = 0; i < 20 && result.current.runningOut; i++) act(() => void vi.advanceTimersByTime(1_000));
    // At the result: kept in their seat, marked out, so the table doesn't turn or close up.
    expect(result.current.view!.seats[1]).toMatchObject({ playerId: 'b', departed: 'out', folded: false });
  });
});

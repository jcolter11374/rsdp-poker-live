// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runoutMs, type HandEvent } from '@rsdp/engine/core';
import { defaultSettings, parseSettings } from '@rsdp/engine/settings';
import type { TableView } from '@rsdp/engine/wire';
import { useShownTable } from './runout';

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
});

describe("Dealer's choice while a runout is dealt out (#459)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /**
   * A cash table: the chooser, c, folded with the pick panel open. The host's waiting change makes the table bigger,
   * with the menu Badugi (6), Razz (8), Pot-Limit Omaha (9). `cash(view, coming, game, late)`: the view with that many
   * coming and that fallback, sent before the server had dealt the runout out itself, or after (`late`).
   */
  function dealersChoice() {
    const { before, after } = table();
    const fold = { seq: 0.5, t: 'action', seat: 2, action: 'fold', amount: 0, to: 0, allIn: false, auto: false } as unknown as HandEvent;
    const withFold = (h: TableView['hand']) => ({ ...h!, events: [h!.events[0], fold, ...h!.events.slice(1)] });
    const table6 = defaultSettings('cash');
    const nlhe = { gameId: 'nlhe', betting: 'no-limit' } as const;
    const settings = parseSettings({ ...table6, table: { ...table6.table, maxSeats: 6 }, seating: { ...table6.seating, waitlist: true }, game: { ...table6.game, dealersChoice: { enabled: true, games: [nlhe, { gameId: 'badugi', betting: 'fixed-limit' }], hands: 0, pickSeconds: 20 } } });
    const pendingSettings = { table: { maxSeats: 9 }, game: { dealersChoice: { games: [{ gameId: 'badugi', betting: 'fixed-limit' }, { gameId: 'razz', betting: 'fixed-limit' }, { gameId: 'plo4', betting: 'pot-limit' }] } } };
    const game = (gameId: string, gameName: string) => ({ gameId, betting: gameId === 'plo4' ? 'pot-limit' : 'fixed-limit', gameName });
    const choice = (comingCount: number, fallback: ReturnType<typeof game>) => ({ chip: 2, current: { ...nlhe, by: 'A', how: 'picked' }, handsLeft: 0, next: null, open: true, deadline: null, count: 3, cap: null, closed: false, defaultIndex: 0, canKeep: false, comingCount, fallback });
    const ends = 1000 + runoutMs(after.hand!.events);
    const cash = (v: TableView, coming: number, fallback: ReturnType<typeof game>, late = false) =>
      ({ ...v, mode: 'cash', tournamentId: null, settings, pendingSettings, hand: withFold(v.hand), choice: choice(coming, fallback), history: [{ handNumber: 9, endedAt: 1000, gameName: "No-Limit Hold'em" }], serverNow: late ? ends : 1000 }) as unknown as TableView;
    return { before, after, cash, razz: game('razz', 'Razz'), omaha: game('plo4', 'Pot-Limit Omaha') };
  }

  it('keeps the people coming, as the server counted them before it had dealt the runout out, until the result shows', () => {
    // Eight were coming before the result; someone joins the waitlist during the runout (nine). Then, after the server
    // has dealt the runout out itself but before the cards are all out here, it gives a busted player's seat to someone
    // waiting (eight). The nine stay until the result.
    const { before, after, cash, razz, omaha } = dealersChoice();
    const { result, rerender } = renderHook(({ live }) => useShownTable(live), { initialProps: { live: cash(before, 8, razz) } });
    rerender({ live: cash(after, 8, razz) });
    expect(result.current.runningOut).toBe(true);
    expect(result.current.view!.choice!.fallback).toMatchObject({ gameId: 'razz' });
    rerender({ live: cash(after, 9, omaha) });
    expect(result.current.view!.choice!.fallback).toMatchObject({ gameId: 'plo4' });
    act(() => void vi.advanceTimersByTime(1_000));
    rerender({ live: cash(after, 8, razz, true) });
    expect(result.current.runningOut).toBe(true);
    expect(result.current.view!.choice!.fallback).toMatchObject({ gameId: 'plo4' });
    // Newer counts don't hold up the cards: the runout ends when it would have.
    for (let i = 0; i < 10 && result.current.runningOut; i++) act(() => void vi.advanceTimersByTime(5_000));
    expect(result.current.runningOut).toBe(false);
    expect(result.current.view!.choice!.fallback).toMatchObject({ gameId: 'razz' });
  });

  it('follows the server while it is still dealing the runout out itself', () => {
    // Someone joins the waitlist during the runout and leaves again before the server has dealt it out: nothing there
    // depends on the result, so the eight coming show again at once.
    const { before, after, cash, razz, omaha } = dealersChoice();
    const { result, rerender } = renderHook(({ live }) => useShownTable(live), { initialProps: { live: cash(before, 8, razz) } });
    rerender({ live: cash(after, 8, razz) });
    rerender({ live: cash(after, 9, omaha) });
    expect(result.current.view!.choice!.fallback).toMatchObject({ gameId: 'plo4' });
    rerender({ live: cash(after, 8, razz) });
    expect(result.current.runningOut).toBe(true);
    expect(result.current.view!.choice!.fallback).toMatchObject({ gameId: 'razz' });
  });
});

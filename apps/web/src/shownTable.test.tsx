// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runoutMs, type HandEvent } from '@rsdp/engine/core';
import { defaultSettings, parseSettings } from '@rsdp/engine/settings';
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

/** A stud tournament hand: b (seat 1) is all in on third street, the rest is run out, and b is knocked out. */
type Card = { card: string; up: boolean };
const down = (card: string): Card => ({ card, up: false });
const up = (card: string): Card => ({ card, up: true });

function studFinished(): TableView {
  const events = [
    { seq: 0, t: 'hand-start', seats: [{ seat: 0, playerId: 'a', stack: 100 }, { seat: 1, playerId: 'b', stack: 100 }] },
    { seq: 1, t: 'post', seat: 0, kind: 'ante', amount: 1, live: false, allIn: false },
    { seq: 2, t: 'post', seat: 1, kind: 'ante', amount: 1, live: false, allIn: false },
    { seq: 3, t: 'deal', seat: 0, cards: [down('As'), down('Ad'), up('2c')] },
    { seq: 4, t: 'deal', seat: 1, cards: [down('Kc'), down('Kd'), up('Kh')] },
    { seq: 5, t: 'action', seat: 0, action: 'bet', amount: 99, to: 99, allIn: true, auto: false },
    { seq: 6, t: 'action', seat: 1, action: 'call', amount: 99, to: 99, allIn: true, auto: false },
    { seq: 7, t: 'show', seat: 0, cards: ['As', 'Ad'] },
    { seq: 8, t: 'show', seat: 1, cards: ['Kc', 'Kd'] },
    { seq: 9, t: 'run-it', times: 1 },
    { seq: 10, t: 'deal', seat: 0, cards: [up('3s')] },
    { seq: 11, t: 'deal', seat: 1, cards: [up('4h')] },
    { seq: 12, t: 'street', street: 1, name: 'Fourth Street' },
    { seq: 13, t: 'deal', seat: 0, cards: [up('5s')] },
    { seq: 14, t: 'deal', seat: 1, cards: [up('6h')] },
    { seq: 15, t: 'street', street: 2, name: 'Fifth Street' },
    { seq: 16, t: 'deal', seat: 0, cards: [up('7s')] },
    { seq: 17, t: 'deal', seat: 1, cards: [up('8h')] },
    { seq: 18, t: 'street', street: 3, name: 'Sixth Street' },
    { seq: 19, t: 'deal', seat: 0, cards: [down('9s')] },
    { seq: 20, t: 'deal', seat: 1, cards: [down('Th')] },
    { seq: 21, t: 'street', street: 4, name: 'Seventh Street' },
    { seq: 22, t: 'show', seat: 0, cards: ['9s'] }, { seq: 23, t: 'show', seat: 1, cards: ['Th'] },
    { seq: 24, t: 'award', pot: 0, run: 0, board: 0, half: 'scoop', seat: 0, amount: 200 },
    { seq: 25, t: 'hand-end', stacks: { 0: 200, 1: 0 } },
  ] as unknown as HandEvent[];
  const seat = (n: number, cards: Card[], extra = {}) => ({ seat: n, playerId: 'ab'[n], name: 'P' + n, stack: 100, won: 0, handName: null, allIn: false, inHand: true, folded: false, sittingOut: false, sitOutReason: null, leaving: false, waiting: false, cards, ...extra });
  const cards0 = [down('As'), down('Ad'), up('2c'), up('3s'), up('5s'), up('7s'), down('9s')];
  return {
    mode: 'tournament',
    hand: { handNumber: 7, gameId: 'stud', family: 'stud', phase: 'complete', showdown: true, boards: [[[]]], pots: [], potTotal: 0, awards: [{ seat: 0, amount: 200 }], events },
    seats: [seat(0, cards0, { stack: 200, won: 200, handName: 'Two pair' }), null],
    ledger: [{ playerId: 'a', net: 0 }],
    log: [{ at: 10, text: 'P0 bets' }, { at: 20, text: 'P0 wins 200' }],
    history: [{ handNumber: 6 }, { handNumber: 7 }],
    me: { playerId: 'a', seat: 0 },
    nit: null, canShow: [], nextHandAt: 99_000, serverNow: 1000,
    rabbit: { available: false, cards: null },
  } as unknown as TableView;
}

function studBefore(): TableView {
  const done = studFinished();
  const hand = { ...done.hand!, phase: 'betting', showdown: false, awards: [], events: done.hand!.events.filter((e) => e.seq <= 5) } as TableView['hand'];
  const seat1 = { seat: 1, playerId: 'b', name: 'P1', stack: 99, won: 0, handName: null, allIn: false, inHand: true, folded: false, sittingOut: false, sitOutReason: null, leaving: false, waiting: false, cards: [down('??'), down('??'), up('Kh')] };
  const seats = [{ ...done.seats[0]!, stack: 1, won: 0, handName: null, cards: done.seats[0]!.cards.slice(0, 3) }, seat1];
  return { ...done, hand, seats, log: done.log.slice(0, 1), history: [{ handNumber: 6 }], nextHandAt: null } as unknown as TableView;
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
    const { result, rerender } = renderHook(({ live, skew }: { live: TableView; skew?: number }) => useShownTable(live, skew ?? 0), { initialProps: { live: before } as { live: TableView; skew?: number } });
    rerender({ live: late });
    let t = 0;
    while (result.current.runningOut && t < 60_000) {
      act(() => void vi.advanceTimersByTime(100));
      t += 100;
      // Never fading while the cards are still coming.
      expect(result.current.view!.seats[1]?.departed).not.toBe('fading');
    }
    expect(result.current.view!.seats[1]).toMatchObject({ playerId: 'b', departed: 'out' });
    // An update while the result shows (a chat line, with its own clock reading) doesn't start the wait over.
    act(() => void vi.advanceTimersByTime(late.nextHandAt! - DEPART_FADE_MS - Date.now() - 400));
    rerender({ live: { ...late, serverNow: Date.now() + 3 } as TableView, skew: 3 });
    act(() => void vi.advanceTimersByTime(200));
    expect(result.current.view!.seats[1]?.departed).toBe('out');
    // Fades about a second before the next deal, by this clock.
    act(() => void vi.advanceTimersByTime(400));
    expect(result.current.view!.seats[1]?.departed).toBe('fading');
  });

  it('fades a knocked-out seat at once when the result shows here less than a second before the next deal', () => {
    const { before, after } = table();
    vi.setSystemTime(1000);
    const ms = runoutMs(after.hand!.events);
    // This device took longer over the runout than the server held the deal for.
    const late = { ...after, nextHandAt: 1000 + ms + 700 } as TableView;
    const { result, rerender } = renderHook(({ live }) => useShownTable(live), { initialProps: { live: before } });
    rerender({ live: late });
    for (let t = 0; result.current.runningOut && t < 60_000; t += 100) act(() => void vi.advanceTimersByTime(100));
    act(() => void vi.advanceTimersByTime(0));
    // Fading before the deal, not cut off by it.
    expect(Date.now()).toBeLessThan(late.nextHandAt!);
    expect(result.current.view!.seats[1]).toMatchObject({ playerId: 'b', departed: 'fading' });
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

  it('shows a player who folded in such a hand and has gone since as folded, not still in it', () => {
    const { before, after } = table();
    const last = { ...before, hand: { ...before.hand!, handNumber: 8, phase: 'complete', events: [] } } as unknown as TableView;
    const deals = [0, 1, 2].map((n, i) => ({ seq: 0.1 + i / 10, t: 'deal', seat: n, cards: [{ card: '??', up: false }, { card: '??', up: false }] }));
    // c, away, is folded by the table; then moved to another table as this one is balanced.
    const fold = { seq: 0.5, t: 'action', seat: 2, action: 'fold', amount: 0, to: 0, allIn: false, auto: true };
    const events = [after.hand!.events[0], ...deals, fold, ...after.hand!.events.slice(1)] as unknown as HandEvent[];
    const now = { ...after, me: { playerId: 'a', seat: 0 }, hand: { ...after.hand!, events }, seats: [after.seats[0], null, null] } as unknown as TableView;
    const { result, rerender } = renderHook(({ live }) => useShownTable(live), { initialProps: { live: last } });
    rerender({ live: now });
    expect(result.current.runningOut).toBe(true);
    expect(result.current.view!.seats[2]).toMatchObject({ playerId: 'c', folded: true, lastAction: 'Fold' });
    expect(result.current.view!.seats[1]).toMatchObject({ playerId: 'b', folded: false });
  });

  it("keeps every card a knocked-out stud player was dealt in the runout at the result", () => {
    const cards = (v: TableView | null) => v?.seats[1]?.cards.map((c) => c.card).join(' ');
    const { result, rerender } = renderHook(({ live }) => useShownTable(live), { initialProps: { live: studBefore() } });
    rerender({ live: studFinished() });
    // Not the finished table, even for the render that starts the runout.
    expect(result.current.runningOut).toBe(true);
    expect(cards(result.current.view)).toBe('Kc Kd Kh');
    for (let i = 0; i < 40 && result.current.runningOut; i++) act(() => void vi.advanceTimersByTime(500));
    expect(result.current.view!.seats[1]).toMatchObject({ playerId: 'b', departed: 'out' });
    expect(cards(result.current.view)).toBe('Kc Kd Kh 4h 6h 8h Th');
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
    // Sent at `at` ms after the hand ended: 'end' is when the server had dealt the runout out, 'late' a delayed
    // spectator's view of a moment in it.
    const cash = (v: TableView, coming: number, fallback: ReturnType<typeof game>, at: number | 'end' | 'late' = 0) =>
      ({ ...v, mode: 'cash', tournamentId: null, settings, pendingSettings, hand: withFold(v.hand), choice: choice(coming, fallback), history: [{ handNumber: 9, endedAt: 1000, gameName: "No-Limit Hold'em" }], serverNow: at === 'end' ? ends : at === 'late' ? ends + 30_000 : 1000 + at }) as unknown as TableView;
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
    rerender({ live: cash(after, 8, razz, 'end') });
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

  it("holds the most people coming in views that can't be told from after the server dealt it out", () => {
    // A spectator on a 30-second delay: every view is sent long after the moment it shows. And a player's view sent
    // just before the server had dealt the runout out, which may have been counted just after.
    const { before, after, cash, razz, omaha } = dealersChoice();
    for (const at of ['late', runoutMs(after.hand!.events) - 1] as const) {
      const { result, rerender } = renderHook(({ live }) => useShownTable(live), { initialProps: { live: cash(before, 8, razz) } });
      rerender({ live: cash(after, 8, razz, at === 'late' ? 'late' : 0) });
      rerender({ live: cash(after, 9, omaha, at) });
      rerender({ live: cash(after, 8, razz, at === 'late' ? 'late' : 'end') });
      expect(result.current.runningOut).toBe(true);
      expect(result.current.view!.choice!.fallback).toMatchObject({ gameId: 'plo4' });
    }
  });
});

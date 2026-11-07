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

/** The pause the server leaves for the result after a runout (a tournament's showdown seconds). */
const RESULT_MS = 6000;

/**
 * A tournament hand in which b (seat 1) goes all in against a (seat 0) and is knocked out: before the flop (the
 * runout deals the flop, turn and river), on the flop (turn and river), or with the board already out (no runout).
 * The next deal comes RESULT_MS after the runout, as the server holds it (runoutMs), or never (`dealNext` false).
 */
function knockout(street: 'preflop' | 'flop' | 'river', dealNext = true) {
  const streets = [['2h', '7c', '9d'], ['Js'], ['3s']];
  const before = street === 'preflop' ? 0 : street === 'flop' ? 1 : 3;
  const boardEvent = (cards: string[], seq: number) => ({ seq, t: 'board', run: 0, board: 0, cards });
  const dealt = [
    { seq: 0, t: 'hand-start', seats: [{ seat: 0, playerId: 'a', stack: 300 }, { seat: 1, playerId: 'b', stack: 100 }, { seat: 2, playerId: 'c', stack: 300 }] },
    ...streets.slice(0, before).map((cards, i) => boardEvent(cards, 1 + i)),
  ];
  let seq = dealt.length;
  const shows = [
    { seq: seq++, t: 'show', seat: 0, cards: ['As', 'Ad'] },
    { seq: seq++, t: 'show', seat: 1, cards: ['Kc', 'Kd'] },
  ];
  const runout = before < 3 ? [{ seq: seq++, t: 'run-it', times: 1 }, ...streets.slice(before).map((cards) => boardEvent(cards, seq++))] : [];
  const events = [...dealt, ...shows, ...runout, { seq: seq++, t: 'hand-end', stacks: { 0: 400, 1: 0, 2: 300 } }] as unknown as HandEvent[];
  const seat = (n: number, extra = {}) => ({ seat: n, playerId: 'abc'[n], name: 'P' + n, stack: 300, won: 0, handName: null, allIn: false, inHand: true, folded: false, cards: [{ card: '??', up: false }, { card: '??', up: false }], ...extra });
  const serverNow = 50_000;
  const base = { mode: 'tournament', tournamentId: 'T', nextHandAt: 40_000, serverNow: 40_000, me: { playerId: 'c', seat: 2 }, log: [], history: [], ledger: [], nit: null, canShow: [], rabbit: { available: false, cards: null } };
  const was = {
    ...base,
    hand: { handNumber: 9, phase: 'betting', showdown: false, boards: [[streets.slice(0, before).flat()]], pots: [], potTotal: 400, awards: [], events: dealt },
    seats: [seat(0), seat(1, { stack: 0, allIn: true }), seat(2, { folded: true })],
  } as unknown as TableView;
  const hand = { handNumber: 9, phase: 'complete', showdown: true, boards: [[streets.flat()]], pots: [], potTotal: 0, awards: [{ seat: 0, amount: 200 }], events };
  const runoutLasts = runoutMs(events);
  const after = { ...base, serverNow, nextHandAt: dealNext ? serverNow + runoutLasts + RESULT_MS : null, hand, seats: [seat(0), null, seat(2, { folded: true })] } as unknown as TableView;
  return { before: was, after, runoutLasts };
}

/** Moves the clock on in small steps, so the table re-renders between them (each street of a runout is its own timer). */
function wait(ms: number) {
  for (let t = 0; t < ms; t += 20) act(() => void vi.advanceTimersByTime(Math.min(20, ms - t)));
}

describe("a knocked-out player's seat (#456)", () => {
  // The computer's clock reads the server's when the hand ends, as the table's clock skew makes it in the app.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(50_000);
  });
  afterEach(() => vi.useRealTimers());

  /** The hook's table, the hand having just finished; and how the knocked-out seat stands now. */
  function start(street: 'preflop' | 'flop' | 'river', dealNext = true) {
    const k = knockout(street, dealNext);
    const hook = renderHook(({ live }) => useShownTable(live), { initialProps: { live: k.before } });
    hook.rerender({ live: k.after });
    const seat = () => hook.result.current.view!.seats[1];
    return { ...k, ...hook, seat };
  }

  for (const street of ['preflop', 'flop', 'river'] as const) {
    it(`stays through the result and fades just before the next deal, all in ${street === 'river' ? 'with the board out' : street === 'preflop' ? 'before the flop' : 'on the flop'}`, () => {
      const { runoutLasts, seat, result } = start(street);
      expect(runoutLasts > 0).toBe(street !== 'river');
      // Dealt out a street at a time, with the player still in the hand.
      wait(runoutLasts + 100);
      expect(result.current.runningOut).toBe(false);
      expect(seat()).toMatchObject({ playerId: 'b', departed: 'out' });
      // The whole result, until a moment before the next deal.
      wait(RESULT_MS - DEPART_FADE_MS - 400);
      expect(seat()).toMatchObject({ playerId: 'b', departed: 'out' });
      wait(600);
      expect(seat()).toMatchObject({ playerId: 'b', departed: 'fading' });
    });
  }

  it("doesn't move the fade when the table updates during the result", () => {
    const { after, seat, rerender } = start('flop');
    wait(knockout('flop').runoutLasts + 2000);
    // A chat line, say: the server's clock has moved on by as much as this one's.
    rerender({ live: { ...after, chat: [{ at: 0, playerId: 'a', name: 'P0', text: 'gg' }], serverNow: after.serverNow + knockout('flop').runoutLasts + 2000 } as TableView });
    wait(RESULT_MS - 2000 - DEPART_FADE_MS - 400);
    expect(seat()).toMatchObject({ departed: 'out' });
    wait(600);
    expect(seat()).toMatchObject({ departed: 'fading' });
  });

  it('fades on time when the table updates just before the fade is due', () => {
    // At a tournament the table also updates when another table's hand starts or ends.
    const { after, runoutLasts, seat, rerender } = start('flop');
    const at = runoutLasts + RESULT_MS - DEPART_FADE_MS - 300;
    wait(at);
    rerender({ live: { ...after, serverNow: after.serverNow + at } as TableView });
    wait(200);
    expect(seat()).toMatchObject({ departed: 'out' });
    wait(200);
    expect(seat()).toMatchObject({ departed: 'fading' });
  });

  it("doesn't fade later for an update that was held up on the way", () => {
    const { after, runoutLasts, seat, rerender } = start('flop');
    wait(runoutLasts + 2000);
    // Sent 1.2s before it arrived: on its own it would put the next deal 1.2s later than it is.
    rerender({ live: { ...after, serverNow: after.serverNow + runoutLasts + 2000 - 1200 } as TableView });
    wait(RESULT_MS - 2000 - DEPART_FADE_MS - 400);
    expect(seat()).toMatchObject({ departed: 'out' });
    wait(600);
    expect(seat()).toMatchObject({ departed: 'fading' });
  });

  it('with no deal coming, fades a while after the result shows even while the table keeps updating', () => {
    const { after, runoutLasts, seat, rerender } = start('preflop', false);
    wait(runoutLasts);
    for (let i = 1; i <= 3; i++) {
      wait(2500);
      rerender({ live: { ...after, serverNow: after.serverNow + runoutLasts + i * 2500 } as TableView });
    }
    expect(seat()).toMatchObject({ departed: 'out' });
    wait(700);
    expect(seat()).toMatchObject({ departed: 'fading' });
  });

  it("doesn't move the fade when the computer's clock is set during the result", () => {
    const { after, runoutLasts, seat, rerender } = start('flop');
    wait(runoutLasts + 1000);
    // The computer's time jumps 3s ahead (a time sync, say), then the table updates.
    vi.setSystemTime(Date.now() + 3000);
    wait(500);
    rerender({ live: { ...after, serverNow: after.serverNow + runoutLasts + 1500 } as TableView });
    wait(RESULT_MS - 1500 - DEPART_FADE_MS - 400);
    expect(seat()).toMatchObject({ departed: 'out' });
    wait(600);
    expect(seat()).toMatchObject({ departed: 'fading' });
  });

  it('with no deal coming, stays a while after the result shows, not from when the hand ended', () => {
    const { runoutLasts, seat } = start('preflop', false);
    wait(runoutLasts + 7000);
    expect(seat()).toMatchObject({ playerId: 'b', departed: 'out' });
    wait(1500);
    expect(seat()).toMatchObject({ playerId: 'b', departed: 'fading' });
  });
});

// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RUNOUT_LAST_STEP_MS, RUNOUT_SETTLE_MS, RUNOUT_STEP_MS, runoutMs, type HandEvent } from '@rsdp/engine/core';
import type { TableView } from '@rsdp/engine/wire';
import { equityInput } from './components/table/Equity';
import { departures, heldCards, holdBack, useRunoutReveal, type Frozen } from './runout';

type Card = { card: string; up: boolean };
const down = (card: string): Card => ({ card, up: false });
const up = (card: string): Card => ({ card, up: true });

/**
 * Seven Card Stud, seen from seat 0: both players all in on third street, so fourth to seventh street are run out.
 * Seat 1's down cards were turned up when they went all in (and the last one at the end), so seat 0 sees them all.
 * With `shared`, a short deck puts seventh street's card in the middle instead.
 */
function finished(shared = false): TableView {
  const seventh: HandEvent[] = shared
    ? ([{ seq: 19, t: 'board', run: 0, board: 0, cards: ['9s'] }] as HandEvent[])
    : ([
        { seq: 19, t: 'deal', seat: 0, cards: [down('9s')] },
        { seq: 20, t: 'deal', seat: 1, cards: [down('Th')] },
      ] as HandEvent[]);
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
    ...seventh,
    { seq: 21, t: 'street', street: 4, name: 'Seventh Street' },
    ...(shared ? [] : [{ seq: 22, t: 'show', seat: 0, cards: ['9s'] }, { seq: 23, t: 'show', seat: 1, cards: ['Th'] }]),
    { seq: 24, t: 'award', pot: 0, run: 0, board: 0, half: 'scoop', seat: 0, amount: 200 },
    { seq: 25, t: 'hand-end', stacks: { 0: 200, 1: 0 } },
  ] as unknown as HandEvent[];
  const seat = (n: number, cards: Card[], extra = {}) => ({ seat: n, playerId: 'ab'[n], name: 'P' + n, stack: 100, won: 0, handName: null, allIn: false, inHand: true, folded: false, sittingOut: false, sitOutReason: null, leaving: false, waiting: false, cards, ...extra });
  const cards0 = [down('As'), down('Ad'), up('2c'), up('3s'), up('5s'), up('7s'), ...(shared ? [] : [down('9s')])];
  const cards1 = [down('Kc'), down('Kd'), up('Kh'), up('4h'), up('6h'), up('8h'), ...(shared ? [] : [down('Th')])];
  return {
    mode: 'tournament',
    hand: { handNumber: 7, gameId: 'stud', family: 'stud', phase: 'complete', showdown: true, boards: [[shared ? ['9s'] : []]], pots: [], potTotal: 0, awards: [{ seat: 0, amount: 200 }], events },
    seats: [seat(0, cards0, { stack: 200, won: 200, handName: 'Two pair' }), seat(1, cards1, { stack: 0, sittingOut: true, sitOutReason: 'busted' })],
    ledger: [{ playerId: 'a', net: 0 }],
    log: [{ at: 10, text: 'P0 bets' }, { at: 20, text: 'P0 wins 200' }],
    history: [{ handNumber: 6 }, { handNumber: 7 }],
    me: { playerId: 'a', seat: 0 },
    nit: null,
    canShow: [],
    nextHandAt: 99_000,
    serverNow: 1000,
    rabbit: { available: false, cards: null },
  } as unknown as TableView;
}

/** The table just before the all-in call: seat 1's down cards still hidden from seat 0. */
function beforeView(): TableView {
  const done = finished();
  const hand = { ...done.hand!, phase: 'betting', showdown: false, awards: [], events: done.hand!.events.filter((e) => e.seq <= 5) } as TableView['hand'];
  const seats = [
    { ...done.seats[0]!, stack: 1, won: 0, handName: null, cards: done.seats[0]!.cards.slice(0, 3) },
    { ...done.seats[1]!, stack: 99, sittingOut: false, sitOutReason: null, cards: [down('??'), down('??'), up('Kh')] },
  ];
  return { ...done, hand, seats, log: done.log.slice(0, 1), history: [{ handNumber: 6 }], nextHandAt: null } as unknown as TableView;
}

const frozen = (): Frozen => {
  const b = beforeView();
  return { logCut: 10, seats: b.seats, ledger: [], me: b.me, nit: null, rotation: null };
};
const cardsOf = (v: TableView, seat: number) => v.seats[seat]!.cards.map((c) => c.card).join(' ');

describe('a stud all-in runout, a street at a time (#216)', () => {
  it("deals each street's cards to every seat together, and keeps the result back", () => {
    const view = finished();
    const at = (shown: number) => holdBack(view, frozen(), shown);
    expect([0, 1, 2, 3, 4].map((n) => [cardsOf(at(n), 0), cardsOf(at(n), 1)])).toEqual([
      ['As Ad 2c', 'Kc Kd Kh'],
      ['As Ad 2c 3s', 'Kc Kd Kh 4h'],
      ['As Ad 2c 3s 5s', 'Kc Kd Kh 4h 6h'],
      ['As Ad 2c 3s 5s 7s', 'Kc Kd Kh 4h 6h 8h'],
      ['As Ad 2c 3s 5s 7s 9s', 'Kc Kd Kh 4h 6h 8h Th'],
    ]);
    // The street events come with their cards, so the hand log and the deal sound go street by street. The cards
    // turned up at the end wait for the result.
    expect(at(0).hand!.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(at(1).hand!.events.map((e) => e.seq).slice(10)).toEqual([10, 11, 12]);
    expect(at(4).hand!.events.map((e) => e.seq).slice(10)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]);
    for (const n of [0, 2, 4]) {
      expect(at(n).hand!).toMatchObject({ phase: 'betting', showdown: false, awards: [] });
      expect(at(n).seats.map((s) => [s!.stack, s!.won, s!.handName])).toEqual([[0, 0, null], [0, 0, null]]);
      expect(at(n).history.map((h) => h.handNumber)).toEqual([6]);
    }
    // Stud's last street goes to the seats: no face-down card waits on the board.
    expect(at(3).hand!.comingNext).toBeUndefined();
  });

  it('shows the shared card a short deck puts in the middle as the last street', () => {
    const view = finished(true);
    expect(holdBack(view, frozen(), 3).hand!.boards).toEqual([[[]]]);
    expect(cardsOf(holdBack(view, frozen(), 3), 1)).toBe('Kc Kd Kh 4h 6h 8h');
    expect(holdBack(view, frozen(), 3).hand!.comingNext).toBeUndefined();
    expect(holdBack(view, frozen(), 4).hand!.boards).toEqual([[['9s']]]);
    // Nothing waited face down for it, so it is dealt as usual. Were it hold'em's river, it would turn over instead.
    expect(heldCards(view.hand)).toEqual([]);
    expect(heldCards({ ...view.hand!, family: 'flop' })).toEqual(['9s']);
  });

  it('never shows a card the finished hand hides from this viewer', () => {
    // Seat 1 mucked seventh street at the end: seat 0 never sees it, during the runout or after.
    const view = finished();
    const hidden = (cards: Card[]) => cards.map((c) => (c.card === 'Th' ? down('??') : c));
    const events = view.hand!.events.filter((e) => !(e.t === 'show' && e.seat === 1 && e.seq > 9)).map((e) => (e.t === 'deal' && e.seat === 1 ? { ...e, cards: hidden(e.cards) } : e));
    const mucked = { ...view, hand: { ...view.hand!, events }, seats: [view.seats[0], { ...view.seats[1]!, cards: hidden(view.seats[1]!.cards) }] } as TableView;
    expect(cardsOf(holdBack(mucked, frozen(), 4), 1)).toBe('Kc Kd Kh 4h 6h 8h ??');
    for (let n = 0; n <= 4; n++) expect(JSON.stringify(holdBack(mucked, frozen(), n))).not.toContain('Th');
  });

  it('keeps a knocked-out player in their seat with the streets dealt so far, then to the next deal', () => {
    // The finished table has nobody in seat 1; the table before the runout had their down cards face down.
    const done = finished();
    const out = { ...done, seats: [done.seats[0], null] } as TableView;
    expect(cardsOf(holdBack(out, frozen(), 2), 1)).toBe('Kc Kd Kh 4h 6h');
    const last = holdBack(out, frozen(), 4);
    expect(last.seats[1]).toMatchObject({ playerId: 'b', stack: 0, allIn: true });
    expect(cardsOf(last, 1)).toBe('Kc Kd Kh 4h 6h 8h Th');
    // When the result shows they stay, every card in view, until the next hand.
    expect(departures(last, out, null)!.seats.get(1)!.cards.map((c) => c.card).join(' ')).toBe('Kc Kd Kh 4h 6h 8h Th');
  });

  it("gives the all-in percentages each street's cards as they come", () => {
    const view = finished();
    expect(equityInput(holdBack(view, frozen(), 0))!.input.hands.map((h) => h.cards.length)).toEqual([3, 3]);
    expect(equityInput(holdBack(view, frozen(), 2))!.input.hands.map((h) => h.cards.length)).toEqual([5, 5]);
  });
});

describe('the table paces a stud runout (#216)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a street every RUNOUT_STEP_MS, a longer wait before seventh street, then the result: as long as the server waits', () => {
    const { result, rerender } = renderHook(({ live }) => useRunoutReveal(live), { initialProps: { live: beforeView() } });
    const done = finished();
    rerender({ live: done });
    const cards = () => result.current!.seats[1]!.cards.length;
    const after = (ms: number) => act(() => vi.advanceTimersByTime(ms));
    expect(cards()).toBe(3);
    after(RUNOUT_STEP_MS - 1);
    expect(cards()).toBe(3);
    after(1);
    expect(cards()).toBe(4);
    after(RUNOUT_STEP_MS);
    expect(cards()).toBe(5);
    after(RUNOUT_STEP_MS);
    expect(cards()).toBe(6);
    after(RUNOUT_LAST_STEP_MS - 1);
    expect(cards()).toBe(6);
    after(1);
    expect(cards()).toBe(7);
    expect(result.current!.hand!.phase).toBe('betting');
    after(RUNOUT_SETTLE_MS);
    expect(result.current).toBe(done);
    // The server holds the next hand exactly as long.
    expect(3 * RUNOUT_STEP_MS + RUNOUT_LAST_STEP_MS + RUNOUT_SETTLE_MS).toBe(runoutMs(done.hand!.events));
  });

  it('opening the table during the runout shows the hand finished', () => {
    const done = finished();
    const { result } = renderHook(({ live }) => useRunoutReveal(live), { initialProps: { live: done } });
    expect(result.current).toBe(done);
  });
});

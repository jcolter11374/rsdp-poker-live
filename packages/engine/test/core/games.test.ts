import { describe, expect, it } from 'vitest';
import { freshDeck } from '../../src/cards';
import { engine, type HandState } from '../../src/core';
import { eventsOf, start } from './harness';

const { act, legalActions } = engine;
const STUD_STAKES = { ante: 1, anteType: 'per-player' as const, bringIn: 1, smallBet: 2, bigBet: 4 };

/** Calls or checks for everyone until the hand ends; stands pat on draws. */
function passive(state: HandState, draw: (seat: number, state: HandState) => number[] = () => []) {
  for (let i = 0; i < 500 && state.phase !== 'complete'; i++) {
    if (state.phase === 'drawing') {
      engine.draw(state, state.toAct!, draw(state.toAct!, state));
      continue;
    }
    const seat = state.toAct!;
    const legal = legalActions(state, seat)!;
    act(state, seat, legal.canCheck ? { type: 'check' } : legal.canBringIn ? { type: 'bring-in' } : { type: 'call' });
  }
  expect(state.phase).toBe('complete');
}

describe('seven card stud', () => {
  // Button lands on seat 1, so cards go 2, 0, 1: two down rounds, then the up card.
  const third = ['Qs', '7h', 'Th', 'Js', '8h', '6c', 'Kd', '2c', 'Ah'];
  const fourth = ['Kc', '3d', '5s'];

  it('antes, the lowest up card brings in, and the best hand showing acts first on fourth street', () => {
    const s = start({ game: 'stud', stacks: [100, 100, 100], stakes: STUD_STAKES, top: [...third, ...fourth] });
    expect(s.input.button).toBe(1);
    expect(eventsOf(s, 'post').map((e) => [e.seat, e.kind, e.amount, e.live])).toEqual([
      [0, 'ante', 1, false],
      [1, 'ante', 1, false],
      [2, 'ante', 1, false],
    ]);
    expect(s.seats.find((x) => x.seat === 0)!.cards.filter((c) => c.up).map((c) => c.card)).toEqual(['2c']);
    expect(s.toAct).toBe(0);
    expect(legalActions(s, 0)).toMatchObject({ canBringIn: true, canCheck: false, minTo: 2, maxTo: 2 });
    act(s, 0, { type: 'bring-in' });
    expect(legalActions(s, 1)).toMatchObject({ callAmount: 1, minTo: 2, maxTo: 2 });
    act(s, 1, { type: 'bet', to: 2 });
    expect(eventsOf(s, 'action').at(-1)).toMatchObject({ action: 'complete', to: 2 });
    act(s, 2, { type: 'call' });
    act(s, 0, { type: 'call' });
    expect(s.street).toBe(1);
    // Seat 2 shows a pair of kings.
    expect(s.toAct).toBe(2);
    expect(legalActions(s, 2)).toMatchObject({ canCheck: true, minTo: 2, maxTo: 2 });
  });

  it('an away bring-in seat posts the bring-in instead of folding', () => {
    const s = start({ game: 'stud', stacks: [100, 100, 100], stakes: STUD_STAKES, top: [...third, ...fourth], away: [0] });
    expect(eventsOf(s, 'action')[0]).toMatchObject({ seat: 0, action: 'bring-in', auto: true });
    expect(s.toAct).toBe(1);
  });

  it('down cards stay hidden from other players, up cards are public', () => {
    const s = start({ game: 'stud', stacks: [100, 100, 100], stakes: STUD_STAKES, top: [...third, ...fourth] });
    const seen = engine.visibleEvents(s, { seat: 1, seeAll: false }).filter((e) => e.t === 'deal');
    expect(seen.find((d) => d.seat === 0)!.cards.map((c) => c.card)).toEqual(['??', '??', '2c']);
  });

  it('eight players to seventh street share one card in the middle', () => {
    const s = start({ game: 'stud', stacks: Array(8).fill(100), stakes: STUD_STAKES });
    passive(s);
    const board = eventsOf(s, 'board');
    expect(board).toHaveLength(1);
    expect(s.runs[0][0]).toHaveLength(1);
    expect(s.seats.every((x) => x.cards.length === 6)).toBe(true);
    const all = [...s.seats.flatMap((x) => x.cards.map((c) => c.card)), ...s.runs[0][0]];
    expect(new Set(all).size).toBe(all.length);
    expect(s.seats.reduce((a, x) => a + x.stack, 0)).toBe(800);
  });

  it('stud hi-lo splits the pot between the best high and the best low', () => {
    let split = 0;
    for (let i = 0; i < 40 && !split; i++) {
      // Rotate the deck so each hand differs.
      const deck = freshDeck();
      const cut = (i * 5) % 52;
      const s = start({ game: 'stud8', stacks: [100, 100, 100, 100], stakes: STUD_STAKES, top: [...deck.slice(cut), ...deck.slice(0, cut)] });
      passive(s);
      const halves = new Set(eventsOf(s, 'award').map((a) => a.half));
      if (halves.has('low') && halves.has('high')) split++;
      expect(s.seats.reduce((a, x) => a + x.stack, 0)).toBe(400);
    }
    expect(split).toBeGreaterThan(0);
  });
});

describe('draw games', () => {
  it('2-7 triple draw: three draws, replacements are private, cards stay unique', () => {
    const s = start({ game: 'td27', stacks: [100, 100, 100], stakes: { smallBet: 2, bigBet: 4 } });
    expect(s.input.betting).toBe('fixed-limit');
    // Preflop: everyone calls.
    passive(s, (seat, st) => (st.street === 1 ? [0, 1] : st.street === 2 ? [0] : []));
    const draws = eventsOf(s, 'draw');
    expect(draws).toHaveLength(9);
    expect(draws.filter((d) => d.discarded === 2)).toHaveLength(3);
    expect(s.seats.every((x) => x.cards.length === 5)).toBe(true);
    const held = s.seats.flatMap((x) => x.cards.map((c) => c.card));
    expect(new Set(held).size).toBe(held.length);
  });

  it('other players see how many cards you drew, not which', () => {
    const s = start({ game: 'td27', stacks: [100, 100, 100] });
    passive(s, () => [0, 1]);
    const mid = start({ game: 'td27', stacks: [100, 100, 100] });
    for (let i = 0; i < 10 && mid.phase === 'betting'; i++) {
      const legal = legalActions(mid, mid.toAct!)!;
      act(mid, mid.toAct!, legal.canCheck ? { type: 'check' } : { type: 'call' });
    }
    expect(mid.phase).toBe('drawing');
    const drawer = mid.toAct!;
    engine.draw(mid, drawer, [0, 1]);
    const other = engine.visibleEvents(mid, { seat: (drawer + 1) % 3, seeAll: false }).find((e) => e.t === 'draw');
    expect(other).toMatchObject({ seat: drawer, discarded: 2, cards: ['??', '??'] });
    expect(other).not.toHaveProperty('positions');
    const own = engine.visibleEvents(mid, { seat: drawer, seeAll: false }).find((e) => e.t === 'draw');
    expect(own && own.t === 'draw' && own.cards.every((c) => c !== '??')).toBe(true);
    expect(own).toMatchObject({ positions: [1, 0] });
    expect(s.phase).toBe('complete');
  });

  it('a stand-pat made when the clock runs out is marked automatic; one a player chooses is not', () => {
    const s = start({ game: 'td27', stacks: [100, 100, 100] });
    for (let i = 0; i < 10 && s.phase === 'betting'; i++) {
      const legal = legalActions(s, s.toAct!)!;
      act(s, s.toAct!, legal.canCheck ? { type: 'check' } : { type: 'call' });
    }
    expect(s.phase).toBe('drawing');
    const first = s.toAct!;
    engine.timeout(s, first);
    const second = s.toAct!;
    engine.draw(s, second, []);
    const [timedOut, chosen] = eventsOf(s, 'draw');
    expect(timedOut).toMatchObject({ seat: first, discarded: 0, auto: true });
    expect(chosen).toMatchObject({ seat: second, discarded: 0 });
    expect(chosen).not.toHaveProperty('auto');
    // Everyone at the table sees which was which.
    const seen = engine.visibleEvents(s, { seat: second, seeAll: false }).find((e) => e.t === 'draw' && e.seat === first);
    expect(seen).toMatchObject({ auto: true });
  });

  it('an all-in player still draws; no betting once nobody can bet', () => {
    const s = start({ game: 'td27', stacks: [2, 100], stakes: { smallBet: 2, bigBet: 4 } });
    // Seat 0 is all in from the small blind... it has 2: posts 1, calls 1 more all in.
    act(s, 0, { type: 'call' });
    expect(s.phase).toBe('drawing');
    let draws = 0;
    while (s.phase === 'drawing') {
      engine.draw(s, s.toAct!, [0]);
      draws++;
    }
    expect(draws).toBe(6);
    expect(s.phase).toBe('complete');
    expect(eventsOf(s, 'action')).toHaveLength(1);
  });

  it('badugi: when the deck runs out the muck is reshuffled, but never your own discards', () => {
    const s = start({ game: 'badugi', stacks: Array(6).fill(100), stakes: { smallBet: 2, bigBet: 4 } });
    const thrownBy = new Map<number, string[]>();
    for (let i = 0; i < 500 && s.phase !== 'complete'; i++) {
      if (s.phase === 'drawing') {
        const seat = s.toAct!;
        const me = s.seats.find((x) => x.seat === seat)!;
        const thrown = me.cards.map((c) => c.card);
        engine.draw(s, seat, [0, 1, 2, 3]);
        const got = me.cards.map((c) => c.card);
        expect(got.some((c) => thrown.includes(c))).toBe(false);
        thrownBy.set(seat, thrown);
        // Nobody holds the same card as anyone else.
        const held = s.seats.filter((x) => !x.folded).flatMap((x) => x.cards.map((c) => c.card));
        expect(new Set(held).size).toBe(held.length);
        continue;
      }
      const legal = legalActions(s, s.toAct!)!;
      act(s, s.toAct!, legal.canCheck ? { type: 'check' } : { type: 'call' });
    }
    expect(s.phase).toBe('complete');
    expect(eventsOf(s, 'draw').reduce((n, d) => n + d.discarded, 0)).toBe(72);
    expect(s.seats.reduce((a, x) => a + x.stack, 0)).toBe(600);
  });

  it('a folded draw hand cannot be shown after the hand', () => {
    const s = start({ game: 'badugi', stacks: [100, 100, 100] });
    act(s, 0, { type: 'fold' });
    act(s, 1, { type: 'fold' });
    expect(s.phase).toBe('complete');
    expect(() => engine.show(s, 0, [0])).toThrow(/folded/);
    engine.show(s, 2, [0, 1, 2, 3]);
  });
});

import { describe, expect, it } from 'vitest';
import { ActionError, engine, HIDDEN_CARD, modifierRegistry, type HandState } from '../../src/core';
import { eventsOf, holdemTop, stacks, start } from './harness';

const { act, legalActions } = engine;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const endStacks = (s: HandState) => sum(s.seats.map((x) => x.stack));

/** Plays check/call for whoever is to act until the hand ends or `stop` says so. */
function checkDown(state: HandState, stop: (s: HandState) => boolean = () => false) {
  for (let i = 0; i < 200 && state.phase === 'betting' && state.toAct !== null && !stop(state); i++) {
    const legal = legalActions(state, state.toAct)!;
    act(state, state.toAct, legal.canCheck ? { type: 'check' } : { type: 'call' });
  }
}

describe("hold'em: order of play", () => {
  it('posts blinds and starts left of the big blind; the big blind gets its option', () => {
    const s = start({ stacks: [100, 100, 100, 100] });
    expect(eventsOf(s, 'post').map((e) => [e.seat, e.kind, e.amount])).toEqual([
      [1, 'small-blind', 1],
      [2, 'big-blind', 2],
    ]);
    expect(s.toAct).toBe(3);
    expect(legalActions(s, 3)).toMatchObject({ canCheck: false, callAmount: 2, canRaise: true, minTo: 4, maxTo: 100 });
    act(s, 3, { type: 'call' });
    act(s, 0, { type: 'call' });
    act(s, 1, { type: 'call' });
    expect(s.toAct).toBe(2);
    expect(legalActions(s, 2)).toMatchObject({ canCheck: true, minTo: 4 });
    act(s, 2, { type: 'check' });
    expect(s.street).toBe(1);
    expect(s.runs[0][0]).toHaveLength(3);
    // After the flop the first live seat left of the button acts.
    expect(s.toAct).toBe(1);
  });

  it('heads up: the button posts the small blind, acts first before the flop and last after it', () => {
    const s = start({ stacks: [100, 100] });
    expect(eventsOf(s, 'post').map((e) => [e.seat, e.kind])).toEqual([
      [0, 'small-blind'],
      [1, 'big-blind'],
    ]);
    expect(s.toAct).toBe(0);
    act(s, 0, { type: 'call' });
    act(s, 1, { type: 'check' });
    expect(s.toAct).toBe(1);
  });

  it('rejects out-of-turn and illegal actions without changing anything', () => {
    const s = start({ stacks: [100, 100, 100] });
    const before = JSON.stringify(s);
    expect(() => act(s, 1, { type: 'call' })).toThrow(ActionError);
    expect(() => act(s, 0, { type: 'check' })).toThrow(ActionError);
    expect(() => act(s, 0, { type: 'raise', to: 3 })).toThrow(/at least 4/);
    expect(() => act(s, 0, { type: 'raise', to: 101 })).toThrow(/at most 100/);
    expect(JSON.stringify(s)).toBe(before);
  });

  it('everyone folds to the big blind: blinds go to it uncontested and nothing is shown', () => {
    const s = start({ stacks: [100, 100, 100] });
    act(s, 0, { type: 'fold' });
    act(s, 1, { type: 'fold' });
    expect(s.phase).toBe('complete');
    expect(s.showdown).toBe(false);
    expect(stacks(s)).toEqual({ 0: 100, 1: 99, 2: 101 });
    expect(eventsOf(s, 'uncalled')).toEqual([expect.objectContaining({ seat: 2, amount: 1 })]);
    expect(eventsOf(s, 'show')).toHaveLength(0);
  });
});

describe("hold'em: raising rules", () => {
  it('the minimum re-raise is the size of the last full raise', () => {
    const s = start({ stacks: [500, 500, 500, 500] });
    act(s, 3, { type: 'raise', to: 10 }); // raise of 8
    expect(legalActions(s, 0)!.minTo).toBe(18);
    act(s, 0, { type: 'raise', to: 30 }); // raise of 20
    expect(legalActions(s, 1)!.minTo).toBe(50);
  });

  it('a short all-in raise does not reopen the betting for players who already acted', () => {
    // Seat 3 opens to 10; seat 0 shoves 14 (a raise of 4, less than the 8 needed).
    const s = start({ stacks: [100, 100, 100, 100].map((x, i) => (i === 0 ? 14 : x)) });
    act(s, 3, { type: 'raise', to: 10 });
    act(s, 0, { type: 'raise', to: 14 });
    act(s, 1, { type: 'fold' });
    // The big blind has not acted yet, so it may still raise.
    expect(legalActions(s, 2)!.canRaise).toBe(true);
    act(s, 2, { type: 'call' });
    // Seat 3 already acted and only faces the short raise: call or fold.
    expect(legalActions(s, 3)).toMatchObject({ canRaise: false, callAmount: 4 });
  });

  it('short all-ins that add up to a full raise reopen the betting for a player who already acted', () => {
    // Blinds 1/2. Seat 3 opens to 10 (a raise of 8); seats 0 and 1 go all in for 15 and 20, each 5 more: short.
    const s = start({ stacks: [15, 20, 500, 500], button: 0 });
    act(s, 3, { type: 'raise', to: 10 });
    act(s, 0, { type: 'raise', to: 15 });
    act(s, 1, { type: 'raise', to: 20 });
    act(s, 2, { type: 'call' });
    // Seat 3 faces 10 more than it put in, at least the last full raise of 8.
    expect(legalActions(s, 3)).toMatchObject({ callAmount: 10, canRaise: true, minTo: 28 });
  });

  it('in fixed limit, short all-ins that add up to half a bet reopen it', () => {
    const s = start({ stacks: [500, 500, 500, 24, 28], button: 0, stakes: { smallBlind: 5, bigBlind: 10, smallBet: 10, bigBet: 20 } });
    s.input.betting = 'fixed-limit';
    for (const seat of [3, 4, 0, 1]) act(s, seat, { type: 'call' });
    act(s, 2, { type: 'check' });
    // Flop: seat 1 bets 10, seat 3 is all in for 14 and seat 4 for 18, each less than half a bet more.
    act(s, 1, { type: 'bet', to: 10 });
    act(s, 2, { type: 'call' });
    act(s, 3, { type: 'raise', to: 14 });
    expect(legalActions(s, 4)).toMatchObject({ canRaise: true, maxTo: 18 });
    act(s, 4, { type: 'raise', to: 18 });
    act(s, 0, { type: 'call' });
    // Seats 1 and 2 face 8 more, at least half a bet, so they may raise again.
    expect(legalActions(s, 1)).toMatchObject({ callAmount: 8, canRaise: true, minTo: 28 });
  });

  it('a big blind all in for less still makes others call the full blind', () => {
    const s = start({ stacks: [100, 100, 1] });
    expect(eventsOf(s, 'post').find((e) => e.seat === 2)).toMatchObject({ amount: 1, allIn: true });
    expect(legalActions(s, 0)!.callAmount).toBe(2);
  });

  it('pot limit caps the raise at the size of the pot', () => {
    const s = start({ game: 'plo4', stacks: [500, 500, 500] });
    // Pot 3, call 2: max raise to 2 + (3 + 2) = 7.
    expect(legalActions(s, 0)).toMatchObject({ minTo: 4, maxTo: 7 });
  });
});

describe("hold'em: showdown and pots", () => {
  it('the best hand wins at showdown and every live hand is shown', () => {
    const top = holdemTop({ 0: ['As', 'Ah'], 1: ['Kd', 'Kc'], 2: ['7c', '2d'] }, ['Ac', '9h', '5s', '3d', 'Jc'], 0);
    const s = start({ stacks: [100, 100, 100], top });
    checkDown(s);
    expect(s.phase).toBe('complete');
    expect(s.showdown).toBe(true);
    expect(eventsOf(s, 'show').map((e) => e.seat).sort()).toEqual([0, 1, 2]);
    expect(eventsOf(s, 'award')).toEqual([expect.objectContaining({ seat: 0, amount: 6, handName: expect.stringMatching(/Three of a Kind/) })]);
    expect(stacks(s)).toEqual({ 0: 104, 1: 98, 2: 98 });
  });

  it('builds side pots for different all-in amounts and conserves chips', () => {
    // Seat 1 (20 chips) has the best hand, seat 2 (50) second, seat 0 (100) worst.
    const top = holdemTop({ 0: ['7c', '2d'], 1: ['As', 'Ah'], 2: ['Kd', 'Kc'] }, ['Qh', '9h', '5s', '3d', 'Jc'], 0);
    const s = start({ stacks: [100, 20, 50], top });
    act(s, 0, { type: 'raise', to: 100 });
    act(s, 1, { type: 'call' });
    act(s, 2, { type: 'call' });
    expect(s.phase).toBe('complete');
    expect(engine.pots(s)).toEqual([
      { amount: 60, eligible: [0, 1, 2] },
      { amount: 60, eligible: [0, 2] },
    ]);
    // Seat 0's extra 50 was never called and came back.
    expect(eventsOf(s, 'uncalled')).toEqual([expect.objectContaining({ seat: 0, amount: 50 })]);
    expect(stacks(s)).toEqual({ 0: 50, 1: 60, 2: 60 });
    expect(endStacks(s)).toBe(170);
  });

  it('splits a tied pot with the odd chip to the first seat left of the button', () => {
    // Seats 0 and 2 both play the straight on the board; the folded small blind leaves a pot of 5.
    const top = holdemTop({ 0: ['2c', '3d'], 1: ['2d', '3c'], 2: ['4h', '4d'] }, ['Ts', 'Js', 'Qh', 'Kd', 'Ac'], 0);
    const s = start({ stacks: [100, 100, 100], top });
    act(s, 0, { type: 'call' });
    act(s, 1, { type: 'fold' }); // 1 dead chip from the small blind
    act(s, 2, { type: 'check' });
    checkDown(s);
    // Pot 5 among three? Seats 0 and 2 both have the Broadway straight on the board.
    const awards = eventsOf(s, 'award');
    expect(awards.map((a) => [a.seat, a.amount])).toEqual([
      [2, 3],
      [0, 2],
    ]);
  });
});

describe('special hands', () => {
  it('straddle: the under-the-gun straddle closes the action before the flop', () => {
    const s = start({ stacks: [100, 100, 100, 100, 100], straddles: 'utg', straddlers: [3] });
    expect(eventsOf(s, 'post').map((e) => [e.seat, e.kind, e.amount])).toEqual([
      [1, 'small-blind', 1],
      [2, 'big-blind', 2],
      [3, 'straddle', 4],
    ]);
    expect(s.toAct).toBe(4);
    expect(legalActions(s, 4)).toMatchObject({ callAmount: 4, minTo: 8 });
    act(s, 4, { type: 'call' });
    act(s, 0, { type: 'call' });
    act(s, 1, { type: 'call' });
    act(s, 2, { type: 'call' });
    expect(s.toAct).toBe(3);
    expect(legalActions(s, 3)!.canCheck).toBe(true);
  });

  it('bomb pot: everyone puts in the bomb, preflop betting is skipped, the flop is out', () => {
    const s = start({ stacks: [100, 100, 100], bombPot: 10 });
    expect(eventsOf(s, 'post').every((e) => e.kind === 'bomb-pot' && e.amount === 10)).toBe(true);
    expect(s.street).toBe(1);
    expect(s.runs[0][0]).toHaveLength(3);
    expect(s.toAct).toBe(1);
    expect(legalActions(s, 1)).toMatchObject({ canCheck: true, callAmount: 0 });
  });

  it('double board: each board wins half the pot', () => {
    // Seat 1 gets 9s 8s, seat 0 Ks Kd. Board 0: 2s 3s 4h Jd 7c (kings win). Board 1: 7h 6c Td 2d 3h (straight wins).
    const top = ['9s', 'Ks', '8s', 'Kd', '2s', '3s', '4h', '7h', '6c', 'Td', 'Jd', '2d', '7c', '3h'];
    const s = start({ stacks: [100, 100], options: { boards: 2 }, top });
    expect(s.runs[0]).toHaveLength(2);
    checkDown(s);
    expect(s.phase).toBe('complete');
    const awards = eventsOf(s, 'award');
    expect(awards.map((a) => [a.board, a.seat, a.amount])).toEqual([
      [0, 0, 2],
      [1, 1, 2],
    ]);
  });

  it('run it twice when everyone agrees, once if anyone says no', () => {
    const allIn = (ritVotes: [boolean, boolean]) => {
      const s = start({ stacks: [100, 100], options: { runItTwice: 'ask' } });
      act(s, 0, { type: 'raise', to: 100 });
      act(s, 1, { type: 'call' });
      expect(s.phase).toBe('rit-vote');
      expect(eventsOf(s, 'show')).toHaveLength(2);
      engine.voteRunItTwice(s, 0, ritVotes[0]);
      if (s.phase === 'rit-vote') engine.voteRunItTwice(s, 1, ritVotes[1]);
      return s;
    };
    const twice = allIn([true, true]);
    expect(twice.phase).toBe('complete');
    expect(twice.runs).toHaveLength(2);
    expect(twice.runs.every((run) => run[0].length === 5)).toBe(true);
    expect(new Set(twice.runs.flatMap((r) => r[0])).size).toBe(10);
    expect(sum(eventsOf(twice, 'award').map((a) => a.amount))).toBe(200);
    expect(new Set(eventsOf(twice, 'award').map((a) => a.run))).toEqual(new Set([0, 1]));

    const once = allIn([true, false]);
    expect(once.runs).toHaveLength(1);
    expect(eventsOf(once, 'run-it')).toEqual([expect.objectContaining({ times: 1 })]);
  });

  it('run it twice "always" skips the vote', () => {
    const s = start({ stacks: [100, 100], options: { runItTwice: 'always' } });
    act(s, 0, { type: 'raise', to: 100 });
    act(s, 1, { type: 'call' });
    expect(s.phase).toBe('complete');
    expect(s.runs).toHaveLength(2);
  });
});

describe('away, timeouts and leaving', () => {
  it('away players check when they can and fold when they cannot', () => {
    const s = start({ stacks: [100, 100, 100, 100], away: [3] });
    // Seat 3 (under the gun) is away and folds to the big blind.
    expect(eventsOf(s, 'action')).toEqual([expect.objectContaining({ seat: 3, action: 'fold', auto: true })]);
    expect(s.toAct).toBe(0);
  });

  it('timeout checks or folds', () => {
    const s = start({ stacks: [100, 100, 100] });
    engine.timeout(s, 0);
    expect(eventsOf(s, 'action').at(-1)).toMatchObject({ seat: 0, action: 'fold', auto: true });
    act(s, 1, { type: 'call' });
    engine.timeout(s, 2);
    expect(eventsOf(s, 'action').at(-1)).toMatchObject({ seat: 2, action: 'check', auto: true });
  });

  it('a player who leaves mid-hand is folded even out of turn', () => {
    const s = start({ stacks: [100, 100, 100] });
    engine.foldOutOfTurn(s, 2);
    expect(s.seats.find((x) => x.seat === 2)!.folded).toBe(true);
    expect(s.toAct).toBe(0);
    act(s, 0, { type: 'fold' });
    expect(s.phase).toBe('complete');
    expect(stacks(s)[1]).toBe(102);
  });
});

describe('visibility', () => {
  it('hides other players’ hole cards until they are shown', () => {
    const top = holdemTop({ 0: ['As', 'Ah'], 1: ['Kd', 'Kc'] }, ['2c', '7d', '9h', 'Ts', '3c'], 0);
    const s = start({ stacks: [100, 100], top });
    const seen = engine.visibleEvents(s, { seat: 0, seeAll: false });
    const deals = seen.filter((e) => e.t === 'deal');
    expect(deals.find((d) => d.seat === 0)!.cards.map((c) => c.card)).toEqual(['As', 'Ah']);
    expect(deals.find((d) => d.seat === 1)!.cards.map((c) => c.card)).toEqual([HIDDEN_CARD, HIDDEN_CARD]);
    expect(engine.visibleEvents(s, { seat: null, seeAll: true }).filter((e) => e.t === 'deal')[0]).toMatchObject({
      cards: [{ card: 'Kd' }, { card: 'Kc' }],
    });
    checkDown(s);
    const after = engine.visibleEvents(s, { seat: 0, seeAll: false }).filter((e) => e.t === 'deal');
    expect(after.find((d) => d.seat === 1)!.cards.map((c) => c.card)).toEqual(['Kd', 'Kc']);
  });

  it('a winner who was not called can choose to show one card', () => {
    const top = holdemTop({ 0: ['As', 'Ah'], 1: ['Kd', 'Kc'] }, [], 0);
    const s = start({ stacks: [100, 100], top });
    act(s, 0, { type: 'raise', to: 10 });
    act(s, 1, { type: 'fold' });
    engine.show(s, 0, [1]);
    const spectator = engine.visibleEvents(s, { seat: null, seeAll: false }).filter((e) => e.t === 'deal');
    expect(spectator.find((d) => d.seat === 0)!.cards.map((c) => c.card)).toEqual([HIDDEN_CARD, 'Ah']);
  });
});

describe('modifiers', () => {
  it('a pot fee and an after-settle transfer apply and keep chips balanced', () => {
    modifierRegistry.register({
      id: 'test-rake',
      potFee: (pot) => Math.floor(pot.amount / 10),
    });
    modifierRegistry.register({
      id: 'test-bounty',
      afterSettle: (state) => {
        const winner = state.awards[0].seat;
        const loser = state.seats.find((x) => x.seat !== winner)!.seat;
        return [{ t: 'transfer', kind: 'bounty-72', from: loser, to: winner, amount: 5 }];
      },
    });
    const top = holdemTop({ 0: ['As', 'Ah'], 1: ['Kd', 'Kc'] }, ['2c', '7d', '9h', 'Ts', '3c'], 0);
    const s = start({ stacks: [100, 100], top, modifiers: [{ id: 'test-rake', settings: {} }, { id: 'test-bounty', settings: {} }] });
    act(s, 0, { type: 'raise', to: 20 });
    act(s, 1, { type: 'call' });
    checkDown(s);
    // Pot 40, fee 4, seat 0 wins 36 and a 5 chip bounty.
    expect(stacks(s)).toEqual({ 0: 121, 1: 75 });
    expect(eventsOf(s, 'transfer').map((e) => [e.kind, e.amount])).toEqual([
      ['rake', 4],
      ['bounty-72', 5],
    ]);
  });
});

describe('trimming excess bets', () => {
  it('caps the big stack at the deepest opponent, so nothing comes back uncalled', () => {
    // Seat 3 (UTG) has 500; the others have 100, 60 and 80.
    const s = start({ stacks: [100, 60, 80, 500], options: { trimExcessBets: true } });
    expect(s.toAct).toBe(3);
    expect(legalActions(s, 3)).toMatchObject({ maxTo: 100 });
    act(s, 3, { type: 'raise', to: 100 });
    expect(s.seats.find((x) => x.seat === 3)!.stack).toBe(400);
    expect(() => act(s, 0, { type: 'raise', to: 101 })).toThrow(ActionError);
    act(s, 0, { type: 'call' });
    act(s, 1, { type: 'fold' });
    act(s, 2, { type: 'fold' });
    expect(eventsOf(s, 'uncalled')).toHaveLength(0);
  });

  it('is off by default', () => {
    const s = start({ stacks: [100, 60, 80, 500] });
    expect(legalActions(s, 3)).toMatchObject({ maxTo: 500 });
  });
});

describe('fixed-limit cap counts the bets that are really made', () => {
  it('before the flop the big blind is the bet: 2-4-6-8 at 2/4 with a cap of 4', () => {
    const s = start({ stacks: [500, 500, 500], button: 0, stakes: { smallBet: 2, bigBet: 4 } });
    s.input.betting = 'fixed-limit';
    engine.act(s, 0, { type: 'raise', to: 4 });
    engine.act(s, 1, { type: 'raise', to: 6 });
    engine.act(s, 2, { type: 'raise', to: 8 });
    expect(engine.legalActions(s, 0)).toMatchObject({ callAmount: 4, canRaise: false });
  });

  it('the same in a limit draw game', () => {
    const s = start({ game: 'td27', stacks: [500, 500, 500], button: 0, stakes: { smallBet: 2, bigBet: 4 } });
    engine.act(s, 0, { type: 'raise', to: 4 });
    engine.act(s, 1, { type: 'raise', to: 6 });
    engine.act(s, 2, { type: 'raise', to: 8 });
    expect(engine.legalActions(s, 0)!.canRaise).toBe(false);
  });

  it('after the flop it is still the bet plus three raises', () => {
    const s = start({ stacks: [500, 500, 500], button: 0, stakes: { smallBet: 2, bigBet: 4 } });
    s.input.betting = 'fixed-limit';
    engine.act(s, 0, { type: 'call' });
    engine.act(s, 1, { type: 'call' });
    engine.act(s, 2, { type: 'check' });
    engine.act(s, 1, { type: 'bet', to: 2 });
    engine.act(s, 2, { type: 'raise', to: 4 });
    engine.act(s, 0, { type: 'raise', to: 6 });
    expect(engine.legalActions(s, 1)!.canRaise).toBe(true);
    engine.act(s, 1, { type: 'raise', to: 8 });
    expect(engine.legalActions(s, 2)!.canRaise).toBe(false);
  });

  it('an all-in short of half a bet is not a raise and leaves the capping bet open', () => {
    const s = start({ stacks: [500, 500, 500, 500, 43], button: 0, stakes: { smallBlind: 5, bigBlind: 10, smallBet: 10, bigBet: 20 } });
    s.input.betting = 'fixed-limit';
    for (const seat of [3, 4, 0, 1]) engine.act(s, seat, { type: 'call' });
    engine.act(s, 2, { type: 'check' });
    engine.act(s, 1, { type: 'bet', to: 10 });
    engine.act(s, 2, { type: 'raise', to: 20 });
    engine.act(s, 3, { type: 'raise', to: 30 });
    engine.act(s, 4, { type: 'raise', to: 33 });
    expect(engine.legalActions(s, 0)).toMatchObject({ callAmount: 33, canRaise: true, minTo: 43, maxTo: 43 });
  });
});

describe('the stud bring-in', () => {
  const STUD = { ante: 1, anteType: 'per-player' as const, bringIn: 1, smallBet: 2, bigBet: 4 };
  // Seat 0 shows the 2c and owes the bring-in.
  const deal = ['Qs', '7h', 'Th', 'Js', '8h', '6c', 'Kd', '2c', 'Ah', 'Kc', '3d', '5s'];

  it('cannot be skipped with a "call" of nothing', () => {
    const s = start({ game: 'stud', stacks: [100, 100, 100], stakes: STUD, top: deal });
    expect(legalActions(s, 0)).toMatchObject({ canBringIn: true, canCheck: false, callAmount: 0 });
    expect(() => act(s, 0, { type: 'call' })).toThrow(ActionError);
    act(s, 0, { type: 'bring-in' });
    expect(s.seats.find((x) => x.seat === 0)!.bet).toBe(1);
    expect(legalActions(s, 1)).toMatchObject({ canBringIn: false, callAmount: 1 });
  });

  it('is forced: the low card may not fold instead of bringing it in', () => {
    const s = start({ game: 'stud', stacks: [100, 100, 100], stakes: STUD, top: deal });
    expect(legalActions(s, 0)).toMatchObject({ canBringIn: true, canFold: false });
    expect(() => act(s, 0, { type: 'fold' })).toThrow(ActionError);
    expect(s.seats.find((x) => x.seat === 0)!.folded).toBe(false);
    act(s, 0, { type: 'bring-in' });
    act(s, 1, { type: 'bet', to: 2 });
    act(s, 2, { type: 'call' });
    // Once the bring-in is in, the low card may fold to a completion like anyone else.
    expect(legalActions(s, 0)).toMatchObject({ canFold: true, callAmount: 1 });
  });

  it('a low card who leaves on their turn has the bring-in posted, then folds, so the next seat faces it', () => {
    const s = start({ game: 'stud', stacks: [100, 100, 100], stakes: STUD, top: deal });
    engine.foldOutOfTurn(s, 0);
    expect(eventsOf(s, 'action').map((e) => [e.seat, e.action, e.amount, e.auto])).toEqual([
      [0, 'bring-in', 1, true],
      [0, 'fold', 0, true],
    ]);
    expect(s.toAct).toBe(1);
    expect(legalActions(s, 1)).toMatchObject({ canBringIn: false, canCheck: false, callAmount: 1 });
  });

  it('a leaving low card whose bring-in puts them all in stays in the hand', () => {
    const s = start({ game: 'stud', stacks: [2, 100, 100], stakes: STUD, top: deal });
    engine.foldOutOfTurn(s, 0);
    expect(s.seats.find((x) => x.seat === 0)).toMatchObject({ allIn: true, folded: false, bet: 1 });
    expect(s.toAct).toBe(1);
  });

  it('after a leaving low card brings in, an away player next acts at once', () => {
    const s = start({ game: 'stud', stacks: [100, 100, 100], stakes: STUD, top: deal, away: [1] });
    engine.foldOutOfTurn(s, 0);
    // Seat 1 is away and folds to the bring-in, so seat 2 wins the antes and the bring-in.
    expect(eventsOf(s, 'action').at(-1)).toMatchObject({ seat: 1, action: 'fold', auto: true });
    expect(s.phase).toBe('complete');
    expect(stacks(s)).toEqual({ 0: 98, 1: 99, 2: 103 });
  });
});

describe('a stud bring-in as big as the small bet', () => {
  // Seat 0 shows the 2c and owes the bring-in; seats 1 and 2 act after it.
  const deal = ['Qs', '7h', 'Th', 'Js', '8h', '6c', 'Kd', '2c', 'Ah', 'Kc', '3d', '5s'];

  it('is the opening bet: the next seat calls it or raises a full bet', () => {
    const s = start({ game: 'stud', stacks: [100, 100, 100], stakes: { ante: 1, anteType: 'per-player', bringIn: 2, smallBet: 2, bigBet: 4 }, top: deal });
    // Nothing is left to complete, so the low card just brings in.
    expect(legalActions(s, 0)).toMatchObject({ canBringIn: true, canRaise: false });
    act(s, 0, { type: 'bring-in' });
    expect(legalActions(s, 1)).toMatchObject({ canBringIn: false, callAmount: 2, canRaise: true, raiseKind: 'raise', minTo: 4, maxTo: 4 });
    act(s, 1, { type: 'raise', to: 4 });
    expect(eventsOf(s, 'action').at(-1)).toMatchObject({ seat: 1, action: 'raise', to: 4 });
    expect(legalActions(s, 2)).toMatchObject({ callAmount: 4, minTo: 6, maxTo: 6 });
  });

  it('counts toward the cap like a big blind: bring-in and three raises', () => {
    const s = start({ game: 'stud', stacks: [100, 100, 100], stakes: { ante: 1, anteType: 'per-player', bringIn: 2, smallBet: 2, bigBet: 4 }, top: deal });
    act(s, 0, { type: 'bring-in' });
    act(s, 1, { type: 'raise', to: 4 });
    act(s, 2, { type: 'raise', to: 6 });
    expect(legalActions(s, 0)!.canRaise).toBe(true);
    act(s, 0, { type: 'raise', to: 8 });
    // The bots read raisesThisRound as the raises players chose to make, so the forced bring-in is not one of them.
    expect(s.raisesThisRound).toBe(3);
    expect(legalActions(s, 1)).toMatchObject({ callAmount: 4, canRaise: false });
  });

  it('whole-chip 1/2 stud, where the bring-in is filled in as 1: third street can still be raised', () => {
    const s = start({ game: 'stud', stacks: [100, 100, 100], stakes: { ante: 0, anteType: 'none', bringIn: 1, smallBet: 1, bigBet: 2 }, top: deal });
    act(s, 0, { type: 'bring-in' });
    expect(legalActions(s, 1)).toMatchObject({ callAmount: 1, canRaise: true, minTo: 2, maxTo: 2 });
    act(s, 1, { type: 'call' });
    expect(legalActions(s, 2)).toMatchObject({ callAmount: 1, canRaise: true, minTo: 2, maxTo: 2 });
  });

  it('a short all-in bring-in is completed to the small bet, and the round goes on from there', () => {
    const s = start({ game: 'stud', stacks: [2, 100, 100], stakes: { ante: 1, anteType: 'per-player', bringIn: 2, smallBet: 2, bigBet: 4 }, top: deal });
    act(s, 0, { type: 'bring-in' });
    expect(s.currentBet).toBe(1);
    expect(legalActions(s, 1)).toMatchObject({ callAmount: 1, canRaise: true, raiseKind: 'bet', minTo: 2, maxTo: 2 });
    act(s, 1, { type: 'bet', to: 2 });
    expect(eventsOf(s, 'action').at(-1)).toMatchObject({ seat: 1, action: 'complete', to: 2 });
    expect(legalActions(s, 2)).toMatchObject({ callAmount: 2, canRaise: true, raiseKind: 'raise', minTo: 4, maxTo: 4 });
  });
});

import { describe, expect, it } from 'vitest';
import { BettingContext, classifyRaise, computeLegal, potLimitMax } from '../../src/core/betting';

/** No-limit 1/2, nobody has bet, 100 behind. */
function ctx(over: Partial<BettingContext> = {}): BettingContext {
  return {
    betting: 'no-limit',
    stack: 100,
    bet: 0,
    currentBet: 0,
    lastFullRaise: 0,
    raisesThisRound: 0,
    bigBlind: 2,
    potTotal: 3,
    seatCanRaise: true,
    ...over,
  };
}

/** Preflop 1/2, first to act. */
const preflop = (over: Partial<BettingContext> = {}) =>
  ctx({ currentBet: 2, lastFullRaise: 2, raisesThisRound: 1, potTotal: 3, ...over });

/** Fixed-limit with a unit, cap 4. */
const limit = (unit: number, over: Partial<BettingContext> = {}) =>
  ctx({ betting: 'fixed-limit', fixed: { unit, cap: 4, uncapped: false }, ...over });

/** Fixed-limit stud third street: 8 antes of 1, bring-in 1, complete to the small bet 4. The seat is the low card. */
const stud = (over: Partial<BettingContext> = {}) =>
  limit(4, { bigBlind: 4, potTotal: 8, bringIn: { amount: 1, completeTo: 4, forced: true }, ...over });

const range = (l: ReturnType<typeof computeLegal>) => [l.minTo, l.maxTo];

describe('potLimitMax', () => {
  it('calls then raises the pot after the call', () => {
    // Blinds 1/2, first to act: pot 3, call 2, raise 5.
    expect(potLimitMax(2, 3, 2)).toBe(7);
    // Small blind after folds: call 1 makes the pot 4.
    expect(potLimitMax(2, 3, 1)).toBe(6);
    // Flop: pot 10, bet 10, then a raise to 40 faces the next player with pot 60.
    expect(potLimitMax(10, 20, 10)).toBe(40);
    expect(potLimitMax(40, 60, 40)).toBe(140);
  });

  it('is the pot when nobody has bet', () => {
    expect(potLimitMax(0, 30, 0)).toBe(30);
  });
});

describe('computeLegal basics', () => {
  it('can check with nothing to call', () => {
    const l = computeLegal(ctx());
    expect(l.canCheck).toBe(true);
    expect(l.callAmount).toBe(0);
  });

  it('cannot check facing a bet and calls the difference', () => {
    const l = computeLegal(preflop({ bet: 1 }));
    expect(l.canCheck).toBe(false);
    expect(l.callAmount).toBe(1);
  });

  it('caps the call at the stack', () => {
    const l = computeLegal(ctx({ currentBet: 50, lastFullRaise: 50, stack: 30 }));
    expect(l.callAmount).toBe(30);
  });

  it('allows folding, even when checking is free', () => {
    expect(computeLegal(ctx()).canFold).toBe(true);
    expect(computeLegal(preflop()).canFold).toBe(true);
    // Except the forced stud bring-in, until it is in.
    expect(computeLegal(stud()).canFold).toBe(false);
    expect(computeLegal(stud({ bet: 1, currentBet: 4 })).canFold).toBe(true);
  });

  it('says bet when nobody has bet and raise otherwise', () => {
    expect(computeLegal(ctx()).raiseKind).toBe('bet');
    expect(computeLegal(preflop()).raiseKind).toBe('raise');
    expect(computeLegal(limit(4)).raiseKind).toBe('bet');
    expect(computeLegal(limit(4, { currentBet: 4 })).raiseKind).toBe('raise');
  });

  it('only offers call or fold when the seat cannot raise', () => {
    const facing = computeLegal(preflop({ seatCanRaise: false }));
    expect(facing).toMatchObject({ canRaise: false, canFold: true, canCheck: false, callAmount: 2, minTo: 0, maxTo: 0 });
    const free = computeLegal(ctx({ seatCanRaise: false }));
    expect(free).toMatchObject({ canRaise: false, canCheck: true });
  });

  it('never offers the bring-in outside stud', () => {
    expect(computeLegal(ctx()).canBringIn).toBe(false);
    expect(computeLegal(limit(4)).canBringIn).toBe(false);
  });

  it('does not touch its input', () => {
    const c = Object.freeze(stud({ fixed: Object.freeze({ unit: 4, cap: 4, uncapped: false }) }));
    expect(() => computeLegal(c)).not.toThrow();
    expect(() => classifyRaise(c, 4)).not.toThrow();
  });
});

describe('no-limit', () => {
  it('opens for at least the big blind, up to all in', () => {
    const l = computeLegal(ctx());
    expect(l).toMatchObject({ canRaise: true, raiseKind: 'bet' });
    expect(range(l)).toEqual([2, 100]);
  });

  it('min raise preflop is to two big blinds', () => {
    const l = computeLegal(preflop());
    expect(l.callAmount).toBe(2);
    expect(range(l)).toEqual([4, 100]);
  });

  it('min raise is the current bet plus the last full raise', () => {
    // 2 raised to 6: the next raise is to at least 10.
    expect(range(computeLegal(ctx({ currentBet: 6, lastFullRaise: 4 })))).toEqual([10, 100]);
    expect(range(computeLegal(ctx({ currentBet: 30, lastFullRaise: 24 })))).toEqual([54, 100]);
  });

  it('min raise is never below the big blind', () => {
    expect(computeLegal(ctx({ currentBet: 2, lastFullRaise: 0 })).minTo).toBe(4);
    expect(computeLegal(ctx({ currentBet: 3, lastFullRaise: 1 })).minTo).toBe(5);
  });

  it('ignores a stale lastFullRaise when nobody has bet', () => {
    expect(computeLegal(ctx({ lastFullRaise: 50 })).minTo).toBe(2);
  });

  it('keeps the minimum above the bet with a zero big blind', () => {
    expect(computeLegal(ctx({ bigBlind: 0 })).minTo).toBe(1);
  });

  it('counts the live bet in the all-in total', () => {
    // Big blind (2 in, 98 behind) facing a raise to 6.
    const l = computeLegal(ctx({ bet: 2, stack: 98, currentBet: 6, lastFullRaise: 4 }));
    expect(l.callAmount).toBe(4);
    expect(range(l)).toEqual([10, 100]);
  });

  it('gives the big blind its option', () => {
    const l = computeLegal(preflop({ bet: 2, stack: 98 }));
    expect(l).toMatchObject({ canCheck: true, callAmount: 0, canRaise: true, raiseKind: 'raise' });
    expect(range(l)).toEqual([4, 100]);
  });

  it('allows an all-in raise below the minimum', () => {
    const l = computeLegal(ctx({ currentBet: 6, lastFullRaise: 4, stack: 7 }));
    expect(l.canRaise).toBe(true);
    expect(range(l)).toEqual([7, 7]);
  });

  it('allows an all-in bet below the big blind', () => {
    const l = computeLegal(ctx({ stack: 1 }));
    expect(l).toMatchObject({ canRaise: true, raiseKind: 'bet' });
    expect(range(l)).toEqual([1, 1]);
  });

  it('only calls all in when the stack just covers the call', () => {
    const l = computeLegal(ctx({ currentBet: 6, lastFullRaise: 4, stack: 6 }));
    expect(l).toMatchObject({ canRaise: false, callAmount: 6, minTo: 0, maxTo: 0 });
  });

  it('only calls all in for less when the stack is short of the call', () => {
    const l = computeLegal(ctx({ currentBet: 6, lastFullRaise: 4, bet: 2, stack: 3 }));
    expect(l).toMatchObject({ canRaise: false, callAmount: 3 });
  });

  it('raises over an incomplete all-in by the last full raise', () => {
    // 100 bet, all in for 150: the next full raise is to 250.
    expect(computeLegal(ctx({ currentBet: 150, lastFullRaise: 100, stack: 1000 })).minTo).toBe(250);
  });

  it('has no raise cap', () => {
    const l = computeLegal(ctx({ currentBet: 64, lastFullRaise: 32, raisesThisRound: 20, fixed: { unit: 2, cap: 4, uncapped: false } }));
    expect(l.canRaise).toBe(true);
    expect(range(l)).toEqual([96, 100]);
  });
});

describe('pot-limit', () => {
  const pl = (over: Partial<BettingContext> = {}) => preflop({ betting: 'pot-limit', ...over });

  it('first to act at 1/2 may raise to 7', () => {
    const l = computeLegal(pl());
    expect(l.callAmount).toBe(2);
    expect(range(l)).toEqual([4, 7]);
  });

  it('small blind after folds may raise to 6', () => {
    expect(range(computeLegal(pl({ bet: 1, stack: 99 })))).toEqual([4, 6]);
  });

  it('big blind option after two limps may raise to 8', () => {
    expect(range(computeLegal(pl({ bet: 2, stack: 98, potTotal: 6 })))).toEqual([4, 8]);
  });

  it('opens for at most the pot', () => {
    const l = computeLegal(ctx({ betting: 'pot-limit', potTotal: 30 }));
    expect(l.raiseKind).toBe('bet');
    expect(range(l)).toEqual([2, 30]);
  });

  it('re-raises the pot after a raise', () => {
    // Flop pot 10, A bets 10, B raises to 40 (increment 30), C acts.
    const l = computeLegal(ctx({ betting: 'pot-limit', currentBet: 40, lastFullRaise: 30, potTotal: 60, stack: 500 }));
    expect(range(l)).toEqual([70, 140]);
  });

  it('measures the pot raise for a seat with a live bet', () => {
    // Back to A (10 in): pot 200 after C raised to 140.
    const l = computeLegal(ctx({ betting: 'pot-limit', bet: 10, stack: 1000, currentBet: 140, lastFullRaise: 100, potTotal: 200 }));
    expect(l.callAmount).toBe(130);
    expect(range(l)).toEqual([240, 470]);
  });

  it('still allows the minimum bet into a pot smaller than it', () => {
    expect(range(computeLegal(ctx({ betting: 'pot-limit', bigBlind: 4, potTotal: 1 })))).toEqual([4, 4]);
  });

  it('caps the pot raise at the stack', () => {
    expect(range(computeLegal(pl({ stack: 5 })))).toEqual([4, 5]);
  });

  it('allows an all-in raise below the minimum', () => {
    expect(range(computeLegal(pl({ stack: 3 })))).toEqual([3, 3]);
  });

  it('only calls when the stack does not exceed the call', () => {
    expect(computeLegal(pl({ stack: 2 }))).toMatchObject({ canRaise: false, callAmount: 2 });
  });

  it('respects seatCanRaise', () => {
    expect(computeLegal(pl({ seatCanRaise: false })).canRaise).toBe(false);
  });
});

describe('fixed-limit', () => {
  it('bets exactly one unit', () => {
    const l = computeLegal(limit(4));
    expect(l).toMatchObject({ canRaise: true, raiseKind: 'bet' });
    expect(range(l)).toEqual([4, 4]);
  });

  it('raises exactly one unit over the current bet', () => {
    // 2/4 preflop, first to act over the big blind.
    expect(range(computeLegal(limit(2, { currentBet: 2, raisesThisRound: 1 })))).toEqual([4, 4]);
    // Small blind completes or raises to 4.
    const sb = computeLegal(limit(2, { bet: 1, currentBet: 2, raisesThisRound: 1 }));
    expect(sb.callAmount).toBe(1);
    expect(range(sb)).toEqual([4, 4]);
    // Big-bet street.
    expect(range(computeLegal(limit(8, { currentBet: 16, raisesThisRound: 2 })))).toEqual([24, 24]);
  });

  it('ignores the big blind, last raise and pot', () => {
    expect(range(computeLegal(limit(4, { currentBet: 8, lastFullRaise: 100, bigBlind: 50, potTotal: 1000 })))).toEqual([12, 12]);
  });

  it('stops raising at the cap', () => {
    const l = computeLegal(limit(4, { currentBet: 16, raisesThisRound: 4 }));
    expect(l).toMatchObject({ canRaise: false, callAmount: 16, minTo: 0, maxTo: 0 });
  });

  it('allows the last raise just below the cap', () => {
    expect(range(computeLegal(limit(4, { currentBet: 12, raisesThisRound: 3 })))).toEqual([16, 16]);
  });

  it('lifts the cap heads-up when uncapped', () => {
    const l = computeLegal(limit(4, { currentBet: 28, raisesThisRound: 7, fixed: { unit: 4, cap: 4, uncapped: true } }));
    expect(l.canRaise).toBe(true);
    expect(range(l)).toEqual([32, 32]);
  });

  it('allows an all-in raise for less than a unit', () => {
    expect(range(computeLegal(limit(4, { currentBet: 4, stack: 6 })))).toEqual([6, 6]);
  });

  it('allows an all-in bet for less than a unit', () => {
    expect(range(computeLegal(limit(4, { stack: 3 })))).toEqual([3, 3]);
  });

  it('only calls when the stack does not exceed the call', () => {
    expect(computeLegal(limit(4, { currentBet: 4, stack: 4 }))).toMatchObject({ canRaise: false, callAmount: 4 });
    expect(computeLegal(limit(4, { currentBet: 8, stack: 5 }))).toMatchObject({ canRaise: false, callAmount: 5 });
  });

  it('respects seatCanRaise under the cap', () => {
    expect(computeLegal(limit(4, { currentBet: 8, raisesThisRound: 2, seatCanRaise: false })).canRaise).toBe(false);
  });

  it('throws without fixed-limit sizes', () => {
    expect(() => computeLegal(ctx({ betting: 'fixed-limit' }))).toThrow(/fixed/);
    expect(() => classifyRaise(ctx({ betting: 'fixed-limit' }), 4)).toThrow(/fixed/);
  });
});

describe('stud bring-in', () => {
  it('lets the bring-in seat bring in or complete, but not check or fold', () => {
    const l = computeLegal(stud());
    expect(l).toMatchObject({ canBringIn: true, canCheck: false, callAmount: 0, canRaise: true, raiseKind: 'bet', canFold: false });
    expect(range(l)).toEqual([4, 4]);
  });

  it('the seat that opens because the low card is all in from the ante may also fold', () => {
    const l = computeLegal(stud({ bringIn: { amount: 1, completeTo: 4 } }));
    expect(l).toMatchObject({ canBringIn: true, canCheck: false, canFold: true, canRaise: true });
    expect(range(l)).toEqual([4, 4]);
  });

  it('bring-in seat covering only the bring-in cannot complete', () => {
    expect(computeLegal(stud({ stack: 1 }))).toMatchObject({ canBringIn: true, canRaise: false });
  });

  it('bring-in seat short of the bring-in may still bring in all in', () => {
    const l = computeLegal(stud({ stack: 1, bringIn: { amount: 2, completeTo: 4 } }));
    expect(l).toMatchObject({ canBringIn: true, canRaise: false, canCheck: false });
  });

  it('bring-in seat short of a completion completes all in for less', () => {
    const l = computeLegal(stud({ stack: 3 }));
    expect(l).toMatchObject({ canBringIn: true, canRaise: true });
    expect(range(l)).toEqual([3, 3]);
  });

  it('later seats call the bring-in or complete', () => {
    const l = computeLegal(stud({ currentBet: 1, potTotal: 9 }));
    expect(l).toMatchObject({ canBringIn: false, canCheck: false, callAmount: 1, canRaise: true, raiseKind: 'bet' });
    expect(range(l)).toEqual([4, 4]);
  });

  it('later seats complete all in for less', () => {
    expect(range(computeLegal(stud({ currentBet: 1, stack: 3 })))).toEqual([3, 3]);
  });

  it('later seats covering only the bring-in just call', () => {
    expect(computeLegal(stud({ currentBet: 1, stack: 1 }))).toMatchObject({ canRaise: false, callAmount: 1 });
  });

  it('a short all-in bring-in is called for what it is', () => {
    const l = computeLegal(stud({ currentBet: 2, bringIn: { amount: 3, completeTo: 8 } }));
    expect(l).toMatchObject({ callAmount: 2, raiseKind: 'bet' });
    expect(range(l)).toEqual([8, 8]);
  });

  it('the bring-in seat may complete when the action returns uncompleted', () => {
    const l = computeLegal(stud({ bet: 1, currentBet: 1, stack: 99 }));
    expect(l).toMatchObject({ canBringIn: false, canCheck: true, canRaise: true, raiseKind: 'bet' });
    expect(range(l)).toEqual([4, 4]);
  });

  it('the bring-in does not count toward the cap', () => {
    const l = computeLegal(stud({ currentBet: 1, fixed: { unit: 4, cap: 1, uncapped: false } }));
    expect(l.canRaise).toBe(true);
  });

  it('after the completion the round is ordinary fixed limit', () => {
    // Completion is bet 1; three raises later the cap of 4 is reached.
    const l = computeLegal(stud({ currentBet: 4, raisesThisRound: 1 }));
    expect(l).toMatchObject({ raiseKind: 'raise', callAmount: 4 });
    expect(range(l)).toEqual([8, 8]);
    expect(computeLegal(stud({ currentBet: 12, raisesThisRound: 3 })).canRaise).toBe(true);
    expect(computeLegal(stud({ currentBet: 16, raisesThisRound: 4 })).canRaise).toBe(false);
  });

  it('a bring-in as big as the completion leaves nothing to complete', () => {
    // Fixed limit: the low card just brings in.
    expect(computeLegal(stud({ bringIn: { amount: 4, completeTo: 4 } }))).toMatchObject({ canBringIn: true, canRaise: false, minTo: 0, maxTo: 0 });
    // No-limit and pot-limit: it may still open for more, but never for less than the forced bring-in.
    const nl = computeLegal(stud({ betting: 'no-limit', bringIn: { amount: 5, completeTo: 2 } }));
    expect(nl).toMatchObject({ canBringIn: true, canRaise: true, raiseKind: 'bet' });
    expect(range(nl)).toEqual([6, 100]);
    expect(range(computeLegal(stud({ betting: 'pot-limit', bringIn: { amount: 4, completeTo: 4 } })))).toEqual([5, 8]);
    // The bet over the bring-in stays legal when the pot is smaller.
    expect(range(computeLegal(stud({ betting: 'pot-limit', potTotal: 2, bringIn: { amount: 4, completeTo: 4 } })))).toEqual([5, 5]);
  });

  it('respects seatCanRaise facing the bring-in', () => {
    expect(computeLegal(stud({ currentBet: 1, seatCanRaise: false }))).toMatchObject({ canRaise: false, callAmount: 1 });
  });

  it('no-limit stud completes to at least the small bet, up to all in', () => {
    const decide = computeLegal(stud({ betting: 'no-limit' }));
    expect(decide.canBringIn).toBe(true);
    expect(range(decide)).toEqual([4, 100]);
    expect(range(computeLegal(stud({ betting: 'no-limit', currentBet: 1 })))).toEqual([4, 100]);
  });

  it('pot-limit stud completes to at least the small bet, up to the pot', () => {
    // Antes 8: the bring-in seat may bet the pot.
    expect(range(computeLegal(stud({ betting: 'pot-limit' })))).toEqual([4, 8]);
    // Facing the bring-in: call 1 makes the pot 10, so up to 11.
    expect(range(computeLegal(stud({ betting: 'pot-limit', currentBet: 1, potTotal: 9 })))).toEqual([4, 11]);
    // Small antes: the completion is still allowed.
    expect(range(computeLegal(stud({ betting: 'pot-limit', potTotal: 2 })))).toEqual([4, 4]);
  });
});

describe('classifyRaise', () => {
  it('no-limit opening bet is full from the big blind', () => {
    expect(classifyRaise(ctx(), 2)).toEqual({ full: true, increment: 2 });
    expect(classifyRaise(ctx(), 40)).toEqual({ full: true, increment: 40 });
    expect(classifyRaise(ctx(), 1)).toEqual({ full: false, increment: 1 });
  });

  it('no-limit raise is full from the last full raise', () => {
    const c = ctx({ currentBet: 6, lastFullRaise: 4 });
    expect(classifyRaise(c, 10)).toEqual({ full: true, increment: 4 });
    expect(classifyRaise(c, 30)).toEqual({ full: true, increment: 24 });
    expect(classifyRaise(c, 9)).toEqual({ full: false, increment: 3 });
  });

  it('an all-in short of a full raise is incomplete', () => {
    expect(classifyRaise(ctx({ currentBet: 100, lastFullRaise: 100 }), 150)).toEqual({ full: false, increment: 50 });
    expect(classifyRaise(ctx({ currentBet: 100, lastFullRaise: 100 }), 199)).toEqual({ full: false, increment: 99 });
  });

  it('no-limit raise must still be a big blind', () => {
    expect(classifyRaise(ctx({ currentBet: 2, lastFullRaise: 0 }), 3).full).toBe(false);
    expect(classifyRaise(ctx({ currentBet: 2, lastFullRaise: 0 }), 4).full).toBe(true);
  });

  it('ignores a stale lastFullRaise when nobody has bet', () => {
    expect(classifyRaise(ctx({ lastFullRaise: 50 }), 2).full).toBe(true);
  });

  it('pot-limit follows the no-limit rule', () => {
    const c = preflop({ betting: 'pot-limit' });
    expect(classifyRaise(c, 4)).toEqual({ full: true, increment: 2 });
    expect(classifyRaise(c, 7)).toEqual({ full: true, increment: 5 });
    expect(classifyRaise(c, 3)).toEqual({ full: false, increment: 1 });
  });

  it('fixed-limit raise of a full unit is full', () => {
    expect(classifyRaise(limit(4, { currentBet: 4 }), 8)).toEqual({ full: true, increment: 4 });
    expect(classifyRaise(limit(4), 4)).toEqual({ full: true, increment: 4 });
  });

  it('fixed-limit all-in of at least half a unit is full', () => {
    expect(classifyRaise(limit(4, { currentBet: 4 }), 6)).toEqual({ full: true, increment: 2 });
    expect(classifyRaise(limit(4, { currentBet: 4 }), 5)).toEqual({ full: false, increment: 1 });
    expect(classifyRaise(limit(4), 2).full).toBe(true);
    expect(classifyRaise(limit(4), 1).full).toBe(false);
  });

  it('fixed-limit half-unit rule works on odd units without fractions', () => {
    expect(classifyRaise(limit(5, { currentBet: 5 }), 7).full).toBe(false);
    expect(classifyRaise(limit(5, { currentBet: 5 }), 8).full).toBe(true);
  });

  it('a stud completion is a full bet measured from zero', () => {
    expect(classifyRaise(stud(), 4)).toEqual({ full: true, increment: 4 });
    expect(classifyRaise(stud({ currentBet: 1 }), 4)).toEqual({ full: true, increment: 4 });
  });

  it('a short stud completion follows the half rule in fixed limit', () => {
    const c = stud({ currentBet: 1, bringIn: { amount: 1, completeTo: 10 }, fixed: { unit: 10, cap: 4, uncapped: false } });
    expect(classifyRaise(c, 4)).toEqual({ full: false, increment: 4 });
    expect(classifyRaise(c, 5)).toEqual({ full: true, increment: 5 });
  });

  it('a no-limit stud bet over the bring-in counts from zero', () => {
    const c = stud({ betting: 'no-limit', currentBet: 1 });
    expect(classifyRaise(c, 10)).toEqual({ full: true, increment: 10 });
    expect(classifyRaise(c, 3)).toEqual({ full: false, increment: 3 });
  });

  it('after the completion stud raises are ordinary', () => {
    expect(classifyRaise(stud({ currentBet: 4 }), 8)).toEqual({ full: true, increment: 4 });
  });
});

describe('invariants', () => {
  /** Small seeded PRNG so failures reproduce. */
  function mulberry32(seed: number) {
    return () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it('holds for random contexts', () => {
    const r = mulberry32(42);
    const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
    const kinds = ['no-limit', 'pot-limit', 'fixed-limit'] as const;
    for (let i = 0; i < 5000; i++) {
      const currentBet = r() < 0.3 ? 0 : int(1, 200);
      const bringIn = r() < 0.2 ? (() => { const amount = int(1, 5); return { amount, completeTo: amount + int(1, 10), forced: r() < 0.8 }; })() : undefined;
      const c: BettingContext = {
        betting: kinds[int(0, 2)],
        stack: int(0, 300),
        bet: int(0, currentBet),
        currentBet: bringIn && r() < 0.7 ? int(0, bringIn.amount) : currentBet,
        lastFullRaise: currentBet ? int(1, currentBet) : 0,
        raisesThisRound: int(0, 6),
        bigBlind: int(1, 10),
        potTotal: currentBet + int(0, 500),
        seatCanRaise: r() < 0.85,
        fixed: { unit: int(1, 10), cap: int(3, 5), uncapped: r() < 0.2 },
        bringIn,
      };
      c.bet = Math.min(c.bet, c.currentBet);
      const l = computeLegal(c);
      const allInTo = c.bet + c.stack;
      const toCall = c.currentBet - c.bet;
      const where = JSON.stringify(c);

      for (const v of [l.callAmount, l.minTo, l.maxTo]) expect(Number.isInteger(v), where).toBe(true);
      expect(l.canFold, where).toBe(!(l.canBringIn && c.bringIn!.forced));
      expect(l.callAmount, where).toBe(Math.min(toCall, c.stack));
      if (!l.canBringIn) expect(l.canCheck, where).toBe(toCall === 0);
      if (!c.seatCanRaise) expect(l.canRaise, where).toBe(false);

      if (!l.canRaise) {
        expect([l.minTo, l.maxTo], where).toEqual([0, 0]);
        continue;
      }
      const floor = l.canBringIn ? c.bringIn!.amount : c.currentBet;
      expect(l.minTo, where).toBeGreaterThan(floor);
      expect(l.minTo, where).toBeLessThanOrEqual(l.maxTo);
      expect(l.maxTo, where).toBeLessThanOrEqual(allInTo);
      // Anything short of all in at the minimum is a full raise.
      if (l.minTo < allInTo) expect(classifyRaise(c, l.minTo).full, where).toBe(true);
      else expect(l.maxTo, where).toBe(allInTo);
    }
  });
});

describe('trimming excess bets', () => {
  it('caps a shove at the most an opponent can call', () => {
    // 100 behind facing a 2 big blind; the deepest opponent has 40 in all.
    const l = computeLegal(preflop({ trimTo: 40 }));
    expect(range(l)).toEqual([4, 40]);
  });

  it('allows a raise to the cap below a full raise', () => {
    // Facing 30, the only opponent left can reach 35: a full raise would be 58.
    const l = computeLegal(ctx({ currentBet: 30, lastFullRaise: 28, trimTo: 35 }));
    expect(l.canRaise).toBe(true);
    expect(range(l)).toEqual([35, 35]);
  });

  it('allows only a call once nobody can put in more', () => {
    const l = computeLegal(ctx({ currentBet: 30, lastFullRaise: 28, trimTo: 30 }));
    expect(l.canRaise).toBe(false);
    expect(l.callAmount).toBe(30);
  });

  it('changes nothing when every opponent covers', () => {
    expect(range(computeLegal(preflop({ trimTo: 500 })))).toEqual(range(computeLegal(preflop())));
  });
});

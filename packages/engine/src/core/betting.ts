/**
 * Betting structures: what one seat may do, given the betting round so far.
 *
 * No-limit, pot-limit and fixed-limit all answer with the same LegalActions
 * shape, so the hand machine, the UI and bots never branch on the structure.
 * Pure functions over whole chips; the hand machine builds the context.
 */

import type { BettingKind, Chips, LegalActions } from './types';

/** Fixed-limit facts for the current round. */
export interface FixedLimitRound {
  /** Small or big bet for this street. Every bet and raise is exactly this size. */
  unit: Chips;
  /** Most bets plus raises this round, e.g. 4. */
  cap: number;
  /** Forced bets that count toward the cap: the big blind (and any straddles) in the first round. */
  forced?: number;
  /** Heads-up with the cap lifted. */
  uncapped: boolean;
}

/**
 * Stud third street while the bring-in is still to be posted, or is the only live bet and short of a full
 * bet. A bring-in as big as the completion is itself the opening bet, after which the round is ordinary.
 */
export interface BringInRound {
  amount: Chips;
  /** Total a completion goes to (the small bet). */
  completeTo: Chips;
}

/** One seat's decision point, built by the hand machine from HandState and the seat. */
export interface BettingContext {
  betting: BettingKind;
  /** Chips behind, not counting the live bet. */
  stack: Chips;
  /** The seat's live bet this round. */
  bet: Chips;
  currentBet: Chips;
  lastFullRaise: Chips;
  raisesThisRound: number;
  bigBlind: Chips;
  /** Every chip in the middle, including all current-round bets. */
  potTotal: Chips;
  /** False after an incomplete raise this seat had already acted before. */
  seatCanRaise: boolean;
  /** Required when betting is fixed-limit. */
  fixed?: FixedLimitRound;
  bringIn?: BringInRound;
  /**
   * Trim excess bets: the most any live opponent can put in this round (their
   * bet plus chips behind). No bet or raise may go past it.
   */
  trimTo?: Chips;
}

/**
 * Largest pot-limit total: call first, then raise by the whole pot after the
 * call. With nothing bet yet this is simply the pot.
 */
export function potLimitMax(currentBet: Chips, potTotal: Chips, toCall: Chips): Chips {
  return currentBet + potTotal + toCall;
}

/**
 * Legal actions for the seat described by `ctx`. minTo and maxTo are 0 when
 * canRaise is false. The stud bring-in seat (bringIn set, nothing bet yet)
 * cannot check: it brings in or completes.
 */
export function computeLegal(ctx: BettingContext): LegalActions {
  const toCall = Math.max(0, ctx.currentBet - ctx.bet);
  // With trimming on, going all in only goes as far as someone can call; a raise to there is legal even below a full raise.
  const allInTo = ctx.trimTo === undefined ? ctx.bet + ctx.stack : Math.min(ctx.bet + ctx.stack, ctx.trimTo);
  const canBringIn = !!ctx.bringIn && ctx.currentBet === 0 && ctx.stack > 0;
  const { base, step, completing } = fullRaise(ctx);
  const fullTo = base + step;
  // Raising must leave the seat above what calling (or bringing in) would.
  const floor = canBringIn ? ctx.bringIn!.amount : ctx.currentBet;
  // A bring-in as big as the completion leaves nothing to complete: the low card just brings in.
  const nothingToComplete = canBringIn && ctx.bringIn!.amount >= ctx.bringIn!.completeTo;
  const canRaise = ctx.seatCanRaise && !capReached(ctx) && allInTo > floor && !nothingToComplete;
  return {
    canFold: true,
    canCheck: toCall === 0 && !canBringIn,
    callAmount: Math.min(toCall, ctx.stack),
    canRaise,
    raiseKind: ctx.currentBet === 0 || completing ? 'bet' : 'raise',
    minTo: canRaise ? Math.min(fullTo, allInTo) : 0,
    maxTo: canRaise ? Math.min(ceiling(ctx, fullTo, toCall), allInTo) : 0,
    canBringIn,
  };
}

/**
 * Whether a bet or raise to `to` is full (reopens the betting for seats that
 * already acted). No-limit and pot-limit need the last full raise, and at least
 * the big blind; fixed-limit counts an all-in of at least half the unit as
 * full. `increment` is what the hand machine stores as lastFullRaise when full.
 * Facing only a stud bring-in it is measured from zero, like an opening bet.
 */
export function classifyRaise(ctx: BettingContext, to: Chips): { full: boolean; increment: Chips } {
  const { base, step } = fullRaise(ctx);
  const increment = to - base;
  const full = ctx.betting === 'fixed-limit' ? 2 * increment >= step : increment >= step;
  return { full, increment };
}

/**
 * A full bet or raise puts `step` chips on top of `base`. The bring-in is not a
 * full bet, so while it is the only bet a completion is measured from zero.
 */
function fullRaise(ctx: BettingContext): { base: Chips; step: Chips; completing: boolean } {
  const b = ctx.bringIn;
  if (b && ctx.currentBet <= b.amount) return { base: 0, step: b.completeTo, completing: true };
  if (ctx.betting === 'fixed-limit') {
    return { base: ctx.currentBet, step: fixedRound(ctx).unit, completing: false };
  }
  const last = ctx.currentBet === 0 ? 0 : ctx.lastFullRaise;
  return { base: ctx.currentBet, step: Math.max(last, ctx.bigBlind, 1), completing: false };
}

/** Largest total the structure allows, before the stack cap. */
function ceiling(ctx: BettingContext, fullTo: Chips, toCall: Chips): Chips {
  if (ctx.betting === 'fixed-limit') return fullTo;
  if (ctx.betting === 'pot-limit') {
    // The minimum bet stays legal even when the pot is smaller.
    return Math.max(fullTo, potLimitMax(ctx.currentBet, ctx.potTotal, toCall));
  }
  return ctx.bet + ctx.stack;
}

function capReached(ctx: BettingContext): boolean {
  if (ctx.betting !== 'fixed-limit') return false;
  const f = fixedRound(ctx);
  return !f.uncapped && ctx.raisesThisRound + (f.forced ?? 0) >= f.cap;
}

function fixedRound(ctx: BettingContext): FixedLimitRound {
  if (!ctx.fixed) throw new Error('fixed-limit betting needs ctx.fixed');
  return ctx.fixed;
}

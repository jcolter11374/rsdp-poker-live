import type { Action, LegalActions, SeatIndex } from '@rsdp/engine/core';
import type { CoachMove, CoachRule, CoachTip } from '@rsdp/engine/wire';
import {
  bestDraw,
  coachTuning,
  drawFieldSize,
  estimateDetail,
  handReads,
  lowDrawRule,
  normalDecide,
  opponentDraws,
  situation,
  tipDice,
  type MoveWhy,
  type Rand,
  type Seen,
} from './strategy';

/**
 * Coach tips: what a Normal bot that never bluffs would do in this spot, with
 * the numbers behind it. It is worked out from `Seen` alone, the hand as the
 * one person in it can see it, so a tip can never use a card they have not
 * been shown. Every sentence is written in the browser (apps/web/src/coach.ts);
 * this file only counts.
 */

/** What a tip needs besides the hand as that seat sees it. */
export interface TipInput {
  /** What the player may do, worked out on the real hand (legalActions reads no cards). Null on a draw turn. */
  legal: LegalActions | null;
  /** Draw turn: the most cards they may throw away. */
  drawMax: number;
  /** Seeded from the turn, so asking twice gives the same answer. */
  rand: Rand;
  /** The decision being answered, as the browser asked for it. */
  handNumber: number;
  at: number;
}

/** A call or fold this close to what the pot asks for is a coin flip, whatever the deals said. */
const CLOSE_BAND = 0.03;
/** A chance this far above the pot odds is a call; a big call wants more (see normalDecide). */
const CALL_MARGIN = 0.03;
/** Strength (chance against an even share) that raises a hand which is not strong on its own. */
const FIELD_RAISE = 2.2;
/** Ways to draw the tip shows. */
const OPTIONS_SHOWN = 3;

export function coachTip(seen: Seen, seat: SeatIndex, input: TipInput): CoachTip {
  const { legal, rand } = input;
  const view = situation(seen, seat);
  // This hand's public betting, and nothing else: an empty players map reads everyone as an ordinary player, so no
  // other hand can count. It is a tip, not a HUD.
  view.reads = handReads(seen, seat, {});
  // Both draw games are lowball: how many cards each opponent threw is public.
  if (lowDrawRule(view.spec)) view.draws = opponentDraws(seen, seat, view.drawsInGame);
  const live = seen.seats.filter((x) => x.seat !== seat && !x.folded);
  const split = (!!view.spec.showdown.high && !!view.spec.showdown.low) || view.boards.length > 1;
  const shared = {
    handNumber: input.handNumber,
    at: input.at,
    split,
    opponents: view.opponents.length,
    drawsLeft: view.drawsLeft,
    // Live opponents, in the order the chances were worked out against them.
    reads: live.map((x, i) => ({ seat: x.seat, bets: toHundredths(view.reads![i] ?? 0) })),
    draws: view.draws ? live.map((x, i) => ({ seat: x.seat, done: [...(view.draws![i]?.done ?? [])] })) : [],
  };

  if (seen.phase === 'drawing') {
    const field = drawFieldSize(view);
    const best = bestDraw(view, input.drawMax, rand, coachTuning.draw, field);
    return {
      ...shared,
      kind: 'draw',
      share: best.equity,
      se: standardError(best.equity, coachTuning.draw.final),
      scoop: null,
      vs: field,
      vsRandom: null,
      call: 0,
      pot: potOf(cappedTotals(seen, seat, 0)),
      cost: null,
      need: null,
      big: false,
      close: false,
      move: { type: 'draw', discard: [...best.discard] },
      rule: best.discard.length ? 'draw' : 'pat',
      options: best.finalists.slice(0, OPTIONS_SHOWN).map((f) => ({ discard: [...f.discard], share: f.equity })),
    };
  }
  if (!legal) throw new Error('a tip for a betting turn needs the legal actions');

  // The chance of winning. With draws to come there is no hand to size up yet, so the best way to draw stands in,
  // played out against the whole field (as Hard does) rather than scaled up from two opponents.
  let share: number;
  let deals: number;
  let vs: number;
  let scoop: number | null = null;
  let vsRandom: number | null = null;
  if (view.drawsLeft > 0) {
    const field = drawFieldSize(view);
    share = bestDraw(view, view.cardsPerPlayer, rand, coachTuning.drawBet, field).equity;
    deals = coachTuning.drawBet.final;
    vs = field;
  } else {
    const started = performance.now();
    const main = estimateDetail(view, rand, coachTuning.equity);
    const spent = performance.now() - started;
    share = main.equity;
    deals = main.n;
    vs = main.vs;
    scoop = split ? main.scoop : null;
    // What the hand would be worth against opponents given no credit for their betting, for the browser to compare
    // against. Only when the betting counted for something, and only when there is time to spare.
    if (view.reads.some((r) => r > 0) && spent < coachTuning.vsRandomUnderMs) vsRandom = estimateDetail({ ...view, reads: undefined }, rand, coachTuning.vsRandom).equity;
  }

  // Normal's own rules decide, with dice that never bluff, steal or semi-bluff. Chips a short stack cannot cover are
  // not mine to win, so the call is measured against the pot as it would be if everyone called what they can.
  const capped = cappedTotals(seen, seat, legal.callAmount);
  const pot = potOf(capped);
  const why: MoveWhy = { rule: 'check' };
  const action = normalDecide(capped, seat, legal, share, view.opponents.length, tipDice, why);
  const rule = coachRule(why, share, view.opponents.length);
  const se = standardError(share, deals);
  // cost and need are set only when facing a bet (never a bring-in, and never with nothing to call).
  const need = why.need ?? null;
  return {
    ...shared,
    kind: 'bet',
    share,
    se,
    scoop,
    vs,
    vsRandom,
    call: legal.callAmount,
    pot,
    cost: why.cost ?? null,
    need,
    big: !!why.big,
    close: need !== null && Math.abs(share - need) < Math.max(CLOSE_BAND, 2 * se),
    move: coachMove(action, seen, seat, legal, pot, rule),
    rule,
    options: [],
  };
}

/** The rule behind the tip, from the one Normal's own code took. */
function coachRule(why: MoveWhy, share: number, opponents: number): CoachRule {
  const strength = share * (opponents + 1);
  switch (why.rule) {
    case 'bring-in':
    case 'complete':
    case 'check':
      return why.rule;
    case 'value':
      return 'bet';
    case 'raise':
      // Far ahead of an even share of a big pot, rather than strong enough on its own.
      return strength >= FIELD_RAISE && share < 0.7 ? 'raise-field' : 'raise';
    case 'call':
      return why.capped ? 'call-capped' : 'call';
    case 'fold':
      // The margin a big call wants is what folded it: a smaller bet would have been a call.
      return why.big && why.cost !== undefined && share >= why.cost + CALL_MARGIN ? 'fold-big' : 'fold';
    default:
      // Tip dice never bluff, steal or semi-bluff, and draws are answered above.
      return 'check';
  }
}

/** The move as the browser shows it: the ½ pot and ¾ pot presets where the size is one of them, and all in where it is everything. */
function coachMove(action: Action, seen: Seen, seat: SeatIndex, legal: LegalActions, pot: number, rule: CoachRule): CoachMove {
  if (action.type === 'fold' || action.type === 'check' || action.type === 'call' || action.type === 'bring-in') return { type: action.type };
  const me = seen.seats.find((x) => x.seat === seat)!;
  const type: 'bet' | 'raise' | 'complete' = rule === 'complete' ? 'complete' : action.type;
  const fraction: 0.5 | 0.75 | null = rule === 'bet' ? 0.5 : rule === 'raise' || rule === 'raise-field' ? 0.75 : null;
  // Fixed limit has one size, and a size squeezed up to the minimum or down to a stack is its own amount, not a preset.
  const preset = fraction !== null && seen.input.betting !== 'fixed-limit' && Math.round(seen.currentBet + fraction * (pot + legal.callAmount)) === action.to ? fraction : null;
  return { type, to: action.to, fraction: preset, allIn: action.to - me.bet >= me.stack };
}

/** The hand with every other seat's chips capped at what I can match: chips a short stack cannot cover are not mine to win. */
function cappedTotals(seen: Seen, seat: SeatIndex, callAmount: number) {
  const me = seen.seats.find((x) => x.seat === seat)!;
  const cap = me.total + callAmount;
  return { ...seen, seats: seen.seats.map((x) => (x.seat === seat ? x : { ...x, total: Math.min(x.total, cap) })) };
}

const potOf = (hand: { seats: { total: number }[] }) => hand.seats.reduce((sum, x) => sum + x.total, 0);

/** How rough a chance is, with a floor so a run of identical finishes doesn't claim to be exact. */
const standardError = (share: number, deals: number) => Math.sqrt(Math.max(share * (1 - share), 0.01) / Math.max(1, deals));

const toHundredths = (x: number) => Math.round(x * 100) / 100;

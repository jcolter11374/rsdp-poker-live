import { z } from 'zod';
import type { Card } from '../cards';
import type { HandEvent, HandState, Modifier, SeatIndex } from '../core/types';
import { MAX_CHIPS } from '../settings/schema';
import { registerModifierSchema } from '../settings/modifiers';

/**
 * 7-2 bounty (Hold'em games): a player who wins a pot, or any share of one,
 * holding 7 and 2 and showing both cards collects the bounty from every other
 * player dealt in. A payer short of the amount pays what they have. The money
 * moves stack to stack, outside the pot, and is never raked. Paid at most once
 * a hand, whether the cards were shown at showdown or afterwards.
 */

export const BOUNTY_SUITS = ['any', 'offsuit', 'suited'] as const;

export const Bounty72Schema = z
  .object({
    enabled: z.boolean(),
    /** Chips each other player pays (not a big blind multiple). */
    amount: z.number().int().min(1).max(MAX_CHIPS),
    /** Which 7-2 hands count. */
    suits: z.enum(BOUNTY_SUITS),
    /** Show a 7-2 winner's cards for them when nobody else saw them (an uncontested win). */
    autoShow: z.boolean(),
  })
  .strict();

export type Bounty72Settings = z.output<typeof Bounty72Schema>;

export const bounty72Schema = registerModifierSchema('bounty-72', Bounty72Schema, { enabled: false, amount: 10, suits: 'any', autoShow: true }, { cashOnly: true });

type Transfer = Omit<Extract<HandEvent, { t: 'transfer' }>, 'seq'>;

/** True for a 7 and a 2 that match the suit rule. */
export function isSevenDeuce(cards: Card[], suits: Bounty72Settings['suits']): boolean {
  if (cards.length !== 2) return false;
  const ranks = cards.map((c) => c[0]).sort().join('');
  if (ranks !== '27') return false;
  const suited = cards[0][1] === cards[1][1];
  return suits === 'any' || (suits === 'suited') === suited;
}

/** Hold'em games: a flop game dealing two hole cards. */
export function bountyGame(state: HandState): boolean {
  const { game } = state.input;
  return game.family === 'flop' && game.streets.reduce((n, st) => n + st.dealDown + st.dealUp, 0) === 2;
}

/** Seats that won chips this hand holding a qualifying 7-2; `shownOnly` keeps those who showed both cards. */
export function sevenDeuceWinners(state: HandState, cfg: Bounty72Settings, shownOnly: boolean): SeatIndex[] {
  if (!bountyGame(state)) return [];
  const winners = new Set(state.awards.filter((a) => a.amount > 0).map((a) => a.seat));
  return state.seats
    .filter((s) => winners.has(s.seat) && isSevenDeuce(s.cards.map((c) => c.card), cfg.suits))
    .filter((s) => !shownOnly || s.cards.every((c, i) => c.up || s.shown.includes(i)))
    .map((s) => s.seat);
}

function bountyTransfers(state: HandState, cfg: Bounty72Settings): Transfer[] {
  if (!cfg.enabled || state.phase !== 'complete') return [];
  if (state.events.some((e) => e.t === 'transfer' && e.kind === 'bounty-72')) return [];
  const claimants = sevenDeuceWinners(state, cfg, true);
  if (!claimants.length) return [];
  const out: Transfer[] = [];
  for (const payer of state.seats) {
    if (claimants.includes(payer.seat)) continue;
    const pay = Math.min(cfg.amount, payer.stack);
    if (pay <= 0) continue;
    // Several claimants share each payer's bounty; leftover chips go to the first in seat order.
    const share = Math.floor(pay / claimants.length);
    const odd = pay - share * claimants.length;
    claimants.forEach((to, i) => {
      const amount = share + (i < odd ? 1 : 0);
      if (amount > 0) out.push({ t: 'transfer', kind: 'bounty-72', from: payer.seat, to, amount });
    });
  }
  return out;
}

export const bounty72: Modifier<Bounty72Settings> = {
  id: 'bounty-72',
  afterSettle: (state, cfg) => bountyTransfers(state, cfg),
  afterShow: (state, cfg) => bountyTransfers(state, cfg),
};

import { z } from 'zod';
import type { HandState, Modifier, Pot } from '../core/types';
import { MAX_CHIPS } from '../settings/schema';
import { registerModifierSchema } from '../settings/modifiers';

/**
 * Simulated rake (a table fee): a percentage of each pot, rounded down to
 * whole chips, goes to the house before the pot is awarded. Nothing is paid
 * anywhere; the table just keeps a running total.
 */

const chips = z.number().int().min(0).max(MAX_CHIPS);
/** Up to two decimals, e.g. 2.5 (%). */
const percent = z
  .number()
  .min(0)
  .max(100)
  .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-9, 'must have at most two decimals');

export const RakeSchema = z
  .object({
    enabled: z.boolean(),
    /** Percent of each pot. */
    percent,
    /** Most taken from one pot; 0 = no cap. */
    cap: chips,
    /** No fee unless the hand's pot reaches this; 0 = any pot. */
    minPot: chips,
    /** No fee when the hand ends before the flop (stud and draw: before the second round). */
    noFlopNoDrop: z.boolean(),
    /** A second rate for short tables: used when this many players or fewer are dealt in; 0 = off. */
    shortHanded: z
      .object({
        players: z.number().int().min(0).max(10),
        percent,
        cap: chips,
      })
      .strict(),
    /** Who sees the running total. */
    visibleTo: z.enum(['host', 'everyone']),
  })
  .strict();

export type RakeSettings = z.output<typeof RakeSchema>;

export const rakeSchema = registerModifierSchema(
  'rake',
  RakeSchema,
  { enabled: false, percent: 5, cap: 0, minPot: 0, noFlopNoDrop: true, shortHanded: { players: 0, percent: 2.5, cap: 0 }, visibleTo: 'host' },
  { cashOnly: true },
);

/** True once the hand got past the first betting round (a flop, or a second street). */
function sawFlop(state: HandState): boolean {
  if (state.input.game.family === 'flop') return (state.runs[0]?.[0]?.length ?? 0) >= 3;
  return state.street > 0;
}

export function rakeFor(pot: Pot, state: HandState, cfg: RakeSettings): number {
  if (!cfg.enabled) return 0;
  if (cfg.noFlopNoDrop && !sawFlop(state)) return 0;
  const total = state.seats.reduce((n, s) => n + s.total, 0);
  if (total < cfg.minPot) return 0;
  const short = cfg.shortHanded.players > 0 && state.seats.length <= cfg.shortHanded.players;
  const rate = short ? cfg.shortHanded.percent : cfg.percent;
  // A short-handed cap of 0 keeps the normal cap.
  const cap = short && cfg.shortHanded.cap > 0 ? cfg.shortHanded.cap : cfg.cap;
  // Integer maths in hundredths of a percent, so 2.5% of 200 is exactly 5.
  const fee = Math.floor((pot.amount * Math.round(rate * 100)) / 10_000);
  return Math.min(pot.amount, cap > 0 ? Math.min(fee, cap) : fee);
}

export const rake: Modifier<RakeSettings> = {
  id: 'rake',
  potFee: (pot, state, cfg) => rakeFor(pot, state, cfg),
};

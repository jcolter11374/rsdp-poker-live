import { z } from 'zod';
import type { BettingKind, Rng } from '../core/types';
import { BETTING_KINDS } from '../settings/schema';
import { registerModifierSchema } from '../settings/modifiers';

/**
 * Bomb pots: every player dealt in posts a number of big blinds, the flop
 * comes at once and betting starts after it. The runtime decides between
 * hands whether the next one is a bomb pot (it has to, because the posts
 * replace the blinds), so this module only holds the settings and the rule.
 */

export const BOMB_POT_LIMITS = {
  chancePercent: { min: 0, max: 100 },
  everyHands: { min: 0, max: 1000 },
  bigBlinds: { min: 1, max: 100 },
} as const;

const L = BOMB_POT_LIMITS;
const int = (r: { min: number; max: number }) => z.number().int().min(r.min).max(r.max);

export const BombPotSchema = z
  .object({
    /** Deal bomb pots on their own (by chance or every N hands). The host's "next hand" button works either way. */
    enabled: z.boolean(),
    /** Chance each hand is a bomb pot, 0-100%. */
    chancePercent: int(L.chancePercent),
    /** Also a bomb pot every N hands, counted from the last one; 0 = off. */
    everyHands: int(L.everyHands),
    /** What each player posts, in big blinds (1-100). */
    bigBlinds: int(L.bigBlinds),
    /** Game for bomb pots, e.g. PLO at a Hold'em table; '' = the table's game. Must be a game with a flop. */
    gameId: z.string().regex(/^([A-Za-z0-9_-]{1,40})?$/, 'must be a game id or empty'),
    /** Betting structure when gameId is set. */
    betting: z.enum(BETTING_KINDS),
  })
  .strict();

export type BombPotSettings = z.output<typeof BombPotSchema>;

export const bombPotSchema = registerModifierSchema(
  'bomb-pot',
  BombPotSchema,
  { enabled: false, chancePercent: 10, everyHands: 0, bigBlinds: 5, gameId: '', betting: 'pot-limit' satisfies BettingKind },
  { cashOnly: true },
);

/**
 * Whether the next hand is a bomb pot. `handsSince` counts hands dealt since
 * the last bomb pot (or since the table opened); `requested` is the host's
 * one-off button.
 */
export function bombPotDue(cfg: BombPotSettings, args: { handsSince: number; requested: boolean; rng: Rng }): boolean {
  if (args.requested) return true;
  if (!cfg.enabled) return false;
  if (cfg.everyHands > 0 && args.handsSince + 1 >= cfg.everyHands) return true;
  return cfg.chancePercent > 0 && args.rng(100) < cfg.chancePercent;
}

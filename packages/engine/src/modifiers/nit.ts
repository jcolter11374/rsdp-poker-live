import { z } from 'zod';
import { pots } from '../core/hand';
import type { HandState, SeatIndex } from '../core/types';
import { registerModifierSchema } from '../settings/modifiers';

/**
 * The Nit game: players opt in, and once enough have, a round starts. Every
 * participant holds a "nit" until they win a pot outright. When only one
 * holder is left, they pay the prize to every other participant and the
 * round ends; a holder who leaves mid-round pays at once. The rounds span
 * hands, so the table runtime runs them; this module holds the settings and
 * the rule for clearing a nit.
 */

export const NitSchema = z
  .object({
    enabled: z.boolean(),
    /** What the last holder pays each other participant, in big blinds at the round's start (1-100). */
    prizeBigBlinds: z.number().int().min(1).max(100),
    /** Opted-in players dealt into a hand before a round starts (2-10). */
    minPlayers: z.number().int().min(2).max(10),
  })
  .strict();

export type NitSettings = z.output<typeof NitSchema>;

export const nitSchema = registerModifierSchema('nit', NitSchema, { enabled: false, prizeBigBlinds: 10, minPlayers: 3 }, { cashOnly: true });

/**
 * Holders among `seats` who won outright this hand: they took the whole of
 * every pot they could win (an uncontested pot counts; a chop, a split
 * hi-lo pot or one run of two does not).
 */
export function nitClears(hand: HandState, seats: SeatIndex[]): SeatIndex[] {
  if (hand.phase !== 'complete') return [];
  const potList = pots(hand);
  return seats.filter((seat) => {
    const mine = potList.map((p, i) => ({ p, i })).filter(({ p }) => p.eligible.includes(seat));
    if (!mine.length) return false;
    return mine.every(({ i }) => {
      const awards = hand.awards.filter((a) => a.pot === i);
      return awards.length > 0 && awards.every((a) => a.seat === seat);
    });
  });
}

import { z } from 'zod';
import type { HandInput, Modifier } from '../core/types';
import { registerModifierSchema } from '../settings/modifiers';

/**
 * Double board: two boards are dealt on every street, and each pot is split
 * between the best hand on each board. Flop games only, and only when the
 * deck holds enough cards for both boards.
 */

export const DOUBLE_BOARD_WHEN = ['always', 'bomb-pots'] as const;

export const DoubleBoardSchema = z
  .object({
    enabled: z.boolean(),
    /** Every hand, or bomb pots only. */
    when: z.enum(DOUBLE_BOARD_WHEN),
  })
  .strict();

export type DoubleBoardSettings = z.output<typeof DoubleBoardSchema>;

export const doubleBoardSchema = registerModifierSchema('double-board', DoubleBoardSchema, { enabled: false, when: 'bomb-pots' }, { cashOnly: true });

/** Cards a hand needs with `boards` boards (no burn cards). */
export function cardsNeeded(input: HandInput, boards: number): number {
  const players = input.seats.length;
  return input.game.streets.reduce((n, st) => n + (st.dealDown + st.dealUp) * players + st.dealBoard * boards, 0);
}

export const doubleBoard: Modifier<DoubleBoardSettings> = {
  id: 'double-board',
  beforeHand(input, cfg) {
    if (!cfg.enabled || input.game.family !== 'flop') return input;
    if (cfg.when === 'bomb-pots' && !input.options.bombPot) return input;
    if (cardsNeeded(input, 2) > input.deck.length) return input;
    return { ...input, options: { ...input.options, boards: 2 } };
  },
};

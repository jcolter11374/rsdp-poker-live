import { highRules } from './high';
import { variants } from './registry';
import type { GameSpec } from './types';

/**
 * Texas hold'em, the one game the core ships with. Every other game lives in
 * src/variants and registers itself the same way.
 */
export const HOLDEM: GameSpec = {
  id: 'nlhe',
  name: "Texas Hold'em",
  family: 'flop',
  streets: [
    { name: 'Preflop', dealDown: 2, dealUp: 0, dealBoard: 0, betSize: 'small' },
    { name: 'Flop', dealDown: 0, dealUp: 0, dealBoard: 3, betSize: 'small' },
    { name: 'Turn', dealDown: 0, dealUp: 0, dealBoard: 1, betSize: 'big' },
    { name: 'River', dealDown: 0, dealUp: 0, dealBoard: 1, betSize: 'big' },
  ],
  maxPlayers: 10,
  defaultBetting: 'no-limit',
  split: 'high',
  forcedBets: 'blinds',
};

export function registerHoldem() {
  variants.register(HOLDEM, highRules);
}

import type { Card, GameSpec, SeatIndex } from '../../src/core/types';

export const nlh: GameSpec = {
  id: 'nlh',
  name: "No-Limit Hold'em",
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

/** "As Kd" -> ['As', 'Kd']. */
export const cards = (s: string): Card[] => (s ? s.split(' ') : []);

export const holes = (bySeat: Record<SeatIndex, string>): Record<SeatIndex, Card[]> =>
  Object.fromEntries(Object.entries(bySeat).map(([seat, c]) => [seat, cards(c)]));

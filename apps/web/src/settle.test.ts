import { describe, expect, it } from 'vitest';
import { settleUp } from './records';

describe('settle up with practice bots', () => {
  it('pays only between people and says what the bots won', () => {
    const r = settleUp([
      { playerId: 'a', name: 'Ann', net: -100 },
      { playerId: 'b', name: 'Bo', net: 60 },
      { playerId: 'x', name: "Ann's Poker Bot", net: 40, bot: true },
    ]);
    expect(r).toEqual({ transfers: [{ from: 'Ann', to: 'Bo', amount: 60 }], off: 0, bots: 40 });
  });

  it('a person who only played bots owes nobody', () => {
    expect(settleUp([
      { playerId: 'a', name: 'Ann', net: -30 },
      { playerId: 'x', name: 'Bot', net: 30, bot: true },
    ])).toEqual({ transfers: [], off: 0, bots: 30 });
  });
});

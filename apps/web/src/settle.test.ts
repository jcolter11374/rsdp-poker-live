import { describe, expect, it } from 'vitest';
import { offAfterFees, settleUp } from './records';

describe('settle up with practice bots', () => {
  it('pays only between people and says what the bots won', () => {
    const r = settleUp([
      { playerId: 'a', name: 'Ann', net: -100 },
      { playerId: 'b', name: 'Bo', net: 60 },
      { playerId: 'x', name: 'Ace', net: 40, bot: true },
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

describe('settle up at a table with a house fee', () => {
  // Ann lost 100, Bo won 94: the house fee took 6 off the table.
  const rows = [
    { playerId: 'a', name: 'Ann', net: -100 },
    { playerId: 'b', name: 'Bo', net: 94 },
  ];

  it('does not call the fee a mistake in the buy-ins', () => {
    const { off } = settleUp(rows);
    expect(off).toBe(-6);
    expect(offAfterFees(off, 6, true)).toBe(0);
    // A player the host doesn't show the fee total to.
    expect(offAfterFees(off, null, true)).toBe(0);
  });

  it('still reports a gap the fee does not explain', () => {
    expect(offAfterFees(-10, 6, true)).toBe(-4);
    expect(offAfterFees(5, 6, true)).toBe(11);
    expect(offAfterFees(5, null, true)).toBe(5);
    expect(offAfterFees(-6, null, false)).toBe(-6);
  });
});

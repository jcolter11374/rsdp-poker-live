import { describe, expect, it } from 'vitest';
import { seatFractions } from './geometry';

const seats = (n: number, taken: number[]) => Array.from({ length: n }, (_, i) => taken.includes(i));

describe('seatFractions', () => {
  it('spaces a full table evenly from the anchor', () => {
    expect(seatFractions(seats(4, [0, 1, 2, 3]), 2)).toEqual([0.5, 0.75, 0, 0.25]);
  });

  it('spreads four players round a ten-seat table instead of bunching them', () => {
    const f = seatFractions(seats(10, [0, 1, 2, 3]), 0);
    expect([0, 1, 2, 3].map((s) => f[s])).toEqual([0, 0.25, 0.5, 0.75]);
    // The six empty seats share the last quarter, in seat order.
    const empties = [4, 5, 6, 7, 8, 9].map((s) => f[s]);
    expect(empties.every((t, i) => t > 0.75 && t < 1 && (i === 0 || t > empties[i - 1]))).toBe(true);
  });

  it('puts the anchor at the bottom and keeps seat order round the table', () => {
    const f = seatFractions(seats(9, [1, 4, 8]), 4);
    expect(f[4]).toBe(0);
    expect(f[8]).toBeCloseTo(1 / 3);
    expect(f[1]).toBeCloseTo(2 / 3);
    const order = [4, 5, 6, 7, 8, 0, 1, 2, 3].map((s) => f[s]);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('keeps empty seats a margin away from the players beside them', () => {
    const f = seatFractions(seats(10, [0, 1, 2, 3]), 0, 0.04);
    const empties = [4, 5, 6, 7, 8, 9].map((s) => f[s]);
    expect(Math.min(...empties)).toBeGreaterThanOrEqual(0.79);
    expect(Math.max(...empties)).toBeLessThanOrEqual(0.96);
    // A margin too big for the gap shrinks to fit rather than overlapping players.
    const tight = seatFractions(seats(10, [0, 1, 2, 3]), 0, 0.5);
    expect([4, 5, 6, 7, 8, 9].every((s) => tight[s] > 0.75 && tight[s] < 1)).toBe(true);
  });

  it('falls back to even spacing when nobody is seated', () => {
    expect(seatFractions(seats(4, []), 0)).toEqual([0, 0.25, 0.5, 0.75]);
  });
});

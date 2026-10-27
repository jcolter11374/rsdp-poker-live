import { describe, expect, it } from 'vitest';
import { baseChip, breakdown, CHIP_SET, DOLLAR_CHIPS } from './Chips';

const total = (parts: [number, number][], base: number) => parts.reduce((s, [i, n]) => s + CHIP_SET[i].mult * base * n, 0);

describe('chips', () => {
  it('picks a base chip from the smallest forced bet', () => {
    expect(baseChip(1)).toBe(1);
    expect(baseChip(5)).toBe(1);
    expect(baseChip(25)).toBe(10);
    expect(baseChip(100)).toBe(100);
    expect(baseChip(0)).toBe(1);
  });

  it('breaks an amount into the fewest chips, biggest first', () => {
    expect(breakdown(137, 1)).toEqual([
      [3, 1],
      [2, 1],
      [1, 2],
      [0, 2],
    ]);
    expect(total(breakdown(137, 1), 1)).toBe(137);
  });

  it('rounds a remainder below the base chip into one more small chip', () => {
    expect(breakdown(55, 10)).toEqual([
      [1, 1],
      [0, 1],
    ]);
  });

  it('gives nothing for nothing', () => {
    expect(breakdown(0, 1)).toEqual([]);
  });
});

describe('casino chips for cash games', () => {
  it('pays out dollars and cents exactly, biggest chips first', () => {
    const parts = breakdown(13_731, 1, DOLLAR_CHIPS);
    expect(parts.map(([i, n]) => [DOLLAR_CHIPS[i].mult, n])).toEqual([
      [10000, 1],
      [2500, 1],
      [500, 2],
      [100, 2],
      [25, 1],
      [5, 1],
      [1, 1],
    ]);
    expect(parts.reduce((s, [i, n]) => s + DOLLAR_CHIPS[i].mult * n, 0)).toBe(13_731);
    // A .25/.50 big blind is two quarters.
    expect(breakdown(50, 1, DOLLAR_CHIPS)).toEqual([[2, 2]]);
  });
});

import { describe, expect, it } from 'vitest';
import { baseChip, breakdown, CHIP_SET } from './Chips';

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

import { describe, expect, it } from 'vitest';
import { seeded } from './fake-clock';

describe('seeded test RNG', () => {
  it('repeats for the same seed and differs between seeds', () => {
    const draw = (seed: number) => {
      const r = seeded(seed);
      return Array.from({ length: 50 }, () => r(52));
    };
    expect(draw(7)).toEqual(draw(7));
    expect(draw(7)).not.toEqual(draw(3));
  });

  it('gives every value, about evenly, with no low bit stuck (a coin comes up both ways)', () => {
    for (const n of [2, 3, 4, 8, 52, 256]) {
      const r = seeded(7);
      const counts = new Array(n).fill(0);
      const draws = n * 400;
      for (let i = 0; i < draws; i++) {
        const v = r(n);
        if (!(Number.isInteger(v) && v >= 0 && v < n)) throw new Error(`r(${n}) gave ${v}`);
        counts[v]++;
      }
      // Each value is expected 400 times; a fair generator stays well inside 300..500.
      for (const c of counts) expect(c).toBeGreaterThan(300);
      for (const c of counts) expect(c).toBeLessThan(500);
    }
  });

  it('does not fall into a short repeating cycle', () => {
    const r = seeded(7);
    const seen = new Set<number>();
    const draws = 200_000;
    for (let i = 0; i < draws; i++) seen.add(r(0x7fffffff));
    // Out of 2^31 values, 200,000 fair draws repeat only about ten times.
    expect(seen.size).toBeGreaterThan(draws - 100);
  });
});

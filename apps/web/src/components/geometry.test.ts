import { describe, expect, it } from 'vitest';
import { clearSideBands, pastBox, seatFractions, stadiumPoint } from './geometry';

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

  it('keeps empty seats clear of the players beside them', () => {
    const f = seatFractions(seats(10, [0, 1, 2, 3]), 0, { clear: 0.04 });
    const empties = [4, 5, 6, 7, 8, 9].map((s) => f[s]);
    expect(Math.min(...empties) - 0.75).toBeGreaterThanOrEqual(0.04 - 1e-9);
    expect(1 - Math.max(...empties)).toBeGreaterThanOrEqual(0.04 - 1e-9);
    // Not enough room to keep clear: back to even spacing rather than overlapping players.
    expect(seatFractions(seats(10, [0, 1, 2, 3]), 0, { clear: 0.2 })).toEqual(Array.from({ length: 10 }, (_, s) => s / 10));
    // A single empty seat needs room on both sides too.
    expect(seatFractions(seats(3, [0, 1]), 0, { clear: 0.3 })).toEqual([0, 1 / 3, 2 / 3]);
  });

  it('keeps empty seats apart, going back to even spacing on a nearly full table', () => {
    // Four players, six empty seats: plenty of room, so players spread out.
    const sparse = seatFractions(seats(10, [0, 1, 2, 3]), 0, { clear: 0.04, minGap: 0.03 });
    expect(sparse[1]).toBe(0.25);
    const gaps = [4, 5, 6, 7, 8, 9, 10].map((s, i, a) => (i === 0 ? sparse[4] - 0.75 : s === 10 ? 1 - sparse[9] : sparse[s] - sparse[a[i - 1]]));
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(0.03 - 1e-9);
    // Eight players and two empty seats side by side: too tight, so seats go back to even spacing.
    expect(seatFractions(seats(10, [0, 1, 2, 3, 4, 5, 8, 9]), 0, { clear: 0.04, minGap: 0.045 })).toEqual(
      Array.from({ length: 10 }, (_, s) => s / 10),
    );
  });

  it('falls back to even spacing when nobody is seated', () => {
    expect(seatFractions(seats(4, []), 0)).toEqual([0, 0.25, 0.5, 0.75]);
  });
});

describe('clearSideBands', () => {
  const even = (n: number) => Array.from({ length: n }, (_, i) => i / n);

  it('keeps every seat out of the middle of the long sides on a tall table', () => {
    const [w, h, band] = [300, 600, 160];
    for (const t of clearSideBands(even(8), w, h, band)) {
      const p = stadiumPoint(t, w, h);
      const onSide = Math.abs(Math.abs(p.x - w / 2) - w / 2) < 1;
      if (onSide) expect(Math.abs(p.y - h / 2)).toBeGreaterThanOrEqual(band / 2 - 0.5);
    }
  });

  it('keeps the bottom seat at the bottom and the order round the table', () => {
    const out = clearSideBands(even(8), 300, 600, 160);
    expect(out[0]).toBe(0);
    expect(out.every((t, i) => i === 0 || t > out[i - 1])).toBe(true);
  });

  it('leaves wide tables alone', () => {
    expect(clearSideBands(even(6), 800, 500, 160)).toEqual(even(6));
  });
});

describe('pastBox', () => {
  it('puts a bet just below a seat at the top of the table', () => {
    const p = pastBox({ x: 100, y: 0 }, { x: 100, y: 200 }, { l: 50, r: 50, u: 40, d: 30 }, { w: 20, h: 10 }, 6);
    expect(p).toEqual({ x: 100, y: 46 });
  });

  it('never goes past the given share of the way', () => {
    const p = pastBox({ x: 0, y: 0 }, { x: 0, y: 50 }, { l: 50, r: 50, u: 40, d: 60 }, { w: 20, h: 10 }, 6, 0.5);
    expect(p).toEqual({ x: 0, y: 25 });
  });
});

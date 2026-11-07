import { describe, expect, it } from 'vitest';
import { besideBet, clearSideBands, fitHand, handRoom, handSpan, inFront, placeRow, seatFractions, stadiumPoint } from './geometry';

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
    // Eight players and two empty seats side by side: too tight to space the players evenly, so that stretch grows just
    // enough and the rest share what is left, everything still apart and in order.
    const tight = seatFractions(seats(10, [0, 1, 2, 3, 4, 5, 8, 9]), 0, { clear: 0.04, minGap: 0.045 });
    expect(tight[0]).toBe(0);
    expect(tight).toEqual([...tight].sort((a, b) => a - b));
    expect(tight[7] - tight[6]).toBeGreaterThanOrEqual(0.045 - 1e-9);
    expect(tight[6] - tight[5]).toBeGreaterThanOrEqual(0.04 - 1e-9);
  });

  it('keeps two players at neighbouring seats far apart when the empty seats can only fit on one side', () => {
    const f = seatFractions(seats(10, [0, 1]), 0, { clear: 0.12, minGap: 0.07 });
    // The eight empty seats need 0.73 of the way round, so the other player gets the rest, not a tenth.
    expect(f[1]).toBeCloseTo(0.27);
    const order = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((s) => f[s]);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(1 - f[9]).toBeGreaterThanOrEqual(0.12 - 1e-9);
  });

  it('spreads players as evenly as it can when one stretch of empty seats needs more room (a phone, five empty in a row)', () => {
    const f = seatFractions(seats(9, [0, 1, 2, 3]), 0, { clear: 0.06, minGap: 0.035 });
    const gaps = [1, 2, 3].map((s) => f[s] - f[s - 1]);
    expect(Math.min(...gaps)).toBeGreaterThan(0.06 * 1.5);
    // Not bunched at even ninths, as they would be with even spacing.
    expect(f[3]).toBeGreaterThan(3 / 9 + 0.05);
    const order = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((s) => f[s]);
    expect(order).toEqual([...order].sort((a, b) => a - b));
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

describe('inFront', () => {
  const box = { l: 140, r: 140, u: 60, d: 30 };
  const half = { w: 30, h: 12 };

  it('puts a top seat\'s bet straight below its nameplate, leaning in a little', () => {
    const p = inFront({ x: 200, y: 0 }, { x: 600, y: 300 }, box, half, 6);
    expect(p.y).toBe(48);
    expect(p.x).toBeCloseTo(248);
  });

  it('puts a seat at the end of the table beside its nameplate', () => {
    const p = inFront({ x: 0, y: 300 }, { x: 600, y: 300 }, box, half, 6);
    expect(p).toEqual({ x: 176, y: 300 });
  });

  it('never goes most of the way to the middle', () => {
    const p = inFront({ x: 600, y: 560 }, { x: 600, y: 300 }, { ...box, u: 400 }, half, 6);
    expect(p.y).toBeCloseTo(560 - 260 * 0.8);
  });
});

describe('besideBet', () => {
  it('puts the button beside a top seat\'s bet, away from the middle', () => {
    expect(besideBet({ x: 250, y: 50 }, { x: 200, y: 0 }, { x: 600, y: 300 }, { w: 30, h: 12 }, 20)).toEqual({ x: 200, y: 50 });
  });

  it('puts the button above a left seat\'s bet when the seat is above the middle', () => {
    expect(besideBet({ x: 176, y: 290 }, { x: 0, y: 280 }, { x: 600, y: 300 }, { w: 30, h: 12 }, 20)).toEqual({ x: 176, y: 258 });
  });
});

describe('handRoom, handSpan and fitHand (#304: your cards covering a neighbour on a phone)', () => {
  const box = (left: number, right: number, top: number, bottom: number) => ({ left, right, top, bottom });
  // A 390px phone, nine players: your nameplate in the middle, Bea and Host either side and a little higher, Cal far above.
  const mine = box(155, 235, 530, 578);
  const others = [box(66, 141, 495, 543), box(248, 327, 495, 543), box(23, 98, 408, 456)];

  const screen = { left: 0, right: 390 };

  it('upright: from the nearest plate on the left to the nearest on the right, among those level with your cards', () => {
    expect(handSpan(mine, others, 84, screen)).toEqual({ left: 141 + 6, right: 248 - 6 });
  });
  it('ignores plates far above your cards, and goes to the screen edges when nobody is beside you', () => {
    expect(handSpan(mine, [box(23, 98, 300, 348)], 84, screen)).toEqual({ left: 3, right: 387 });
  });
  it('sideways: the gap to the nearest plate on your left', () => {
    expect(handRoom(box(380, 460, 265, 313), [box(205, 275, 265, 313), box(565, 640, 265, 313)], 56)).toBe(380 - 6 - 275 - 6);
  });
  it('sideways: counts a plate level with your cards, even if not with your nameplate', () => {
    // Your cards (56px tall) reach 4px above and below your 48px nameplate.
    expect(handRoom(box(380, 460, 265, 313), [box(205, 275, 215, 263)], 56)).toBe(380 - 6 - 275 - 6);
    expect(handRoom(box(380, 460, 265, 313), [box(205, 275, 200, 258)], 56)).toBe(Infinity);
  });

  it('leaves a hand that fits as it is', () => {
    expect(fitHand(4, 200, { cw: 60, overlap: 24 })).toBeNull();
    expect(fitHand(4, Infinity, { cw: 60, overlap: 24 })).toBeNull();
  });
  it('bunches the cards first, then shrinks them, never past the floor', () => {
    const natural = { cw: 60, overlap: 24 };
    const width = (f: { cw: number; overlap: number }) => f.cw + 3 * (f.cw - f.overlap);
    const bunched = fitHand(4, 150, natural)!;
    expect(bunched.cw).toBe(60);
    expect(width(bunched)).toBeLessThanOrEqual(150);
    const smaller = fitHand(4, 96, natural)!;
    expect(smaller.cw).toBeLessThan(60);
    expect(width(smaller)).toBeLessThanOrEqual(97);
    // At least 45% of each card still shows, enough for its rank and suit.
    expect(smaller.cw - smaller.overlap).toBeGreaterThanOrEqual(Math.floor(smaller.cw * 0.45));
    expect(fitHand(4, 20, natural)!.cw).toBe(30);
  });
});

describe('placeRow (#318: other players\' cards covering the next seat on a phone)', () => {
  const box = (left: number, right: number, top: number, bottom: number) => ({ left, right, top, bottom });
  const four = { cards: 4, cw: 30, step: 22 };
  const width = (cards: number, cw: number, step: number) => cw + (cards - 1) * step;
  const screen = { left: 0, right: 390 };
  // A 390px phone, nine players at Omaha: Dee in the top-left corner, Eli's nameplate up and to the right of her cards.
  const dee = box(34, 120, 175, 223);
  const deeRow = { top: 136, bottom: 178 };
  const eli = box(106, 188, 108, 156);

  it('leaves a row that fits centred over its nameplate', () => {
    expect(placeRow(box(160, 240, 300, 348), { top: 261, bottom: 303 }, [eli], screen, four)).toBeNull();
  });
  it('moves a row aside, keeping its look, when the next nameplate is in the way', () => {
    const p = placeRow(dee, deeRow, [eli], screen, four)!;
    expect(p).toMatchObject({ cw: 30, step: 22 });
    const left = (dee.left + dee.right) / 2 - width(4, 30, 22) / 2 + p.shift;
    expect(left).toBeGreaterThanOrEqual(3);
    expect(left + width(4, 30, 22)).toBeLessThanOrEqual(eli.left - 3);
  });
  it('ignores what is above or below the row', () => {
    // A nameplate that only reaches a sliver (4px) into the row, from above or below, doesn't count either.
    expect(placeRow(dee, deeRow, [box(106, 188, 40, 136), box(106, 188, 178, 230), box(106, 188, 100, 140), box(106, 188, 174, 230)], screen, four)).toBeNull();
    // Any more, and it does.
    expect(placeRow(dee, deeRow, [box(106, 188, 100, 142)], screen, four)).not.toBeNull();
  });
  it('bunches the cards only when there is no room to move into, then makes them smaller', () => {
    // Nameplates either side, 80px apart: the row can't move, so it bunches to fit between them.
    const p = placeRow(box(150, 230, 300, 348), { top: 261, bottom: 303 }, [box(60, 145, 270, 318), box(235, 320, 270, 318)], screen, four)!;
    const w = width(4, p.cw, p.step);
    expect(p.cw).toBe(30);
    expect(p.step).toBeLessThan(22);
    expect(p.step).toBeGreaterThanOrEqual(15);
    expect(190 + p.shift - w / 2).toBeGreaterThanOrEqual(148);
    expect(190 + p.shift + w / 2).toBeLessThanOrEqual(232);
    // Seven stud cards in 110px: bunched as far as half a card each, they'd still be 120px wide, so they get smaller too.
    const seven = placeRow(box(150, 230, 300, 348), { top: 261, bottom: 303 }, [box(60, 137, 270, 318), box(253, 320, 270, 318)], screen, { cards: 7, cw: 30, step: 19 })!;
    expect(seven).toMatchObject({ cw: 26, step: 13 });
    expect(width(7, seven.cw, seven.step)).toBeLessThanOrEqual(110);
    // In 50px they can't fit at the smallest size either: they sit in the middle of the room.
    const tight = placeRow(box(150, 230, 300, 348), { top: 261, bottom: 303 }, [box(60, 162, 270, 318), box(218, 320, 270, 318)], screen, { cards: 7, cw: 30, step: 19 })!;
    expect(tight).toEqual({ cw: 24, step: 12, shift: 0 });
  });
  it('keeps to its side of a line halfway to a level neighbour', () => {
    // Two rows level with each other, nameplates 10px apart: a line at 195 between them.
    const wall = box(195, 195, 261, 303);
    const p = placeRow(box(100, 190, 300, 348), { top: 261, bottom: 303 }, [wall], screen, { cards: 5, cw: 30, step: 19 })!;
    expect(145 + p.shift + width(5, 30, p.step) / 2).toBeLessThanOrEqual(192);
  });
  it('stays on the screen', () => {
    const p = placeRow(box(-10, 70, 300, 348), { top: 261, bottom: 303 }, [], screen, { cards: 7, cw: 30, step: 19 })!;
    expect(30 + p.shift - width(7, 30, 19) / 2).toBeGreaterThanOrEqual(3);
    // Even when it can't fit: squeezed against the screen's edge, it spills over the nameplate beside it instead.
    const q = placeRow(box(0, 76, 300, 348), { top: 261, bottom: 303 }, [box(60, 140, 270, 318)], screen, { cards: 7, cw: 30, step: 19 })!;
    expect(38 + q.shift - width(7, q.cw, q.step) / 2).toBeGreaterThanOrEqual(3);
  });
});

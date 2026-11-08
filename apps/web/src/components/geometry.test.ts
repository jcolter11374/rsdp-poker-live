import { describe, expect, it } from 'vitest';
import { apart, besideBet, clearOfRows, clearSideBands, FELT_SLACK, fitHand, fitMiddle, handRoom, handSpan, inFront, keepPlaced, placeHand, placePlayers, placeRow, placeSeats, playerFractions, seatFractions, seatsApart, spreadByBoxes, stadiumLength, stadiumPoint, type Extent } from './geometry';

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

describe('apart', () => {
  const plate: Extent = { l: 100, r: 100, u: 30, d: 30 };
  it('is true side by side or one above the other, and false when the boxes cross', () => {
    expect(apart({ x: 0, y: 0 }, plate, { x: 200, y: 0 }, plate)).toBe(true);
    expect(apart({ x: 0, y: 0 }, plate, { x: 150, y: 59 }, plate)).toBe(false);
    expect(apart({ x: 0, y: 0 }, plate, { x: 150, y: 60 }, plate)).toBe(true);
    expect(apart({ x: 0, y: 60 }, plate, { x: 150, y: 0 }, plate)).toBe(true);
  });
  it('asks for the gap too, and reads each side of a lopsided box', () => {
    expect(apart({ x: 0, y: 0 }, plate, { x: 200, y: 0 }, plate, 1)).toBe(false);
    // Cards standing up over a nameplate reach further up than down.
    const tall: Extent = { l: 100, r: 100, u: 70, d: 30 };
    expect(apart({ x: 0, y: 0 }, tall, { x: 0, y: -90 }, plate)).toBe(false);
    expect(apart({ x: 0, y: 0 }, tall, { x: 0, y: 100 }, plate)).toBe(true);
  });
});

describe('placeSeats (#363: nameplates covering each other on a laptop)', () => {
  // The felt of a 1280x800 window with the side column, and the boxes of #363's table: four-card Omaha nameplates with
  // their cards (yours a little bigger), and the + Bot button of an empty seat.
  const w = 646;
  const h = 391;
  const box = (taken: boolean[], me: Extent, other: Extent, empty: Extent) => (seat: number) => (!taken[seat] ? empty : seat === 0 ? me : other);
  const omaha = { me: { l: 140, r: 140, u: 45, d: 30 }, other: { l: 134, r: 134, u: 38, d: 31 } };
  const plusBot: Extent = { l: 40, r: 40, u: 14, d: 14 };
  // The spacing Table.tsx asks seatFractions for: half the widest nameplate and half an empty seat, and 120px between empty seats.
  const spacing = (podHalf: number) => ({ clear: (podHalf + 58 + 6) / stadiumLength(w, h), minGap: 120 / stadiumLength(w, h) });
  const inOrder = (f: readonly number[]) => {
    const round = f.map((t, s) => ({ t, s })).sort((a, b) => a.t - b.t).map((x) => x.s);
    return round.every((s, i) => s === i);
  };

  it('moves four Omaha players apart where even spacing put two nameplates on top of each other', () => {
    const taken = seats(9, [0, 1, 2, 3]);
    const b = box(taken, omaha.me, omaha.other, plusBot);
    // The old spacing ran out of room and spaced all nine seats evenly: your nameplate covered the next one.
    const old = seatFractions(taken, 0, spacing(140));
    expect(old).toEqual(Array.from({ length: 9 }, (_, s) => s / 9));
    expect(seatsApart(old, w, h, b)).toBe(false);
    const f = placeSeats(taken, 0, w, h, { ...spacing(140), box: b, gap: 6 });
    expect(seatsApart(f, w, h, b)).toBe(true);
    expect(f[0]).toBe(0);
    expect(inOrder(f)).toBe(true);
    // The players spread round the table, a quarter each, and the empty seats share the last quarter.
    [1, 2, 3].forEach((s) => expect(f[s]).toBeCloseTo(s / 4, 1));
  });

  it('keeps six and nine Omaha players clear of each other on the same laptop', () => {
    const six = seats(9, [0, 1, 2, 3, 4, 5]);
    const small = { me: { l: 125, r: 125, u: 40, d: 23 }, other: { l: 120, r: 120, u: 30, d: 23 } };
    const b6 = box(six, small.me, small.other, plusBot);
    expect(seatsApart(seatFractions(six, 0, spacing(125)), w, h, b6)).toBe(false);
    const f6 = placeSeats(six, 0, w, h, { ...spacing(125), box: b6, gap: 6 });
    expect(seatsApart(f6, w, h, b6)).toBe(true);
    expect(inOrder(f6)).toBe(true);
    const nine = seats(9, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
    const smaller = { me: { l: 120, r: 120, u: 38, d: 22 }, other: { l: 115, r: 115, u: 29, d: 22 } };
    const b9 = box(nine, smaller.me, smaller.other, plusBot);
    expect(seatsApart(seatFractions(nine, 0, spacing(120)), w, h, b9)).toBe(false);
    const f9 = placeSeats(nine, 0, w, h, { ...spacing(120), box: b9, gap: 6 });
    expect(seatsApart(f9, w, h, b9)).toBe(true);
    expect(inOrder(f9)).toBe(true);
  });

  it('mirrors the table when the players sit on the other side of you', () => {
    const after = seats(9, [0, 1, 2, 3]);
    const before = seats(9, [0, 6, 7, 8]);
    const fa = placeSeats(after, 0, w, h, { ...spacing(140), box: box(after, omaha.me, omaha.other, plusBot), gap: 6 });
    const fb = placeSeats(before, 0, w, h, { ...spacing(140), box: box(before, omaha.me, omaha.other, plusBot), gap: 6 });
    // Seat 1 after you sits where seat 8 before you does, reflected left to right (to within a few pixels: the spots
    // round the table are a few pixels apart).
    [[1, 8], [2, 7], [3, 6]].forEach(([a, b]) => {
      const p = stadiumPoint(fa[a], w, h);
      const q = stadiumPoint(fb[b], w, h);
      expect(Math.abs(p.x - (w - q.x))).toBeLessThan(12);
      expect(Math.abs(p.y - q.y)).toBeLessThan(12);
    });
  });

  it('keeps the old spacing exactly where nothing overlaps, so tables that looked right stay as they were', () => {
    const taken = seats(9, [0, 1, 2, 3]);
    const holdem = box(taken, { l: 122, r: 122, u: 59, d: 30 }, { l: 117, r: 117, u: 46, d: 31 }, plusBot);
    const f = placeSeats(taken, 0, 900, 520, { ...spacing(122), box: holdem, gap: 6 });
    expect(f).toEqual(seatFractions(taken, 0, spacing(122)));
  });

  it('lets two empty seats meet by a pixel or two, as they do today on a wide, short window', () => {
    // John's 2300x824-class screen at 2300x800, four Omaha players at a 9-seat table: the empty seats along the bottom
    // are 120px apart and 122px wide. Players are all clear, so nothing moves.
    const [fw, fh] = [1867, 345];
    const taken = seats(9, [0, 1, 2, 3]);
    const b = box(taken, { l: 212, r: 212, u: 74, d: 47 }, { l: 196, r: 196, u: 62, d: 47 }, { l: 61, r: 61, u: 13, d: 13 });
    const sp = { clear: (212 + 58 + 6) / stadiumLength(fw, fh), minGap: 120 / stadiumLength(fw, fh) };
    const old = seatFractions(taken, 0, sp);
    expect(seatsApart(old, fw, fh, b)).toBe(false);
    expect(placeSeats(taken, 0, fw, fh, { ...sp, box: b, gap: 6 })).toEqual(old);
  });

  it('keeps seats where they are while they still have room, and moves them only when a box would cover another', () => {
    const taken = seats(9, [0, 1, 2, 3]);
    const b = box(taken, omaha.me, omaha.other, plusBot);
    const f = placeSeats(taken, 0, w, h, { ...spacing(140), box: b, gap: 6 });
    // A badge under the nameplates makes every box a little taller: there's still room, so nothing moves.
    const taller = box(taken, { ...omaha.me, d: omaha.me.d + 6 }, { ...omaha.other, d: omaha.other.d + 6 }, plusBot);
    expect(placeSeats(taken, 0, w, h, { ...spacing(140), box: taller, gap: 6, keep: f })).toBe(f);
    // Seats left where they'd overlap are placed again.
    const old = seatFractions(taken, 0, spacing(140));
    const again = placeSeats(taken, 0, w, h, { ...spacing(140), box: b, gap: 6, keep: old });
    expect(again).not.toEqual(old);
    expect(seatsApart(again, w, h, b)).toBe(true);
  });

  it('keeps the old spacing until every seat has been measured', () => {
    const taken = seats(9, [0, 1, 2, 3]);
    const f = placeSeats(taken, 0, w, h, { ...spacing(140), box: (seat) => (seat === 2 ? undefined : omaha.other), gap: 6 });
    expect(f).toEqual(seatFractions(taken, 0, spacing(140)));
  });

  it('squeezes empty seats in between players when there is no room to keep them clear, and gives up only when players cannot fit', () => {
    const taken = seats(9, [0, 1, 2, 3, 4, 5, 6, 7]);
    const tall: Extent = { l: 134, r: 134, u: 60, d: 60 };
    const big = box(taken, tall, tall, { l: 100, r: 100, u: 20, d: 20 });
    // No spacing keeps the empty seat clear of everyone...
    expect(spreadByBoxes(taken, 0, w, h, big, { gap: 0 })).toBeNull();
    const f = placeSeats(taken, 0, w, h, { ...spacing(140), box: big, gap: 6 });
    expect(seatsApart(f, w, h, big)).toBe(false);
    // ...so players are kept clear of each other, and the empty seat goes between two of them.
    expect(f).toEqual(spreadByBoxes(taken, 0, w, h, big, { players: true }));
    expect(seatsApart(f, w, h, (s) => (taken[s] ? big(s) : undefined))).toBe(true);
    expect(inOrder(f)).toBe(true);
    // Far too big for the table: back to even spacing.
    const huge: Extent = { l: 300, r: 300, u: 120, d: 120 };
    expect(placeSeats(taken, 0, w, h, { ...spacing(300), box: () => huge, gap: 6 })).toEqual(seatFractions(taken, 0, spacing(300)));
  });
});

describe('spreadByBoxes', () => {
  it('says when the boxes cannot fit round the table', () => {
    expect(spreadByBoxes(seats(9, [0, 1, 2, 3, 4, 5, 6, 7, 8]), 0, 400, 250, () => ({ l: 150, r: 150, u: 40, d: 40 }))).toBeNull();
  });
  it('says so, rather than failing, when an empty seat has no room left before the next player', () => {
    // Two players and seven big empty seats on a small table: the empty seats run out of room partway round. This once
    // threw while placing the empty seat after the one that didn't fit, and the table went blank.
    const taken = seats(9, [0, 1]);
    const box = (s: number): Extent => (taken[s] ? { l: 140, r: 140, u: 45, d: 30 } : { l: 120, r: 120, u: 60, d: 60 });
    for (const [tw, th] of [[646, 391], [500, 300], [400, 250]]) {
      expect(spreadByBoxes(taken, 0, tw, th, box, { gap: 6 })).toBeNull();
      const f = placeSeats(taken, 0, tw, th, { box, gap: 6 });
      expect(f).toHaveLength(9);
      // The players are still kept clear of each other.
      expect(seatsApart(f, tw, th, (s) => (taken[s] ? box(s) : undefined))).toBe(true);
    }
  });
  it('spaces seats evenly when every box fits with room to spare', () => {
    const f = spreadByBoxes(seats(4, [0, 1, 2, 3]), 0, 900, 520, () => ({ l: 40, r: 40, u: 20, d: 20 }))!;
    [0, 1, 2, 3].forEach((s) => expect(f[s]).toBeCloseTo(s / 4, 2));
  });
});

describe('playerFractions (#303: tournament tables draw no empty seats)', () => {
  it('spreads the players evenly with yours at the bottom, whatever seats they hold', () => {
    const f = playerFractions(seats(8, [0, 2, 3, 5, 6, 7]), 5);
    [5, 6, 7, 0, 2, 3].forEach((s, i) => expect(f[s]).toBeCloseTo(i / 6));
  });

  it('spaces two to nine players evenly at a nine-seat table, in seat order, wherever they sit', () => {
    for (let m = 2; m <= 9; m++) {
      // Every other seat first, then the rest, so the players have gaps of different sizes between them.
      const held = [0, 2, 4, 6, 8, 1, 3, 5, 7].slice(0, m).sort((a, b) => a - b);
      for (const mine of held) {
        const f = playerFractions(seats(9, held), mine);
        expect(f[mine]).toBe(0);
        const order = [...held.filter((s) => s >= mine), ...held.filter((s) => s < mine)];
        order.forEach((s, i) => expect(f[s]).toBeCloseTo(i / m));
      }
    }
  });

  it('works for tables of other sizes too', () => {
    for (const n of [2, 6, 10]) {
      const held = [0, n - 1];
      const f = playerFractions(seats(n, held), n - 1);
      expect(f[n - 1]).toBe(0);
      expect(f[0]).toBeCloseTo(0.5);
    }
  });

  it('puts the first player from seat 1 at the bottom for someone watching, so no gap is left there', () => {
    const f = playerFractions(seats(8, [2, 4, 6]), 0);
    expect(f[2]).toBe(0);
    expect(f[4]).toBeCloseTo(1 / 3);
    expect(f[6]).toBeCloseTo(2 / 3);
    // The search goes round the table from the anchor.
    expect(playerFractions(seats(8, [1, 5]), 6)[1]).toBe(0);
  });

  it('gives an empty seat a place between its neighbours, for a dead button', () => {
    const f = playerFractions(seats(9, [0, 2, 4, 6, 7]), 0);
    // Seat 3 is the only empty seat between seats 2 and 4: halfway.
    expect(f[3]).toBeCloseTo((f[2] + f[4]) / 2);
    // Seat 8 and the bottom seat 0 have seat 7 before them, then 8, then seat 0 again a full turn on.
    expect(f[8]).toBeGreaterThan(f[7]);
    expect(f[8]).toBeLessThan(1);
  });

  it('only re-spreads, keeping everyone in order, when a player goes out or one is moved in', () => {
    const before = playerFractions(seats(9, [0, 2, 3, 5, 7]), 3);
    const after = playerFractions(seats(9, [0, 2, 3, 7]), 3);
    expect(after[3]).toBe(0);
    const ordered = (f: number[], held: number[]) => held.map((s) => f[s]);
    expect(ordered(after, [3, 7, 0, 2])).toEqual([...ordered(after, [3, 7, 0, 2])].sort((a, b) => a - b));
    // Nobody passes anyone else: each player's place moves by less than one player's share.
    for (const s of [7, 0, 2]) expect(Math.abs(after[s] - before[s])).toBeLessThan(1 / 4);
    const movedIn = playerFractions(seats(9, [0, 2, 3, 5, 7, 8]), 3);
    expect(movedIn[3]).toBe(0);
    for (const s of [5, 7, 0, 2]) expect(Math.abs(movedIn[s] - before[s])).toBeLessThan(1 / 5);
  });

  it('is plain even spacing at a full table, and copes with an empty one', () => {
    expect(playerFractions(seats(4, [0, 1, 2, 3]), 2)).toEqual([0.5, 0.75, 0, 0.25]);
    expect(playerFractions(seats(3, []), 0)).toEqual([0, 1 / 3, 2 / 3]);
    expect(playerFractions([], 0)).toEqual([]);
  });
});

describe('placePlayers (#303 and #363: a tournament table on a laptop)', () => {
  // The felt of a 1280x800 window with the side column, and four-card Omaha nameplates with their cards (yours a little bigger).
  const w = 646;
  const h = 391;
  const me: Extent = { l: 140, r: 140, u: 45, d: 30 };
  const other: Extent = { l: 134, r: 134, u: 38, d: 31 };
  // Empty seats aren't drawn, so they have no box (Table.tsx never measures one there).
  const box = (taken: boolean[], mine = 0) => (seat: number) => (!taken[seat] ? undefined : seat === mine ? me : other);
  const round = (f: readonly number[], held: number[]) => held.map((s) => f[s]);

  it('keeps the even spacing while no nameplate covers another', () => {
    const taken = seats(9, [0, 2, 4, 6, 8]);
    expect(seatsApart(playerFractions(taken, 0), w, h, box(taken))).toBe(true);
    expect(placePlayers(taken, 0, w, h, { box: box(taken), gap: 6 })).toEqual(playerFractions(taken, 0));
  });

  it('moves the players apart, in seat order with yours at the bottom, where even spacing put two nameplates together', () => {
    for (const held of [[0, 1, 2, 3, 4, 5], [0, 1, 2, 3, 4, 5, 6, 7, 8], [0, 2, 3, 5, 6, 8]]) {
      const taken = seats(9, held);
      expect(seatsApart(playerFractions(taken, 0), w, h, box(taken))).toBe(false);
      const f = placePlayers(taken, 0, w, h, { box: box(taken), gap: 6 });
      expect(seatsApart(f, w, h, box(taken))).toBe(true);
      expect(f[0]).toBe(0);
      const at = round(f, held);
      expect(at).toEqual([...at].sort((a, b) => a - b));
    }
  });

  it('gives the empty seats no room: each sits halfway between its neighbours, for a dead button', () => {
    const taken = seats(9, [0, 2, 3, 5, 6, 8]);
    const f = placePlayers(taken, 0, w, h, { box: box(taken), gap: 6 });
    expect(f[1]).toBeCloseTo((f[0] + f[2]) / 2, 2);
    expect(f[4]).toBeCloseTo((f[3] + f[5]) / 2, 2);
    expect(f[7]).toBeCloseTo((f[6] + f[8]) / 2, 2);
  });

  it('puts the first player from the anchor at the bottom for someone watching', () => {
    const taken = seats(9, [1, 2, 3, 4, 5, 6, 7, 8]);
    const f = placePlayers(taken, 0, w, h, { box: box(taken, -1), gap: 6 });
    expect(f[1]).toBe(0);
    expect(seatsApart(f, w, h, box(taken, -1))).toBe(true);
  });

  it('keeps the even spacing until every player has a box, and keeps where the seats are while they have room', () => {
    const taken = seats(9, [0, 1, 2, 3, 4, 5]);
    const some = (seat: number) => (seat === 3 ? undefined : box(taken)(seat));
    expect(placePlayers(taken, 0, w, h, { box: some, gap: 6 })).toEqual(playerFractions(taken, 0));
    const f = placePlayers(taken, 0, w, h, { box: box(taken), gap: 6 });
    const nudged = f.map((x, s) => (s === 0 ? x : x + 0.002));
    expect(placePlayers(taken, 0, w, h, { box: box(taken), gap: 6, keep: nudged })).toBe(nudged);
    // A place where nameplates cover each other isn't kept.
    expect(placePlayers(taken, 0, w, h, { box: box(taken), gap: 6, keep: playerFractions(taken, 0) })).toEqual(f);
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

describe('clearOfRows and placeHand (#318: your cards making room for the rows beside them)', () => {
  const box = (left: number, right: number, top: number, bottom: number) => ({ left, right, top, bottom });
  // Your nameplate in the middle of a 390px phone; your cards hang to 8px into it, 84px tall (454 to 538).
  const mine = box(155, 235, 530, 578);
  const span = { left: 3, right: 387 };

  it('keeps clear of the rows level with your cards, each on its player\'s side', () => {
    // Bea's row (her nameplate's middle at 103) has moved right, past the middle of yours: it still counts on her side.
    const bea = { box: box(100, 199, 460, 502), from: 103 };
    const hal = { box: box(240, 330, 460, 502), from: 290 };
    expect(clearOfRows(mine, [bea, hal], 84, span)).toEqual({ left: 199 + 6, right: 240 - 6 });
  });
  it('ignores rows above your cards, or reaching only a sliver into them', () => {
    const above = { box: box(20, 100, 380, 422), from: 60 };
    const sliver = { box: box(20, 150, 415, 457), from: 85 };
    expect(clearOfRows(mine, [above, sliver], 84, span)).toEqual(span);
    expect(clearOfRows(mine, [{ ...sliver, box: box(20, 150, 415, 459) }], 84, span)).toEqual({ left: 156, right: 387 });
    // Counting your cards 3px higher, as the rows do, the sliver counts.
    expect(clearOfRows(mine, [sliver], 84, span, 3)).toEqual({ left: 156, right: 387 });
  });
  it('never reaches past the room clear of nameplates', () => {
    expect(clearOfRows(mine, [{ box: box(0, 2, 460, 502), from: 1 }], 84, { left: 50, right: 300 })).toEqual({ left: 50, right: 300 });
  });

  it('leaves a hand centred over your nameplate when it fits', () => {
    expect(placeHand(195, 100, span)).toBe(145);
    expect(placeHand(195, 100, span, { left: 120, right: 387 })).toBe(145);
  });
  it('moves it only as far as it must, clear of nameplates and then of rows', () => {
    expect(placeHand(187, 174, { left: 151, right: 372 })).toBe(151);
    expect(placeHand(195, 100, span, { left: 160, right: 387 })).toBe(160);
  });
  it('with no room to keep clear of a row on one side, goes as far from it as it can', () => {
    // A 375px phone with nobody on your right: Bea's row would need your cards to start at 205.
    expect(placeHand(187, 174, { left: 151, right: 372 }, { left: 205, right: 372 })).toBe(198);
  });
  it('with rows on both sides, leaves them equally short', () => {
    expect(placeHand(200, 174, { left: 150, right: 340 }, { left: 160, right: 330 })).toBe(158);
    // Even when the rows would cross over each other: halfway between them, still in the room.
    expect(placeHand(200, 100, { left: 150, right: 340 }, { left: 320, right: 180 })).toBe(200);
  });
  it('puts a hand wider than its room in the middle of it', () => {
    expect(placeHand(195, 200, { left: 100, right: 250 })).toBe(75);
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

describe('keepPlaced (#410: seats kept through a small change to the felt)', () => {
  const was = { key: '2-4|0|0|111100000|0', w: 646, h: 402 };
  it('keeps them through a change of a few pixels, and the 17px #410 measured', () => {
    expect(keepPlaced(was, was.key, 646, 402)).toBe(true);
    expect(keepPlaced(was, was.key, 646, 396)).toBe(true);
    expect(keepPlaced(was, was.key, 646, 385)).toBe(true);
    expect(keepPlaced(was, was.key, 640, 410)).toBe(true);
  });
  it('keeps them through 20px on a small felt, where that is more than 5% (a laptop window with its browser bars)', () => {
    const small = { ...was, h: 320 };
    expect(keepPlaced(small, was.key, 646, 303)).toBe(true);
    expect(keepPlaced(small, was.key, 646, 300)).toBe(true);
    expect(keepPlaced(small, was.key, 646, 299)).toBe(false);
  });
  it('places them afresh after a bigger change, a new key, or before anything was placed or measured', () => {
    expect(keepPlaced(was, was.key, 646, Math.floor(402 * (1 - FELT_SLACK)) - 1)).toBe(false);
    expect(keepPlaced(was, was.key, 700, 402)).toBe(false);
    expect(keepPlaced(was, '2-3-4-5-6-7|0|0|111100000|0', 646, 402)).toBe(false);
    expect(keepPlaced(null, was.key, 646, 402)).toBe(false);
    expect(keepPlaced({ ...was, w: 0, h: 0 }, was.key, 0, 0)).toBe(false);
  });
});

describe('fitMiddle', () => {
  const centre = { x: 500, y: 200 };
  // A board row 300 wide and 60 tall, and a winner's line under it, centred on (500, 200).
  const board = { left: 350, right: 650, top: 150, bottom: 210 };
  const line = { left: 400, right: 600, top: 220, bottom: 250, line: true };

  it('keeps the full size when nothing is covered', () => {
    expect(fitMiddle([board, line], [{ left: 450, right: 550, top: 20, bottom: 100 }], null, centre)).toBe(1);
  });

  it('draws the middle just small enough to clear a seat below it', () => {
    // A nameplate whose top is 10px into the winner's line: at k the line's bottom is 200 + 50k, plus the 4px gap.
    const k = fitMiddle([board, line], [{ left: 450, right: 550, top: 240, bottom: 300 }], null, centre);
    expect(k).toBe(0.72);
    expect(200 + 50 * k + 4).toBeLessThanOrEqual(240);
  });

  it('never draws the middle smaller for the dealer button alone', () => {
    const button = { left: 490, right: 516, top: 236, bottom: 262 };
    expect(fitMiddle([board, line], [], button, centre)).toBe(1);
  });

  it('where a seat makes it smaller anyway, goes a little further to move the lines off the button', () => {
    // The seat needs 0.92 (the line's bottom, 200 + 50k, and the 4px gap reach no lower than 250). A button whose top is
    // at 248 needs two steps more, 0.88; one at 246 would need 0.84, too far, so the seat's 0.92 stands.
    const seat = { left: 450, right: 550, top: 250, bottom: 300 };
    expect(fitMiddle([board, line], [seat], { left: 490, right: 516, top: 248, bottom: 274 }, centre)).toBe(0.88);
    expect(fitMiddle([board, line], [seat], { left: 490, right: 516, top: 246, bottom: 272 }, centre)).toBe(0.92);
    // On the cards, the button never matters.
    expect(fitMiddle([board, line], [seat], { left: 490, right: 516, top: 150, bottom: 176 }, centre)).toBe(0.92);
  });

  it('lets the button stay on a line rather than give up much size for it', () => {
    // No size near 0.92 (what the seat needs) clears the button, so the seat's size stands.
    const button = { left: 480, right: 520, top: 205, bottom: 245 };
    const seat = { left: 450, right: 550, top: 250, bottom: 300 };
    expect(fitMiddle([board, line], [seat], button, centre)).toBe(0.92);
  });

  it('stops at the smallest size and covers as little as it can there', () => {
    const seat = { left: 300, right: 700, top: 180, bottom: 260 };
    expect(fitMiddle([board, line], [seat], null, centre)).toBe(0.6);
  });
});

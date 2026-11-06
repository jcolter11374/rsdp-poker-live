import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { drawSeats, isSeatSeed, legacySeatRng, nextRandom, SEAT_RNG_VERSION, seatRng, tablesNeeded } from '../src/seating';
import type { SeatRngState } from '../src/types';

const SEED = '5eed'.repeat(16);

/** Word i of the rsdp-seats-v1 stream, worked out from its definition with Node's own SHA-256. */
function streamWord(seed: string, i: number): number {
  const block = createHash('sha256').update(`${SEAT_RNG_VERSION}|${seed}|${Math.floor(i / 8)}`).digest();
  return block.readUInt32BE((i % 8) * 4);
}

/** The draw the way seats were drawn before 2026-11-06 (mulberry32, copied from the old seating.ts). */
function oldDrawSeats<T>(players: T[], seatsPerTable: number, rng: number): [(T | null)[][], number] {
  const oldShuffle = <U>(items: U[], state: number): [U[], number] => {
    const out = [...items];
    let s = state;
    for (let i = out.length - 1; i > 0; i--) {
      let r: number;
      [r, s] = nextRandom(s);
      const j = Math.floor(r * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return [out, s];
  };
  const [shuffled, s1] = oldShuffle(players, rng);
  const count = tablesNeeded(players.length, seatsPerTable);
  const groups: T[][] = Array.from({ length: count }, () => []);
  shuffled.forEach((p, i) => groups[i % count].push(p));
  let s = s1;
  const tables = groups.map((group) => {
    let seatOrder: number[];
    [seatOrder, s] = oldShuffle(
      Array.from({ length: seatsPerTable }, (_, i) => i),
      s,
    );
    const seats: (T | null)[] = new Array(seatsPerTable).fill(null);
    group.forEach((p, i) => (seats[seatOrder[i]] = p));
    return seats;
  });
  return [tables, s];
}

/** Pearson's chi-squared statistic of observed counts against equal expected counts. */
function chiSquared(counts: number[]): number {
  const total = counts.reduce((a, b) => a + b, 0);
  const expected = total / counts.length;
  return counts.reduce((sum, c) => sum + (c - expected) ** 2 / expected, 0);
}

const players = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`);

describe('the seat-draw generator (rsdp-seats-v1)', () => {
  it('is SHA-256 in counter mode over the seed, read as big-endian 32-bit words', () => {
    const state: SeatRngState = { seed: SEED, at: 0 };
    const rng = seatRng(state);
    // With n = 2^32 nothing is ever rejected, so each call returns the next word as it is.
    const words = Array.from({ length: 20 }, () => rng(0x100000000));
    expect(words).toEqual(Array.from({ length: 20 }, (_, i) => streamWord(SEED, i)));
    expect(state.at).toBe(20);
  });

  it('takes numbers by rejection sampling, so no value is more likely than another', () => {
    // Words of 3,000,000,000 or more are thrown away for n = 3e9 (about 30% of them), and for n = 7 only the top
    // few: work out what the rule gives from the words themselves and compare.
    for (const n of [3_000_000_000, 7, 2 ** 31 + 1]) {
      const state: SeatRngState = { seed: SEED, at: 0 };
      const rng = seatRng(state);
      const limit = Math.floor(0x100000000 / n) * n;
      let i = 0;
      const expected = () => {
        for (;;) {
          const w = streamWord(SEED, i++);
          if (w < limit) return w % n;
        }
      };
      for (let k = 0; k < 40; k++) expect(rng(n)).toBe(expected());
      expect(state.at).toBe(i);
    }
    // Some of those big-range calls did throw words away.
    const state: SeatRngState = { seed: SEED, at: 0 };
    const rng = seatRng(state);
    for (let k = 0; k < 40; k++) rng(3_000_000_000);
    expect(state.at).toBeGreaterThan(40);
  });

  it('refuses a range it cannot draw from', () => {
    const rng = seatRng({ seed: SEED, at: 0 });
    for (const n of [0, -1, 1.5, 2 ** 32 + 1, NaN]) expect(() => rng(n)).toThrow(RangeError);
    expect(rng(1)).toBe(0);
  });

  it('knows a seed when it sees one', () => {
    expect(isSeatSeed(SEED)).toBe(true);
    expect(isSeatSeed('ab'.repeat(31))).toBe(false);
    expect(isSeatSeed('AB'.repeat(32))).toBe(false);
    expect(isSeatSeed('zz'.repeat(32))).toBe(false);
    expect(isSeatSeed(42)).toBe(false);
  });
});

describe('drawing seats', () => {
  it('draws the same seats from the same seed, and different seats from another', () => {
    const field = players(23);
    const a = drawSeats(field, 9, seatRng({ seed: SEED, at: 0 }));
    const b = drawSeats(field, 9, seatRng({ seed: SEED, at: 0 }));
    const c = drawSeats(field, 9, seatRng({ seed: 'c0ffee'.repeat(10) + 'beef', at: 0 }));
    expect(a).toEqual(b);
    expect(c).not.toEqual(a);
    // Three tables of 8, 8 and 7, everyone seated once.
    expect(a.map((t) => t.filter(Boolean).length)).toEqual([8, 8, 7]);
    expect(a.flat().filter(Boolean).sort()).toEqual([...field].sort());
  });

  it('carries on from where the last draw stopped, after a save too', () => {
    const state: SeatRngState = { seed: SEED, at: 0 };
    const first = drawSeats(players(12), 6, seatRng(state));
    const after = state.at;
    expect(after).toBeGreaterThan(0);
    // The state is saved as JSON and loaded again before the next draw.
    const loaded = JSON.parse(JSON.stringify(state)) as SeatRngState;
    const second = drawSeats(players(12), 6, seatRng(loaded));
    expect(second).toEqual(drawSeats(players(12), 6, seatRng({ seed: SEED, at: after })));
    // A later draw never repeats the numbers an earlier one used.
    expect(second).not.toEqual(first);
    // Reading on in one go gives the same two draws as stopping in between.
    const oneGo = seatRng({ seed: SEED, at: 0 });
    expect([drawSeats(players(12), 6, oneGo), drawSeats(players(12), 6, oneGo)]).toEqual([first, second]);
  });

  it('is a fair shuffle: every order of four players comes up equally often', () => {
    const state: SeatRngState = { seed: SEED, at: 0 };
    const rng = seatRng(state);
    const counts = new Map<string, number>();
    const draws = 24_000;
    for (let k = 0; k < draws; k++) {
      // One table of four seats, all taken: the seats the players get are a random order of the four.
      const [table] = drawSeats(players(4), 4, rng);
      const key = table.join();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    expect(counts.size).toBe(24);
    // 23 degrees of freedom: 49.7 is the 0.1% point, so a fair shuffle fails this about once in a thousand
    // seeds. The seed is fixed, so the test always gives the same answer.
    expect(chiSquared([...counts.values()])).toBeLessThan(49.7);
  });

  it('puts each player at each table and seat equally often', () => {
    const rng = seatRng({ seed: SEED, at: 0 });
    // Ten players at 6-seat tables: two tables of five. Count where p0 lands among the 12 seats.
    const counts = new Array(12).fill(0);
    const tables = [0, 0];
    const draws = 12_000;
    for (let k = 0; k < draws; k++) {
      const draw = drawSeats(players(10), 6, rng);
      draw.forEach((seats, t) =>
        seats.forEach((p, seat) => {
          if (p === 'p0') {
            counts[t * 6 + seat]++;
            tables[t]++;
          }
        }),
      );
    }
    // 11 degrees of freedom: 31.3 is the 0.1% point.
    expect(chiSquared(counts)).toBeLessThan(31.3);
    // 1 degree of freedom: 10.8 is the 0.1% point.
    expect(chiSquared(tables)).toBeLessThan(10.8);
  });

  it('draws a tournament saved with the old generator exactly as it would have before', () => {
    for (const [n, seats, state] of [
      [23, 9, 42],
      [7, 6, 1],
      [2, 9, 0xdeadbeef],
      [45, 8, 7],
    ] as const) {
      const holder = { rng: state };
      const draw = drawSeats(players(n), seats, legacySeatRng(holder));
      const [old, next] = oldDrawSeats(players(n), seats, state);
      expect(draw).toEqual(old);
      expect(holder.rng).toBe(next);
    }
  });
});

import { describe, expect, it } from 'vitest';
import { computePots, uncalledBet, type PotSeat } from '../../src/core/pots';

const live = (seat: number, total: number): PotSeat => ({ seat, total, folded: false });
const out = (seat: number, total: number): PotSeat => ({ seat, total, folded: true });
const sum = (xs: { amount: number }[]) => xs.reduce((s, x) => s + x.amount, 0);

/** Small deterministic LCG so the property test is reproducible. */
function seeded(seed: number) {
  let x = seed >>> 0;
  return (n: number) => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x % n;
  };
}

describe('computePots', () => {
  it('makes one pot when everyone put in the same', () => {
    expect(computePots([live(0, 100), live(1, 100), live(2, 100)])).toEqual([{ amount: 300, eligible: [0, 1, 2] }]);
  });

  it('makes a main pot and one side pot for a short all-in (3 players)', () => {
    expect(computePots([live(0, 100), live(1, 250), live(2, 250)])).toEqual([
      { amount: 300, eligible: [0, 1, 2] },
      { amount: 300, eligible: [1, 2] },
    ]);
  });

  it('makes a pot per all-in level (4 players, 3 levels)', () => {
    const pots = computePots([live(0, 50), live(1, 120), live(2, 300), live(3, 300)]);
    expect(pots).toEqual([
      { amount: 200, eligible: [0, 1, 2, 3] },
      { amount: 210, eligible: [1, 2, 3] },
      { amount: 360, eligible: [2, 3] },
    ]);
    expect(sum(pots)).toBe(770);
  });

  it('makes a pot per all-in level (4 players, 4 levels)', () => {
    const pots = computePots([live(0, 10), live(1, 20), live(2, 30), live(3, 40)]);
    expect(pots).toEqual([
      { amount: 40, eligible: [0, 1, 2, 3] },
      { amount: 30, eligible: [1, 2, 3] },
      { amount: 20, eligible: [2, 3] },
      { amount: 10, eligible: [3] },
    ]);
  });

  it('lets folded money fill only the levels it reaches', () => {
    // Seat 3 put in 200 and folded: 100 to the main pot, 100 to the side pot.
    const pots = computePots([live(0, 100), live(1, 300), live(2, 300), out(3, 200)]);
    expect(pots).toEqual([
      { amount: 400, eligible: [0, 1, 2] },
      { amount: 500, eligible: [1, 2] },
    ]);
    expect(sum(pots)).toBe(900);
  });

  it('puts small folded money (a blind) in the main pot', () => {
    expect(computePots([out(0, 1), out(1, 2), live(2, 100), live(3, 100)])).toEqual([
      { amount: 203, eligible: [2, 3] },
    ]);
  });

  it('counts dead money from a folded seat', () => {
    // Seat 4 posted a dead small blind (1) and a big blind (2), then folded.
    expect(computePots([live(0, 40), live(1, 80), live(2, 80), out(4, 3)])).toEqual([
      { amount: 123, eligible: [0, 1, 2] },
      { amount: 80, eligible: [1, 2] },
    ]);
  });

  it('counts a live seat\'s dead money as part of its total', () => {
    // Seat 0 posted a dead small blind (1) and went all in for 50 more: total 51.
    const pots = computePots([live(0, 51), live(1, 100), live(2, 100)]);
    expect(pots).toEqual([
      { amount: 153, eligible: [0, 1, 2] },
      { amount: 98, eligible: [1, 2] },
    ]);
  });

  it('gives chips above the top live level to the last pot', () => {
    // Seat 2 bet 400 and was folded out of turn; nobody else matched it.
    const pots = computePots([live(0, 100), live(1, 150), out(2, 400)]);
    expect(pots).toEqual([
      { amount: 300, eligible: [0, 1] },
      { amount: 350, eligible: [1] },
    ]);
    expect(sum(pots)).toBe(650);
  });

  it('gives everything to the lone live seat', () => {
    expect(computePots([live(0, 100), out(1, 300), out(2, 100)])).toEqual([{ amount: 500, eligible: [0] }]);
  });

  it('skips empty pots', () => {
    // Seat 0 is live with nothing in: the level-0 pot is empty and dropped.
    expect(computePots([live(0, 0), live(1, 10), live(2, 10)])).toEqual([{ amount: 20, eligible: [1, 2] }]);
    expect(computePots([live(0, 0), live(1, 0)])).toEqual([]);
    expect(computePots([])).toEqual([]);
  });

  it('keeps folded money when the only live seat put in nothing', () => {
    expect(computePots([live(0, 0), out(1, 5)])).toEqual([{ amount: 5, eligible: [0] }]);
  });

  it('lists eligible seats in seat order whatever the input order', () => {
    expect(computePots([live(5, 100), live(2, 50), live(7, 100), live(0, 100)])).toEqual([
      { amount: 200, eligible: [0, 2, 5, 7] },
      { amount: 150, eligible: [0, 5, 7] },
    ]);
  });

  it('rejects bad input', () => {
    expect(() => computePots([live(0, -1)])).toThrow();
    expect(() => computePots([live(0, 1.5)])).toThrow();
    expect(() => computePots([live(0, Number.NaN)])).toThrow();
    expect(() => computePots([live(0, 10), live(0, 10)])).toThrow(/twice/);
    expect(() => computePots([out(0, 10), out(1, 10)])).toThrow(/no seat/);
    expect(computePots([out(0, 0), out(1, 0)])).toEqual([]);
  });

  it('conserves chips and shrinks eligibility (random hands)', () => {
    const rng = seeded(42);
    for (let i = 0; i < 2000; i++) {
      const n = 2 + rng(9);
      const seats: PotSeat[] = Array.from({ length: n }, (_, k) => ({
        seat: k,
        total: rng(4) === 0 ? 0 : rng(5) * 25 + rng(30),
        folded: rng(3) === 0,
      }));
      if (seats.every((s) => s.folded)) seats[rng(n)].folded = false;
      const pots = computePots(seats);
      expect(sum(pots)).toBe(seats.reduce((s, x) => s + x.total, 0));
      const liveSeats = seats.filter((s) => !s.folded).map((s) => s.seat);
      for (const [j, pot] of pots.entries()) {
        expect(pot.amount).toBeGreaterThan(0);
        expect(Number.isInteger(pot.amount)).toBe(true);
        expect(pot.eligible.length).toBeGreaterThan(0);
        expect(pot.eligible.every((s) => liveSeats.includes(s))).toBe(true);
        expect([...pot.eligible].sort((a, b) => a - b)).toEqual(pot.eligible);
        if (j > 0) {
          const prev = pots[j - 1].eligible;
          expect(pot.eligible.every((s) => prev.includes(s))).toBe(true);
          expect(pot.eligible.length).toBeLessThan(prev.length);
        }
      }
      // No live seat wins more from any one opponent than it put in.
      for (const s of seats.filter((x) => !x.folded)) {
        const winnable = pots.filter((p) => p.eligible.includes(s.seat)).reduce((t, p) => t + p.amount, 0);
        const cap = seats.reduce((t, o) => t + Math.min(o.total, s.total), 0);
        const isTop = s.total === Math.max(...seats.filter((x) => !x.folded).map((x) => x.total));
        if (!isTop) expect(winnable).toBe(cap);
      }
    }
  });
});

describe('uncalledBet', () => {
  it('returns a bet nobody called', () => {
    expect(uncalledBet([{ seat: 0, bet: 100 }, { seat: 1, bet: 0 }, { seat: 2, bet: 0 }])).toEqual({ seat: 0, amount: 100 });
  });

  it('returns the unmatched part of a raise when the bettor folds', () => {
    expect(uncalledBet([{ seat: 0, bet: 100 }, { seat: 1, bet: 300 }])).toEqual({ seat: 1, amount: 200 });
  });

  it('returns the part above a short all-in call', () => {
    expect(uncalledBet([{ seat: 0, bet: 40 }, { seat: 1, bet: 100 }, { seat: 2, bet: 0 }])).toEqual({ seat: 1, amount: 60 });
  });

  it('measures against folded seats\' bets too', () => {
    // Seat 2 raised to 60 then folded to a re-raise to 150; seat 0 called 20 earlier and folded.
    expect(uncalledBet([{ seat: 0, bet: 20 }, { seat: 1, bet: 150 }, { seat: 2, bet: 60 }])).toEqual({ seat: 1, amount: 90 });
  });

  it('is null when the top bet was matched', () => {
    expect(uncalledBet([{ seat: 0, bet: 100 }, { seat: 1, bet: 100 }])).toBeNull();
    expect(uncalledBet([{ seat: 0, bet: 100 }, { seat: 1, bet: 100 }, { seat: 2, bet: 50 }])).toBeNull();
  });

  it('is null with no bets', () => {
    expect(uncalledBet([{ seat: 0, bet: 0 }, { seat: 1, bet: 0 }])).toBeNull();
    expect(uncalledBet([])).toBeNull();
  });

  it('returns a lone seat\'s whole bet', () => {
    expect(uncalledBet([{ seat: 4, bet: 7 }])).toEqual({ seat: 4, amount: 7 });
  });

  it('rejects bad bets', () => {
    expect(() => uncalledBet([{ seat: 0, bet: 2.5 }])).toThrow();
    expect(() => uncalledBet([{ seat: 0, bet: -1 }])).toThrow();
  });
});

describe('computePots: dead money paid for the table', () => {
  it('a big blind ante goes to the main pot instead of back to the big blind', () => {
    // Big blind posts 2 + 2 ante and shoves for 48 live in total; seat 1 calls 48.
    expect(
      computePots([
        { seat: 0, total: 50, folded: false, dead: 2 },
        { seat: 1, total: 48, folded: false },
      ]),
    ).toEqual([{ amount: 98, eligible: [0, 1] }]);
  });

  it('a dead small blind does not raise the poster’s side-pot level', () => {
    expect(
      computePots([
        { seat: 0, total: 51, folded: false, dead: 1 },
        { seat: 1, total: 100, folded: false },
        { seat: 2, total: 100, folded: false },
      ]),
    ).toEqual([
      { amount: 151, eligible: [0, 1, 2] },
      { amount: 100, eligible: [1, 2] },
    ]);
  });
});

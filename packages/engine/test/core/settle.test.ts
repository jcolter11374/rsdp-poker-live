import { describe, expect, it } from 'vitest';
import { highRules } from '../../src/core/high';
import { computePots, uncalledBet } from '../../src/core/pots';
import { oddChipOrder, settle, type SettleArgs } from '../../src/core/settle';
import type { Award, AwardPortion, Card, Pot, SeatIndex, VariantRules } from '../../src/core/types';
import { cards, holes, nlh } from './fixtures';

const sum = (xs: { amount: number }[]) => xs.reduce((s, x) => s + x.amount, 0);

/** Chips won per seat across all awards. */
function won(awards: Award[]): Record<SeatIndex, number> {
  const out: Record<SeatIndex, number> = {};
  for (const a of awards) out[a.seat] = (out[a.seat] ?? 0) + a.amount;
  return out;
}

const tags = (awards: Award[]) => awards.map((a) => [a.pot, a.run, a.board, a.seat, a.amount]);

/** Fake rules: the whole portion to the first seat it is handed. Records every call. */
function firstSeat() {
  const calls: { amount: number; eligible: SeatIndex[]; board: Card[] }[] = [];
  const awardPortion: AwardPortion = (_spec, amount, eligible, _holes, board) => {
    calls.push({ amount, eligible, board });
    return [{ seat: eligible[0], amount, half: 'scoop' }];
  };
  return { rules: { awardPortion } as VariantRules, calls };
}

/** Fake rules: every eligible seat ties, odd chips one at a time in the order given. */
const chop: VariantRules = {
  awardPortion: (_spec, amount, eligible) => {
    const share = Math.floor(amount / eligible.length);
    const odd = amount - share * eligible.length;
    return eligible.map((seat, i) => ({ seat, amount: share + (i < odd ? 1 : 0), half: 'scoop' as const }));
  },
};

const exploding: VariantRules = {
  awardPortion: () => {
    throw new Error('should not evaluate');
  },
};

const dryBoard = '2c 7s 9d 4c 3h';

function args(over: Partial<SettleArgs> & Pick<SettleArgs, 'pots'>): SettleArgs {
  return { runs: [[cards(dryBoard)]], button: 0, maxSeats: 6, holeBySeat: {}, spec: nlh, rules: highRules, ...over };
}

describe('oddChipOrder', () => {
  it('runs clockwise from the seat after the button', () => {
    expect(oddChipOrder([0, 1, 2, 4, 5], 3, 6)).toEqual([4, 5, 0, 1, 2]);
  });

  it('puts the button seat last', () => {
    expect(oddChipOrder([3, 1, 4], 3, 6)).toEqual([4, 1, 3]);
    expect(oddChipOrder([5, 2, 0], 5, 6)).toEqual([0, 2, 5]);
  });

  it('works when the button seat is empty or not eligible', () => {
    expect(oddChipOrder([1, 7, 8], 4, 9)).toEqual([7, 8, 1]);
  });

  it('uses seat order from seat 0 without a button', () => {
    expect(oddChipOrder([4, 0, 2], null, 6)).toEqual([0, 2, 4]);
  });

  it('does not change its input', () => {
    const eligible = [0, 4];
    oddChipOrder(eligible, 1, 6);
    expect(eligible).toEqual([0, 4]);
  });

  it('rejects seats outside the table', () => {
    expect(() => oddChipOrder([6], 0, 6)).toThrow();
    expect(() => oddChipOrder([-1], 0, 6)).toThrow();
    expect(() => oddChipOrder([0], 6, 6)).toThrow();
    expect(() => oddChipOrder([0], 0, 0)).toThrow();
  });
});

describe('settle', () => {
  it('gives a single-eligible pot to that seat whole without evaluating', () => {
    const awards = settle(
      args({
        pots: [{ amount: 150, eligible: [2] }],
        runs: [[cards(dryBoard), cards('Ah Kh Qh Jh Th')], [cards('As Ks Qs Js Ts'), cards('Ad Kd Qd Jd Td')]],
        rules: exploding,
      }),
    );
    expect(awards).toEqual([{ pot: 0, run: 0, board: 0, seat: 2, amount: 150, half: 'scoop' }]);
  });

  it('awards side pots at three all-in levels to different players (4 players)', () => {
    const pots = computePots([
      { seat: 0, total: 50, folded: false },
      { seat: 1, total: 120, folded: false },
      { seat: 2, total: 300, folded: false },
      { seat: 3, total: 300, folded: false },
    ]);
    const awards = settle(
      args({ pots, holeBySeat: holes({ 0: 'Ah Ad', 1: 'Kh Kd', 2: 'Qh Qd', 3: 'Jh Jd' }) }),
    );
    expect(tags(awards)).toEqual([
      [0, 0, 0, 0, 200],
      [1, 0, 0, 1, 210],
      [2, 0, 0, 2, 360],
    ]);
    expect(awards.map((a) => a.handName)).toEqual(['Pair of Aces', 'Pair of Kings', 'Pair of Queens']);
    expect(sum(awards)).toBe(770);
  });

  it('lets the short stack win the main pot while the others chop the side pot (3 players + a folder)', () => {
    // Seat 3 put in 50 and folded; its chips feed both pots.
    const pots = computePots([
      { seat: 0, total: 33, folded: false },
      { seat: 1, total: 100, folded: false },
      { seat: 2, total: 100, folded: false },
      { seat: 3, total: 50, folded: true },
    ]);
    expect(pots).toEqual([
      { amount: 132, eligible: [0, 1, 2] },
      { amount: 151, eligible: [1, 2] },
    ]);
    const holeBySeat = holes({ 0: 'Ah Ad', 1: 'Kh Qd', 2: 'Kd Qh' });
    const btn0 = settle(args({ pots, holeBySeat, button: 0 }));
    expect(tags(btn0)).toEqual([
      [0, 0, 0, 0, 132],
      [1, 0, 0, 1, 76],
      [1, 0, 0, 2, 75],
    ]);
    const btn1 = settle(args({ pots, holeBySeat, button: 1 }));
    expect(won(btn1)).toEqual({ 0: 132, 1: 75, 2: 76 });
    expect(sum(btn1)).toBe(283);
  });

  it('gives dead money to the winner of the pot it lands in', () => {
    // Seat 4 posted a dead small blind and the big blind (3 total) and folded.
    const pots = computePots([
      { seat: 0, total: 40, folded: false },
      { seat: 1, total: 80, folded: false },
      { seat: 4, total: 3, folded: true },
    ]);
    const awards = settle(args({ pots, holeBySeat: holes({ 0: 'Ah Ad', 1: 'Kh Kd' }) }));
    expect(tags(awards)).toEqual([
      [0, 0, 0, 0, 83],
      [1, 0, 0, 1, 40],
    ]);
  });

  it('returns the uncalled bet before pots are built and conserves chips over a hand', () => {
    // River: seat 1 shoves 500 into seat 0 (all in for 180 total this round); seat 2 folded earlier.
    const start = { 0: 300, 1: 900, 2: 400 };
    const seats = [
      { seat: 0, total: 300, bet: 180, folded: false },
      { seat: 1, total: 620, bet: 500, folded: false },
      { seat: 2, total: 40, bet: 0, folded: true },
    ];
    const back = uncalledBet(seats);
    expect(back).toEqual({ seat: 1, amount: 320 });
    const s1 = seats.find((s) => s.seat === back!.seat)!;
    s1.total -= back!.amount;
    const pots = computePots(seats);
    expect(pots).toEqual([{ amount: 640, eligible: [0, 1] }]);
    const awards = settle(args({ pots, holeBySeat: holes({ 0: '7h 7d', 1: 'Ah Kd' }) }));
    expect(awards).toEqual([expect.objectContaining({ seat: 0, amount: 640, handName: 'Three Sevens' })]);
    const stacks = Object.fromEntries(seats.map((s) => [s.seat, start[s.seat as 0 | 1 | 2] - s.total + (won(awards)[s.seat] ?? 0)]));
    expect(stacks).toEqual({ 0: 640, 1: 600, 2: 360 });
    expect(stacks[0] + stacks[1] + stacks[2]).toBe(1600);
  });

  describe('chopped pot odd chip follows the button', () => {
    // Seats 1 and 4 tie; the odd chip goes to whichever comes first clockwise after the button.
    const cases: [SeatIndex | null, SeatIndex][] = [
      [0, 1],
      [1, 4],
      [2, 4],
      [3, 4],
      [4, 1],
      [5, 1],
      [null, 1],
    ];
    for (const [button, odd] of cases) {
      it(`button ${button} -> seat ${odd}`, () => {
        const awards = settle(
          args({
            pots: [{ amount: 101, eligible: [1, 4] }],
            button,
            holeBySeat: holes({ 1: 'Ah Kd', 4: 'As Kc' }),
          }),
        );
        expect(awards).toHaveLength(2);
        expect(won(awards)[odd]).toBe(51);
        expect(sum(awards)).toBe(101);
        expect(awards[0].seat).toBe(odd);
      });
    }
  });

  it('runs it twice with a different winner each run', () => {
    const awards = settle(
      args({
        pots: [{ amount: 201, eligible: [0, 3] }],
        runs: [[cards('2c 7s 9d Jc 3h')], [cards('4c 8s Ts Ks 5h')]],
        holeBySeat: holes({ 0: 'Ah Ad', 3: 'Kh Kd' }),
      }),
    );
    expect(tags(awards)).toEqual([
      [0, 0, 0, 0, 101],
      [0, 1, 0, 3, 100],
    ]);
    expect(awards.map((a) => a.handName)).toEqual(['Pair of Aces', 'Three Kings']);
  });

  it('splits a double board pot between the boards', () => {
    const awards = settle(
      args({
        pots: [{ amount: 101, eligible: [0, 3] }],
        runs: [[cards('2c 7s 9d Jc 3h'), cards('4c 8s Ts Ks 5h')]],
        holeBySeat: holes({ 0: 'Ah Ad', 3: 'Kh Kd' }),
      }),
    );
    expect(tags(awards)).toEqual([
      [0, 0, 0, 0, 51],
      [0, 0, 1, 3, 50],
    ]);
  });

  it('cuts double board plus run it twice into four portions, odd chips to run 0 then board 0', () => {
    const { rules, calls } = firstSeat();
    const runs = [
      [cards('2c 7s 9d Jc 3h'), cards('4c 8s Ts Ks 5h')],
      [cards('As Ks Qs Js Ts'), cards('Ah Kh Qh Jh Th')],
    ];
    const awards = settle(args({ pots: [{ amount: 203, eligible: [0, 3] }], runs, rules, button: 0 }));
    expect(calls.map((c) => c.amount)).toEqual([51, 51, 51, 50]);
    expect(calls.map((c) => c.board)).toEqual([runs[0][0], runs[0][1], runs[1][0], runs[1][1]]);
    expect(awards.map((a) => [a.run, a.board, a.amount])).toEqual([
      [0, 0, 51],
      [0, 1, 51],
      [1, 0, 51],
      [1, 1, 50],
    ]);
    expect(sum(awards)).toBe(203);
  });

  it('chops each of the four portions with real hands and odd chips in button order', () => {
    // Every board plays for both seats. Portions: 52, 51, 51, 51.
    const runs = [
      [cards('As Ks Qs Js Ts'), cards('Ah Kh Qh Jh Th')],
      [cards('Ad Kd Qd Jd Td'), cards('9c Tc Jc Qc Kc')],
    ];
    const awards = settle(
      args({
        pots: [{ amount: 205, eligible: [2, 5] }],
        runs,
        button: 3,
        holeBySeat: holes({ 2: '2c 3d', 5: '2h 3s' }),
      }),
    );
    expect(tags(awards)).toEqual([
      [0, 0, 0, 5, 26],
      [0, 0, 0, 2, 26],
      [0, 0, 1, 5, 26],
      [0, 0, 1, 2, 25],
      [0, 1, 0, 5, 26],
      [0, 1, 0, 2, 25],
      [0, 1, 1, 5, 26],
      [0, 1, 1, 2, 25],
    ]);
    expect(won(awards)).toEqual({ 2: 101, 5: 104 });
    expect(awards[0].handName).toBe('Royal Flush');
    expect(awards[6].handName).toBe('Straight Flush, King high');
  });

  it('deducts a fee from each pot before awarding', () => {
    const seen: [Pot, number][] = [];
    const fee = (pot: Pot, index: number) => {
      seen.push([pot, index]);
      return Math.floor(pot.amount / 20);
    };
    const pots = [
      { amount: 200, eligible: [0, 1, 2] },
      { amount: 150, eligible: [1, 2] },
      { amount: 9, eligible: [2] },
    ];
    const awards = settle(args({ pots, fee, holeBySeat: holes({ 0: 'Ah Ad', 1: 'Kh Kd', 2: 'Qh Qd' }) }));
    expect(seen).toEqual([[pots[0], 0], [pots[1], 1], [pots[2], 2]]);
    expect(tags(awards)).toEqual([
      [0, 0, 0, 0, 190],
      [1, 0, 0, 1, 143],
      [2, 0, 0, 2, 9],
    ]);
    expect(sum(awards)).toBe(359 - 17);
  });

  it('awards nothing from a pot the fee takes whole', () => {
    const awards = settle(
      args({
        pots: [{ amount: 3, eligible: [0, 1] }, { amount: 10, eligible: [1] }],
        fee: (pot, i) => (i === 0 ? pot.amount : 0),
        rules: chop,
      }),
    );
    expect(tags(awards)).toEqual([[1, 0, 0, 1, 10]]);
  });

  it('rejects bad fees', () => {
    const pots = [{ amount: 100, eligible: [0, 1] }];
    expect(() => settle(args({ pots, rules: chop, fee: () => 2.5 }))).toThrow();
    expect(() => settle(args({ pots, rules: chop, fee: () => -1 }))).toThrow();
    expect(() => settle(args({ pots, rules: chop, fee: () => 101 }))).toThrow(/more than pot/);
  });

  it('hands awardPortion the odd-chip order and the matching board', () => {
    const { rules, calls } = firstSeat();
    const runs = [[cards(dryBoard)]];
    settle(args({ pots: [{ amount: 30, eligible: [0, 2, 4] }], runs, rules, button: 2 }));
    expect(calls).toEqual([{ amount: 30, eligible: [4, 0, 2], board: runs[0][0] }]);
  });

  it('skips portions that get no chips', () => {
    const { rules, calls } = firstSeat();
    const awards = settle(
      args({ pots: [{ amount: 1, eligible: [0, 1] }], runs: [[cards(dryBoard)], [cards('4c 8s Ts Ks 5h')]], rules }),
    );
    expect(calls).toHaveLength(1);
    expect(tags(awards)).toEqual([[0, 0, 0, 1, 1]]);
  });

  it('keeps pot indexes on awards across several pots', () => {
    const awards = settle(
      args({
        pots: [{ amount: 10, eligible: [0, 1, 2] }, { amount: 20, eligible: [1, 2] }, { amount: 5, eligible: [2] }],
        rules: chop,
        button: 2,
      }),
    );
    expect(tags(awards)).toEqual([
      [0, 0, 0, 0, 4],
      [0, 0, 0, 1, 3],
      [0, 0, 0, 2, 3],
      [1, 0, 0, 1, 10],
      [1, 0, 0, 2, 10],
      [2, 0, 0, 2, 5],
    ]);
  });

  it('treats no runs as one empty board (stud)', () => {
    const { rules, calls } = firstSeat();
    settle(args({ pots: [{ amount: 10, eligible: [0, 1] }], runs: [], rules }));
    expect(calls[0].board).toEqual([]);
    const awards = settle(
      args({
        pots: [{ amount: 10, eligible: [0, 1] }],
        runs: [],
        holeBySeat: holes({ 0: 'Ah Ad Ac 2s 3s 4d 9c', 1: 'Kh Kd Kc Ks 2c 3c 5h' }),
      }),
    );
    expect(awards).toEqual([expect.objectContaining({ pot: 0, run: 0, board: 0, seat: 1, amount: 10, handName: 'Four Kings' })]);
  });

  it('rejects malformed input', () => {
    expect(() => settle(args({ pots: [{ amount: 10, eligible: [0, 1] }], runs: [[]], rules: chop }))).toThrow(/no boards/);
    expect(() => settle(args({ pots: [{ amount: 10, eligible: [] }], rules: chop }))).toThrow(/no eligible/);
    expect(() => settle(args({ pots: [{ amount: 10.5, eligible: [0, 1] }], rules: chop }))).toThrow();
  });

  it('throws when a variant creates, loses or misplaces chips', () => {
    const pots = [{ amount: 11, eligible: [0, 1] }];
    const rules = (awardPortion: AwardPortion): VariantRules => ({ awardPortion });
    expect(() =>
      settle(args({ pots, rules: rules((_s, amount, e) => [{ seat: e[0], amount: amount - 1, half: 'scoop' }]) })),
    ).toThrow(/awarded 10 of 11/);
    expect(() =>
      settle(args({ pots, rules: rules((_s, amount, e) => [{ seat: e[0], amount: amount + 1, half: 'scoop' }]) })),
    ).toThrow(/awarded 12 of 11/);
    expect(() =>
      settle(args({ pots, rules: rules((_s, amount) => [{ seat: 3, amount, half: 'scoop' }]) })),
    ).toThrow(/not eligible/);
    expect(() =>
      settle(
        args({
          pots,
          rules: rules((_s, amount, e) => e.map((seat) => ({ seat, amount: amount / 2, half: 'scoop' as const }))),
        }),
      ),
    ).toThrow(/integer/);
    expect(() => settle(args({ pots, rules: rules(() => []) }))).toThrow();
  });

  it('conserves chips: awards equal pots minus fees (random settlements)', () => {
    let x = 7;
    const rng = (n: number) => {
      x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
      return x % n;
    };
    for (let i = 0; i < 500; i++) {
      const seats = Array.from({ length: 2 + rng(8) }, (_, k) => ({ seat: k, total: rng(400), folded: rng(4) === 0 }));
      if (seats.every((s) => s.folded)) seats[0].folded = false;
      const pots = computePots(seats);
      const runs = Array.from({ length: 1 + rng(2) }, () => Array.from({ length: 1 + rng(2) }, () => cards(dryBoard)));
      const feeRate = rng(11);
      const fee = (pot: Pot) => Math.floor((pot.amount * feeRate) / 100);
      const awards = settle({
        pots,
        runs,
        button: rng(3) === 0 ? null : rng(10),
        maxSeats: 10,
        holeBySeat: {},
        spec: nlh,
        rules: chop,
        fee,
      });
      expect(sum(awards)).toBe(sum(pots) - pots.reduce((s, p) => s + fee(p), 0));
      expect(awards.every((a) => Number.isInteger(a.amount) && a.amount >= 0)).toBe(true);
    }
  });
});

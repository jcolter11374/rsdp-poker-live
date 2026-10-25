import { describe, expect, it } from 'vitest';
import type { GameSpec, VariantRules } from '../../src/core/types';
import {
  awardPortion,
  bringInSeat,
  drawReplacements,
  firstToActSeat,
  gameCode,
  gameTitle,
  registerAllVariants,
  studOddChipOrder,
  VARIANT_LIST,
  VARIANTS,
} from '../../src/variants';

const c = (s: string) => s.split(' ');

describe('variant registry', () => {
  it('registers every game with the rules its family needs', () => {
    const seen = new Map<string, VariantRules>();
    registerAllVariants({ register: (spec: GameSpec, rules: VariantRules) => seen.set(spec.id, rules) });
    expect([...seen.keys()].sort()).toEqual(
      ['badugi', 'nlhe', 'plo4', 'plo5', 'plo5-8', 'plo6', 'plo6-8', 'plo8', 'razz', 'stud', 'stud8', 'td27'].sort(),
    );
    expect(seen.get('stud')!.bringInSeat).toBeDefined();
    expect(seen.get('plo4')!.bringInSeat).toBeUndefined();
  });

  it('keeps split, showdown rules and card counts consistent', () => {
    for (const s of VARIANT_LIST) {
      const split = s.showdown.high && s.showdown.low ? 'hi-lo' : s.showdown.high ? 'high' : 'low';
      expect(s.split, s.id).toBe(split);
      const dealt = s.streets.reduce((n, st) => n + st.dealDown + st.dealUp, 0);
      expect(dealt, s.id).toBe(s.cardsPerPlayer);
      const board = s.streets.reduce((n, st) => n + st.dealBoard, 0);
      expect(board, s.id).toBe(s.family === 'flop' ? 5 : 0);
      if (s.family === 'flop') expect(s.maxPlayers * s.cardsPerPlayer + 5).toBeLessThanOrEqual(52);
    }
    expect(VARIANTS.plo5.maxPlayers).toBe(9);
    expect(VARIANTS.plo6.maxPlayers).toBe(7);
    expect(VARIANTS.td27.streets.filter((s) => s.drawMaxDiscard).length).toBe(3);
  });
});

describe('awardPortion', () => {
  it('high-only: odd chips go one each in eligible order', () => {
    // Both play the board straight.
    const board = c('5c 6d 7h 8s 9c');
    const hole = { 1: c('2c 2d'), 4: c('3c 3d'), 7: c('4c 4d') };
    const awards = awardPortion(VARIANTS.nlhe, 1115, [4, 7, 1], hole, board);
    expect(awards.map((a) => [a.seat, a.amount, a.half])).toEqual([
      [4, 372, 'high'],
      [7, 372, 'high'],
      [1, 371, 'high'],
    ]);
    expect(awards[0].handName).toBe('Straight, Nine high');
  });

  it('hi-lo: odd chip to the high half, then quartering', () => {
    const board = c('2s 3d 7h Kc Kd');
    const hole = {
      0: c('Kh Qh Js Ts'), // trip kings, no low
      1: c('Ac 4c 9h 9s'), // 7-4-3-2-A
      2: c('Ad 4h Qs Qc'), // same low
    };
    const awards = awardPortion(VARIANTS.plo8, 375, [1, 2, 0], hole, board);
    expect(awards.map((a) => [a.seat, a.amount, a.half])).toEqual([
      [0, 188, 'high'],
      [1, 94, 'low'],
      [2, 93, 'low'],
    ]);
    expect(awards[1].handName).toBe('Seven-Four low');
  });

  it('hi-lo: high takes everything when no low qualifies', () => {
    const board = c('9s Td Jh Kc Kd');
    const hole = { 0: c('Kh Qh 2s 3s'), 1: c('Ac 4c 5h 6s') };
    expect(awardPortion(VARIANTS.plo8, 101, [0, 1], hole, board)).toMatchObject([
      { seat: 0, amount: 101, half: 'scoop' },
    ]);
  });

  it('hi-lo: one seat winning both halves scoops', () => {
    const board = c('2s 3d 4h Kc 9d');
    const hole = { 0: c('Ah 5h Qs Js'), 1: c('Kh Qh Td 8s') };
    const [award] = awardPortion(VARIANTS.plo8, 100, [0, 1], hole, board);
    expect(award).toMatchObject({ seat: 0, amount: 100, half: 'scoop' });
    expect(award.handName).toBe('Straight, Five high and Five-Four low');
  });

  it('hi-lo: winning the high and tying the low takes three quarters', () => {
    const board = c('2s 3d 7h Kc Kd');
    const hole = { 0: c('Ac 4c Kh Qs'), 1: c('Ad 4h 9s 9c') };
    const awards = awardPortion(VARIANTS.plo8, 100, [0, 1], hole, board);
    expect(awards.map((a) => [a.seat, a.amount, a.half])).toEqual([
      [0, 50, 'high'],
      [0, 25, 'low'],
      [1, 25, 'low'],
    ]);
  });

  it('stud hi-lo: a nine low does not qualify, so the high scoops', () => {
    const hole = { 0: c('9c 7d 5h 3s 2c Kd Kh'), 1: c('Ac Ad Qs Qd Jc Th 4s') };
    expect(awardPortion(VARIANTS.stud8, 60, [0, 1], hole, [])).toMatchObject([{ seat: 1, amount: 60, half: 'scoop' }]);
  });

  it('stud hi-lo uses any five of seven for each half', () => {
    const hole = {
      3: c('As 2d 3c 4h 9s 9d 9c'), // trip nines high, 9-4-3-2-A is no low -> 4-3-2-A needs a fifth: none
      5: c('Kc Kd 8h 6s 5d 4c 2h'), // pair of kings, 8-6-5-4-2 low
    };
    const awards = awardPortion(VARIANTS.stud8, 41, studOddChipOrder([3, 5], hole), hole, []);
    expect(awards).toMatchObject([
      { seat: 3, amount: 21, half: 'high' },
      { seat: 5, amount: 20, half: 'low', handName: 'Eight-Six low' },
    ]);
  });

  it('low-only games pay the low', () => {
    const hole = { 0: c('7c 5d 4h 3s 2c'), 1: c('7d 5c 4s 3h 2d') };
    expect(awardPortion(VARIANTS.td27, 9, [1, 0], hole, [])).toMatchObject([
      { seat: 1, amount: 5, half: 'low' },
      { seat: 0, amount: 4, half: 'low' },
    ]);
    const badugi = { 0: c('Kc Qd Jh Ts'), 1: c('Ac 2c 3d 4h') };
    expect(awardPortion(VARIANTS.badugi, 10, [0, 1], badugi, [])).toMatchObject([{ seat: 0, amount: 10 }]);
  });

  it('skips zero-chip awards and rejects fractional chips', () => {
    const board = c('2s 3d 7h Kc Kd');
    const hole = { 0: c('Kh Qh Js Ts'), 1: c('Ac 4c 9h 9s') };
    expect(awardPortion(VARIANTS.plo8, 1, [0, 1], hole, board)).toMatchObject([{ seat: 0, amount: 1, half: 'high' }]);
    expect(() => awardPortion(VARIANTS.plo8, 1.5, [0, 1], hole, board)).toThrow();
  });
});

describe('stud order', () => {
  it('lowest card brings in, clubs lowest; Razz flips it', () => {
    const up = { 0: ['5h'], 1: ['2s'], 2: ['2c'], 3: ['Kd'], 4: ['Ac'] };
    expect(bringInSeat(VARIANTS.stud, up)).toBe(2);
    expect(bringInSeat(VARIANTS.stud8, up)).toBe(2);
    expect(bringInSeat(VARIANTS.razz, up)).toBe(3);
    expect(bringInSeat(VARIANTS.razz, { 0: ['Kc'], 1: ['Ks'], 2: ['Ah'] })).toBe(1);
  });

  it('best hand showing acts first; Razz the best low', () => {
    const up = { 0: c('Ah Kd'), 1: c('4c 4d'), 2: c('7s 2h'), 3: c('Ad Qc') };
    expect(firstToActSeat(VARIANTS.stud, up)).toBe(1);
    expect(firstToActSeat(VARIANTS.stud8, up)).toBe(1);
    expect(firstToActSeat(VARIANTS.razz, up)).toBe(2);
  });

  it('ties go to the first seat in the given order', () => {
    const up = { 2: c('Ah Kd'), 5: c('As Kc') };
    expect(firstToActSeat(VARIANTS.stud, up)).toBe(2);
    expect(firstToActSeat(VARIANTS.stud, up, [5, 2])).toBe(5);
  });

  it('rejects non-stud games', () => {
    expect(() => bringInSeat(VARIANTS.plo4, { 0: ['2c'] })).toThrow();
  });
});

describe('drawReplacements', () => {
  const rng = (n: number) => n - 1;

  it('deals from the top of the stub', () => {
    const r = drawReplacements({ discards: c('Kc Qd'), stub: c('2c 3c 4c 5c'), muck: c('9h'), rng, maxDiscard: 5 });
    expect(r).toEqual({ cards: c('2c 3c'), stub: c('4c 5c'), muck: c('9h Kc Qd'), reshuffled: false });
  });

  it('never deals the last card: reshuffles it with the muck, not the drawer’s discards', () => {
    const r = drawReplacements({ discards: c('Kc Qd Jh'), stub: c('2c 3c'), muck: c('9h 8h'), rng });
    expect(r.reshuffled).toBe(true);
    // This rng leaves the shuffle in order: last stub card first, then the muck.
    expect(r.cards).toEqual(c('2c 3c 9h'));
    expect(r.stub).toHaveLength(1);
    expect(r.cards).not.toContain('Kc');
    expect(r.muck).toEqual(c('Kc Qd Jh'));
    expect([...r.cards, ...r.stub].sort()).toEqual(c('2c 3c 8h 9h').sort());
  });

  it('validates the draw', () => {
    expect(() => drawReplacements({ discards: c('Kc Qd Jh Ts 9s'), stub: c('2c'), muck: [], rng, maxDiscard: 4 })).toThrow();
    expect(() => drawReplacements({ discards: c('Kc Qd'), stub: c('2c'), muck: [], rng })).toThrow();
  });
});

describe('game names', () => {
  it('names the game and its betting separately, and every combination', () => {
    expect(gameTitle('nlhe', 'no-limit')).toBe("No-Limit Hold'em");
    expect(gameTitle('nlhe', 'fixed-limit')).toBe("Limit Hold'em");
    expect(gameTitle('plo4', 'pot-limit')).toBe('Pot-Limit Omaha');
    expect(gameTitle('plo4', 'fixed-limit')).toBe('Limit Omaha');
    expect(gameTitle('plo8')).toBe('Pot-Limit Omaha Hi-Lo (8 or better)');
    expect(gameTitle('plo5')).toBe('Pot-Limit 5-Card Omaha');
    expect(gameTitle('stud8')).toBe('Stud Hi-Lo (8 or better)');
    expect(gameTitle('badugi', 'no-limit')).toBe('No-Limit Badugi');
    expect(gameCode('nlhe', 'no-limit')).toBe('NLH');
    expect(gameCode('nlhe', 'pot-limit')).toBe('PLH');
    expect(gameCode('nlhe', 'fixed-limit')).toBe('LHE');
    expect(gameCode('plo4', 'pot-limit')).toBe('PLO');
    expect(gameCode('plo8', 'fixed-limit')).toBe('LO8');
    expect(gameCode('stud', 'fixed-limit')).toBe('Stud');
    expect(gameCode('td27', 'no-limit')).toBe('NL 2-7 TD');
    for (const v of VARIANT_LIST) expect(v.name).not.toMatch(/limit/i);
  });
});

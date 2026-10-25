import { describe, expect, it } from 'vitest';
import {
  chipChop,
  clockAt,
  curvePercents,
  generateStructure,
  icm,
  payoutPreset,
  placePrizes,
  plannedMinutes,
  presetStructure,
  prizePool,
  prizesForPlaces,
  validatePayoutStructure,
  validateStructure,
  type LevelRow,
  type StructureRow,
} from '../src';

const lv = (sb: number, bb: number, minutes = 10, extra: Partial<LevelRow> = {}): LevelRow => ({ kind: 'level', sb, bb, ante: 0, anteType: 'none', minutes, ...extra });

describe('structures', () => {
  it('ships valid presets with rising blinds', () => {
    for (const name of ['hyper', 'turbo', 'regular', 'deep'] as const) {
      const rows = presetStructure(name, { startingStack: 10_000, expectedEntrants: 30 });
      expect(validateStructure(rows)).toEqual({ errors: [], warnings: [] });
      const levels = rows.filter((r): r is LevelRow => r.kind === 'level');
      expect(levels[0].bb * (name === 'deep' ? 200 : name === 'regular' ? 100 : name === 'turbo' ? 50 : 25)).toBeCloseTo(10_000, -4);
      levels.slice(1).forEach((l, i) => expect(l.bb).toBeGreaterThan(levels[i].bb));
      expect(levels.every((l) => l.sb * 2 === l.bb)).toBe(true);
      expect(levels.at(-1)!.bb).toBeGreaterThanOrEqual(30_000);
    }
  });

  it('regular preset starts 50/100 with a 10,000 stack and adds antes at level 5', () => {
    const rows = presetStructure('regular', { startingStack: 10_000 });
    expect(rows[0]).toMatchObject({ sb: 50, bb: 100, minutes: 15, anteType: 'none' });
    const l5 = rows.filter((r) => r.kind === 'level')[4] as LevelRow;
    expect(l5.anteType).toBe('per-player');
    expect(l5.ante).toBeGreaterThan(0);
    expect(rows[6]).toMatchObject({ kind: 'break', minutes: 10 });
  });

  it('big-blind antes equal the big blind', () => {
    const rows = presetStructure('turbo', { startingStack: 5000, anteType: 'big-blind' });
    const l = rows.filter((r): r is LevelRow => r.kind === 'level' && r.anteType !== 'none');
    expect(l.every((x) => x.ante === x.bb && x.anteType === 'big-blind')).toBe(true);
  });

  it('marks rebuy levels and the add-on break', () => {
    const rows = presetStructure('regular', { startingStack: 10_000, rebuyThroughLevel: 6, addOnAtFirstBreak: true });
    expect(rows.filter((r) => r.kind === 'level' && r.rebuy)).toHaveLength(6);
    expect(rows.find((r) => r.kind === 'break')).toMatchObject({ addOn: true });
  });

  it('generates a structure near a target duration', () => {
    for (const target of [60, 180, 300]) {
      const rows = generateStructure({ startingStack: 10_000, expectedEntrants: 20, targetMinutes: target });
      expect(validateStructure(rows).errors).toEqual([]);
      expect(Math.abs(plannedMinutes(rows) - target) / target).toBeLessThan(0.25);
    }
  });

  it('reports errors and warnings', () => {
    const rows: StructureRow[] = [
      { kind: 'break', minutes: 10 },
      lv(60, 50),
      lv(10, 20, 0),
      { kind: 'break', minutes: 5 },
      { kind: 'break', minutes: 5 },
      lv(100, 200, 10, { ante: 300, anteType: 'per-player' }),
      lv(0, 0, 10, { limit: { smallBet: 10, bigBet: 5, bringIn: 20 } }),
    ];
    const { errors, warnings } = validateStructure(rows, { maxRebuys: 1 });
    expect(errors).toEqual(
      expect.arrayContaining([
        'A break cannot be first',
        'Level 1: small blind is larger than the big blind',
        'Level 2: length must be 1-240 minutes',
        'Break after level 2: two breaks in a row',
        'Level 4: big blind must be above 0',
        'Level 4: big bet is smaller than the small bet',
        'Level 4: bring-in is larger than the small bet',
        'Rebuys are on, but no level allows rebuys',
      ]),
    );
    expect(warnings).toEqual(expect.arrayContaining(['Level 3: ante is larger than the big blind', 'Level 2: blinds go down from the previous level']));
  });

  it('clock lookup', () => {
    const rows: StructureRow[] = [lv(1, 2), lv(2, 4), { kind: 'break', minutes: 5 }, lv(5, 10)];
    const min = 60_000;
    expect(clockAt(rows, 0)).toMatchObject({ rowIndex: 0, levelNumber: 1, msLeft: 10 * min, msToBreak: 20 * min, onBreak: false });
    expect(clockAt(rows, 15 * min)).toMatchObject({ rowIndex: 1, levelNumber: 2, msLeft: 5 * min, msToBreak: 5 * min });
    const brk = clockAt(rows, 22 * min);
    expect(brk).toMatchObject({ rowIndex: 2, levelNumber: 2, onBreak: true, msLeft: 3 * min });
    expect(brk.level.bb).toBe(10);
    expect(clockAt(rows, 999 * min)).toMatchObject({ rowIndex: 3, levelNumber: 3, msLeft: null, nextLevel: null });
  });
});

describe('payouts', () => {
  it('presets are valid up to 600 entries', () => {
    for (const name of ['winner-take-all', 'top-two', 'top-three', 'standard', 'flat'] as const) {
      expect(validatePayoutStructure(payoutPreset(name), 600)).toEqual([]);
    }
  });

  it('standard pays 1 / 2 / 3 / ~15%', () => {
    const s = payoutPreset('standard');
    const paid = (n: number) => placePrizes(10_000, s, n).length;
    expect([paid(4), paid(7), paid(10), paid(20), paid(100), paid(600)]).toEqual([1, 2, 3, 4, 15, 90]);
  });

  it('two-place curve is about 65/35', () => {
    expect(curvePercents(2, 0.9)).toEqual([65.11, 34.89]);
  });

  it('rounds each place down and gives the remainder to 1st', () => {
    const s = { name: 'x', ranges: [{ minEntries: 2, maxEntries: 10, percents: [50, 30, 20] }] };
    expect(placePrizes(1001, s, 9)).toEqual([501, 300, 200]);
    expect(placePrizes(1001, s, 11)).toEqual([]);
  });

  it('validates ranges', () => {
    const errors = validatePayoutStructure(
      {
        name: 'bad',
        ranges: [
          { minEntries: 2, maxEntries: 5, percents: [60, 30, 20] },
          { minEntries: 7, maxEntries: 9, percents: [40, 50, 10] },
        ],
      },
      20,
    );
    expect(errors).toEqual([
      'Range 2-5: pays more places than 2 entries',
      'Range 2-5: percents add up to 110, not 100',
      'Range 7-9: must start at 6 (no gaps or overlaps)',
      'Range 7-9: a lower place pays more than a higher one',
      'Ranges stop at 9 entries; they must reach 20',
    ]);
  });

  it('prize pool from display-only money', () => {
    expect(prizePool({ buyIn: 2000, rebuy: 2000, addOn: 1000, feePercent: 10, added: 500 }, { entries: 10, rebuys: 3, addOns: 5 })).toBe(
      Math.floor(((20000 + 6000 + 5000) * 90) / 100) + 500,
    );
  });

  it('tied places split the places they cover', () => {
    expect(prizesForPlaces({ a: 1, b: 2, c: 2, d: 4 }, [500, 300, 201, 0])).toEqual({ a: 500, b: 251, c: 250, d: 0 });
  });

  it('ICM: equal stacks split evenly, and totals match', () => {
    expect(icm([100, 100, 100], [50, 30, 20])).toEqual([34, 33, 33]);
    const eq = icm([5000, 3000, 2000], [500, 300, 200]);
    expect(eq.reduce((a, b) => a + b, 0)).toBe(1000);
    expect(eq[0]).toBeGreaterThan(eq[1]);
    expect(eq[0]).toBeLessThan(500);
    // Heads-up ICM is the floor plus a chip-proportional share of the rest.
    expect(icm([3000, 1000], [700, 300])).toEqual([600, 400]);
  });

  it('chip chop gives everyone the lowest prize plus a chip share', () => {
    expect(chipChop([3000, 1000], [700, 300])).toEqual([600, 400]);
    expect(chipChop([1, 1, 2], [500, 300, 200]).reduce((a, b) => a + b, 0)).toBe(1000);
  });
});

import { describe, expect, it } from 'vitest';
import { MAX_CHIPS, MAX_LEVELS, validateStructure, type LevelRow, type StructureRow } from '@rsdp/tournament';
import { canAddStructureLevel, nextStructureLevel } from './structureRows';

/** Presses "+ Add level" until the editor stops offering it (or well past the limit, should it never stop). */
function addAllLevels(rows: StructureRow[]) {
  const out = [...rows];
  while (canAddStructureLevel(out) && out.length < 4 * MAX_LEVELS) out.push(nextStructureLevel(out));
  return out;
}

describe('the tournament structure editor\'s "+ Add level"', () => {
  it('stops at the most levels the server accepts, never passes the chip maximum, and that structure saves', () => {
    const first: LevelRow = { kind: 'level', sb: 25, bb: 50, ante: 5, anteType: 'per-player', minutes: 15 };
    const rows = addAllLevels([first, { kind: 'break', minutes: 10 }]);
    expect(rows.filter((r) => r.kind === 'level')).toHaveLength(MAX_LEVELS);
    expect(rows[rows.length - 1]).toMatchObject({ sb: MAX_CHIPS, bb: MAX_CHIPS, ante: MAX_CHIPS });
    expect(validateStructure(rows).errors).toEqual([]);
  });

  it('counts only levels, not breaks, against the limit', () => {
    const level: LevelRow = { kind: 'level', sb: 25, bb: 50, ante: 0, anteType: 'none', minutes: 15 };
    const rows: StructureRow[] = [];
    for (let i = 0; i < MAX_LEVELS - 1; i++) rows.push(level, { kind: 'break', minutes: 5 });
    rows.push(level);
    expect(canAddStructureLevel(rows)).toBe(false);
    expect(canAddStructureLevel(rows.slice(0, -1))).toBe(true);
  });

  it('doubles the last level and keeps its ante type, length and rebuys', () => {
    expect(nextStructureLevel([{ kind: 'level', sb: 100, bb: 200, ante: 25, anteType: 'big-blind', minutes: 12, rebuy: true }, { kind: 'break', minutes: 10 }])).toEqual({
      kind: 'level', sb: 200, bb: 400, ante: 50, anteType: 'big-blind', minutes: 12, rebuy: true,
    });
    expect(nextStructureLevel([])).toEqual({ kind: 'level', sb: 25, bb: 50, ante: 0, anteType: 'none', minutes: 15 });
  });
});

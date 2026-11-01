import { MAX_CHIPS, MAX_LEVELS, type LevelRow, type StructureRow } from '@rsdp/tournament';

/** Whether "+ Add level" may add another level: the server takes at most MAX_LEVELS levels (breaks don't count). */
export const canAddStructureLevel = (rows: readonly StructureRow[]) => rows.filter((r) => r.kind === 'level').length < MAX_LEVELS;

/** The level "+ Add level" adds: the last level's blinds and ante doubled, but never past MAX_CHIPS, which the server refuses. */
export function nextStructureLevel(rows: readonly StructureRow[]): LevelRow {
  const last = [...rows].reverse().find((r): r is LevelRow => r.kind === 'level');
  const double = (v: number) => Math.min(v * 2, MAX_CHIPS);
  const sb = last ? double(last.sb) : 25;
  return { kind: 'level', sb, bb: double(sb), ante: last?.anteType === 'none' ? 0 : double(last?.ante ?? 0), anteType: last?.anteType ?? 'none', minutes: last?.minutes ?? 15, ...(last?.rebuy ? { rebuy: true } : {}) };
}

import { scaleChipAmounts, type TableSettings } from '@rsdp/engine/settings';

/**
 * Puts a preset's setup on a table, keeping the table's own name, mode and
 * money: a preset saved in chips (from before cash games were in dollars) counts
 * each chip as a dollar, so its 1/2 is 1/2 here too.
 */
export function withPreset(table: TableSettings, preset: TableSettings): TableSettings {
  const cents = table.stakes.centsMode;
  // Cents don't fit in whole chips: 0.25/0.50 would round to 0/1.
  if (!cents && preset.stakes.centsMode) throw new Error("This table plays in chips, so it can't load a preset in dollars and cents. Start a new table to use it.");
  const factor = cents === preset.stakes.centsMode ? 1 : 100;
  const scaled = factor === 1 ? structuredClone(preset) : scaleChipAmounts(structuredClone(preset), factor);
  return { ...scaled, table: { ...preset.table, name: table.table.name, mode: table.table.mode }, stakes: { ...scaled.stakes, centsMode: cents } };
}

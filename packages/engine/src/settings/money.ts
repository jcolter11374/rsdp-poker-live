import { isPlainObject, type JsonObject } from './json';
import type { SettingsPatch } from './changes';
import type { TableSettings } from './schema';

/**
 * Cash games are played for money: one chip is one cent (stakes.centsMode),
 * so .25/.50 is 25/50 and the engine still only counts whole numbers.
 * Tournaments stay in plain chips.
 */

/** Every setting that is an amount of chips. `*` is each item of an array. */
export const CHIP_AMOUNT_PATHS = [
  'stakes.smallBlind',
  'stakes.bigBlind',
  'stakes.ante',
  'stakes.bringIn',
  'stakes.smallBet',
  'stakes.bigBet',
  'seating.minBuyIn',
  'seating.maxBuyIn',
  'blindSchedule.levels.*.smallBlind',
  'blindSchedule.levels.*.bigBlind',
  'blindSchedule.levels.*.ante',
  'modifiers.bounty-72.amount',
  'modifiers.rake.cap',
  'modifiers.rake.minPot',
  'modifiers.rake.shortHanded.cap',
] as const;

function scaleAt(node: unknown, parts: string[], factor: number): unknown {
  if (!parts.length) return typeof node === 'number' ? Math.round(node * factor) : node;
  const [head, ...rest] = parts;
  if (head === '*') return Array.isArray(node) ? node.map((item) => scaleAt(item, rest, factor)) : node;
  if (!isPlainObject(node) || !Object.hasOwn(node, head)) return node;
  return { ...node, [head]: scaleAt(node[head], rest, factor) };
}

/** The same settings (or patch) with every chip amount it holds multiplied by `factor`. Missing fields stay missing. */
export function scaleChipAmounts<T extends SettingsPatch | TableSettings>(settings: T, factor: number): T {
  let out: unknown = settings;
  for (const path of CHIP_AMOUNT_PATHS) out = scaleAt(out, path.split('.'), factor);
  return out as T;
}

/**
 * A new cash table's settings in dollars and cents. Settings already in cents
 * pass through; older ones (a preset or saved setup from before every cash
 * game was in dollars, or an old page) count each chip as a dollar, so 1/2
 * stays 1/2.
 */
export function cashInDollars(patch: SettingsPatch): SettingsPatch {
  if (patch.stakes?.centsMode === true) return patch;
  const scaled = scaleChipAmounts(patch, 100) as JsonObject & SettingsPatch;
  return { ...scaled, stakes: { ...scaled.stakes, centsMode: true } };
}

/** An amount for log lines: "1,500" in chips, "0.25" or "12" in dollars (the server's text, so not locale dependent). */
export function amountText(chips: number, centsMode: boolean): string {
  if (!centsMode) return chips.toLocaleString('en-US');
  return (chips / 100).toLocaleString('en-US', { minimumFractionDigits: chips % 100 ? 2 : 0, maximumFractionDigits: 2 });
}

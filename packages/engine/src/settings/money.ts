import { isPlainObject } from './json';
import { applyAtNextHand, type SettingsPatch } from './changes';
import { defaultSettings, parseSettings } from './parse';
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
 * The settings a new cash table starts with, in dollars and cents. A patch in
 * chips (with stakes, but not in cents) is filled from the chip defaults and
 * then counted a dollar a chip, so everything it left out matches what it
 * set. A patch in cents is filled from defaults that follow its blinds: limit
 * bets of 0 mean the big blind and twice it, and a 7-2 bounty starts at 5 big
 * blinds (2.50 at .25/.50, the same as 10 chips at 1/2).
 */
export function newCashSettings(patch: SettingsPatch): TableSettings {
  if (patch.stakes && patch.stakes.centsMode !== true) {
    const chips = applyAtNextHand(defaultSettings('cash'), patch).settings;
    const scaled = scaleChipAmounts(chips, 100);
    return parseSettings({ ...scaled, stakes: { ...scaled.stakes, centsMode: true } });
  }
  const base = defaultSettings('cash');
  base.stakes = { ...base.stakes, smallBet: 0, bigBet: 0, centsMode: true };
  const settings = applyAtNextHand(base, patch).settings;
  const bounty = settings.modifiers['bounty-72'];
  const bountySet = (patch.modifiers?.['bounty-72'] as { amount?: number } | undefined)?.amount !== undefined;
  if (bounty && !bountySet) return parseSettings({ ...settings, modifiers: { ...settings.modifiers, 'bounty-72': { ...bounty, amount: Math.max(1, settings.stakes.bigBlind * 5) } } });
  return settings;
}

/** An amount for log lines: "1,500" in chips, "0.25" or "12" in dollars (the server's text, so not locale dependent). */
export function amountText(chips: number, centsMode: boolean): string {
  if (!centsMode) return chips.toLocaleString('en-US');
  return (chips / 100).toLocaleString('en-US', { minimumFractionDigits: chips % 100 ? 2 : 0, maximumFractionDigits: 2 });
}

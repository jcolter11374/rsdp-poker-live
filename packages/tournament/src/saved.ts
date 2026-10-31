// Saved tournament structures: a whole setup kept under a name, loaded in one
// tap when making a new tournament. Also the built-in starters.

import { copySettings } from './copy';
import { defaultSettings, validateSettings } from './director';
import { presetStructure, rsdpStructure, RSDP_STACK, RSDP_TABLE_RULES, type PresetName, type StructureRow } from './structure';
import type { TournamentSettings } from './types';

/** Longest saved structure, as JSON. Real ones are a few kilobytes. */
export const MAX_SAVED_STRUCTURE_LENGTH = 64 * 1024;

/**
 * The settings to keep for a structure: everything on the form. A scheduled
 * start whose time can't be worked out (it has passed) keeps its schedule; the
 * start time itself is worked out again when it is loaded.
 */
export function structureToSave(settings: TournamentSettings): TournamentSettings {
  const out = structuredClone(settings);
  if (out.start.kind === 'scheduled' && !Number.isSafeInteger(out.start.startAt)) out.start = { ...out.start, startAt: 0 };
  return out;
}

/** Why a structure can't be saved, or [] when it can. */
export function savedStructureErrors(settings: TournamentSettings): string[] {
  return validateSettings(settings);
}

/**
 * Reads a saved structure. Settings added since it was saved get their
 * defaults, and a start time that has passed moves forward the way Duplicate
 * settings does. Throws when it isn't a saved structure.
 */
export function readSavedStructure(json: string, now: number): TournamentSettings {
  if (typeof json !== 'string' || json.length > MAX_SAVED_STRUCTURE_LENGTH) throw new Error('That saved structure is too big');
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('That saved structure is damaged');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('That saved structure is damaged');
  const settings = { ...defaultSettings(), ...(raw as Partial<TournamentSettings>) };
  if (!settings.start || typeof settings.start !== 'object') settings.start = { kind: 'manual' };
  return copySettings(settings, now);
}

export type StarterId = 'rsdp' | 'turbo' | 'standard' | 'deep';

export const STARTERS: { id: StarterId; name: string; blurb: string }[] = [
  { id: 'rsdp', name: 'RSDP', blurb: '63,000 chips, 28 levels of 8 minutes, no antes, late registration through level 5, 10-second clock' },
  { id: 'turbo', name: 'Turbo', blurb: '10,000 chips (50 big blinds), 8-minute levels' },
  { id: 'standard', name: 'Standard', blurb: '10,000 chips (100 big blinds), 15-minute levels' },
  { id: 'deep', name: 'Deep stack', blurb: '20,000 chips (200 big blinds), 20-minute levels' },
];

const STARTER_SPECS: Record<StarterId, { preset: PresetName | 'rsdp'; stack: number; lateThrough: number }> = {
  rsdp: { preset: 'rsdp', stack: RSDP_STACK, lateThrough: 5 },
  turbo: { preset: 'turbo', stack: 10_000, lateThrough: 4 },
  standard: { preset: 'regular', stack: 10_000, lateThrough: 4 },
  deep: { preset: 'deep', stack: 20_000, lateThrough: 6 },
};

/**
 * Puts a starter's stack, blind levels and late registration on `current`,
 * and for RSDP its table rules, keeping everything else (name, games, start, prizes). Rebuys and add-ons
 * that are on stay on, on the first four levels and the first break.
 */
export function applyStarter(current: TournamentSettings, id: StarterId): TournamentSettings {
  const spec = STARTER_SPECS[id];
  const expectedEntrants = current.start.kind === 'sng' ? current.start.playersNeeded : Math.min(current.maxEntrants, 30);
  const rebuys = current.rebuy.max > 0 ? { rebuyThroughLevel: 4 } : {};
  let structure: StructureRow[] =
    spec.preset === 'rsdp'
      ? rsdpStructure(rebuys)
      : presetStructure(spec.preset, {
          startingStack: spec.stack,
          expectedEntrants,
          ...rebuys,
          ...(current.addOn.max > 0 ? { addOnAtFirstBreak: true } : {}),
        });
  // A short field, or RSDP's levels, can have no break; an add-on needs one, so add one after level 4.
  if (current.addOn.max > 0 && !structure.some((r) => r.kind === 'break')) structure = [...structure.slice(0, 4), { kind: 'break', minutes: 5, addOn: true }, ...structure.slice(4)];
  return {
    ...structuredClone(current),
    startingStack: spec.stack,
    structure,
    lateRegistration: { enabled: true, throughLevel: spec.lateThrough },
    rebuy: { ...current.rebuy, chips: spec.stack },
    addOn: { ...current.addOn, chips: spec.stack },
    ...(id === 'rsdp' ? { tableRules: { ...RSDP_TABLE_RULES } } : {}),
  };
}

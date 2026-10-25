import { z } from 'zod';
import { getOwn, isPlainObject } from './json';
import { settingsErrorMap } from './messages';
import { migrateSettings } from './migrate';
import { SettingsError, issuesFromZod, parseSettings, type SettingsIssue } from './parse';
import type { TableSettings } from './schema';

/** Tag that marks a file as an RSDP table preset. */
export const PRESET_FORMAT = 'rsdp-table-preset';

/** Version of the preset wrapper. The settings inside carry their own `version`. */
export const PRESET_VERSION = 1;

/** Generous upper bound on a preset file; real presets are a few kilobytes. */
const MAX_PRESET_LENGTH = 256 * 1024;

const presetName = z
  .string()
  .trim()
  .min(1, 'must not be blank')
  .max(60, 'must be at most 60 characters')
  .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), 'must not contain control characters');

export interface SettingsPreset {
  format: typeof PRESET_FORMAT;
  version: typeof PRESET_VERSION;
  name: string;
  settings: TableSettings;
}

/** Saves settings as a named, shareable preset (pretty-printed JSON). Throws SettingsError if either is invalid. */
export function exportPreset(settings: TableSettings, name: string): string {
  const preset: SettingsPreset = {
    format: PRESET_FORMAT,
    version: PRESET_VERSION,
    name: parseName(name),
    settings: parseSettings(settings),
  };
  return JSON.stringify(preset, null, 2);
}

/**
 * Reads a preset file. Its settings go through migrateSettings, so presets
 * saved by older builds still load. The caller decides what to keep from the
 * table it is applied to (for example its name and mode).
 */
export function importPreset(json: string): { name: string; settings: TableSettings } {
  if (typeof json !== 'string') throw presetError([{ path: '(root)', message: 'preset must be JSON text' }]);
  if (json.length > MAX_PRESET_LENGTH) {
    throw presetError([{ path: '(root)', message: `preset is larger than ${MAX_PRESET_LENGTH} characters` }]);
  }
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw presetError([{ path: '(root)', message: 'not valid JSON' }]);
  }
  if (!isPlainObject(data)) throw presetError([{ path: '(root)', message: 'preset must be a JSON object' }]);
  if (getOwn(data, 'format') !== PRESET_FORMAT) {
    throw presetError([{ path: 'format', message: `must be "${PRESET_FORMAT}"` }]);
  }
  const version = getOwn(data, 'version');
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw presetError([{ path: 'version', message: 'must be a whole number' }]);
  }
  if (version > PRESET_VERSION) {
    throw presetError([{ path: 'version', message: `${version} is newer than this build supports (${PRESET_VERSION})` }]);
  }
  const name = parseName(getOwn(data, 'name'));
  const raw = getOwn(data, 'settings');
  if (raw === undefined) throw presetError([{ path: 'settings', message: 'required' }]);
  try {
    return { name, settings: migrateSettings(raw) };
  } catch (err) {
    if (err instanceof SettingsError) throw presetError(prefixed(err.issues, 'settings'));
    throw err;
  }
}

function parseName(name: unknown): string {
  const result = presetName.safeParse(name, { errorMap: settingsErrorMap });
  if (!result.success) throw presetError(prefixed(issuesFromZod(result.error), 'name'));
  return result.data;
}

function presetError(issues: SettingsIssue[]): SettingsError {
  return new SettingsError(issues, 'Invalid preset');
}

function prefixed(issues: SettingsIssue[], prefix: string): SettingsIssue[] {
  return issues.map((i) => ({ path: i.path === '(root)' ? prefix : `${prefix}.${i.path}`, message: i.message }));
}

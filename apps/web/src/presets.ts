import { useSyncExternalStore } from 'react';
import { exportPreset, importPreset, type TableSettings } from '@rsdp/engine/settings';

/**
 * Table presets saved in this browser: whole table setups under a name, kept
 * as preset files (the same JSON that Export downloads), so they load through
 * the settings migration even after the settings change shape.
 */
export interface SavedPreset {
  name: string;
  json: string;
}

const KEY = 'rsdp.presets';

function load(): SavedPreset[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((p) => p && typeof p.name === 'string' && typeof p.json === 'string') : [];
  } catch {
    return [];
  }
}

let current = load();
const listeners = new Set<() => void>();

function store(next: SavedPreset[]) {
  current = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage blocked or full: the presets last for this page only */
  }
  listeners.forEach((l) => l());
}

export function usePresets(): SavedPreset[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
}

/** Saves settings under a name, replacing a preset of the same name. Throws SettingsError when they don't validate. */
export function savePreset(name: string, settings: TableSettings) {
  const json = exportPreset(settings, name);
  const clean = JSON.parse(json).name as string;
  store([...current.filter((p) => p.name !== clean), { name: clean, json }].sort((a, b) => a.name.localeCompare(b.name)));
  return clean;
}

/** Adds a preset file someone shared. Throws SettingsError for anything that isn't one. */
export function addPresetFile(json: string) {
  const { name, settings } = importPreset(json);
  return savePreset(name, settings);
}

export function deletePreset(name: string) {
  store(current.filter((p) => p.name !== name));
}

/** A saved preset's settings, upgraded to the current layout. */
export function presetSettings(preset: SavedPreset): TableSettings {
  return importPreset(preset.json).settings;
}

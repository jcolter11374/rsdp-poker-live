import { ActionError } from '@rsdp/engine/core';
import { exportPreset, importPreset } from '@rsdp/engine/settings';
import { SETUP_KINDS, SETUP_NAME_MAX, SETUPS_PER_KIND, type SavedSetup, type SetupKind } from '@rsdp/engine/wire';
import { MAX_SAVED_STRUCTURE_LENGTH, readSavedStructure, savedStructureErrors } from '@rsdp/tournament';
import { deleteSavedSetup, listSavedSetups, putSavedSetup, renameSavedSetup, type Db } from './db';

/**
 * Where signed-in players keep the setups they saved: cash table presets and
 * tournament structures. The default keeps them in memory.
 */
export interface SetupStore {
  list(owner: string, kind: SetupKind): Promise<SavedSetup[]>;
  /** Saves, replacing one of the same name. Throws when the owner already keeps the most allowed. */
  save(owner: string, kind: SetupKind, setup: SavedSetup): Promise<void>;
  /** False when there is none by that name or the new name is taken. */
  rename(owner: string, kind: SetupKind, from: string, to: SavedSetup): Promise<boolean>;
  remove(owner: string, kind: SetupKind, name: string): Promise<void>;
}

const tooMany = () => new ActionError(`you can keep up to ${SETUPS_PER_KIND} of these; delete some first`);

export function cleanKind(raw: unknown): SetupKind {
  if (!SETUP_KINDS.includes(raw as SetupKind)) throw new ActionError('unknown kind of setup');
  return raw as SetupKind;
}

export function cleanSetupName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  if (!name) throw new ActionError('give it a name');
  if (Array.from(name).length > SETUP_NAME_MAX) throw new ActionError(`names can be up to ${SETUP_NAME_MAX} characters`);
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new ActionError('names cannot contain control characters');
  return name;
}

/**
 * Checks a setup from a client and tidies it: a table preset is written out
 * again under its name; a tournament structure must be settings that would
 * make a tournament.
 */
export function cleanSetup(kind: SetupKind, raw: unknown, now: number): SavedSetup {
  const input = (raw ?? {}) as Partial<Record<keyof SavedSetup, unknown>>;
  const name = cleanSetupName(input.name);
  const json = typeof input.json === 'string' ? input.json : '';
  if (json.length > MAX_SAVED_STRUCTURE_LENGTH) throw new ActionError('that setup is too big to save');
  if (kind === 'table') return { name, json: exportPreset(importPreset(json).settings, name) };
  let settings;
  try {
    settings = readSavedStructure(json, now);
  } catch (e) {
    throw new ActionError((e as Error).message);
  }
  const errors = savedStructureErrors(settings);
  if (errors.length) throw new ActionError(`that structure can't be saved: ${errors[0]}`);
  return { name, json: JSON.stringify(settings) };
}

/** The setup under a new name (a table preset carries its name inside). */
export function renamed(kind: SetupKind, setup: SavedSetup, to: string): SavedSetup {
  return { name: to, json: kind === 'table' ? exportPreset(importPreset(setup.json).settings, to) : setup.json };
}

/** A name not in `taken`: the name itself, or with " (2)", " (3)"… on the end. */
export function freeName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name;
  for (let n = 2; ; n++) {
    const suffix = ` (${n})`;
    const candidate = Array.from(name).slice(0, SETUP_NAME_MAX - suffix.length).join('') + suffix;
    if (!taken.has(candidate)) return candidate;
  }
}

export function memorySetups(): SetupStore {
  const byOwner = new Map<string, Map<string, SavedSetup>>();
  const of = (owner: string, kind: SetupKind) => {
    const key = `${owner}\n${kind}`;
    const m = byOwner.get(key) ?? new Map<string, SavedSetup>();
    byOwner.set(key, m);
    return m;
  };
  return {
    async list(owner, kind) {
      return [...of(owner, kind).values()].map((s) => ({ ...s })).sort((a, b) => a.name.localeCompare(b.name));
    },
    async save(owner, kind, setup) {
      const m = of(owner, kind);
      if (!m.has(setup.name) && m.size >= SETUPS_PER_KIND) throw tooMany();
      m.set(setup.name, { ...setup });
    },
    async rename(owner, kind, from, to) {
      const m = of(owner, kind);
      if (!m.has(from) || (from !== to.name && m.has(to.name))) return false;
      m.delete(from);
      m.set(to.name, { ...to });
      return true;
    },
    async remove(owner, kind, name) {
      of(owner, kind).delete(name);
    },
  };
}

export function dbSetups(db: Db): SetupStore {
  return {
    async list(owner, kind) {
      return (await listSavedSetups(db, owner, kind)).map((r) => ({ name: r.name, json: r.json }));
    },
    async save(owner, kind, setup) {
      if (!(await putSavedSetup(db, { playerId: owner, kind, ...setup, limit: SETUPS_PER_KIND }))) throw tooMany();
    },
    async rename(owner, kind, from, to) {
      return renameSavedSetup(db, { playerId: owner, kind, from, to: to.name, json: to.json });
    },
    async remove(owner, kind, name) {
      await deleteSavedSetup(db, owner, kind, name);
    },
  };
}

import { z } from 'zod';
import type { TableSettings } from './schema';
import { cloneJson, formatPath, isPlainObject } from './json';
import { settingsErrorMap } from './messages';

/**
 * Modifier sections (bomb pot, 7-2 bounty, double board, nit game, rake) live
 * under `settings.modifiers[id]`. Each module registers its own zod schema at
 * import time, so adding a feature never edits the core settings files.
 *
 * Rules, enforced when settings are parsed:
 * - Registered ids are validated by their schema; absent ones get their defaults.
 * - Unregistered ids are rejected by parseSettings (catches typos and clients
 *   missing a module) and dropped, with a report, by migrateSettings.
 * - Server and web must therefore import the same modifier modules before
 *   parsing or migrating settings.
 */

/** Every modifier section has an on/off switch, so mode gates and the runtime can tell whether it is active. */
export interface ModifierSection {
  enabled: boolean;
}

export interface ModifierSchemaOptions {
  /** Cash games only: the section must stay disabled while table.mode is 'tournament'. */
  cashOnly?: boolean;
}

/** What registerModifierSchema returns. Keep it to read the section back with its type. */
export interface RegisteredModifier<T extends ModifierSection = ModifierSection> {
  readonly id: string;
  readonly schema: z.ZodType<T, unknown>;
  readonly cashOnly: boolean;
  /** A fresh copy of the defaults (always disabled). */
  defaults(): T;
  /** This modifier's section of parsed settings, or its defaults when the section is absent. */
  get(settings: TableSettings): T;
}

/** Lowercase letters, digits and dashes, so ids read cleanly in settings paths ("modifiers.bomb-pot.enabled"). */
const MODIFIER_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

const registry = new Map<string, RegisteredModifier>();

/**
 * Adds a modifier section. `defaults` must parse with `schema` and have
 * `enabled: false`, so a table only gains a feature when the host turns it on
 * (and tournament defaults never trip the cash-only gate). Registering an id
 * again replaces it, which keeps hot reload working.
 */
export function registerModifierSchema<S extends z.ZodType<ModifierSection, unknown>>(
  id: string,
  schema: S,
  defaults: z.input<S>,
  options: ModifierSchemaOptions = {},
): RegisteredModifier<z.output<S>> {
  if (!MODIFIER_ID.test(id)) {
    throw new Error(`modifier id "${id}" must be 1-40 lowercase letters, digits or dashes`);
  }
  const parsed = schema.safeParse(defaults, { error: settingsErrorMap });
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${formatPath(i.path) || '(root)'}: ${i.message}`);
    throw new Error(`modifier "${id}" defaults do not match its schema: ${problems.join('; ')}`);
  }
  const value: unknown = parsed.data;
  if (!isPlainObject(value) || value.enabled !== false) {
    throw new Error(`modifier "${id}" defaults must be an object with enabled: false`);
  }
  const frozen = cloneJson(parsed.data as z.output<S>);
  const entry: RegisteredModifier<z.output<S>> = {
    id,
    schema: schema as unknown as z.ZodType<z.output<S>, unknown>,
    cashOnly: options.cashOnly ?? false,
    defaults: () => cloneJson(frozen),
    get: (settings) => {
      const section = Object.hasOwn(settings.modifiers, id) ? settings.modifiers[id] : undefined;
      return section === undefined ? cloneJson(frozen) : (section as z.output<S>);
    },
  };
  registry.set(id, entry);
  return entry;
}

/** Removes a registration (tests, or a module being unloaded). Returns false if the id was not registered. */
export function unregisterModifierSchema(id: string): boolean {
  return registry.delete(id);
}

export function getModifierSchema(id: string): RegisteredModifier | undefined {
  return registry.get(id);
}

/** Registered modifiers in registration order. */
export function listModifierSchemas(): RegisteredModifier[] {
  return [...registry.values()];
}

/** Defaults for every registered modifier, keyed by id. */
export function defaultModifierSections(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const entry of registry.values()) out[entry.id] = entry.defaults();
  return out;
}

/** Enabled registered modifiers in the shape HandInput.modifiers expects. */
export function enabledModifiers(settings: TableSettings): { id: string; settings: unknown }[] {
  return listModifierSchemas()
    .map((entry) => ({ id: entry.id, settings: entry.get(settings) }))
    .filter((m) => m.settings.enabled);
}

/** True when a parsed section is switched on. */
export function isSectionEnabled(section: unknown): boolean {
  return isPlainObject(section) && section.enabled === true;
}

/** Zod transform for `settings.modifiers`: validates against the registry and fills absent sections. */
export function parseModifierSections(raw: Record<string, unknown>, ctx: z.RefinementCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [id, value] of Object.entries(raw)) {
    const entry = registry.get(id);
    if (!entry) {
      ctx.addIssue({ code: 'custom', path: [id], message: 'unknown modifier (not registered)', continue: true });
      continue;
    }
    const result = entry.schema.safeParse(value, { error: settingsErrorMap });
    if (!result.success) {
      // continue: the cross-section rules still run, so a host sees every problem at once.
      for (const issue of result.error.issues) ctx.addIssue({ ...issue, path: [id, ...issue.path], continue: true });
      continue;
    }
    out[id] = result.data;
  }
  for (const entry of registry.values()) {
    if (!Object.hasOwn(raw, entry.id)) out[entry.id] = entry.defaults();
  }
  return out;
}

import { isPlainObject, joinPath, mergeDeep, setOwn, type JsonObject } from './json';
import { parseSettings } from './parse';
import type { TableSettings } from './schema';

/** One changed leaf. `from` is undefined for an added value, `to` for a removed one. */
export interface SettingsChange {
  path: string;
  from: unknown;
  to: unknown;
}

/** Objects merge key by key; arrays (blind levels, rotation steps) are replaced whole. */
export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

/** A host edit: any subset of the settings. */
export type SettingsPatch = DeepPartial<TableSettings>;

export interface SettingsUpdate {
  settings: TableSettings;
  /** What changed, for the change log (with who made it, which the runtime adds). */
  diff: SettingsChange[];
}

/**
 * Fields that may change in the middle of a hand, because they cannot alter
 * the hand in progress: its cards, bets, clocks, who is dealt in, or what
 * anyone can see of it. Everything else waits for the next hand. Entries are
 * path prefixes; none of them may take part in a rule with a next-hand field.
 * Spectator card visibility and delay wait, so a hand is watched under the
 * rules it started with.
 */
export const IMMEDIATE_FIELDS = [
  'table.name',
  'chat',
  'spectators.allowed',
  'seating.requireApproval',
  'seating.allowRebuys',
  'seating.rebuyRequiresApproval',
  'seating.minBuyIn',
  'seating.maxBuyIn',
  'seating.ratholeMinutes',
  'seating.waitlist',
] as const;

export function isImmediateField(path: string): boolean {
  return IMMEDIATE_FIELDS.some((f) => path === f || path.startsWith(`${f}.`) || path.startsWith(`${f}[`));
}

/** Leaf-level differences from `a` to `b`, in a's key order then b's new keys. Array items compare by index. */
export function diffSettings(a: TableSettings, b: TableSettings): SettingsChange[] {
  const out: SettingsChange[] = [];
  diffValue(a, b, '', out);
  return out;
}

function diffValue(a: unknown, b: unknown, path: string, out: SettingsChange[]): void {
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = [...Object.keys(a), ...Object.keys(b).filter((k) => !Object.hasOwn(a, k))];
    for (const key of keys) {
      diffValue(Object.hasOwn(a, key) ? a[key] : undefined, Object.hasOwn(b, key) ? b[key] : undefined, joinPath(path, key), out);
    }
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) diffValue(a[i], b[i], joinPath(path, i), out);
    return;
  }
  if (!Object.is(a, b)) out.push({ path, from: a, to: b });
}

/** Combines two queued edits; the later one wins where they overlap. */
export function mergePatches(earlier: SettingsPatch, later: SettingsPatch): SettingsPatch {
  return mergeDeep(earlier, later) as SettingsPatch;
}

/**
 * Applies the queued edit between hands: merges it onto the current settings,
 * validates the result (throws SettingsError) and returns it with the diff.
 * A null edit is a no-op.
 */
export function applyAtNextHand(current: TableSettings, pending: SettingsPatch | null): SettingsUpdate {
  if (pending === null) return { settings: current, diff: [] };
  const settings = parseSettings(mergeDeep(current, pending));
  return { settings, diff: diffSettings(current, settings) };
}

/**
 * Applies the IMMEDIATE_FIELDS part of an edit now and returns the rest to
 * queue for the next hand (null when nothing is left). The whole edit is
 * validated first, so a bad edit is rejected before any of it applies. When an
 * edit is already queued, pass mergePatches(queued, edit) so the combination
 * is what gets validated, and replace the queue with `deferred`.
 */
export function applyImmediate(
  current: TableSettings,
  pending: SettingsPatch | null,
): SettingsUpdate & { deferred: SettingsPatch | null } {
  if (pending === null) return { settings: current, diff: [], deferred: null };
  const target = parseSettings(mergeDeep(current, pending));
  const { now, later } = splitPatch(pending as JsonObject, '');
  const settings = parseSettings(mergeDeep(current, now));
  const deferred = diffSettings(settings, target).length > 0 ? (later as SettingsPatch) : null;
  return { settings, diff: diffSettings(current, settings), deferred };
}

function splitPatch(patch: JsonObject, path: string): { now: JsonObject; later: JsonObject } {
  const now: JsonObject = {};
  const later: JsonObject = {};
  for (const key of Object.keys(patch)) {
    const value = patch[key];
    const p = joinPath(path, key);
    if (isImmediateField(p)) {
      setOwn(now, key, value);
    } else if (isPlainObject(value) && IMMEDIATE_FIELDS.some((f) => f.startsWith(`${p}.`))) {
      const inner = splitPatch(value, p);
      if (Object.keys(inner.now).length > 0) setOwn(now, key, inner.now);
      if (Object.keys(inner.later).length > 0) setOwn(later, key, inner.later);
    } else {
      setOwn(later, key, value);
    }
  }
  return { now, later };
}

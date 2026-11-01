/** Small helpers for the plain JSON values settings are made of. */

export type JsonObject = Record<string, unknown>;

/** True for `{...}` objects (what JSON.parse makes), false for arrays, null and class instances. */
export function isPlainObject(value: unknown): value is JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Sets an own property even for keys such as "__proto__", so a key from
 * untrusted JSON can never reach a prototype; strict schemas then reject it.
 */
export function setOwn(target: JsonObject, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/** Own property or undefined (never an inherited one). */
export function getOwn(source: JsonObject, key: string): unknown {
  return Object.hasOwn(source, key) ? source[key] : undefined;
}

/** Deep copy, so defaults, patches and results never share arrays or objects. */
export function cloneJson<T>(value: T): T {
  if (Array.isArray(value)) return value.map(cloneJson) as T;
  if (isPlainObject(value)) {
    const out: JsonObject = {};
    for (const key of Object.keys(value)) setOwn(out, key, cloneJson(value[key]));
    return out as T;
  }
  return value;
}

/** Deep merge: objects merge key by key, anything else (arrays included) replaces. Undefined leaves the base alone. */
export function mergeDeep(base: unknown, patch: unknown): unknown {
  if (patch === undefined) return cloneJson(base);
  if (!isPlainObject(base) || !isPlainObject(patch)) return cloneJson(patch);
  const out = cloneJson(base);
  for (const key of Object.keys(patch)) {
    const value = patch[key];
    if (value === undefined) continue;
    setOwn(out, key, mergeDeep(getOwn(out, key), value));
  }
  return out;
}

/** Settings paths as errors, diffs and IMMEDIATE_FIELDS print them: "stakes.bigBlind", "blindSchedule.levels[2].ante". */
export function joinPath(base: string, key: string | number): string {
  if (typeof key === 'number') return `${base}[${key}]`;
  return base ? `${base}.${key}` : key;
}

export function formatPath(path: readonly PropertyKey[]): string {
  return path.reduce<string>((acc, key) => joinPath(acc, typeof key === 'symbol' ? String(key) : key), '');
}

import { SettingsError, type SettingsIssue } from '../../src/settings';

/** Copy of `value` with the field at `path` ("stakes.bigBlind", "blindSchedule.levels[0].ante") set. */
export function withField<T>(value: T, path: string, field: unknown): T {
  const copy = structuredClone(value) as Record<string, unknown>;
  const keys = path.replace(/\[(\d+)\]/g, '.$1').split('.');
  let node: Record<string, unknown> = copy;
  for (const key of keys.slice(0, -1)) node = node[key] as Record<string, unknown>;
  const last = keys[keys.length - 1];
  if (field === undefined) delete node[last];
  else node[last] = field;
  return copy as T;
}

/** The issues of the SettingsError `fn` throws; fails if it throws nothing or something else. */
export function issuesOf(fn: () => unknown): SettingsIssue[] {
  try {
    fn();
  } catch (err) {
    if (err instanceof SettingsError) return err.issues;
    throw err;
  }
  throw new Error('expected a SettingsError');
}

export function pathsOf(fn: () => unknown): string[] {
  return issuesOf(fn).map((i) => i.path);
}

import { DrizzleQueryError } from 'drizzle-orm';

export type StorageErrorCode = 'not-found' | 'conflict' | 'invalid';

/** Expected storage failures (missing row, stale version, bad input) that callers turn into user-facing errors. */
export class StorageError extends Error {
  constructor(
    readonly code: StorageErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'StorageError';
  }
}

/**
 * The database's own error behind a failed query. drizzle-orm wraps it in a DrizzleQueryError whose message is the
 * SQL and every parameter (a whole table snapshot, a backup's rows): too long for a log, holding players' data, and
 * without the reason, which is only in `cause`. Anything else comes back as it is.
 */
export function dbCause(err: unknown): unknown {
  return err instanceof DrizzleQueryError && err.cause !== undefined ? err.cause : err;
}

/** An error's message for a log line or an admin, with the database's reason rather than drizzle's wrapper. */
export function errorText(err: unknown): string {
  const e = dbCause(err);
  return e instanceof Error ? e.message : String(e);
}

/** True for Postgres unique_violation, whichever driver raised it (drivers may wrap the error in `cause`). */
export function isUniqueViolation(err: unknown): boolean {
  let e = err;
  for (let depth = 0; depth < 5 && e && typeof e === 'object'; depth++) {
    if ((e as { code?: unknown }).code === '23505') return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/** Throws unless n is a whole number of chips that JavaScript represents exactly. */
export function assertChips(n: unknown, what: string): asserts n is number {
  if (typeof n !== 'number' || !Number.isSafeInteger(n)) {
    throw new StorageError('invalid', `${what} must be a whole number of chips`);
  }
}

/** Page sizes from callers (often from the network) are clamped rather than trusted. */
export function clampLimit(limit: number | undefined, fallback: number, max = 500): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(limit)));
}

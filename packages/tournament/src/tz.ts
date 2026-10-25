// IANA time-zone helpers built on Intl, so the package has no dependencies.

/** A wall-clock date and time in some time zone. Month is 1-12. */
export interface LocalDateTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
// Each formatter holds native memory, and every capitalisation of a zone is its own key.
const MAX_FORMATTERS = 1000;

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    if (formatters.size >= MAX_FORMATTERS) formatters.clear();
    formatters.set(timeZone, f);
  }
  return f;
}

/** How many formatters are cached (for tests). */
export const formatterCacheSize = () => formatters.size;

/** Throws on an unknown time zone name. */
export function assertTimeZone(timeZone: string): void {
  // Not cached: any capitalisation is valid, so caching here would let callers fill the cache.
  new Intl.DateTimeFormat('en-US', { timeZone });
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    assertTimeZone(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** The wall-clock time in `timeZone` at the instant `utcMs`. */
export function toLocal(utcMs: number, timeZone: string): LocalDateTime & { second: number } {
  const parts: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(new Date(utcMs))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

/** Offset of `timeZone` from UTC at `utcMs`, in ms (New York in summer is -4 h). */
export function offsetAt(utcMs: number, timeZone: string): number {
  const l = toLocal(utcMs, timeZone);
  const asUtc = Date.UTC(l.year, l.month - 1, l.day, l.hour, l.minute, l.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/**
 * The instant at which `timeZone` shows the wall-clock time `local`.
 * A time skipped by a spring-forward gap resolves to the same instant as one
 * hour later (02:30 becomes 03:30). An ambiguous fall-back time resolves to
 * the first of the two instants.
 */
export function fromLocal(local: LocalDateTime, timeZone: string): number {
  const naive = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  // Try both offsets around the naive instant and keep the earliest that matches.
  const candidates = new Set([offsetAt(naive - 86_400_000, timeZone), offsetAt(naive + 86_400_000, timeZone)]);
  const matches: number[] = [];
  for (const off of candidates) {
    const utc = naive - off;
    if (offsetAt(utc, timeZone) === off) matches.push(utc);
  }
  if (matches.length) return Math.min(...matches);
  // In a gap: use the offset in force before the gap, which lands after it.
  return naive - offsetAt(naive - 86_400_000, timeZone);
}

/** Day of week, 0 = Sunday, for a calendar date (time-zone independent). */
export function weekdayOf(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Adds days to a calendar date. */
export function addDays(year: number, month: number, day: number, days: number) {
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

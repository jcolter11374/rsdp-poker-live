// Recurring tournament schedules (TRN-06): daily, weekly on chosen weekdays,
// or monthly by day of month or by nth / last weekday. Occurrences keep the
// same local time across daylight-saving changes.

import { addDays, daysInMonth, fromLocal, isValidTimeZone, toLocal, weekdayOf } from './tz';

/** 0 = Sunday ... 6 = Saturday. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type RecurrenceRule =
  | { freq: 'daily'; interval?: number }
  | { freq: 'weekly'; interval?: number; weekdays: Weekday[] }
  | { freq: 'monthly'; interval?: number; monthDay: number }
  /** nth weekday of the month; nth = -1 means the last one. */
  | { freq: 'monthly'; interval?: number; nth: 1 | 2 | 3 | 4 | -1; weekday: Weekday };

export interface Schedule {
  /** IANA time zone, e.g. "America/Los_Angeles". */
  timeZone: string;
  /** First occurrence, as a local date "YYYY-MM-DD". */
  startDate: string;
  /** Local start time "HH:MM" (24 h). */
  time: string;
  /** Omitted or null: does not repeat. */
  repeat?: RecurrenceRule | null;
  /** Last local date "YYYY-MM-DD" an occurrence may fall on (inclusive). */
  until?: string;
}

const RRULE_DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

function parseDate(s: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new Error(`Invalid date "${s}", expected YYYY-MM-DD`);
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) throw new Error(`Invalid date "${s}"`);
  return { year, month, day };
}

function parseTime(s: string) {
  const m = /^(\d{2}):(\d{2})$/.exec(s);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`Invalid time "${s}", expected HH:MM`);
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

const dateKey = (d: { year: number; month: number; day: number }) => d.year * 10000 + d.month * 100 + d.day;

/** Returns a list of problems; empty means the schedule is valid. */
export function validateSchedule(s: Schedule): string[] {
  const errors: string[] = [];
  if (typeof s.timeZone !== 'string' || !isValidTimeZone(s.timeZone)) errors.push(`Unknown time zone "${s.timeZone}"`);
  for (const [label, fn] of [
    ['startDate', () => parseDate(s.startDate)],
    ['time', () => parseTime(s.time)],
    ['until', () => s.until !== undefined && parseDate(s.until)],
  ] as const) {
    try {
      fn();
    } catch (e) {
      errors.push(`${label}: ${(e as Error).message}`);
    }
  }
  const r = s.repeat;
  if (r) {
    if (!['daily', 'weekly', 'monthly'].includes(r.freq)) errors.push('Repeat must be daily, weekly or monthly');
    if (r.interval !== undefined && (!Number.isInteger(r.interval) || r.interval < 1 || r.interval > 365))
      errors.push('interval must be a whole number from 1 to 365');
    if (r.freq === 'weekly') {
      if (!Array.isArray(r.weekdays) || !r.weekdays.length) errors.push('Pick at least one weekday');
      else if (r.weekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) errors.push('Weekdays must be 0-6');
    }
    if (r.freq === 'monthly' && 'monthDay' in r && (!Number.isInteger(r.monthDay) || r.monthDay < 1 || r.monthDay > 31))
      errors.push('monthDay must be 1-31');
    if (r.freq === 'monthly' && 'nth' in r && ![1, 2, 3, 4, -1].includes(r.nth)) errors.push('nth must be 1-4 or -1');
    if (r.freq === 'monthly' && 'nth' in r && !(Number.isInteger(r.weekday) && r.weekday >= 0 && r.weekday <= 6)) errors.push('Weekdays must be 0-6');
    if (r.freq === 'monthly' && !('monthDay' in r) && !('nth' in r)) errors.push('Pick a day of the month');
  }
  if (!errors.length && s.until && dateKey(parseDate(s.until)) < dateKey(parseDate(s.startDate)))
    errors.push('until is before startDate');
  return errors;
}

/** Whether the rule fires on a local calendar date, given the series' first date. */
function matches(rule: RecurrenceRule, first: { year: number; month: number; day: number }, d: { year: number; month: number; day: number }): boolean {
  const interval = rule.interval ?? 1;
  const dayIndex = (x: typeof d) => Math.round(Date.UTC(x.year, x.month - 1, x.day) / 86_400_000);
  switch (rule.freq) {
    case 'daily':
      return (dayIndex(d) - dayIndex(first)) % interval === 0;
    case 'weekly': {
      if (!rule.weekdays.includes(weekdayOf(d.year, d.month, d.day) as Weekday)) return false;
      // Weeks counted from the Sunday on or before the first date.
      const weekStart = (x: typeof d) => dayIndex(x) - weekdayOf(x.year, x.month, x.day);
      return ((weekStart(d) - weekStart(first)) / 7) % interval === 0;
    }
    case 'monthly': {
      const months = (d.year - first.year) * 12 + (d.month - first.month);
      if (months % interval !== 0) return false;
      if ('monthDay' in rule) {
        // A 31st falls back to the month's last day, so short months still get a game.
        return d.day === Math.min(rule.monthDay, daysInMonth(d.year, d.month));
      }
      if (weekdayOf(d.year, d.month, d.day) !== rule.weekday) return false;
      if (rule.nth === -1) return d.day + 7 > daysInMonth(d.year, d.month);
      return Math.ceil(d.day / 7) === rule.nth;
    }
  }
}

/**
 * The first occurrence that starts strictly after `afterMs` (UTC epoch ms),
 * or null when the series has ended. A non-repeating schedule has exactly one
 * occurrence, at startDate + time.
 */
export function nextOccurrence(s: Schedule, afterMs: number): number | null {
  const errors = validateSchedule(s);
  if (errors.length) throw new Error(errors.join('; '));
  const first = parseDate(s.startDate);
  const { hour, minute } = parseTime(s.time);
  const until = s.until ? dateKey(parseDate(s.until)) : Infinity;
  const at = (d: typeof first) => fromLocal({ ...d, hour, minute }, s.timeZone);

  if (!s.repeat) {
    const t = at(first);
    return t > afterMs ? t : null;
  }

  // Start scanning from whichever is later: the first date or the local date of afterMs (minus a day for safety).
  const localAfter = toLocal(afterMs, s.timeZone);
  let d = dateKey(localAfter) > dateKey(first) ? addDays(localAfter.year, localAfter.month, localAfter.day, -1) : first;
  if (dateKey(d) < dateKey(first)) d = first;
  // Monthly with interval up to 365 can need a long scan; cap at ~30 years.
  for (let i = 0; i < 366 * 30; i++, d = addDays(d.year, d.month, d.day, 1)) {
    if (dateKey(d) > until) return null;
    if (!matches(s.repeat, first, d)) continue;
    const t = at(d);
    if (t > afterMs) return t;
  }
  return null;
}

/** Up to `limit` upcoming occurrences after `afterMs`, for previews. */
export function upcomingOccurrences(s: Schedule, afterMs: number, limit: number): number[] {
  const out: number[] = [];
  let t = afterMs;
  while (out.length < limit) {
    const next = nextOccurrence(s, t);
    if (next === null) break;
    out.push(next);
    t = next;
  }
  return out;
}

/** The schedule as an iCalendar DTSTART + RRULE pair, for storage or export. */
export function toRRule(s: Schedule): string {
  const { year, month, day } = parseDate(s.startDate);
  const { hour, minute } = parseTime(s.time);
  const p2 = (n: number) => String(n).padStart(2, '0');
  const dtstart = `DTSTART;TZID=${s.timeZone}:${year}${p2(month)}${p2(day)}T${p2(hour)}${p2(minute)}00`;
  const r = s.repeat;
  if (!r) return dtstart;
  const parts = [`FREQ=${r.freq.toUpperCase()}`];
  if (r.interval && r.interval > 1) parts.push(`INTERVAL=${r.interval}`);
  if (r.freq === 'weekly') parts.push(`BYDAY=${[...r.weekdays].sort().map((d) => RRULE_DAYS[d]).join(',')}`);
  if (r.freq === 'monthly' && 'monthDay' in r) {
    // RFC 5545 skips months without the day. Adding -1 with BYSETPOS=1 picks the
    // earlier of the day and the month's last day, matching our fall-back.
    parts.push(r.monthDay > 28 ? `BYMONTHDAY=${r.monthDay},-1;BYSETPOS=1` : `BYMONTHDAY=${r.monthDay}`);
  }
  if (r.freq === 'monthly' && 'nth' in r) parts.push(`BYDAY=${r.nth}${RRULE_DAYS[r.weekday]}`);
  if (s.until) {
    const u = parseDate(s.until);
    parts.push(`UNTIL=${u.year}${p2(u.month)}${p2(u.day)}T235959`);
  }
  return `${dtstart}\nRRULE:${parts.join(';')}`;
}

/**
 * Settings copied from an older tournament (TRN-07): if the copied start has
 * already passed, move it to the same local time on the next day that is in
 * the future.
 */
export function rollForwardStart(s: Pick<Schedule, 'timeZone' | 'startDate' | 'time'>, nowMs: number): string {
  let d = parseDate(s.startDate);
  const { hour, minute } = parseTime(s.time);
  while (fromLocal({ ...d, hour, minute }, s.timeZone) <= nowMs) {
    const local = toLocal(nowMs, s.timeZone);
    d = dateKey(d) < dateKey(local) ? local : addDays(d.year, d.month, d.day, 1);
  }
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${d.year}-${p2(d.month)}-${p2(d.day)}`;
}

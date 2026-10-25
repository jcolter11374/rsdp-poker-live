import { describe, expect, it } from 'vitest';
import { fromLocal, nextOccurrence, rollForwardStart, toLocal, toRRule, upcomingOccurrences, validateSchedule, type Schedule } from '../src';

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const NY = 'America/New_York';

describe('time zones', () => {
  it('converts wall time to UTC on both sides of a DST change', () => {
    expect(iso(fromLocal({ year: 2026, month: 10, day: 29, hour: 19, minute: 30 }, NY))).toBe('2026-10-29T23:30:00.000Z');
    expect(iso(fromLocal({ year: 2026, month: 11, day: 5, hour: 19, minute: 30 }, NY))).toBe('2026-11-06T00:30:00.000Z');
  });

  it('moves a time skipped by spring-forward one hour later', () => {
    expect(iso(fromLocal({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, NY))).toBe('2026-03-08T07:30:00.000Z');
  });

  it('picks the first of two repeated fall-back times', () => {
    expect(iso(fromLocal({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, NY))).toBe('2026-11-01T05:30:00.000Z');
  });

  it('reads local time back', () => {
    expect(toLocal(Date.UTC(2026, 6, 1, 12), 'Europe/London')).toMatchObject({ hour: 13, day: 1, month: 7 });
  });
});

describe('recurrence', () => {
  const weekly: Schedule = { timeZone: NY, startDate: '2026-10-29', time: '19:30', repeat: { freq: 'weekly', weekdays: [4] } };

  it('keeps the same local time across DST', () => {
    const list = upcomingOccurrences(weekly, Date.UTC(2026, 9, 1), 3).map(iso);
    expect(list).toEqual(['2026-10-29T23:30:00.000Z', '2026-11-06T00:30:00.000Z', '2026-11-13T00:30:00.000Z']);
  });

  it('finds the next occurrence strictly after a time', () => {
    const first = Date.parse('2026-10-29T23:30:00Z');
    expect(iso(nextOccurrence(weekly, first))).toBe('2026-11-06T00:30:00.000Z');
    expect(iso(nextOccurrence(weekly, first - 1))).toBe('2026-10-29T23:30:00.000Z');
  });

  it('supports several weekdays and an interval', () => {
    const s: Schedule = { timeZone: 'UTC', startDate: '2026-10-26', time: '20:00', repeat: { freq: 'weekly', weekdays: [1, 5], interval: 2 } };
    const days = upcomingOccurrences(s, 0, 4).map((t) => iso(t)!.slice(0, 10));
    expect(days).toEqual(['2026-10-26', '2026-10-30', '2026-11-09', '2026-11-13']);
  });

  it('daily with an end date', () => {
    const s: Schedule = { timeZone: 'UTC', startDate: '2026-10-25', time: '09:00', repeat: { freq: 'daily' }, until: '2026-10-27' };
    expect(upcomingOccurrences(s, 0, 10)).toHaveLength(3);
  });

  it('monthly on the 31st falls back to the last day', () => {
    const s: Schedule = { timeZone: 'UTC', startDate: '2026-10-31', time: '18:00', repeat: { freq: 'monthly', monthDay: 31 } };
    const days = upcomingOccurrences(s, 0, 3).map((t) => iso(t)!.slice(0, 10));
    expect(days).toEqual(['2026-10-31', '2026-11-30', '2026-12-31']);
  });

  it('monthly on the last Friday and the 2nd Tuesday', () => {
    const last: Schedule = { timeZone: 'UTC', startDate: '2026-10-01', time: '18:00', repeat: { freq: 'monthly', nth: -1, weekday: 5 } };
    expect(upcomingOccurrences(last, 0, 2).map((t) => iso(t)!.slice(0, 10))).toEqual(['2026-10-30', '2026-11-27']);
    const second: Schedule = { timeZone: 'UTC', startDate: '2026-10-01', time: '18:00', repeat: { freq: 'monthly', nth: 2, weekday: 2 } };
    expect(upcomingOccurrences(second, 0, 2).map((t) => iso(t)!.slice(0, 10))).toEqual(['2026-10-13', '2026-11-10']);
  });

  it('a one-off has a single occurrence', () => {
    const s: Schedule = { timeZone: NY, startDate: '2026-10-29', time: '19:30' };
    expect(upcomingOccurrences(s, 0, 5)).toHaveLength(1);
  });

  it('validates', () => {
    expect(validateSchedule({ timeZone: 'Mars/Base', startDate: '2026-02-30', time: '25:00', repeat: { freq: 'weekly', weekdays: [] } })).toHaveLength(4);
    expect(validateSchedule(weekly)).toEqual([]);
  });

  it('exports RRULE', () => {
    expect(toRRule(weekly)).toBe('DTSTART;TZID=America/New_York:20261029T193000\nRRULE:FREQ=WEEKLY;BYDAY=TH');
    expect(toRRule({ timeZone: 'UTC', startDate: '2026-10-01', time: '18:00', repeat: { freq: 'monthly', nth: -1, weekday: 5 } })).toContain('BYDAY=-1FR');
  });

  it('rolls a copied start that has passed to the next day', () => {
    const now = Date.parse('2026-10-25T12:00:00Z');
    expect(rollForwardStart({ timeZone: 'UTC', startDate: '2026-09-01', time: '18:00' }, now)).toBe('2026-10-25');
    expect(rollForwardStart({ timeZone: 'UTC', startDate: '2026-09-01', time: '09:00' }, now)).toBe('2026-10-26');
    expect(rollForwardStart({ timeZone: 'UTC', startDate: '2026-12-01', time: '09:00' }, now)).toBe('2026-12-01');
  });
});

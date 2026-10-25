// Copy settings from another tournament (TRN-07). Every field is kept as it
// was; only a start time that has passed moves forward.

import { nextOccurrence, rollForwardStart } from './recurrence';
import type { TournamentSettings } from './types';

/**
 * The settings for a new event made from `source`. A one-off scheduled start
 * that has passed moves to the same local time on the next day still to come;
 * a series starts at its next occurrence. A start with no schedule moves by
 * whole days.
 */
export function copySettings(source: TournamentSettings, now: number): TournamentSettings {
  const out = structuredClone(source);
  const start = out.start;
  if (start.kind !== 'scheduled') return out;
  if (start.schedule) {
    const schedule = start.schedule;
    let next = schedule.repeat ? nextOccurrence(schedule, now) : null;
    if (next === null) {
      // A one-off, or a series that has ended: one event, on the next day still to come.
      delete schedule.repeat;
      delete schedule.until;
      schedule.startDate = rollForwardStart(schedule, now);
      next = nextOccurrence(schedule, now);
    }
    start.startAt = next ?? start.startAt;
  } else if (start.startAt <= now) {
    const day = 24 * 3600_000;
    start.startAt += Math.ceil((now - start.startAt + 1) / day) * day;
  }
  return out;
}

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
    if (!start.schedule.repeat) start.schedule.startDate = rollForwardStart(start.schedule, now);
    start.startAt = nextOccurrence(start.schedule, now) ?? start.startAt;
  } else if (start.startAt <= now) {
    const day = 24 * 3600_000;
    start.startAt += Math.ceil((now - start.startAt + 1) / day) * day;
  }
  return out;
}

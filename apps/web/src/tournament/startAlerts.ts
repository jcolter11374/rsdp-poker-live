import type { TournamentListing } from '@rsdp/tournament';

/** "Starting soon" goes out this long before the start. */
export const START_LEAD_MS = 5 * 60_000;
/** The player's events that are due a "starting soon" alert now and have not had one. */
export function startAlertsDue(list: TournamentListing[], now: number, fired: ReadonlySet<string>): TournamentListing[] {
  return list.filter(
    (t) =>
      t.me.alive &&
      (t.status === 'registering' || t.status === 'seating') &&
      t.startAt !== null &&
      t.startAt > now &&
      t.startAt - now <= START_LEAD_MS &&
      !fired.has(startKey(t)),
  );
}

/** One alert per start time: a host who moves the start gets the player a fresh one. */
export const startKey = (t: TournamentListing) => `start:${t.id}:${t.startAt}`;


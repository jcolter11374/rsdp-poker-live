import type { TournamentListing } from '@rsdp/tournament';

/** "Starting soon" goes out this long before the start. */
export const START_LEAD_MS = 5 * 60_000;
/**
 * The player's events that are due a "starting soon" alert now and have not had one. Not those on screen in some tab
 * (`onScreen`: its lobby or one of its tables, which already count down); they stay due, so the alert still comes if
 * the player looks away before the start.
 */
export function startAlertsDue(list: TournamentListing[], now: number, fired: ReadonlySet<string>, onScreen: ReadonlySet<string> = new Set()): TournamentListing[] {
  return list.filter(
    (t) =>
      !onScreen.has(t.id) &&
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


/** How long a tab's note that it has an event on screen holds that event's alert back in the site's other tabs: two checks. */
export const ON_SCREEN_FOR_MS = 35_000;

/** The event a page of the site shows: its lobby, or one of its tables (`tournamentOf` names a table's event). */
export function eventOnPage(path: string, tournamentOf: (table: string) => string | null): string | null {
  const lobby = /^\/tn\/([\w-]+)$/.exec(path)?.[1];
  if (lobby) return lobby === 'new' ? null : lobby;
  const table = /^\/t\/([\w-]+)$/.exec(path)?.[1];
  return table ? tournamentOf(table) : null;
}

/** Events some tab of this browser has on screen, from the note each tab leaves (event id, and when it last had it). */
export function onScreenNow(notes: Record<string, number>, now: number): Set<string> {
  return new Set(Object.entries(notes).flatMap(([id, at]) => (now - at < ON_SCREEN_FOR_MS && at <= now + 1000 ? [id] : [])));
}

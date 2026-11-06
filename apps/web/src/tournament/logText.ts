import type { LobbyItem, LogEvent, TournamentSettings } from '@rsdp/tournament';
import { blinds, gameName, money, ordinal } from './format';

const chips = (n: number) => n.toLocaleString();

/** What each setting is called in the activity log. A new setting fails to compile until it has a name here. */
const SETTING_NAMES: Record<keyof TournamentSettings, string> = {
  name: 'name',
  start: 'start time',
  games: 'games',
  gameBetting: 'games',
  stopRotationAtLevel: 'game rotation',
  structure: 'blind levels',
  startingStack: 'starting stack',
  seatsPerTable: 'seats per table',
  maxEntrants: 'max players',
  seatLeadSeconds: 'seating time',
  graceMinutes: 'grace period',
  registrationApproval: 'registration approval',
  lateRegistration: 'late registration',
  reEntry: 're-entry',
  rebuy: 'rebuys',
  addOn: 'add-ons',
  allowQuit: 'leaving early',
  payouts: 'payouts',
  handForHand: 'hand-for-hand',
  bounty: 'bounties',
  invites: 'invite codes',
  checkIn: 'check-in',
  season: 'season',
  tableRules: 'table rules',
};

/** The names of these settings, each once; a setting this tab doesn't know (from a newer server) is skipped. */
function settingNames(keys: readonly string[] | undefined): string[] {
  const known = (keys ?? []).filter((k): k is keyof TournamentSettings => Object.hasOwn(SETTING_NAMES, k));
  return [...new Set(known.map((k) => SETTING_NAMES[k]))];
}

/** Takes only an event no case names. An older open tab can still be sent a kind it doesn't know, and shows nothing for it. */
const unknownKind = (_e: never): string => '';

/** One line of the lobby's activity log, or '' for an event this tab can't describe (left out of the list). */
export function logText(e: LogEvent): string {
  switch (e.type) {
    case 'registered':
      return e.entryNo > 1 ? `${e.name} re-entered` : `${e.name} registered${e.late ? ' (late)' : ''}`;
    case 'unregistered':
      return e.notCheckedIn ? `${e.name} didn't check in and lost their seat` : `${e.name} unregistered`;
    case 'bountyWon':
      return `${e.name} collected ${e.from}'s bounty${e.cash ? ` (${money(e.cash)})` : ''}`;
    case 'started':
      return 'Cards in the air. The tournament has started.';
    case 'startDelayed':
      return 'Waiting for a second player before starting';
    case 'levelUp':
      return `Level ${e.levelNumber}: ${blinds(e)}${e.gameId ? ` · ${gameName(e.gameId, e.betting)}` : ''}`;
    case 'breakStarted':
      return `${e.minutes}-minute break${e.addOn ? ' · add-ons open' : ''}`;
    case 'breakEnded':
      return 'Break over';
    case 'lateRegistrationClosed':
      return 'Late registration closed';
    case 'rebuysClosed':
      return 'Rebuys closed';
    case 'reEntryClosed':
      return 'Re-entry closed';
    case 'chipsAdded':
      return `${e.name} ${e.reason === 'rebuy' ? 'rebought' : 'took the add-on'} for ${chips(e.chips)}`;
    case 'eliminated': {
      const how = e.reason === 'quit' ? 'left' : e.reason === 'removed' ? 'was removed' : 'busted';
      const by = e.reason === 'busted' && e.by.length ? ` by ${e.by.join(' and ')}` : '';
      return `${e.name} ${how} in ${ordinal(e.place)}${by}`;
    }
    case 'tableBroken':
      return 'A table broke; players moved to fill seats';
    case 'handForHand':
      return e.active ? 'Hand-for-hand on the bubble' : 'Hand-for-hand over';
    case 'paused':
      return 'The host paused the tournament';
    case 'resumed':
      return 'The tournament resumed';
    case 'structureEdited':
      return 'The host changed the blind levels';
    case 'settingsUpdated': {
      const names = settingNames(e.changed);
      return `The host changed the tournament settings${names.length ? `: ${names.join(', ')}` : ''}`;
    }
    case 'finished':
      return e.winner ? `🏆 ${e.winner} wins the tournament` : 'The tournament is over';
    case 'cancelled':
      return e.reason === 'host' ? 'The host cancelled the tournament' : 'Cancelled: not enough players';
    case 'stackSet':
      return `The host set ${e.name}'s stack to ${chips(e.stack)} (was ${chips(e.previous)})`;
    case 'seatsSwapped':
      return `The host swapped the seats of ${e.names.join(' and ')}`;
    case 'seatMoved':
      return `The host moved ${e.name} to another seat`;
    case 'coHostsChanged':
      return 'The host changed the co-hosts';
    case 'hostChanged':
      return `${e.name} is now the host`;
    case 'archived':
      return 'The tournament was archived';
  }
  // Every kind is named above, so a new kind fails to compile here until it has a line (or a reason not to).
  return unknownKind(e);
}

/** Settings changes this close together, with nothing else shown between them, make one line. */
export const SETTINGS_RUN_MS = 5 * 60_000;

/** One entry of the Activity list. */
export interface ActivityLine {
  id: string;
  at: number;
  text: string;
}

/**
 * The Activity list, newest first: every event this tab can describe. A run of settings changes close together
 * (a host flicking through the switches) makes one line, at the time of the last change, naming every setting in it.
 */
export function activityLines(items: readonly LobbyItem[]): ActivityLine[] {
  const shown: { id: string; at: number; event: LogEvent }[] = [];
  for (const x of items) {
    if (x.kind !== 'event' || !logText(x.event)) continue;
    const last = shown.at(-1);
    if (x.event.type === 'settingsUpdated' && last?.event.type === 'settingsUpdated' && x.at - last.at <= SETTINGS_RUN_MS) {
      // Without the names on either side, the line can't say which settings changed.
      const a = last.event.changed ?? [];
      const b = x.event.changed ?? [];
      shown[shown.length - 1] = { id: last.id, at: x.at, event: { type: 'settingsUpdated', changed: a.length && b.length ? [...new Set([...a, ...b])] : [] } };
      continue;
    }
    shown.push({ id: x.id, at: x.at, event: x.event });
  }
  return shown.map((x) => ({ id: x.id, at: x.at, text: logText(x.event) })).reverse();
}

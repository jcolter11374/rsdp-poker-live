import { describe, expect, it } from 'vitest';
import type { LobbyItem, LogEvent } from '@rsdp/tournament';
import { activityLines, logText, SETTINGS_RUN_MS } from './logText';

describe('activity lines', () => {
  it('reads like sentences', () => {
    expect(logText({ type: 'eliminated', name: 'Ana', place: 3, by: ['Bo', 'Cy'], reason: 'busted' })).toBe('Ana busted in 3rd by Bo and Cy');
    expect(logText({ type: 'eliminated', name: 'Ana', place: 7, by: [], reason: 'quit' })).toBe('Ana left in 7th');
    expect(logText({ type: 'registered', name: 'Ana', late: true, entryNo: 1 })).toBe('Ana registered (late)');
    expect(logText({ type: 'registered', name: 'Ana', late: true, entryNo: 2 })).toBe('Ana re-entered');
    expect(logText({ type: 'chipsAdded', name: 'Ana', chips: 5000, reason: 'rebuy' })).toBe('Ana rebought for 5,000');
  });
});

/** One of every kind of log event: a new kind fails to compile here until it has a sample. */
type OneOfEach = { [K in LogEvent['type']]: Extract<LogEvent, { type: K }> };
const ALL: OneOfEach = {
  registered: { type: 'registered', name: 'Ana', late: false, entryNo: 1 },
  unregistered: { type: 'unregistered', name: 'Ana' },
  bountyWon: { type: 'bountyWon', name: 'Ana', from: 'Bo', cash: 500 },
  started: { type: 'started' },
  startDelayed: { type: 'startDelayed', graceUntil: 0 },
  levelUp: { type: 'levelUp', levelNumber: 2, sb: 50, bb: 100, ante: 0, anteType: 'none', gameId: 'nlhe' },
  breakStarted: { type: 'breakStarted', minutes: 5, addOn: true },
  breakEnded: { type: 'breakEnded' },
  lateRegistrationClosed: { type: 'lateRegistrationClosed' },
  rebuysClosed: { type: 'rebuysClosed' },
  reEntryClosed: { type: 'reEntryClosed' },
  chipsAdded: { type: 'chipsAdded', name: 'Ana', chips: 100, reason: 'add-on' },
  eliminated: { type: 'eliminated', name: 'Ana', place: 2, by: ['Bo'], reason: 'busted' },
  tableBroken: { type: 'tableBroken' },
  handForHand: { type: 'handForHand', active: true },
  paused: { type: 'paused' },
  resumed: { type: 'resumed' },
  structureEdited: { type: 'structureEdited' },
  settingsUpdated: { type: 'settingsUpdated', changed: ['reEntry'] },
  finished: { type: 'finished', winner: 'Ana' },
  cancelled: { type: 'cancelled', reason: 'not-enough-players' },
  stackSet: { type: 'stackSet', name: 'Ana', stack: 50, previous: 100 },
  seatsSwapped: { type: 'seatsSwapped', names: ['Ana', 'Bo'] },
  seatMoved: { type: 'seatMoved', name: 'Ana' },
  coHostsChanged: { type: 'coHostsChanged' },
  hostChanged: { type: 'hostChanged', name: 'Ana' },
  archived: { type: 'archived' },
};

describe('every kind of log event', () => {
  it('has a line of its own', () => {
    const lines = Object.values(ALL).map((e) => logText(e));
    expect(lines.filter((x) => !x)).toEqual([]);
    expect(new Set(lines).size).toBe(lines.length);
  });

  it('shows nothing for a kind this tab is too old to know', () => {
    expect(logText({ type: 'somethingNew', name: 'Ana' } as unknown as LogEvent)).toBe('');
  });
});

describe('host settings changes', () => {
  const settings = (changed: string[]) => logText({ type: 'settingsUpdated', changed } as LogEvent);

  it('say which settings changed, each once', () => {
    expect(settings(['lateRegistration'])).toBe('The host changed the tournament settings: late registration');
    expect(settings(['reEntry', 'handForHand', 'tableRules'])).toBe('The host changed the tournament settings: re-entry, hand-for-hand, table rules');
    expect(settings(['games', 'gameBetting'])).toBe('The host changed the tournament settings: games');
    // The two invite switches, not new codes: making codes isn't shown.
    expect(settings(['invites'])).toBe('The host changed the tournament settings: invite code rules');
  });

  it('fall back to a plain line for settings this tab does not know', () => {
    expect(settings([])).toBe('The host changed the tournament settings');
    expect(settings(['fromANewerServer'])).toBe('The host changed the tournament settings');
    expect(settings(['fromANewerServer', 'allowQuit'])).toBe('The host changed the tournament settings: leaving early');
    expect(logText({ type: 'settingsUpdated' } as LogEvent)).toBe('The host changed the tournament settings');
  });
});

describe('the Activity list', () => {
  const T = Date.parse('2026-11-06T20:00:00Z');
  const MIN = 60_000;
  let n = 0;
  const ev = (at: number, event: LogEvent): LobbyItem => ({ id: `i${n++}`, at, kind: 'event', event });
  const set = (at: number, ...changed: Extract<LogEvent, { type: 'settingsUpdated' }>['changed']) => ev(at, { type: 'settingsUpdated', changed });
  const chat = (at: number): LobbyItem => ({ id: `i${n++}`, at, kind: 'chat', playerId: 'p', name: 'Ana', text: 'hi' });

  it('is newest first, without chat or kinds this tab cannot describe', () => {
    const items = [ev(T, { type: 'started' }), chat(T + 1), ev(T + 2, { type: 'somethingNew' } as unknown as LogEvent), ev(T + 3, { type: 'paused' })];
    expect(activityLines(items).map((x) => x.text)).toEqual(['The host paused the tournament', 'Cards in the air. The tournament has started.']);
  });

  it('makes one line of settings changes close together, at the time of the last', () => {
    const items = [set(T, 'lateRegistration'), chat(T + MIN), set(T + 2 * MIN, 'reEntry'), set(T + 6 * MIN, 'lateRegistration', 'handForHand')];
    const lines = activityLines(items);
    expect(lines).toEqual([{ id: items[0].id, at: T + 6 * MIN, text: 'The host changed the tournament settings: late registration, re-entry, hand-for-hand' }]);
  });

  it('keeps settings changes apart when something else happened between them, or they are far apart', () => {
    const items = [set(T, 'lateRegistration'), ev(T + MIN, { type: 'registered', name: 'Ana', late: false, entryNo: 1 }), set(T + 2 * MIN, 'reEntry'), set(T + 2 * MIN + SETTINGS_RUN_MS + 1, 'allowQuit')];
    expect(activityLines(items).map((x) => x.text)).toEqual([
      'The host changed the tournament settings: leaving early',
      'The host changed the tournament settings: re-entry',
      'Ana registered',
      'The host changed the tournament settings: late registration',
    ]);
  });

  it('says only that settings changed when a change in the run has no names', () => {
    const items = [set(T, 'lateRegistration'), ev(T + MIN, { type: 'settingsUpdated' } as LogEvent)];
    expect(activityLines(items).map((x) => x.text)).toEqual(['The host changed the tournament settings']);
  });
});

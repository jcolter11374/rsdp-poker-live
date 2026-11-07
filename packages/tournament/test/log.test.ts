import { describe, expect, it } from 'vitest';
import { apply, createTournament, defaultSettings, logEvent, namesIn, type DirectorEvent, type PlayerId, type TournamentSettings, type TournamentState } from '../src';

const T0 = Date.parse('2026-10-30T00:00:00Z');

describe('the public lobby log', () => {
  it('names players instead of showing their ids, including one who just unregistered', () => {
    let s: TournamentState = createTournament({ id: 'L', hostId: 'host', settings: defaultSettings(), now: T0, seed: '01'.repeat(32) });
    s = apply(s, { type: 'register', playerId: 'p1', displayName: 'Ana' }, T0).state;
    const before = s;
    const r = apply(s, { type: 'unregister', playerId: 'p1' }, T0);
    const out = r.events.map((e) => logEvent(e, namesIn(r.state, before)));
    expect(out).toEqual([{ type: 'unregistered', name: 'Ana' }]);
  });

  it('leaves out requests and seat moves', () => {
    const name = () => 'X';
    const request = { id: 'r', kind: 'register', playerId: 'p', displayName: 'P', at: 0 } as const;
    const quiet: DirectorEvent[] = [
      { type: 'requestPending', request },
      { type: 'requestRejected', request },
      { type: 'moveSeat', entryId: 'e', playerId: 'p', from: { tableId: 't1', seat: 0 }, to: { tableId: 't2', seat: 1 }, stack: 5 },
      { type: 'scheduleNext', startAt: 0 },
    ];
    expect(quiet.map((e) => logEvent(e, name))).toEqual([null, null, null, null]);
    expect(logEvent({ type: 'eliminated', entryId: 'e', playerId: 'p', place: 3, by: ['q'], tableId: null, seat: null, reason: 'busted' }, (id) => (id === 'p' ? 'Ana' : 'Bo'))).toEqual({
      type: 'eliminated',
      name: 'Ana',
      place: 3,
      by: ['Bo'],
      reason: 'busted',
    });
  });
});

/** One of every kind of director event: a new kind fails to compile here until it has a sample. */
type OneOfEach = { [K in DirectorEvent['type']]: Extract<DirectorEvent, { type: K }> };
const request = { id: 'r', kind: 'register', playerId: 'id-p', displayName: 'P', at: 0, code: 'SECRETCODE' } as const;
const seat = { tableId: 't1', seat: 0, entryId: 'e', playerId: 'id-p', displayName: 'P', stack: 5 };
const move = { type: 'moveSeat', entryId: 'e', playerId: 'id-p', from: { tableId: 't1', seat: 0 }, to: { tableId: 't2', seat: 1 }, stack: 5 } as const;
const ALL: OneOfEach = {
  registered: { type: 'registered', entryId: 'e', playerId: 'id-p', displayName: 'Ana', late: false, entryNo: 1 },
  unregistered: { type: 'unregistered', playerId: 'id-p' },
  checkInOpened: { type: 'checkInOpened', group: 1, playerIds: ['id-p'] },
  checkedIn: { type: 'checkedIn', playerId: 'id-p' },
  bountyWon: { type: 'bountyWon', entryId: 'e', playerId: 'id-p', fromEntryId: 'f', fromPlayerId: 'id-q', cash: 500, headAdded: 0 },
  invitesCreated: { type: 'invitesCreated', codes: ['SECRETCODE'] },
  requestPending: { type: 'requestPending', request },
  requestRejected: { type: 'requestRejected', request },
  tablesCreated: { type: 'tablesCreated', tables: [{ tableId: 't1', seats: [seat] }] },
  tableOpened: { type: 'tableOpened', tableId: 't2' },
  startDelayed: { type: 'startDelayed', reason: 'not-enough-players', graceUntil: 5 },
  started: { type: 'started', at: 0 },
  levelUp: { type: 'levelUp', levelNumber: 2, sb: 50, bb: 100, ante: 0, anteType: 'none', gameId: 'nlhe' },
  breakStarted: { type: 'breakStarted', minutes: 5, endsAt: 0, addOn: false },
  breakEnded: { type: 'breakEnded' },
  lateRegistrationClosed: { type: 'lateRegistrationClosed' },
  rebuysClosed: { type: 'rebuysClosed' },
  reEntryClosed: { type: 'reEntryClosed' },
  seatPlayer: { type: 'seatPlayer', seat, reason: 'late-registration' },
  moveSeat: { ...move, by: 'id-host' },
  seatsSwapped: { type: 'seatsSwapped', by: 'id-host', moves: [move] },
  stackSet: { type: 'stackSet', by: 'id-host', entryId: 'e', playerId: 'id-p', tableId: 't1', seat: 0, stack: 50, previous: 100, applied: true },
  coHostsChanged: { type: 'coHostsChanged', by: 'id-host' },
  hostChanged: { type: 'hostChanged', by: 'id-host', hostId: 'id-p' },
  archived: { type: 'archived', by: 'id-host' },
  tableBroken: { type: 'tableBroken', tableId: 't1' },
  rebuyOffered: { type: 'rebuyOffered', entryId: 'e', playerId: 'id-p', expiresAt: 0, chips: 100 },
  stackAdded: { type: 'stackAdded', entryId: 'e', playerId: 'id-p', tableId: 't1', seat: 0, chips: 100, reason: 'rebuy' },
  eliminated: { type: 'eliminated', entryId: 'e', playerId: 'id-p', place: 3, by: ['id-q'], tableId: 't1', seat: 0, reason: 'busted' },
  handForHand: { type: 'handForHand', active: true },
  paused: { type: 'paused' },
  resumed: { type: 'resumed' },
  structureEdited: { type: 'structureEdited' },
  settingsUpdated: { type: 'settingsUpdated', changed: ['lateRegistration'] },
  finished: { type: 'finished', standings: [] },
  cancelled: { type: 'cancelled', reason: 'host' },
  scheduleNext: { type: 'scheduleNext', startAt: 0 },
  spawnNext: { type: 'spawnNext' },
};

/** The kinds the lobby never sees, each for a reason given in logEvent. */
const LEFT_OUT: DirectorEvent['type'][] = [
  'checkInOpened',
  'checkedIn',
  'invitesCreated',
  'requestPending',
  'requestRejected',
  'tablesCreated',
  'tableOpened',
  'seatPlayer',
  'rebuyOffered',
  'scheduleNext',
  'spawnNext',
];

describe('every kind of director event', () => {
  const name = (id: PlayerId) => (id === 'id-p' ? 'Ana' : 'Bo');
  const out = Object.values(ALL).map((e) => ({ type: e.type, shown: logEvent(e, name) }));

  it('is shown or left out on purpose', () => {
    expect(out.filter((x) => x.shown === null).map((x) => x.type)).toEqual(LEFT_OUT);
    expect(out.filter((x) => x.shown !== null)).toHaveLength(Object.keys(ALL).length - LEFT_OUT.length);
  });

  it('shows names, never player ids or invite codes', () => {
    const shown = JSON.stringify(out.map((x) => x.shown));
    expect(shown).not.toMatch(/id-|SECRETCODE/);
    expect(shown).toContain('Ana');
    expect(shown).toContain('Bo');
  });
});

describe('host settings changes', () => {
  const name = () => 'X';
  const create = () => createTournament({ id: 'S', hostId: 'host', settings: defaultSettings({ lateRegistration: { enabled: true, throughLevel: 4 } }), now: T0, seed: 'a1'.repeat(32) });
  const update = (s: TournamentState, settings: Partial<TournamentSettings>) => apply(s, { type: 'updateSettings', by: 'host', settings }, T0);

  it('name the settings that changed, the way a lobby switch sends them', () => {
    const s = create();
    const r = update(s, { lateRegistration: { ...s.settings.lateRegistration, enabled: false }, allowQuit: s.settings.allowQuit });
    expect(r.events).toEqual([{ type: 'settingsUpdated', changed: ['lateRegistration'] }]);
    expect(r.events.map((e) => logEvent(e, name))).toEqual([{ type: 'settingsUpdated', changed: ['lateRegistration'] }]);
  });

  it('show the table rules editor saving', () => {
    const r = update(create(), { tableRules: { decisionSeconds: 45, timeBankSeconds: 60, timeBankRefillHands: 10, rabbitHunt: false } });
    expect(r.events.map((e) => logEvent(e, name))).toEqual([{ type: 'settingsUpdated', changed: ['tableRules'] }]);
  });

  it('leave out a save that changed nothing, though the server still hears of it', () => {
    const s = create();
    const r = update(s, { lateRegistration: { ...s.settings.lateRegistration }, handForHand: s.settings.handForHand });
    expect(r.events).toEqual([{ type: 'settingsUpdated', changed: [] }]);
    expect(logEvent(r.events[0], name)).toBeNull();
  });

  it('count the same values sent with their keys in another order as no change', () => {
    const r = update(create(), { lateRegistration: { throughLevel: 4, enabled: true } });
    expect(r.events).toEqual([{ type: 'settingsUpdated', changed: [] }]);
    // A list is still compared in order.
    const mixed = createTournament({ id: 'M', hostId: 'host', settings: defaultSettings({ games: ['nlhe', 'plo'] }), now: T0, seed: 'a1'.repeat(32) });
    expect(update(mixed, { games: ['plo', 'nlhe'] }).events).toEqual([{ type: 'settingsUpdated', changed: ['games'] }]);
  });

  it('let a locked setting be sent back with its keys in another order', () => {
    const s = create();
    const reordered = s.settings.structure.map((row) => Object.fromEntries(Object.entries(row).reverse())) as TournamentSettings['structure'];
    expect(Object.keys(reordered[0])).not.toEqual(Object.keys(s.settings.structure[0]));
    expect(update(s, { structure: reordered }).events).toEqual([{ type: 'settingsUpdated', changed: [] }]);
    expect(() => update(s, { structure: reordered.slice(1) })).toThrow(/Use editStructure/);
  });
});

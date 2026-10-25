import { describe, expect, it } from 'vitest';
import {
  apply,
  autoArchive,
  copySettings,
  createTournament,
  defaultSettings,
  isTournamentStaff,
  lastActivityAt,
  mayCommand,
  standings,
  tick,
  type Command,
  type DirectorEvent,
  type TournamentSettings,
  type TournamentState,
} from '../src';

const T0 = Date.parse('2026-10-30T00:00:00Z');

class Sim {
  state: TournamentState;
  events: DirectorEvent[] = [];
  now = T0;
  constructor(overrides: Partial<TournamentSettings> = {}) {
    this.state = createTournament({
      id: 'T',
      hostId: 'host',
      settings: defaultSettings({ startingStack: 1000, lateRegistration: { enabled: false, throughLevel: null }, ...overrides }),
      now: this.now,
      seed: 7,
    });
  }
  do(cmd: Command) {
    const r = apply(this.state, cmd, this.now);
    this.state = r.state;
    this.events.push(...r.events);
    return r.events;
  }
  register(n: number) {
    for (let i = 0; i < n; i++) this.do({ type: 'register', playerId: `p${i}`, displayName: `P${i}` });
  }
  of<K extends DirectorEvent['type']>(type: K) {
    return this.events.filter((e): e is Extract<DirectorEvent, { type: K }> => e.type === type);
  }
  entry(playerId: string) {
    return this.state.entries.filter((e) => e.playerId === playerId).at(-1)!;
  }
  seatedAt(tableId: string) {
    const t = this.state.tables.find((x) => x.id === tableId)!;
    return t.seats.filter((x): x is string => !!x).map((id) => this.state.entries.find((e) => e.id === id)!.playerId);
  }
  start(tableId: string) {
    const t = this.state.tables.find((x) => x.id === tableId)!;
    this.do({ type: 'handStarted', tableId, handNumber: t.lastHandNumber + 1 });
  }
  end(tableId: string, change: Record<string, number> = {}) {
    const t = this.state.tables.find((x) => x.id === tableId)!;
    const start = Object.fromEntries(this.seatedAt(tableId).map((p) => [p, this.entry(p).stack]));
    const end = Object.fromEntries(Object.entries(start).map(([p, n]) => [p, n + (change[p] ?? 0)]));
    return this.do({ type: 'handResult', result: { tableId, handNumber: t.lastHandNumber, startStacks: start, endStacks: end } });
  }
}

describe('co-hosts', () => {
  it('gives a co-host only the powers the host picked', () => {
    const sim = new Sim({ registrationApproval: true });
    sim.do({ type: 'register', playerId: 'ann', displayName: 'Ann' });
    sim.do({ type: 'register', playerId: 'bob', displayName: 'Bob' });
    sim.do({ type: 'setCoHost', by: 'host', playerId: 'ann', powers: ['approve'] });
    expect(sim.state.coHosts).toEqual([{ playerId: 'ann', name: 'Ann', powers: ['approve'] }]);
    const approve: Command = { type: 'approve', by: 'ann', requestId: sim.state.requests[1].id };
    expect(mayCommand(sim.state, 'ann', approve)).toBe(true);
    expect(mayCommand(sim.state, 'ann', { type: 'pause', by: 'ann' })).toBe(false);
    expect(mayCommand(sim.state, 'ann', { type: 'setCoHost', by: 'ann', playerId: 'x', powers: [] })).toBe(false);
    expect(mayCommand(sim.state, 'bob', approve)).toBe(false);
    expect(mayCommand(sim.state, 'host', { type: 'pause', by: 'host' })).toBe(true);
    // Player commands are never staff commands.
    expect(mayCommand(sim.state, 'host', { type: 'register', playerId: 'host', displayName: 'H' })).toBe(false);
    expect(isTournamentStaff(sim.state, 'ann')).toBe(true);
    expect(isTournamentStaff(sim.state, 'bob')).toBe(false);
  });

  it('keeps co-hosts off their own requests and chips, and needs the chip power for a custom stack', () => {
    const sim = new Sim({ registrationApproval: true });
    sim.do({ type: 'register', playerId: 'ann', displayName: 'Ann' });
    sim.do({ type: 'register', playerId: 'bob', displayName: 'Bob' });
    sim.do({ type: 'setCoHost', by: 'host', playerId: 'ann', powers: ['approve'] });
    const [annReq, bobReq] = sim.state.requests;
    expect(mayCommand(sim.state, 'ann', { type: 'approve', by: 'ann', requestId: annReq.id })).toBe(false);
    expect(mayCommand(sim.state, 'ann', { type: 'approve', by: 'ann', requestId: bobReq.id })).toBe(true);
    expect(mayCommand(sim.state, 'ann', { type: 'approve', by: 'ann', requestId: bobReq.id, stack: 5000 })).toBe(false);
    sim.do({ type: 'setCoHost', by: 'host', playerId: 'ann', powers: ['approve', 'chips'] });
    expect(mayCommand(sim.state, 'ann', { type: 'approve', by: 'ann', requestId: bobReq.id, stack: 5000 })).toBe(true);
    expect(mayCommand(sim.state, 'ann', { type: 'setStack', by: 'ann', playerId: 'ann', stack: 5000 })).toBe(false);
    expect(mayCommand(sim.state, 'ann', { type: 'setStack', by: 'ann', playerId: 'bob', stack: 5000 })).toBe(true);
    expect(mayCommand(sim.state, 'host', { type: 'approve', by: 'host', requestId: annReq.id, stack: 1 })).toBe(true);
  });

  it('only takes people the event knows, and known powers', () => {
    const sim = new Sim();
    sim.register(1);
    expect(() => sim.do({ type: 'setCoHost', by: 'host', playerId: 'stranger', powers: [] })).toThrow(/in this event/);
    expect(() => sim.do({ type: 'setCoHost', by: 'host', playerId: 'p0', powers: ['fly' as never] })).toThrow(/Unknown power/);
    expect(() => sim.do({ type: 'setCoHost', by: 'host', playerId: 'host', powers: [] })).toThrow();
    sim.do({ type: 'setCoHost', by: 'host', playerId: 'p0', powers: ['settings', 'run', 'run'] });
    expect(sim.state.coHosts![0].powers).toEqual(['run', 'settings']);
    sim.do({ type: 'setCoHost', by: 'host', playerId: 'p0', powers: [] });
    expect(sim.state.coHosts).toHaveLength(1);
  });

  it('lets a co-host step down and the host remove one', () => {
    const sim = new Sim();
    sim.register(2);
    sim.do({ type: 'setCoHost', by: 'host', playerId: 'p0', powers: ['run'] });
    sim.do({ type: 'setCoHost', by: 'host', playerId: 'p1', powers: ['run'] });
    expect(mayCommand(sim.state, 'p0', { type: 'removeCoHost', by: 'p0', playerId: 'p0' })).toBe(true);
    expect(mayCommand(sim.state, 'p0', { type: 'removeCoHost', by: 'p0', playerId: 'p1' })).toBe(false);
    sim.do({ type: 'removeCoHost', by: 'p0', playerId: 'p0' });
    sim.do({ type: 'removeCoHost', by: 'host', playerId: 'p1' });
    expect(sim.state.coHosts).toEqual([]);
    expect(sim.of('coHostsChanged')).toHaveLength(4);
  });

  it('hands the host role on and keeps the old host as a full co-host', () => {
    const sim = new Sim();
    sim.register(2);
    sim.do({ type: 'setCoHost', by: 'host', playerId: 'p0', powers: ['run'] });
    sim.do({ type: 'transferHost', by: 'host', to: 'p0', byName: 'Dealer' });
    expect(sim.state.hostId).toBe('p0');
    expect(sim.state.coHosts).toEqual([{ playerId: 'host', name: 'Dealer', powers: ['approve', 'chips', 'run', 'players', 'settings'] }]);
    expect(sim.of('hostChanged')[0]).toMatchObject({ hostId: 'p0', by: 'host' });
    expect(mayCommand(sim.state, 'host', { type: 'transferHost', by: 'host', to: 'p1' })).toBe(false);
  });
});

describe('stacks', () => {
  it('approves a registration with a custom stack', () => {
    const sim = new Sim({ registrationApproval: true });
    sim.do({ type: 'register', playerId: 'ann', displayName: 'Ann' });
    const requestId = sim.state.requests[0].id;
    expect(() => sim.do({ type: 'approve', by: 'host', requestId, stack: 0 })).toThrow(/whole number/);
    sim.do({ type: 'approve', by: 'host', requestId, stack: 1500 });
    expect(sim.entry('ann').stack).toBe(1500);
    expect(sim.of('registered')[0].stack).toBe(1500);
  });

  it('sets a stack between hands at once and during a hand when it ends', () => {
    const sim = new Sim();
    sim.register(4);
    sim.do({ type: 'startNow', by: 'host' });
    const t = sim.state.tables[0].id;
    sim.do({ type: 'setStack', by: 'host', playerId: 'p0', stack: 2500 });
    expect(sim.entry('p0').stack).toBe(2500);
    expect(sim.of('stackSet')).toMatchObject([{ applied: true, stack: 2500, previous: 1000, tableId: t }]);

    sim.start(t);
    sim.do({ type: 'setStack', by: 'host', playerId: 'p1', stack: 300 });
    expect(sim.entry('p1').stack).toBe(1000);
    expect(sim.of('stackSet')[1]).toMatchObject({ applied: false, stack: 300 });
    // p1 loses everything in the hand, but the edit lands first, so they play on with 300.
    sim.end(t, { p1: -1000, p0: 1000 });
    expect(sim.entry('p1')).toMatchObject({ stack: 300, status: 'seated' });
    expect(sim.of('stackSet')[2]).toMatchObject({ applied: true, stack: 300, previous: 0 });
    expect(sim.of('eliminated')).toHaveLength(0);
  });

  it('credits the co-host who made the edit and keeps an add-on bought while it waits', () => {
    const structure = [
      { kind: 'level' as const, sb: 5, bb: 10, ante: 0, anteType: 'none' as const, minutes: 10 },
      { kind: 'break' as const, minutes: 5, addOn: true },
      { kind: 'level' as const, sb: 10, bb: 20, ante: 0, anteType: 'none' as const, minutes: 10 },
    ];
    const sim = new Sim({ structure, addOn: { max: 1, chips: 500, approval: false } });
    sim.register(2);
    sim.do({ type: 'setCoHost', by: 'host', playerId: 'p1', powers: ['chips'] });
    sim.do({ type: 'startNow', by: 'host' });
    const t = sim.state.tables[0].id;
    sim.start(t);
    sim.do({ type: 'setStack', by: 'p1', playerId: 'p0', stack: 3000 });
    // The break starts during the hand; p0 takes the add-on before it ends.
    sim.now += 10 * 60_000;
    sim.do({ type: 'addOn', playerId: 'p0' });
    sim.end(t);
    expect(sim.entry('p0').stack).toBe(3500);
    expect(sim.of('stackSet').at(-1)).toMatchObject({ by: 'p1', applied: true, stack: 3500 });
  });

  it('is not a rebuy', () => {
    const sim = new Sim();
    sim.register(2);
    sim.do({ type: 'setStack', by: 'host', playerId: 'p0', stack: 50 });
    expect(sim.entry('p0')).toMatchObject({ stack: 50, rebuys: 0 });
    expect(() => sim.do({ type: 'setStack', by: 'host', playerId: 'nobody', stack: 50 })).toThrow(/Not playing/);
  });
});

describe('moving players', () => {
  const twoTables = () => {
    const sim = new Sim({ seatsPerTable: 6 });
    sim.register(10);
    sim.do({ type: 'startNow', by: 'host' });
    return sim;
  };

  it('moves a player to an empty seat at the same table', () => {
    const sim = twoTables();
    const t = sim.state.tables[0];
    const who = sim.seatedAt(t.id)[0];
    const free = t.seats.indexOf(null);
    sim.do({ type: 'movePlayer', by: 'host', playerId: who, tableId: t.id, seat: free });
    expect(sim.entry(who).seat).toBe(free);
    expect(sim.state.tables[0].seats[free]).toBe(sim.entry(who).id);
    expect(sim.of('moveSeat').at(-1)).toMatchObject({ by: 'host', to: { tableId: t.id, seat: free } });
  });

  it('swaps two players across tables', () => {
    const sim = twoTables();
    const [a, b] = sim.state.tables;
    const x = sim.seatedAt(a.id)[0];
    const y = sim.seatedAt(b.id)[0];
    const [xSeat, ySeat] = [sim.entry(x).seat!, sim.entry(y).seat!];
    sim.do({ type: 'movePlayer', by: 'host', playerId: x, tableId: b.id, seat: ySeat });
    expect(sim.entry(x)).toMatchObject({ tableId: b.id, seat: ySeat });
    expect(sim.entry(y)).toMatchObject({ tableId: a.id, seat: xSeat });
    expect(sim.of('seatsSwapped')[0].moves).toHaveLength(2);
  });

  it('refuses a move that leaves the tables uneven, or during a hand', () => {
    const sim = twoTables();
    const [a, b] = sim.state.tables;
    const x = sim.seatedAt(a.id)[0];
    // 5 and 5: moving one makes 4 and 6.
    expect(() => sim.do({ type: 'movePlayer', by: 'host', playerId: x, tableId: b.id, seat: sim.state.tables[1].seats.indexOf(null) })).toThrow(/uneven/);
    sim.start(b.id);
    const y = sim.seatedAt(b.id)[0];
    expect(() => sim.do({ type: 'movePlayer', by: 'host', playerId: x, tableId: b.id, seat: sim.entry(y).seat! })).toThrow(/hand in progress/);
  });
});

describe('archive and cleanup', () => {
  it('cancels and archives before the start, refuses while running, archives once over', () => {
    const before = new Sim();
    before.register(1);
    before.do({ type: 'archive', by: 'host' });
    expect(before.state).toMatchObject({ status: 'cancelled', archivedAt: T0 });
    expect(() => before.do({ type: 'archive', by: 'host' })).toThrow(/Already/);

    const sim = new Sim();
    sim.register(2);
    sim.do({ type: 'startNow', by: 'host' });
    expect(() => sim.do({ type: 'archive', by: 'host' })).toThrow(/End the tournament first/);
    sim.do({ type: 'pause', by: 'host' });
    sim.do({ type: 'end', by: 'host' });
    sim.do({ type: 'archive', by: 'host' });
    expect(sim.state.archivedAt).toBe(T0);
    // Results stay.
    expect(standings(sim.state).map((s) => s.place)).toEqual([1, 1]);
  });

  it('auto-archives an untouched event and never one in play', () => {
    const sim = new Sim();
    sim.register(1);
    expect(lastActivityAt(sim.state)).toBe(T0);
    const r = autoArchive(sim.state, T0 + 1);
    expect(r.state).toMatchObject({ status: 'cancelled', archivedAt: T0 + 1 });
    expect(r.events.map((e) => e.type)).toEqual(['cancelled', 'archived']);

    sim.do({ type: 'register', playerId: 'p1', displayName: 'P1' });
    sim.do({ type: 'startNow', by: 'host' });
    expect(autoArchive(sim.state, T0 + 1).events).toEqual([]);
  });
});

describe('copy settings', () => {
  it('copies every field and moves a passed one-off start to the next day', () => {
    const source = defaultSettings({
      name: 'Friday',
      allowQuit: false,
      start: { kind: 'scheduled', startAt: Date.parse('2026-10-23T02:30:00Z'), schedule: { timeZone: 'UTC', startDate: '2026-10-23', time: '02:30' } },
    });
    const now = Date.parse('2026-10-30T12:00:00Z');
    const copy = copySettings(source, now);
    expect({ ...copy, start: null }).toEqual({ ...source, start: null });
    expect(copy.start).toMatchObject({ startAt: Date.parse('2026-10-31T02:30:00Z'), schedule: { startDate: '2026-10-31' } });
    expect(source.start).toMatchObject({ schedule: { startDate: '2026-10-23' } });
  });

  it('makes an ended series into one event on the next day', () => {
    const source = defaultSettings({
      start: { kind: 'scheduled', startAt: Date.parse('2026-10-02T19:00:00Z'), schedule: { timeZone: 'UTC', startDate: '2026-10-02', time: '19:00', repeat: { freq: 'daily' }, until: '2026-10-05' } },
    });
    const copy = copySettings(source, Date.parse('2026-10-25T20:00:00Z'));
    expect(copy.start).toEqual({ kind: 'scheduled', startAt: Date.parse('2026-10-26T19:00:00Z'), schedule: { timeZone: 'UTC', startDate: '2026-10-26', time: '19:00' } });
  });

  it('starts a copied series at its next occurrence', () => {
    const source = defaultSettings({
      start: { kind: 'scheduled', startAt: Date.parse('2026-10-02T19:00:00Z'), schedule: { timeZone: 'UTC', startDate: '2026-10-02', time: '19:00', repeat: { freq: 'weekly', weekdays: [5] } } },
    });
    const copy = copySettings(source, Date.parse('2026-10-25T12:00:00Z'));
    expect(copy.start).toMatchObject({ startAt: Date.parse('2026-10-30T19:00:00Z'), schedule: { startDate: '2026-10-02' } });
  });
});

describe('replayed hands', () => {
  it('ignores a result for a hand the director already closed', () => {
    const sim = new Sim();
    sim.register(2);
    sim.do({ type: 'startNow', by: 'host' });
    const t = sim.state.tables[0].id;
    sim.start(t);
    sim.end(t, { p0: 500, p1: -500 });
    const before = sim.state;
    sim.end(t, { p0: -1500, p1: 1500 });
    expect(sim.state.entries).toEqual(before.entries);
    expect(tick(sim.state, T0).events).toEqual([]);
  });
});

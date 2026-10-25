import type { AddressInfo } from 'node:net';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { engine, variants } from '@rsdp/engine/core';
import { registerAllVariants } from '@rsdp/engine/variants';
import { addOnsOpen, defaultSettings, levelEndsAt, standings, tableAddress, type StructureRow, type TournamentSettings, type TournamentState } from '@rsdp/tournament';
import { createApp, memoryStore } from '../src/app';
import type { TableRuntime } from '../src/runtime/table';
import { memoryTournamentStore } from '../src/tournament/store';
import { FakeClock, seeded } from './fake-clock';
import { socketClient, type Client } from './socket-client';
import { chipsInPlay, players, playUntil, registerAll, seatsAgree, setup, type Env } from './tournament-helpers';

beforeAll(() => registerAllVariants(variants));

// Tests can make the next few random draws come out the same, as if two new tournaments drew one id.
const draws = vi.hoisted(() => ({ fixed: 0 }));
vi.mock('node:crypto', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:crypto')>();
  const randomBytes = (n: number) => {
    if (draws.fixed <= 0) return real.randomBytes(n);
    draws.fixed--;
    return Buffer.alloc(n, 0xab);
  };
  return { ...real, randomBytes };
});

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

/** A new server process after a crash: the stores as the old one left them, and a clock of its own, so nothing the old process armed ever fires. */
async function restart(store: Env['store'], snapshots: Map<string, string>, now: number) {
  const clock = new FakeClock();
  clock.t = now;
  const env = setup({ store, snapshots, clock });
  await env.manager.resumeAll();
  return env;
}

/** Lets saves and other promise chains that need no timers finish. */
const settled = () => new Promise((resolve) => setImmediate(resolve));

/** A store holding just this director state, as the last save left it. */
async function savedAs(state: TournamentState) {
  const store = memoryTournamentStore();
  await store.save(state, null);
  return store;
}

/** A series at 20:00 UTC every day, from the test clock's first day. */
function daily(env: Env) {
  const startAt = Date.UTC(1970, 0, 1, 20, 0);
  expect(startAt).toBeGreaterThan(env.clock.now());
  const schedule = { timeZone: 'UTC', startDate: '1970-01-01', time: '20:00', repeat: { freq: 'daily' as const } };
  return { startAt, settings: defaultSettings({ name: 'Daily', startingStack: 1000, start: { kind: 'scheduled', startAt, schedule } }) };
}

async function started(n: number, overrides: Partial<TournamentSettings> = {}) {
  const env = setup();
  const settings = defaultSettings({ name: 'Restart', startingStack: 1000, seatsPerTable: 6, lateRegistration: { enabled: false, throughLevel: null }, ...overrides });
  const id = await env.manager.create('host', settings);
  await registerAll(env, id, n);
  await env.manager.command(id, 'host', '', { type: 'startNow', by: 'host' });
  return { env, id, state: () => env.manager.view(id)!.state };
}

/** The first player to act moves all in and everyone calls (or checks) it down. */
function allIn(rt: TableRuntime) {
  while (rt.state.hand?.phase === 'betting' && rt.state.hand.toAct !== null) {
    const hand = rt.state.hand;
    const seat = hand.seats.find((x) => x.seat === hand.toAct)!;
    const legal = engine.legalActions(hand, seat.seat)!;
    rt.act(seat.playerId, legal.canRaise ? { type: legal.raiseKind, to: legal.maxTo } : legal.canCheck ? { type: 'check' } : { type: 'call' });
  }
}

describe('shutting down', () => {
  it('a hand that ends as the server stops is saved by both the director and its table', async () => {
    const clock = new FakeClock();
    const tables = memoryStore();
    const tournaments = memoryTournamentStore();
    const errors: unknown[] = [];
    const server = createApp({ clock, rng: seeded(3), store: tables, tournaments, log: (m, e) => errors.push([m, e]) });
    const id = await server.tournaments.create('host', defaultSettings({ name: 'Shutdown', startingStack: 1500 }));
    for (const p of players(2)) await server.tournaments.command(id, p.id, p.name, { type: 'register', playerId: p.id, displayName: p.name });
    await server.tournaments.command(id, 'host', '', { type: 'startNow', by: 'host' });
    const [rt] = server.tables.values();
    // The hand is over and the table has reported it, but the director acts on that a moment later.
    allIn(rt);
    expect(rt.state.handStartedAt).toBeNull();
    await server.close();

    const director = (await tournaments.load(id))!.state;
    const table = (await tables.loadTable(rt.state.id))!;
    expect(director.tables[0]).toMatchObject({ inHand: false, lastHandNumber: table.handNumber });
    for (const e of director.entries) expect(table.seats.find((x) => x?.playerId === e.playerId)?.stack ?? 0, e.playerId).toBe(e.stack);
    // Nothing moves once the server has stopped.
    clock.advance(10 * MIN);
    expect(rt.state).toEqual(table);
    expect(errors).toEqual([]);
  });

  it('players still connected as the server stops are not timed out at their tables', async () => {
    const tables = memoryStore();
    const server = createApp({ clock: new FakeClock(), rng: seeded(3), store: tables, log: () => {} });
    await new Promise<void>((resolve) => server.http.listen(0, resolve));
    const url = `http://localhost:${(server.http.address() as AddressInfo).port}`;
    const clients: Client[] = [];
    const host = socketClient(url, 'host-secret-shutdown-0123', clients);
    const guest = socketClient(url, 'guest-secret-shutdown-0123', clients);
    try {
      // No grace: a player who drops is out of time at once.
      const settings = { seating: { offlineGraceSeconds: 0, requireApproval: false } };
      const { tableId } = await host.call<{ tableId: string }>('table:create', { settings });
      await host.call('table:join', { tableId });
      await guest.call('table:join', { tableId });
      await host.call('seat:request', { seat: 0, name: 'Host', stack: 100 });
      await guest.call('seat:request', { seat: 1, name: 'Guest', stack: 100 });
      await host.call('host:start');
      const rt = server.tables.get(tableId)!;
      expect(rt.state.hand).toMatchObject({ phase: 'betting', toAct: expect.any(Number) });
      const before = JSON.parse(JSON.stringify(rt.state));
      await server.close();
      expect(await tables.loadTable(tableId)).toEqual(before);
    } finally {
      for (const c of clients) c.close();
    }
  });
});

describe('tournaments after a crash', () => {
  it.each(['during', 'before'] as const)('a bust the director never saved is replayed from the table (director saved %s the hand)', async (when) => {
    const { env, id, state } = await started(4);
    const [rt] = env.tables.values();
    // The director as it stood between hands, and at a hand that has just knocked somebody out but not been reported yet.
    let between = state();
    playUntil(env, () => {
      const t = state().tables[0];
      if (rt.state.handStartedAt === null && !t.inHand && t.lastHandNumber === rt.state.handNumber) between = state();
      const unreported = rt.state.handStartedAt === null && t.inHand && rt.state.seats.some((x) => x?.stack === 0);
      // Before: the director must have been between hands since the last one (not so for a bust in the first hand).
      return unreported && (when === 'during' || (!between.tables[0].inHand && between.tables[0].lastHandNumber === rt.state.handNumber - 1));
    });
    const saved = when === 'during' ? state() : between;
    expect(saved.tables[0].lastHandNumber).toBe(when === 'during' ? rt.state.handNumber : rt.state.handNumber - 1);
    const busted = rt.state.seats.flatMap((x) => (x?.stack === 0 ? [x.playerId] : [])).sort();

    const after = await restart(await savedAs(saved), env.snapshots, env.clock.t);
    const now = () => after.manager.view(id)!.state;
    expect(now().entries.filter((e) => e.status === 'busted').map((e) => e.playerId).sort()).toEqual(busted);
    expect(now().tables[0]).toMatchObject({ inHand: false, lastHandNumber: rt.state.handNumber });
    seatsAgree(after, id);
    expect(chipsInPlay(after)).toBe(4000);
    playUntil(after, () => now().status === 'finished');
    expect(after.errors).toEqual([]);
    expect(standings(now())[0].stack).toBe(4000);
  }, 60_000);

  it.each(['before', 'after'] as const)('a table break the director never saved is replayed, and its players reach the table they moved to (saved %s the move)', async (when) => {
    const { env, id, state } = await started(4, { seatsPerTable: 3 });
    expect(state().tables).toHaveLength(2);
    const unreported = () =>
      state().tables.some((t) => {
        const rt = env.tables.get(tableAddress(t.id))!;
        return t.inHand && rt.state.handStartedAt === null && rt.state.seats.some((x) => x?.stack === 0);
      });
    playUntil(env, unreported);
    const saved = state();
    const before = new Map(env.snapshots);
    // The report lands: somebody is out, a table breaks and its players move.
    env.clock.advance(0);
    expect(state().tables).toHaveLength(1);
    // The broken table was saved at once; the one its players moved to may not have been saved since.
    const snapshots = new Map(when === 'after' ? env.snapshots : before);
    for (const [address, json] of env.snapshots) if (!env.tables.has(address)) snapshots.set(address, json);

    const after = await restart(await savedAs(saved), snapshots, env.clock.t);
    const now = () => after.manager.view(id)!.state;
    expect(now().tables).toHaveLength(1);
    expect(now().entries.filter((e) => e.status === 'busted')).toHaveLength(1);
    seatsAgree(after, id);
    expect(chipsInPlay(after)).toBe(4000);
    playUntil(after, () => now().status === 'finished');
    expect(after.errors).toEqual([]);
    expect(standings(now())[0].stack).toBe(4000);
  }, 60_000);

  it('an add-on bought during a hand the director never heard end is kept', async () => {
    const level = (sb: number): StructureRow => ({ kind: 'level', sb, bb: sb * 2, ante: 0, anteType: 'none', minutes: 5 });
    const structure = [level(10), { kind: 'break', minutes: 5, addOn: true } as const, level(20), level(40)];
    const { env, id, state } = await started(3, { structure, addOn: { max: 1, chips: 1000, approval: false } });
    const [rt] = env.tables.values();
    // A hand is dealt just before the break, which starts while it is still being played.
    const toBreak = () => levelEndsAt(state(), 1, env.clock.now())! - env.clock.now();
    playUntil(env, () => rt.state.hand?.phase === 'betting' && toBreak() < 20_000, { shove: 0 });
    env.clock.advance(toBreak());
    expect(addOnsOpen(state())).toBe(true);
    const buyer = rt.state.hand!.seats[0].playerId;
    await env.manager.command(id, buyer, '', { type: 'addOn', playerId: buyer });
    expect(rt.seatOf(buyer)!.pendingChips).toBe(1000);
    const saved = state();
    // The hand ends and the table is saved; the server stops before the director acts on it.
    playUntil(env, () => rt.state.handStartedAt === null, { shove: 0 });
    expect(saved.tables[0].inHand).toBe(true);

    const after = await restart(await savedAs(saved), env.snapshots, env.clock.t);
    const now = () => after.manager.view(id)!.state;
    const [table] = after.tables.values();
    expect(now().tables[0]).toMatchObject({ inHand: false, lastHandNumber: rt.state.handNumber });
    for (const e of now().entries) expect(e.stack, e.playerId).toBe(table.seatOf(e.playerId)?.stack ?? 0);
    expect(now().entries.reduce((n, e) => n + e.stack, 0)).toBe(4000);
    seatsAgree(after, id);
    expect(after.errors).toEqual([]);
  });

  it('seats players where the director has them when their tables were saved before a move', async () => {
    const env = setup();
    const startAt = env.clock.now() + 5 * MIN;
    const settings = defaultSettings({ name: 'Moves', start: { kind: 'scheduled', startAt }, startingStack: 1000, seatsPerTable: 6, lateRegistration: { enabled: false, throughLevel: null } });
    const id = await env.manager.create('host', settings);
    await registerAll(env, id, 10);
    env.clock.advance(4 * MIN + 1000);
    const state = () => env.manager.view(id)!.state;
    expect(state().status).toBe('seating');
    const lagging = new Map(env.snapshots);
    // Two players leave one table, so a player moves over from the other.
    const [a] = state().tables;
    for (const e of state().entries.filter((x) => x.tableId === a.id).slice(0, 2)) await env.manager.command(id, 'host', '', { type: 'remove', by: 'host', playerId: e.playerId });
    expect(env.moves.filter((m) => m.from !== '')).toHaveLength(1);
    // The director was saved after all that, the tables before it.
    await env.manager.flush();

    const after = await restart(env.store, lagging, env.clock.t);
    const now = () => after.manager.view(id)!.state;
    seatsAgree(after, id);
    expect(chipsInPlay(after)).toBe(8000);
    after.clock.advance(MIN);
    expect(now().status).toBe('running');
    playUntil(after, () => now().status === 'finished');
    expect(after.errors).toEqual([]);
    expect(standings(now())[0].stack).toBe(8000);
  }, 60_000);
});

describe('tournament ids', () => {
  it('a new tournament never takes over one whose id it happens to draw', async () => {
    const env = setup();
    draws.fixed = 1;
    const first = await env.manager.create('host', defaultSettings({ name: 'First' }));
    draws.fixed = 1;
    const second = await env.manager.create('other', defaultSettings({ name: 'Second' }));
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(second).toMatch(/^[0-9a-f]{16}$/);
    expect(second).not.toBe(first);
    expect((await env.store.load(first))!.state).toMatchObject({ hostId: 'host', settings: { name: 'First' } });
    expect((await env.store.load(second))!.state).toMatchObject({ hostId: 'other', settings: { name: 'Second' } });
    expect(env.manager.view(first)!.state.settings.name).toBe('First');
  });
});

describe('the next event', () => {
  it('a Sit & Go that fills just before a crash opens one next Sit & Go, not two', async () => {
    const first = setup();
    const id = await first.manager.create('host', defaultSettings({ name: 'Turbo', startingStack: 1000, start: { kind: 'sng', playersNeeded: 3, startDelaySeconds: 60, autoSpawn: true } }));
    await registerAll(first, id, 2);
    await first.manager.flush();
    // The third player fills it: the next one is saved at once, but this one's own save is still 300 ms away.
    const third = { type: 'register', playerId: 'p3', displayName: 'Player 3' } as const;
    await first.manager.command(id, 'p3', 'Player 3', third);
    await settled();
    const next = first.manager.view(id)!.nextId;
    expect(next).not.toBeNull();
    expect((await first.store.load(id))!.state.status).toBe('registering');

    const after = await restart(first.store, first.snapshots, first.clock.t);
    await after.manager.command(id, 'p3', 'Player 3', third);
    await settled();
    after.clock.advance(1000);
    expect(after.manager.view(id)!.nextId).toBe(next);
    const open = (await after.store.listLive()).filter((t) => t.state.status === 'registering').map((t) => t.state.id);
    expect(open).toEqual([next]);
    expect(after.errors).toEqual([]);
  });

  it('a series goes on after the server was down through its next date', async () => {
    const first = setup();
    const { startAt, settings } = daily(first);
    const id = await first.manager.create('host', settings);
    await registerAll(first, id, 3);
    await first.manager.flush();
    // Back up a day and an hour after the start: the overdue event begins, and next is the one still to come.
    const after = await restart(first.store, first.snapshots, startAt + DAY + 60 * MIN);
    await settled();
    const view = after.manager.view(id)!;
    expect(view.state.status).toBe('running');
    expect(view.nextId).not.toBeNull();
    expect((await after.store.load(view.nextId!))!.state).toMatchObject({ status: 'registering', startAt: startAt + 2 * DAY });
    expect(after.errors).toEqual([]);
  });

  it('a series goes on after an event nobody came to', async () => {
    const env = setup();
    const { startAt, settings } = daily(env);
    const id = await env.manager.create('host', settings);
    await registerAll(env, id, 1);
    // Past the start and its 15 minutes of grace.
    env.clock.advance(startAt + 16 * MIN - env.clock.now());
    await settled();
    const view = env.manager.view(id)!;
    expect(view.state.status).toBe('cancelled');
    expect(view.nextId).not.toBeNull();
    expect((await env.store.load(view.nextId!))!.state).toMatchObject({ status: 'registering', startAt: startAt + DAY });
    expect(env.errors).toEqual([]);
  });
});

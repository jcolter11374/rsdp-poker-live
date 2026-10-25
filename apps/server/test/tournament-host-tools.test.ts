import { beforeAll, describe, expect, it } from 'vitest';
import { engine, variants } from '@rsdp/engine/core';
import { registerAllVariants } from '@rsdp/engine/variants';
import { defaultSettings, tableAddress, type TournamentSettings } from '@rsdp/tournament';
import type { TableRuntime } from '../src/runtime/table';
import { FINISHED_KEEP_MS, IDLE_ARCHIVE_MS } from '../src/tournament/manager';
import { memoryTournamentStore } from '../src/tournament/store';
import { FakeClock } from './fake-clock';
import { chipsInPlay, playUntil, registerAll, seatsAgree, setup, type Env } from './tournament-helpers';

beforeAll(() => registerAllVariants(variants));

const DAY = 24 * 3600_000;

async function started(n: number, overrides: Partial<TournamentSettings> = {}, env = setup()) {
  const settings = defaultSettings({ name: 'Tools', startingStack: 1000, seatsPerTable: 6, lateRegistration: { enabled: false, throughLevel: null }, ...overrides });
  const id = await env.manager.create('host', settings);
  await registerAll(env, id, n);
  await env.manager.command(id, 'host', '', { type: 'startNow', by: 'host' });
  return { env, id, state: () => env.manager.view(id)!.state };
}

const tableOf = (env: Env, playerId: string) => [...env.tables.values()].find((rt) => rt.seatOf(playerId))!;
const live = (rt: TableRuntime) => !!rt.state.hand && rt.state.hand.phase !== 'complete';

function allIn(rt: TableRuntime) {
  while (rt.state.hand?.phase === 'betting' && rt.state.hand.toAct !== null) {
    const hand = rt.state.hand;
    const seat = hand.seats.find((x) => x.seat === hand.toAct)!;
    const legal = engine.legalActions(hand, seat.seat)!;
    rt.act(seat.playerId, legal.canRaise ? { type: legal.raiseKind, to: legal.maxTo } : legal.canCheck ? { type: 'check' } : { type: 'call' });
  }
}

/** Everyone folds to the big blind (or checks it down), so nobody busts. */
function foldOut(rt: TableRuntime) {
  while (rt.state.hand?.phase === 'betting' && rt.state.hand.toAct !== null) {
    const hand = rt.state.hand;
    const seat = hand.seats.find((x) => x.seat === hand.toAct)!;
    const legal = engine.legalActions(hand, seat.seat)!;
    rt.act(seat.playerId, legal.canCheck ? { type: 'check' } : { type: 'fold' });
  }
}

function untilDealt(env: Env, rt: TableRuntime) {
  for (let i = 0; i < 60 && !live(rt); i++) env.clock.advance(500);
  expect(live(rt)).toBe(true);
}

async function restart(env: Env, snapshots: Map<string, string>) {
  const clock = new FakeClock();
  clock.t = env.clock.now();
  const next = setup({ store: env.store, snapshots, clock });
  await next.manager.resumeAll();
  return next;
}

/** Logged problems, apart from the note that a table was brought in line. */
const problems = (env: Env) => (env.errors as [unknown, unknown][]).filter(([m]) => !String(m).includes('bringing it in line'));
const aligned = (env: Env) => (env.errors as [unknown, unknown][]).some(([m]) => String(m).includes('bringing it in line'));

const settled = () => new Promise((resolve) => setImmediate(resolve));

describe('co-hosts on the server', () => {
  it('lets a co-host use only the powers they were given', async () => {
    const { env, id, state } = await started(3);
    await env.manager.command(id, 'host', 'Host', { type: 'setCoHost', by: 'host', playerId: 'p1', powers: ['run'] } as never);
    // `by` comes from the connection, whatever the browser sent.
    await env.manager.command(id, 'p1', 'Player 1', { type: 'pause', by: 'host' });
    expect(state().status).toBe('paused');
    await expect(env.manager.command(id, 'p1', 'Player 1', { type: 'setStack', by: 'p1', playerId: 'p2', stack: 5 })).rejects.toThrow(/not given you that power/);
    await expect(env.manager.command(id, 'p2', 'Player 2', { type: 'resume', by: 'p2' })).rejects.toThrow(/only the host/);
    await expect(env.manager.command(id, 'p1', 'Player 1', { type: 'archive', by: 'p1' })).rejects.toThrow();
    await env.manager.command(id, 'host', 'Dealer', { type: 'transferHost', by: 'host', to: 'p1' });
    expect(state()).toMatchObject({ hostId: 'p1', coHosts: [{ playerId: 'host', name: 'Dealer' }] });
    await env.manager.command(id, 'p1', 'Player 1', { type: 'resume', by: 'p1' });
    expect(state().status).toBe('running');
  });
});

describe('stack edits and seat moves reach the tables', () => {
  it('sets a stack between hands and after a hand in progress', async () => {
    const { env, id, state } = await started(3);
    const rt = [...env.tables.values()][0];
    // The first hand is dealt at the start: the edit waits for it.
    untilDealt(env, rt);
    await env.manager.command(id, 'host', '', { type: 'setStack', by: 'host', playerId: 'p2', stack: 2222 });
    expect(state().entries.find((e) => e.playerId === 'p2')!.pendingStack).toBe(2222);
    foldOut(rt);
    env.clock.advance(10);
    expect(rt.seatOf('p2')!.stack).toBe(2222);
    expect(state().entries.find((e) => e.playerId === 'p2')!.stack).toBe(2222);
    // Between hands it lands at once.
    expect(live(rt)).toBe(false);
    await env.manager.command(id, 'host', '', { type: 'setStack', by: 'host', playerId: 'p1', stack: 4000 });
    expect(rt.seatOf('p1')!.stack).toBe(4000);
    expect(chipsInPlay(env)).toBe(state().entries.reduce((n, e) => n + e.stack, 0));
  });

  it('swaps two players at different tables between hands', async () => {
    const { env, id, state } = await started(8, { seatsPerTable: 4 });
    // Pausing lets the hands in progress finish, then the tables hold.
    await env.manager.command(id, 'host', '', { type: 'pause', by: 'host' });
    playUntil(env, () => state().tables.every((t) => !t.inHand));
    const [a, b] = state().tables;
    const x = state().entries.find((e) => e.tableId === a.id)!;
    const y = state().entries.find((e) => e.tableId === b.id)!;
    await env.manager.command(id, 'host', '', { type: 'movePlayer', by: 'host', playerId: x.playerId, tableId: b.id, seat: y.seat! });
    expect(tableOf(env, x.playerId).state.id).toBe(tableAddress(b.id));
    expect(tableOf(env, x.playerId).seatOf(x.playerId)!.seat).toBe(y.seat);
    expect(tableOf(env, y.playerId).state.id).toBe(tableAddress(a.id));
    expect(env.moves.filter((m) => m.from !== '')).toHaveLength(2);
    seatsAgree(env, id);
    await env.manager.command(id, 'host', '', { type: 'resume', by: 'host' });
    playUntil(env, () => state().status === 'finished');
    expect(state().status).toBe('finished');
  });
});

describe('restart behind the director (issue #5)', () => {
  it('drops a hand the director already closed instead of playing it again', async () => {
    const { env, id, state } = await started(2, { rebuy: { max: 3, chips: 1000, approval: false, offerSeconds: 15 }, structure: defaultSettings().structure.map((r) => (r.kind === 'level' ? { ...r, rebuy: true } : r)) });
    const rt = [...env.tables.values()][0];
    untilDealt(env, rt);
    const stale = new Map(env.snapshots);
    allIn(rt);
    env.clock.advance(1000);
    await settled();
    const director = (await env.store.load(id))!.state;
    expect(director.tables[0].inHand).toBe(false);

    const next = await restart(env, stale);
    const table = [...next.tables.values()][0];
    const after = next.manager.view(id)!.state;
    expect(table.state.handNumber).toBe(after.tables[0].lastHandNumber);
    for (const e of after.entries.filter((x) => x.status === 'seated')) expect(table.seatOf(e.playerId)!.stack, e.playerId).toBe(e.stack);
    expect(problems(next)).toEqual([]);
    playUntil(next, () => next.manager.view(id)!.state.status === 'finished' || next.manager.view(id)!.state.entries.some((e) => e.rebuys > 0));
    void state;
  });

  it('closes a hand the director heard start but the table never saved', async () => {
    const { env, id } = await started(3);
    const rt = [...env.tables.values()][0];
    foldOut(rt);
    env.clock.advance(10);
    expect(live(rt)).toBe(false);
    // Saved between hands; the next deal and the director's save of it are lost with the table's.
    const before = new Map(env.snapshots);
    untilDealt(env, rt);
    env.clock.advance(400);
    await settled();
    expect((await env.store.load(id))!.state.tables[0].inHand).toBe(true);

    const next = await restart(env, before);
    const s = () => next.manager.view(id)!.state;
    // The lost hand is closed, so the table deals its next one and the two agree on it.
    const table = [...next.tables.values()][0];
    expect(s().tables[0]).toMatchObject({ lastHandNumber: table.state.handNumber, inHand: live(table) });
    expect(aligned(next)).toBe(true);
    expect(problems(next)).toEqual([]);
    playUntil(next, () => s().status === 'finished');
    expect(s().status).toBe('finished');
  });
});

describe('restart with a stack edit in flight', () => {
  it('does not apply a replayed edit again to the hand after it', async () => {
    const { env, id } = await started(3);
    const rt = [...env.tables.values()][0];
    untilDealt(env, rt);
    await env.manager.command(id, 'host', '', { type: 'setStack', by: 'host', playerId: 'p2', stack: 2222 });
    env.clock.advance(400);
    await settled();
    // The director as saved: the edit still waiting for hand 1.
    const directorSave = (await env.store.load(id))!.state;
    expect(directorSave.entries.find((e) => e.playerId === 'p2')!.pendingStack).toBe(2222);
    foldOut(rt);
    env.clock.advance(10);
    untilDealt(env, rt);
    // The table as saved: in hand 2, with the edit already in its stacks.
    const store = memoryTournamentStore();
    await store.save(directorSave, null);
    const clock = new FakeClock();
    clock.t = env.clock.now();
    const next = setup({ store, snapshots: new Map(env.snapshots), clock });
    await next.manager.resumeAll();
    const table = [...next.tables.values()][0];
    expect(table.seatOf('p2')!.pendingStack).toBeNull();
    const total = () => next.manager.view(id)!.state.entries.reduce((n, e) => n + e.stack, 0);
    const before = chipsInPlay(next);
    foldOut(table);
    next.clock.advance(10);
    expect(total()).toBe(before);
    expect(chipsInPlay(next)).toBe(before);
  });
});

describe('cleanup', () => {
  it('archives an event nobody started after 30 idle days', async () => {
    const env = setup();
    const id = await env.manager.create('host', defaultSettings({ name: 'Idle' }));
    env.clock.t += IDLE_ARCHIVE_MS - 1000;
    env.manager.sweep();
    expect(env.manager.view(id)!.state.archivedAt ?? null).toBeNull();
    env.clock.t += 1000;
    env.manager.sweep();
    expect(env.manager.view(id)!.state).toMatchObject({ status: 'cancelled', archivedAt: env.clock.t });
  });

  it('lets go of a finished event after a while and loads it again on request', async () => {
    const { env, id, state } = await started(2);
    await env.manager.command(id, 'host', '', { type: 'pause', by: 'host' });
    playUntil(env, () => state().tables.every((t) => !t.inHand) || state().status === 'finished');
    if (state().status !== 'finished') await env.manager.command(id, 'host', '', { type: 'end', by: 'host' });
    env.clock.advance(FINISHED_KEEP_MS + DAY);
    env.manager.sweep();
    await settled();
    expect(env.manager.view(id)).toBeNull();
    expect(env.tables.size).toBe(0);
    expect((await env.manager.get(id))!.state.status).toBe('finished');
  });
});

describe('operator cleanup', () => {
  it('lists events, then ends a running one as its host would and hides it', async () => {
    const { env, id, state } = await started(3);
    expect(env.manager.adminList()).toEqual([expect.objectContaining({ id, name: 'Tools', status: 'running', archived: false, players: ['Player 1', 'Player 2', 'Player 3'] })]);
    const rt = [...env.tables.values()][0];
    untilDealt(env, rt);
    const done = env.manager.adminArchive(id);
    // The pause waits for the hand in progress.
    await new Promise((r) => setTimeout(r, 0));
    expect(state().status).toBe('paused');
    foldOut(rt);
    env.clock.advance(100);
    expect(await done).toEqual({ id, status: 'finished', archived: true });
    expect(await env.manager.list('p1')).toEqual([]);
    expect(problems(env)).toEqual([]);
  });

  it('archives an event that has not started', async () => {
    const env = setup();
    const id = await env.manager.create('host', defaultSettings({ name: 'Smoke Cup' }));
    await registerAll(env, id, 2);
    expect(await env.manager.adminArchive(id)).toEqual({ id, status: 'cancelled', archived: true });
    await expect(env.manager.adminArchive('nope')).rejects.toThrow('tournament not found');
  });
});

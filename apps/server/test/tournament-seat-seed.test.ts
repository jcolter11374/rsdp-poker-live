import { beforeAll, describe, expect, it } from 'vitest';
import { variants } from '@rsdp/engine/core';
import { registerAllVariants } from '@rsdp/engine/variants';
import { defaultSettings, drawSeats, seatRng, type TournamentState } from '@rsdp/tournament';
import { TournamentManager } from '../src/tournament/manager';
import { memoryTournamentStore } from '../src/tournament/store';
import { FakeClock } from './fake-clock';
import { registerAll, seatsAgree, setup } from './tournament-helpers';

beforeAll(() => registerAllVariants(variants));

const HEX64 = /^[0-9a-f]{64}$/;

/** Rewrites a saved tournament the way a server saved it before rsdp-seats-v1: a mulberry32 state and no seat-draw seed. */
async function saveTheOldWay(env: ReturnType<typeof setup>, id: string, rng: number) {
  await env.manager.flush();
  env.manager.dispose();
  const saved = (await env.store.load(id))!;
  const { seatRng: _gone, ...old } = saved.state;
  await env.store.save({ ...old, rng }, saved.nextId);
}

describe('tournament seat-draw seeds on the server', () => {
  it('makes a fresh 32-byte seed for every tournament and never sends it to a browser', async () => {
    const env = setup();
    const a = await env.manager.create('host', defaultSettings({ name: 'A' }));
    const b = await env.manager.create('host', defaultSettings({ name: 'B' }));
    const seedOf = async (id: string) => (await env.manager.peek(id))!.seatRng!.seed;
    expect(await seedOf(a)).toMatch(HEX64);
    expect(await seedOf(b)).toMatch(HEX64);
    expect(await seedOf(a)).not.toBe(await seedOf(b));
    // The old generator's state is secret too (for a rolled-back server): a nonzero 32-bit number of its own.
    const rngOf = async (id: string) => (await env.manager.peek(id))!.rng;
    for (const id of [a, b]) {
      expect(Number.isInteger(await rngOf(id))).toBe(true);
      expect(await rngOf(id)).toBeGreaterThan(0);
      expect(await rngOf(id)).toBeLessThan(2 ** 32);
    }
    expect(await rngOf(a)).not.toBe(await rngOf(b));
    await registerAll(env, a, 3);
    await env.manager.command(a, 'host', '', { type: 'startNow', by: 'host' });
    const seed = await seedOf(a);
    for (const viewer of ['host', 'p1', 'stranger', undefined]) {
      const view = env.manager.view(a, viewer)!;
      expect(view.state.seatRng).toBeUndefined();
      expect(view.state.rng).toBe(0);
      expect(JSON.stringify(view)).not.toContain(seed);
    }
    // It is saved with the tournament, so a restart carries on from the same stream.
    await env.manager.flush();
    expect((await env.store.load(a))!.state.seatRng).toEqual((await env.manager.peek(a))!.seatRng);
    expect((await env.manager.peek(a))!.seatRng!.at).toBeGreaterThan(0);
  });

  it('takes the seed from crypto.randomBytes when no test generator is given', async () => {
    const errors: unknown[] = [];
    const manager = new TournamentManager({
      clock: new FakeClock(),
      store: memoryTournamentStore(),
      tables: {
        createTable: async () => {},
        loadTable: async () => null,
        attach: () => {},
        detach: () => {},
      },
      onState: () => {},
      onMoved: () => {},
      log: (m, e) => errors.push([m, e]),
    });
    const ids = [await manager.create('host', defaultSettings({ name: 'A' })), await manager.create('host', defaultSettings({ name: 'B' }))];
    const seeds = await Promise.all(ids.map(async (id) => (await manager.peek(id))!.seatRng!.seed));
    for (const seed of seeds) expect(seed).toMatch(HEX64);
    expect(seeds[0]).not.toBe(seeds[1]);
    const rngs = await Promise.all(ids.map(async (id) => (await manager.peek(id))!.rng));
    for (const rng of rngs) expect(rng).toBeGreaterThan(0);
    expect(rngs[0]).not.toBe(rngs[1]);
    manager.dispose();
    expect(errors).toEqual([]);
  });

  it('makes the old-generator state apart from the seed, so knowing the seed tells nothing about it', async () => {
    // Every seed byte comes out 0, so every tournament gets the same seed; the old-generator state must still differ.
    let k = 0;
    const errors: unknown[] = [];
    const manager = new TournamentManager({
      clock: new FakeClock(),
      store: memoryTournamentStore(),
      tables: { createTable: async () => {}, loadTable: async () => null, attach: () => {}, detach: () => {} },
      rng: (n) => (n === 256 ? 0 : ++k % n),
      onState: () => {},
      onMoved: () => {},
      log: (m, e) => errors.push([m, e]),
    });
    const ids = [await manager.create('host', defaultSettings({ name: 'A' })), await manager.create('host', defaultSettings({ name: 'B' }))];
    const states = await Promise.all(ids.map(async (id) => (await manager.peek(id))!));
    expect(states[0].seatRng!.seed).toBe('00'.repeat(32));
    expect(states[1].seatRng!.seed).toBe(states[0].seatRng!.seed);
    expect(states[0].rng).not.toBe(states[1].rng);
    manager.dispose();
    expect(errors).toEqual([]);
  });

  it('gives a tournament saved with the old 32-bit seed a fresh secure one when its seats are still to draw', async () => {
    const first = setup();
    const id = await first.manager.create('host', defaultSettings({ name: 'Before', startingStack: 1000, seatsPerTable: 6 }));
    await registerAll(first, id, 8);
    await saveTheOldWay(first, id, 12345);
    expect((await first.store.load(id))!.state.seatRng).toBeUndefined();

    const env = setup({ store: first.store, snapshots: first.snapshots, clock: first.clock });
    await env.manager.resumeAll();
    const loaded = (await env.manager.peek(id))!;
    expect(loaded.seatRng!.seed).toMatch(HEX64);
    expect(loaded.seatRng!.at).toBe(0);
    // Saved straight away.
    env.clock.advance(1000);
    expect((await env.store.load(id))!.state.seatRng).toEqual(loaded.seatRng);

    const waiting = loaded.entries.filter((e) => e.status === 'registered').map((e) => e.id);
    await env.manager.command(id, 'host', '', { type: 'startNow', by: 'host' });
    const drawn = (await env.manager.peek(id))!;
    expect(drawn.tables.map((t) => t.seats)).toEqual(drawSeats(waiting, 6, seatRng({ seed: loaded.seatRng!.seed, at: 0 })));
    expect(drawn.status).toBe('running');
    seatsAgree(env, id);
    expect(env.errors).toEqual([]);
  });

  it('keeps the seed a new tournament was saved with, with no second save, until it is loaded again', async () => {
    const env = setup();
    let saves = 0;
    const save = env.store.save.bind(env.store);
    env.store.save = (...args: Parameters<typeof save>) => (saves++, save(...args));
    const id = await env.manager.create('host', defaultSettings({ name: 'New' }));
    const stored = (await env.store.load(id))!.state;
    const live = (await env.manager.peek(id))!;
    expect(live.seatRng).toEqual(stored.seatRng);
    expect(live.rng).toBe(stored.rng);
    env.clock.advance(1000);
    expect(saves).toBe(0);
    expect(env.errors).toEqual([]);
  });

  it('gives a tournament a fresh seed and old-generator state each time it loads while its seats are still to draw', async () => {
    // A server rolled back to before rsdp-seats-v1 sends seatRng to browsers, so a seed saved while it ran may have
    // been seen. The next load replaces it; nothing has been drawn from it yet.
    const first = setup();
    const id = await first.manager.create('host', defaultSettings({ name: 'Reload', startingStack: 1000, seatsPerTable: 6 }));
    await registerAll(first, id, 8);
    await first.manager.flush();
    first.manager.dispose();
    const before = (await first.store.load(id))!.state;

    const second = setup({ store: first.store, snapshots: first.snapshots, clock: first.clock }, { rngSeed: 12 });
    await second.manager.resumeAll();
    const loaded = (await second.manager.peek(id))!;
    expect(loaded.seatRng!.seed).toMatch(HEX64);
    expect(loaded.seatRng!.seed).not.toBe(before.seatRng!.seed);
    expect(loaded.seatRng!.at).toBe(0);
    expect(loaded.rng).toBeGreaterThan(0);
    expect(loaded.rng).not.toBe(before.rng);
    second.clock.advance(1000);
    expect((await second.store.load(id))!.state.seatRng).toEqual(loaded.seatRng);

    // Drawn from the new seed; after the draw a restart keeps the seed and its place.
    const waiting = loaded.entries.filter((e) => e.status === 'registered').map((e) => e.id);
    await second.manager.command(id, 'host', '', { type: 'startNow', by: 'host' });
    const drawn = (await second.manager.peek(id))!;
    expect(drawn.tables.map((t) => t.seats)).toEqual(drawSeats(waiting, 6, seatRng({ seed: loaded.seatRng!.seed, at: 0 })));
    await second.manager.flush();
    second.manager.dispose();

    const third = setup({ store: first.store, snapshots: first.snapshots, clock: first.clock }, { rngSeed: 13 });
    await third.manager.resumeAll();
    const resumed = (await third.manager.peek(id))!;
    expect(resumed.seatRng).toEqual(drawn.seatRng);
    expect(resumed.rng).toBe(drawn.rng);
    expect(resumed.tables.map((t) => t.seats)).toEqual(drawn.tables.map((t) => t.seats));
    seatsAgree(third, id);
    expect([...first.errors, ...second.errors, ...third.errors]).toEqual([]);
  });

  it('keeps a tournament saved with the old generator running once its seats are drawn, with no new seed', async () => {
    const first = setup();
    const id = await first.manager.create('host', defaultSettings({ name: 'Running', startingStack: 1000 }));
    await registerAll(first, id, 4);
    await first.manager.command(id, 'host', '', { type: 'startNow', by: 'host' });
    const seats = (await first.manager.peek(id))!.tables.map((t) => t.seats);
    await saveTheOldWay(first, id, 777);

    const env = setup({ store: first.store, snapshots: first.snapshots, clock: first.clock });
    await env.manager.resumeAll();
    const loaded: TournamentState = (await env.manager.peek(id))!;
    expect(loaded.seatRng).toBeUndefined();
    expect(loaded.rng).toBe(777);
    expect(loaded.tables.map((t) => t.seats)).toEqual(seats);
    // Late registration still seats a player by the usual rules.
    await env.manager.command(id, 'p9', 'Late', { type: 'register', playerId: 'p9', displayName: 'Late' });
    expect((await env.manager.peek(id))!.entries.find((e) => e.playerId === 'p9')!.status).toBe('seated');
    seatsAgree(env, id);
    expect(env.errors).toEqual([]);
  });
});

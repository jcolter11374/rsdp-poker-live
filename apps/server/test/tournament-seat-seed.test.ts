import { beforeAll, describe, expect, it } from 'vitest';
import { variants } from '@rsdp/engine/core';
import { registerAllVariants } from '@rsdp/engine/variants';
import { defaultSettings, drawSeats, seatRng, type TournamentState } from '@rsdp/tournament';
import { registerAll, seatsAgree, setup } from './tournament-helpers';

beforeAll(() => registerAllVariants(variants));

const HEX64 = /^[0-9a-f]{64}$/;

/** Rewrites a saved tournament the way a server saved it before 2026-11-06: a mulberry32 state and no seat-draw seed. */
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
    // Saved straight away, so another restart before the draw keeps this seed.
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

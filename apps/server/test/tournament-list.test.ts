import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { variants } from '@rsdp/engine/core';
import { registerAllVariants } from '@rsdp/engine/variants';
import { createTournament, defaultSettings } from '@rsdp/tournament';
import { closeDb, type Db } from '../src/db/client';
import { createTestDb } from '../src/db/testing';
import { dbTournamentStore } from '../src/tournament/store';
import { playUntil, registerAll, setup } from './tournament-helpers';

beforeAll(() => registerAllVariants(variants));

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

describe('the home page tournament list', () => {
  it('lists every live event, and finished ones only for their host and players', async () => {
    const env = setup();
    const open = await env.manager.create('host', defaultSettings({ name: 'Open' }));
    const done = await env.manager.create('host', defaultSettings({ name: 'Done', startingStack: 200, lateRegistration: { enabled: false, throughLevel: null } }));
    await registerAll(env, done, 2);
    await env.manager.command(done, 'host', 'Host', { type: 'startNow', by: 'host' });
    playUntil(env, () => env.manager.view(done)!.state.status === 'finished');
    expect(env.manager.view(done)!.state.status).toBe('finished');

    const stranger = await env.manager.list('stranger');
    expect(stranger.map((t) => t.name)).toEqual(['Open']);
    const player = await env.manager.list('p1');
    expect(player.map((t) => t.name)).toEqual(['Open', 'Done']);
    expect(player[1].me.registered).toBe(true);
    expect(player[1].me.place).not.toBeNull();
    const host = await env.manager.list('host');
    expect(host.find((t) => t.id === open)!.me.hosting).toBe(true);

    // A month later the finished one has dropped off.
    env.clock.advance(31 * DAY);
    expect((await env.manager.list('p1')).map((t) => t.name)).toEqual(['Open']);
  });
});

describe('listing a player’s tournaments from the database', () => {
  let db: Db | undefined;
  afterEach(async () => {
    if (db) await closeDb(db);
    db = undefined;
  });

  it('finds the ones they host or have an entry in', async () => {
    db = await createTestDb();
    await db.execute(sql`insert into players (id) values ('host'), ('p1'), ('p2')`);
    const store = dbTournamentStore(db);
    const now = Date.now();
    const make = (id: string, hostId: string) => createTournament({ id, hostId, settings: defaultSettings({ name: id }), now, seed: 1 });
    const a = make('a', 'host');
    const b = make('b', 'p2');
    b.entries.push({ id: 'b:e1', playerId: 'p1', displayName: 'P1', entryNo: 1, status: 'registered', stack: 1, tableId: null, seat: null, rebuys: 0, addOns: 0, registeredAt: now });
    await store.create(a);
    await store.create(b);
    await store.create(make('c', 'p2'));
    const ids = async (p: string) => (await store.listForPlayer(p, now - DAY)).map((r) => r.state.id).sort();
    expect(await ids('host')).toEqual(['a']);
    expect(await ids('p1')).toEqual(['b']);
    expect(await ids('p2')).toEqual(['b', 'c']);
    expect(await store.listForPlayer('p2', now + DAY)).toEqual([]);
  });
});

import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { variants } from '@rsdp/engine/core';
import { registerAllVariants } from '@rsdp/engine/variants';
import { createApp } from '../src/app';
import { closeDb, listHandsByTable, type Db } from '../src/db';
import { createTestDb } from '../src/db/testing';
import { dbIdentity, dbStore, withoutLoneSurrogates } from '../src/storage';
import { dbTournamentStore } from '../src/tournament/store';
import { createTournament, defaultSettings as tournamentDefaults } from '@rsdp/tournament';
import { socketClient, type Client } from './socket-client';

let db: Db;
let server: ReturnType<typeof createApp>;
let url = '';
const clients: Client[] = [];
const client = (token: string) => socketClient(url, token, clients);

beforeAll(async () => {
  registerAllVariants(variants);
  db = await createTestDb();
  server = createApp({ identity: dbIdentity(db), store: dbStore(db), tournaments: dbTournamentStore(db), log: (m, e) => console.error(m, e) });
  await new Promise<void>((resolve) => server.http.listen(0, resolve));
  url = `http://localhost:${(server.http.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const c of clients) c.close();
  await server.close();
  await closeDb(db);
});

describe('database storage', () => {
  it('keeps the same player for a browser secret, saves the table and its hands', async () => {
    const host = client('db-host-secret-0123456789');
    const guest = client('db-guest-secret-0123456789');
    const { tableId } = await host.call<{ tableId: string }>('table:create', { settings: { table: { name: 'Saved night' } } });
    await host.call('table:join', { tableId });
    await guest.call('table:join', { tableId });
    const hostId = host.view().me.playerId;

    await host.call('seat:request', { seat: 0, name: 'Host', stack: 100 });
    await guest.call('seat:request', { seat: 1, name: 'Guest', stack: 100 });
    const pending = await host.until((v) => v.requests.length === 1);
    await host.call('host:approve', { requestId: pending.requests[0].id });
    await host.call('host:settings', { patch: { timing: { autoStartNextHand: false } } });
    await host.call('host:start');
    const hv = await host.until((v) => !!v.hand);
    await (hv.legal ? host : guest).call('hand:act', { type: 'fold' });
    await host.until((v) => v.hand?.phase === 'complete');

    // Saves are debounced; give them a moment.
    await new Promise((r) => setTimeout(r, 900));
    const { hands } = await listHandsByTable(db, tableId);
    expect(hands).toHaveLength(1);
    expect(hands[0].number).toBe(1);

    // A second tab of the same browser is the same player.
    const again = client('db-host-secret-0123456789');
    await again.call('table:join', { tableId });
    expect(again.view().me.playerId).toBe(hostId);
    expect(again.view().me.seat).toBe(0);

    // Drop the table from memory: it comes back from its snapshot.
    const rt = server.tables.get(tableId)!;
    server.tables.delete(tableId);
    rt.dispose();
    const back = client('db-guest-secret-0123456789');
    await back.call('table:join', { tableId });
    expect(back.view().name).toBe('Saved night');
    expect(back.view().seats[1]?.name).toBe('Guest');
    expect(back.view().history.map((h) => h.handNumber)).toEqual([1]);
  });

  it('saves a table even if half an emoji got into its state, without it', async () => {
    const host = client('db-surrogate-secret-0123456789');
    const { tableId } = await host.call<{ tableId: string }>('table:create', { settings: { table: { name: 'Odd chat' } } });
    await host.call('table:join', { tableId });
    const store = dbStore(db);
    const state = structuredClone((await store.loadTable(tableId))!);
    state.chat.push({ at: 1, playerId: null, name: 'Dealer \ud83d', text: 'fine 🃏 \udc00 then' });
    await store.saveTable(state);
    const back = (await store.loadTable(tableId))!;
    expect(back.chat.at(-1)).toMatchObject({ name: 'Dealer ', text: 'fine 🃏  then' });
    expect(withoutLoneSurrogates(back)).toBe(back);
  });

  it('saves tournaments, seats their tables in the database and finds them again after a restart', async () => {
    const host = client('db-tn-host-0123456789');
    const p1 = client('db-tn-player1-0123456789');
    const p2 = client('db-tn-player2-0123456789');
    await new Promise((r) => setTimeout(r, 200));
    const { id } = await host.call<{ id: string }>('tournament:create', { settings: tournamentDefaults({ name: 'Saved cup', startingStack: 1500 }) });
    for (const [c, name] of [[p1, 'Ann'], [p2, 'Bob']] as const) {
      await c.call('session:name', { name });
      await c.call('tournament:subscribe', { id });
      await c.call('tournament:command', { id, command: { type: 'register', playerId: 'x', displayName: 'x' } });
    }
    await host.call('tournament:subscribe', { id });
    await host.call('tournament:command', { id, command: { type: 'startNow', by: 'x' } });
    await new Promise((r) => setTimeout(r, 900));

    const store = dbTournamentStore(db);
    const live = await store.listLive();
    const saved = live.find((t) => t.state.id === id)!;
    expect(saved.state.status).toBe('running');
    expect(saved.state.entries.map((e) => e.displayName).sort()).toEqual(['Ann', 'Bob']);
    const tableId = saved.state.tables[0].id.replace(':', '-');
    const snapshot = await dbStore(db).loadTable(tableId);
    expect(snapshot?.settings.table.mode).toBe('tournament');

    // A second server on the same database picks the tournament and its table back up.
    const again = createApp({ identity: dbIdentity(db), store: dbStore(db), tournaments: dbTournamentStore(db), log: (m, e) => console.error(m, e) });
    await again.resume();
    expect(again.tournaments.view(id)?.state.status).toBe('running');
    expect(again.tables.get(tableId)?.state.seats.filter(Boolean)).toHaveLength(2);
    again.tournaments.dispose();
    for (const rt of again.tables.values()) rt.dispose();
  });

  it('never saves a new tournament over one with the same id', async () => {
    const store = dbTournamentStore(db);
    const [host, other] = await Promise.all(['db-tn-same-id-host-0123456789', 'db-tn-same-id-other-0123456789'].map((t) => dbIdentity(db).resolve(t)));
    const state = createTournament({ id: 'feedfacecafebeef', hostId: host.playerId, settings: tournamentDefaults({ name: 'First' }), now: Date.now(), seed: 1 });
    expect(await store.create(state)).toBe(true);
    expect(await store.create({ ...state, hostId: other.playerId, settings: { ...state.settings, name: 'Second' } })).toBe(false);
    expect((await store.load(state.id))!.state).toMatchObject({ hostId: host.playerId, settings: { name: 'First' } });
    // Later saves still replace it.
    await store.save({ ...state, status: 'cancelled' }, null);
    expect((await store.load(state.id))!.state.status).toBe('cancelled');
  });

  it('keeps seasons: a host starts one and adds events, nobody else can, and anyone can read the board', async () => {
    const host = client('db-season-host-0123456789');
    const other = client('db-season-other-0123456789');
    await new Promise((r) => setTimeout(r, 200));
    const first = await host.call<{ id: string }>('tournament:create', { settings: tournamentDefaults({ name: 'Week 1', season: { id: '', name: 'Fall league' } }) });
    const second = await host.call<{ id: string }>('tournament:create', { settings: tournamentDefaults({ name: 'Week 2', season: { id: first.id, name: 'renamed?' } }) });
    await expect(other.call('tournament:create', { settings: tournamentDefaults({ name: 'Sneaky', season: { id: first.id, name: 'x' } }) })).rejects.toThrow(/only the host/);
    await expect(host.call('tournament:create', { settings: tournamentDefaults({ name: 'Lost', season: { id: 'nope', name: 'x' } }) })).rejects.toThrow(/season was not found/);

    const { seasons } = await host.call<{ seasons: { id: string; name: string; events: number }[] }>('season:mine', {});
    expect(seasons).toEqual([{ id: first.id, name: 'Fall league', events: 2 }]);
    expect((await other.call<{ seasons: unknown[] }>('season:mine', {})).seasons).toEqual([]);

    const { board } = await other.call<{ board: { name: string; events: unknown[]; rows: unknown[] } }>('season:get', { id: first.id });
    expect(board).toMatchObject({ name: 'Fall league', events: [], rows: [] });
    await expect(other.call('season:get', { id: 'nope' })).rejects.toThrow(/season not found/);
    expect((await dbTournamentStore(db).listSeason(first.id)).map((s) => s.id).sort()).toEqual([first.id, second.id].sort());
  });
});

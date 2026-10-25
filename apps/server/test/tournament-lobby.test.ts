import type { AddressInfo } from 'node:net';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { variants } from '@rsdp/engine/core';
import { registerAllVariants } from '@rsdp/engine/variants';
import { defaultSettings, type LobbyItem } from '@rsdp/tournament';
import { createApp } from '../src/app';
import { closeDb, type Db } from '../src/db';
import { createTestDb } from '../src/db/testing';
import { dbIdentity, dbStore } from '../src/storage';
import { dbLobbyStore } from '../src/tournament/lobby';
import { dbTournamentStore } from '../src/tournament/store';
import { socketClient, type Client } from './socket-client';

beforeAll(() => registerAllVariants(variants));

let db: Db | undefined;
let server: ReturnType<typeof createApp> | undefined;
const clients: Client[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await server?.close();
  if (db) await closeDb(db);
  server = db = undefined;
});

async function start() {
  db = await createTestDb();
  server = createApp({ identity: dbIdentity(db), store: dbStore(db), tournaments: dbTournamentStore(db), lobby: dbLobbyStore(db), log: (m, e) => console.error(m, e) });
  await new Promise<void>((resolve) => server!.http.listen(0, resolve));
  const url = `http://localhost:${(server.http.address() as AddressInfo).port}`;
  return (token: string) => {
    const c = socketClient(url, token, clients);
    const logs: LobbyItem[][] = [];
    let items: LobbyItem[] = [];
    (c.socket as unknown as { on: (e: string, cb: (x: { items: LobbyItem[]; append: boolean }) => void) => void }).on('tournament:log', ({ items: got, append }) => {
      items = append ? [...items, ...got] : got;
      logs.push(items);
    });
    const until = async (test: (items: LobbyItem[]) => boolean) => {
      for (let i = 0; i < 100 && !test(items); i++) await new Promise((r) => setTimeout(r, 20));
      expect(test(items)).toBe(true);
      return items;
    };
    return { ...c, until, items: () => items };
  };
}

const text = (items: LobbyItem[]) => items.map((x) => (x.kind === 'chat' ? `${x.name}: ${x.text}` : x.event.type));

describe('tournament lobby chat and log', () => {
  it('logs public events and chat, sends them to watchers and keeps them in the database', async () => {
    const client = await start();
    const host = client('lobby-host-secret-000000');
    const ana = client('lobby-ana-secret-0000000');
    await host.call('session:name', { name: 'Host' });
    await ana.call('session:name', { name: 'Ana' });
    const { id } = await host.call<{ id: string }>('tournament:create', { settings: defaultSettings({ name: 'Lobby', registrationApproval: true }) });
    await host.call('tournament:subscribe', { id });
    await ana.call('tournament:command', { id, command: { type: 'register' } });
    // A request waiting for the host is not news; the approval is.
    await host.call('tournament:command', { id, command: { type: 'approve', requestId: 'x' } }).catch(() => {});
    await ana.call('tournament:chat', { id, text: '  good luck all \u0007 ' });
    await expect(ana.call('tournament:chat', { id, text: 'again' })).rejects.toThrow('slow down');
    const seen = await host.until((items) => items.some((x) => x.kind === 'chat'));
    expect(text(seen)).toEqual(['Ana: good luck all']);

    const state = server!.tournaments.view(id)!.state;
    await host.call('tournament:command', { id, command: { type: 'approve', requestId: state.requests[0].id } });
    await host.until((items) => items.some((x) => x.kind === 'event' && x.event.type === 'registered'));

    // A new watcher gets the history.
    const late = client('lobby-late-secret-000000');
    await late.call('tournament:subscribe', { id });
    const history = await late.until((items) => items.length === 2);
    expect(text(history)).toEqual(['Ana: good luck all', 'registered']);
    expect(history[1]).toMatchObject({ kind: 'event', event: { type: 'registered', name: 'Ana' } });
    // Player ids of the log's people are not in events.
    expect(JSON.stringify(history[1])).not.toContain(state.requests[0].playerId);

    // Saved: a fresh server reads it back.
    await server!.close();
    const fresh = createApp({ identity: dbIdentity(db!), store: dbStore(db!), tournaments: dbTournamentStore(db!), lobby: dbLobbyStore(db!) });
    server = fresh;
    await new Promise<void>((resolve) => fresh.http.listen(0, resolve));
    const url = `http://localhost:${(fresh.http.address() as AddressInfo).port}`;
    const again = socketClient(url, 'lobby-late-secret-000000', clients);
    const got = new Promise<LobbyItem[]>((resolve) => (again.socket as unknown as { on: (e: string, cb: (x: { items: LobbyItem[] }) => void) => void }).on('tournament:log', (x) => resolve(x.items)));
    await again.call('tournament:subscribe', { id });
    expect(text(await got)).toEqual(['Ana: good luck all', 'registered']);
  });

  it('needs a name to chat', async () => {
    const client = await start();
    const host = client('lobby-host2-secret-00000');
    const { id } = await host.call<{ id: string }>('tournament:create', { settings: defaultSettings({ name: 'Quiet' }) });
    await expect(host.call('tournament:chat', { id, text: 'hi' })).rejects.toThrow('pick a name');
  });
});

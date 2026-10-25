import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PlayerNote } from '@rsdp/engine/wire';
import { createApp } from '../src/app';
import { closeDb, type Db } from '../src/db';
import { createTestDb } from '../src/db/testing';
import { cleanNote, dbNotes, memoryNotes } from '../src/notes';
import { dbIdentity, dbStore } from '../src/storage';
import { socketClient, type Client } from './socket-client';

let db: Db;
let server: ReturnType<typeof createApp>;
let url = '';
const clients: Client[] = [];
const client = (token: string) => socketClient(url, token, clients);

beforeAll(async () => {
  db = await createTestDb();
  server = createApp({ identity: dbIdentity(db), store: dbStore(db), notes: dbNotes(db), log: (m, e) => console.error(m, e) });
  await new Promise<void>((resolve) => server.http.listen(0, resolve));
  url = `http://localhost:${(server.http.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const c of clients) c.close();
  await server.close();
  await closeDb(db);
});

const me = (c: ReturnType<typeof client>) =>
  new Promise<string>((resolve) => c.socket.once('session', (s) => resolve(s.playerId)));

describe('player notes', () => {
  it('keeps notes private to their owner, syncs the owner\'s tabs, and deletes empty notes', async () => {
    const tab1 = client('notes-owner-0123456789');
    const owner = await me(tab1);
    const tab2 = client('notes-owner-0123456789');
    const other = client('notes-other-0123456789');
    await me(tab2);
    const target = await me(other);
    expect(owner).not.toBe(target);

    const synced = new Promise<PlayerNote[]>((resolve) => tab2.socket.once('notes', resolve));
    let otherGotNotes = false;
    other.socket.on('notes', () => (otherGotNotes = true));

    const { note } = await tab1.call<{ note: PlayerNote }>('notes:set', { targetPlayerId: target, text: '  bluffs rivers ', color: 'red' });
    expect(note).toEqual({ targetPlayerId: target, text: 'bluffs rivers', color: 'red' });
    expect(await synced).toEqual([note]);

    await tab1.call('notes:set', { targetPlayerId: target, text: 'calls everything', color: 'blue' });
    expect((await tab2.call<{ notes: PlayerNote[] }>('notes:list')).notes).toEqual([{ targetPlayerId: target, text: 'calls everything', color: 'blue' }]);
    expect((await other.call<{ notes: PlayerNote[] }>('notes:list')).notes).toEqual([]);
    expect(otherGotNotes).toBe(false);

    const cleared = await tab1.call<{ note: PlayerNote | null }>('notes:set', { targetPlayerId: target, text: '', color: 'none' });
    expect(cleared.note).toBeNull();
    expect((await tab1.call<{ notes: PlayerNote[] }>('notes:list')).notes).toEqual([]);
  });

  it('rejects bad notes', async () => {
    const c = client('notes-bad-0123456789');
    await expect(c.call('notes:set', { targetPlayerId: 'x', text: 'hi', color: 'pink' })).rejects.toThrow(/colour/);
    await expect(c.call('notes:set', { targetPlayerId: 'x', text: 'a'.repeat(501), color: 'none' })).rejects.toThrow(/500/);
    await expect(c.call('notes:set', { text: 'hi', color: 'red' })).rejects.toThrow(/player/);
  });
});

describe('memory notes', () => {
  it('stores, lists and deletes per owner', async () => {
    const store = memoryNotes();
    await store.set('a', cleanNote({ targetPlayerId: 'b', text: 'tight', color: 'green' }));
    await store.set('c', cleanNote({ targetPlayerId: 'b', text: 'loose' }));
    expect(await store.list('a')).toEqual([{ targetPlayerId: 'b', text: 'tight', color: 'green' }]);
    expect(await store.set('a', cleanNote({ targetPlayerId: 'b' }))).toBeNull();
    expect(await store.list('a')).toEqual([]);
    expect(await store.list('c')).toHaveLength(1);
  });
});

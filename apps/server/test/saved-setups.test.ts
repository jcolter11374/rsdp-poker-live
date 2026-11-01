import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { io as connect } from 'socket.io-client';
import { defaultSettings } from '@rsdp/tournament';
import { defaultSettings as defaultTableSettings, exportPreset } from '@rsdp/engine/settings';
import { SETUPS_PER_KIND, type SavedSetup } from '@rsdp/engine/wire';
import { createApp } from '../src/app';
import { closeDb, type Db } from '../src/db';
import { createTestDb, resetTestDb } from '../src/db/testing';
import { dbSetups } from '../src/savedSetups';
import { dbIdentity } from '../src/storage';
import { FakeClock } from './fake-clock';
import type { Client } from './socket-client';

const PHONE = 'guest-secret-phone-aaaaaaaaaaaa';
const LAPTOP = 'guest-secret-laptop-bbbbbbbbbbb';

let db: Db;
let server: ReturnType<typeof createApp>;
let url = '';
const clients: Client[] = [];

beforeAll(async () => {
  db = await createTestDb();
});

beforeEach(async () => {
  await resetTestDb(db);
  const clock = new FakeClock();
  clock.t = Date.now();
  server = createApp({ clock, identity: dbIdentity(db), setups: dbSetups(db), accounts: db, log: (m, e) => console.error(m, e) });
  await new Promise<void>((resolve) => server.http.listen(0, resolve));
  url = `http://localhost:${(server.http.address() as AddressInfo).port}`;
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.disconnect();
  await server.close();
});

afterAll(async () => {
  await closeDb(db);
});

async function post(path: string, body: object, guest: string, session?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-guest-token': guest };
  if (session) headers['x-session-token'] = session;
  const res = await fetch(`${url}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  return (await res.json()) as Record<string, unknown>;
}

/** A browser tab, signed in when given a session. */
async function tab(guest: string, session?: string) {
  const c: Client = connect(url, { auth: { token: guest, session }, transports: ['websocket'], forceNew: true });
  clients.push(c);
  const who = await new Promise<{ playerId: string; account: unknown }>((r) => c.once('session', r));
  const call = <T = object>(event: string, input: object) =>
    new Promise<T>((resolve, reject) =>
      (c.emit as (e: string, ...a: unknown[]) => void)(event, input, (res: { ok: boolean; error?: string } & T) => (res.ok ? resolve(res) : reject(new Error(res.error)))),
    );
  return { socket: c, who, call };
}

async function signedIn() {
  await tab(PHONE);
  const up = await post('/api/account/signup', { username: 'Mike', password: 'correct horse' }, PHONE);
  return { session: up.session as string, phone: await tab(PHONE, up.session as string) };
}

const structure = (name = 'Friday turbo') => JSON.stringify(defaultSettings({ name }));
const preset = (name = 'x') => exportPreset(defaultTableSettings('cash'), name);

describe('saved setups', () => {
  it('are for signed-in players; a guest is told to sign in', async () => {
    const guest = await tab(LAPTOP);
    await expect(guest.call('setups:save', { kind: 'tournament', name: 'Mine', json: structure() })).rejects.toThrow(/sign in/);
    await expect(guest.call('setups:list', { kind: 'tournament' })).rejects.toThrow(/sign in/);
  });

  it('save, rename and delete, and every tab and device of the account sees the change', async () => {
    const { phone } = await signedIn();
    const signIn = await post('/api/account/signin', { username: 'Mike', password: 'correct horse', bringOver: false }, LAPTOP);
    const laptop = await tab(LAPTOP, signIn.session as string);
    expect(laptop.who.playerId).toBe(phone.who.playerId);
    const pushed = new Promise<{ kind: string; setups: SavedSetup[] }>((r) => laptop.socket.once('setups', r));

    expect(await phone.call('setups:save', { kind: 'tournament', name: '  Friday   turbo ', json: structure() })).toMatchObject({ name: 'Friday turbo' });
    expect(await pushed).toMatchObject({ kind: 'tournament', setups: [{ name: 'Friday turbo' }] });
    const { setups } = await laptop.call<{ setups: SavedSetup[] }>('setups:list', { kind: 'tournament' });
    expect(JSON.parse(setups[0]!.json)).toMatchObject({ name: 'Friday turbo', startingStack: 10_000 });
    // Table presets are a separate list.
    expect((await laptop.call<{ setups: SavedSetup[] }>('setups:list', { kind: 'table' })).setups).toEqual([]);

    await phone.call('setups:save', { kind: 'tournament', name: 'Deep', json: structure('Deep') });
    await expect(phone.call('setups:rename', { kind: 'tournament', from: 'Deep', to: 'Friday turbo' })).rejects.toThrow(/already have one/);
    await expect(phone.call('setups:rename', { kind: 'tournament', from: 'Nope', to: 'Other' })).rejects.toThrow(/gone/);
    expect(await phone.call('setups:rename', { kind: 'tournament', from: 'Deep', to: 'Sunday deep' })).toMatchObject({ name: 'Sunday deep' });
    await phone.call('setups:delete', { kind: 'tournament', name: 'Friday turbo' });
    expect((await laptop.call<{ setups: SavedSetup[] }>('setups:list', { kind: 'tournament' })).setups.map((s) => s.name)).toEqual(['Sunday deep']);
  });

  it('a renamed table preset carries its new name inside, so its export file says so', async () => {
    const { phone } = await signedIn();
    await phone.call('setups:save', { kind: 'table', name: 'PLO', json: preset('whatever') });
    await phone.call('setups:rename', { kind: 'table', from: 'PLO', to: 'Friday PLO' });
    const { setups } = await phone.call<{ setups: SavedSetup[] }>('setups:list', { kind: 'table' });
    expect(setups.map((s) => [s.name, JSON.parse(s.json).name])).toEqual([['Friday PLO', 'Friday PLO']]);
  });

  it('refuses setups that are not one, and names that are blank or too long', async () => {
    const { phone } = await signedIn();
    await expect(phone.call('setups:save', { kind: 'table', name: 'X', json: '{}' })).rejects.toThrow();
    await expect(phone.call('setups:save', { kind: 'tournament', name: 'X', json: JSON.stringify({ ...defaultSettings(), seatsPerTable: 40 }) })).rejects.toThrow(/Seats per table/);
    await expect(phone.call('setups:save', { kind: 'tournament', name: 'X', json: 'nope' })).rejects.toThrow(/damaged/);
    await expect(phone.call('setups:save', { kind: 'tournament', name: '   ', json: structure() })).rejects.toThrow(/name/);
    await expect(phone.call('setups:save', { kind: 'tournament', name: 'x'.repeat(61), json: structure() })).rejects.toThrow(/60/);
    await expect(phone.call('setups:save', { kind: 'cash', name: 'X', json: structure() })).rejects.toThrow(/kind/);
  });

  it('brings a browser’s setups onto the account on sign-in, numbering a name already taken and skipping repeats and junk', async () => {
    const { phone } = await signedIn();
    await phone.call('setups:save', { kind: 'tournament', name: 'Turbo', json: structure('A') });
    const r = await phone.call<{ added: number; kept: string[] }>('setups:import', {
      kind: 'tournament',
      setups: [
        { name: 'Turbo', json: structure('B') },
        { name: 'Turbo', json: structure('A') },
        { name: 'Deep', json: structure('Deep') },
        { name: 'Bad', json: '{' },
      ],
    });
    expect(r.added).toBe(2);
    // The junk one is not kept, so the browser holds on to it.
    expect(r.kept).toEqual(['Turbo', 'Turbo', 'Deep']);
    const { setups } = await phone.call<{ setups: SavedSetup[] }>('setups:list', { kind: 'tournament' });
    expect(setups.map((s) => [s.name, JSON.parse(s.json).name])).toEqual([
      ['Deep', 'Deep'],
      ['Turbo', 'A'],
      ['Turbo (2)', 'B'],
    ]);
  });

  it('a table preset numbered on the way onto the account carries its new name inside', async () => {
    const { phone } = await signedIn();
    const long = '🂡'.repeat(30);
    const settings = defaultTableSettings('cash');
    const other = (name: string) => exportPreset({ ...settings, table: { ...settings.table, maxSeats: 6 } }, name);
    await phone.call('setups:save', { kind: 'table', name: 'Friday', json: preset('Friday') });
    await phone.call('setups:save', { kind: 'table', name: long, json: preset(long) });
    const r = await phone.call<{ added: number }>('setups:import', {
      kind: 'table',
      setups: [
        { name: 'Friday', json: other('Friday') },
        { name: long, json: other(long) },
      ],
    });
    expect(r.added).toBe(2);
    const { setups } = await phone.call<{ setups: SavedSetup[] }>('setups:list', { kind: 'table' });
    for (const s of setups) expect(JSON.parse(s.json).name).toBe(s.name);
    expect(setups.map((s) => s.name).sort()).toEqual(['Friday', 'Friday (2)', long, `${'🂡'.repeat(28)} (2)`].sort());
  });

  it('a structure a browser kept under a name now too long is brought over with the name shortened, not left behind', async () => {
    const { phone } = await signedIn();
    const r = await phone.call<{ added: number; kept: string[] }>('setups:import', { kind: 'tournament', setups: [{ name: '🂡'.repeat(40), json: structure() }] });
    expect(r).toMatchObject({ added: 1, kept: ['🂡'.repeat(40)] });
    const { setups } = await phone.call<{ setups: SavedSetup[] }>('setups:list', { kind: 'tournament' });
    expect(setups.map((s) => s.name)).toEqual(['🂡'.repeat(30)]);
  });

  it(`keeps up to ${SETUPS_PER_KIND} of each kind`, async () => {
    const { phone } = await signedIn();
    const many = Array.from({ length: SETUPS_PER_KIND }, (_, i) => ({ name: `S${i}`, json: structure() }));
    expect((await phone.call<{ added: number }>('setups:import', { kind: 'tournament', setups: many })).added).toBe(SETUPS_PER_KIND);
    await expect(phone.call('setups:save', { kind: 'tournament', name: 'One more', json: structure() })).rejects.toThrow(/up to/);
    // Bringing more over when full keeps none of them, so the browser keeps them all.
    const full = await phone.call<{ added: number; kept: string[] }>('setups:import', { kind: 'tournament', setups: [{ name: 'Extra', json: structure() }] });
    expect(full).toMatchObject({ added: 0, kept: [] });
    // Several tabs saving at once can't pass the limit.
    await phone.call('setups:delete', { kind: 'tournament', name: 'S1' });
    const race = await Promise.allSettled(['A', 'B', 'C'].map((n) => phone.call('setups:save', { kind: 'tournament', name: n, json: structure() })));
    expect(race.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    // Replacing one is fine.
    await phone.call('setups:save', { kind: 'tournament', name: 'S0', json: structure('Again') });
  });

  it('are deleted with the account', async () => {
    const { session, phone } = await signedIn();
    await phone.call('setups:save', { kind: 'tournament', name: 'Turbo', json: structure() });
    expect((await post('/api/account/delete', { password: 'correct horse' }, PHONE, session)).ok).toBe(true);
    expect(await dbSetups(db).list(phone.who.playerId, 'tournament')).toEqual([]);
  });
});

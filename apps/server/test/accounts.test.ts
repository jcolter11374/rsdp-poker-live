import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { io as connect } from 'socket.io-client';
import { variants } from '@rsdp/engine/core';
import { registerAllVariants } from '@rsdp/engine/variants';
import { defaultSettings } from '@rsdp/tournament';
import { createApp } from '../src/app';
import { closeDb, createTable, loadSnapshot, saveHand, saveSnapshot, tablesSeatingInSaves, type Db } from '../src/db';
import { createTestDb, resetTestDb } from '../src/db/testing';
import { dbAvatars } from '../src/avatars';
import { dbNotes } from '../src/notes';
import { RUNTIME_VERSION, type RuntimeState } from '../src/runtime/types';
import { dbIdentity, dbStore } from '../src/storage';
import { getPlayer } from '../src/identity';
import { FakeClock } from './fake-clock';
import { socketClient, type Client } from './socket-client';

const KEY = 'test-admin-key-0123456789';
const PHONE = 'guest-secret-phone-aaaaaaaaaaaa';
const LAPTOP = 'guest-secret-laptop-bbbbbbbbbbb';

let db: Db;
let clock: FakeClock;
let server: ReturnType<typeof createApp>;
let url = '';
const clients: Client[] = [];

beforeAll(async () => {
  registerAllVariants(variants);
  db = await createTestDb();
});

beforeEach(async () => {
  await resetTestDb(db);
  clock = new FakeClock();
  // Sessions on the socket are checked against the real time.
  clock.t = Date.now();
  server = createApp({ clock, identity: dbIdentity(db), notes: dbNotes(db), avatars: dbAvatars(db), accounts: db, adminKey: KEY, log: (m, e) => console.error(m, e) });
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

type Res = { status: number; body: Record<string, unknown> };
async function post(path: string, body: object, h: { guest?: string; session?: string; ip?: string; admin?: string } = {}): Promise<Res> {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'fly-client-ip': h.ip ?? '203.0.113.1' };
  if (h.guest) headers['x-guest-token'] = h.guest;
  if (h.session) headers['x-session-token'] = h.session;
  if (h.admin) headers['x-admin-key'] = h.admin;
  const res = await fetch(`${url}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
async function me(guest: string, session?: string) {
  const headers: Record<string, string> = { 'x-guest-token': guest };
  if (session) headers['x-session-token'] = session;
  return (await (await fetch(`${url}/api/account/me`, { headers })).json()) as {
    playerId: string;
    displayName: string;
    account: { username: string; devices: number } | null;
    tables: { tableId: string; name: string; hands: number; net: number | null }[];
  };
}

/** Connects like the web app does and waits for the session message. */
function sessionOf(guest: string, session?: string) {
  const c = connect(url, { auth: { token: guest, session }, transports: ['websocket'], forceNew: true });
  clients.push(c);
  return new Promise<{ playerId: string; displayName: string; account: { username: string } | null; avatar?: string | null }>((resolve) => c.once('session', resolve));
}

const signUp = (guest: string, username = 'Mike', password = 'correct horse') => post('/api/account/signup', { username, password }, { guest });
const signIn = (guest: string, username = 'Mike', password = 'correct horse', ip?: string, bringOver = true) => post('/api/account/signin', { username, password, bringOver }, { guest, ip });

describe('accounts', () => {
  it('signing up keeps the guest player, so everything played so far stays', async () => {
    const before = await sessionOf(PHONE);
    const up = await signUp(PHONE);
    expect(up.status).toBe(200);
    expect(up.body).toMatchObject({ ok: true, username: 'Mike' });
    const after = await sessionOf(PHONE, up.body.session as string);
    expect(after).toMatchObject({ playerId: before.playerId, account: { username: 'Mike' } });
    // The browser that made the account stays signed in even without its session.
    expect((await sessionOf(PHONE)).account).toEqual({ username: 'Mike' });
  });

  it('refuses taken usernames (ignoring case), bad usernames and short passwords', async () => {
    await signUp(PHONE);
    expect((await signUp(LAPTOP, 'mike')).status).toBe(409);
    expect((await signUp(LAPTOP, 'a b')).body.error).toMatch(/Usernames are/);
    expect((await signUp(LAPTOP, 'Bo_99', 'short')).body.error).toMatch(/at least 8/);
    expect((await signUp(LAPTOP, 'Bo_99')).status).toBe(200);
  });

  it('signing in on another device plays as the account and brings that guest’s notes and picture along', async () => {
    const phone = socketClient(url, PHONE, clients);
    const phoneSession = await new Promise<{ playerId: string }>((r) => phone.socket.once('session', r));
    await phone.call('session:name', { name: 'Mike' });
    await signUp(PHONE);

    const laptop = socketClient(url, LAPTOP, clients);
    await new Promise((r) => laptop.socket.once('session', r));
    await laptop.call('notes:set', { targetPlayerId: 'villain', text: 'bluffs rivers', color: 'red' });
    await laptop.call('avatar:set', { library: Object.keys((await import('@rsdp/engine/wire')).AVATARS)[0] });

    const signedIn = await signIn(LAPTOP);
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.broughtOver).toBe(true);
    const session = await sessionOf(LAPTOP, signedIn.body.session as string);
    expect(session).toMatchObject({ playerId: phoneSession.playerId, displayName: 'Mike', account: { username: 'Mike' } });
    expect(session.avatar).toMatch(/^lib:/);
    const notes = await dbNotes(db).list(phoneSession.playerId);
    expect(notes).toMatchObject([{ targetPlayerId: 'villain', text: 'bluffs rivers', color: 'red' }]);
    expect((await me(LAPTOP, signedIn.body.session as string)).account).toMatchObject({ username: 'Mike', devices: 2 });
  });

  it('pauses sign-in after 10 wrong passwords from one address, without locking the owner out elsewhere', async () => {
    await signUp(PHONE);
    for (let i = 0; i < 10; i++) expect((await signIn(LAPTOP, 'Mike', 'wrong password')).status).toBe(401);
    expect((await signIn(LAPTOP)).status).toBe(429);
    // Someone guessing from one address can't keep the real Mike out from his own.
    expect((await signIn(LAPTOP, 'Mike', 'correct horse', '198.51.100.7')).status).toBe(200);
    clock.advance(15 * 60_000 + 1);
    await post('/api/account/signout', {}, { guest: LAPTOP });
    expect((await signIn('guest-secret-tablet-cccccccccccc')).status).toBe(200);
    // A dozen password checks take a few seconds on a busy machine.
  }, 20_000);

  it('on a friend’s device, signing in without bringing anything over leaves their guest alone', async () => {
    await signUp(PHONE);
    const friend = socketClient(url, LAPTOP, clients);
    const before = await new Promise<{ playerId: string }>((r) => friend.socket.once('session', r));
    await friend.call('notes:set', { targetPlayerId: 'villain', text: 'friend’s note', color: 'none' });
    const { body } = await signIn(LAPTOP, 'Mike', 'correct horse', undefined, false);
    expect(body.broughtOver).toBe(false);
    expect((await me(LAPTOP, body.session as string)).account?.devices).toBe(1);
    const out = await post('/api/account/signout', {}, { guest: LAPTOP, session: body.session as string });
    expect(out.body.forgot).toBe(false);
    expect((await sessionOf(LAPTOP)).playerId).toBe(before.playerId);
    expect(await dbNotes(db).list(before.playerId)).toMatchObject([{ text: 'friend’s note' }]);
  });

  it('refuses to sign in to a second account while signed in', async () => {
    const { body } = await signUp(PHONE);
    await signUp(LAPTOP, 'Bo_99');
    expect((await post('/api/account/signin', { username: 'Bo_99', password: 'correct horse' }, { guest: PHONE, session: body.session as string })).status).toBe(409);
  });

  it('won’t sign in on a device whose guest has a seat, so the seat and its chips aren’t left behind', async () => {
    await signUp(PHONE);
    const laptop = socketClient(url, LAPTOP, clients);
    const guest = await new Promise<{ playerId: string }>((r) => laptop.socket.once('session', r));
    const { tableId } = await laptop.call<{ tableId: string }>('table:create', { settings: { table: { name: 'Kitchen' }, seating: { requireApproval: false }, timing: { autoStartNextHand: false } } });
    await laptop.call('table:join', { tableId });
    await laptop.call('seat:request', { seat: 0, name: 'Guest', stack: 100 });

    const refused = await signIn(LAPTOP);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/Kitchen/);
    expect(refused.body.error).toMatch(/stand up/i);
    // A link to the table, since names need not be unique and it may be one the player has lost.
    expect(refused.body).toMatchObject({ code: 'seated', href: `/t/${tableId}` });
    expect(refused.body.session).toBeUndefined();
    // Nothing changed: the browser still plays as its guest, which keeps the seat.
    expect((await me(LAPTOP)).account).toBeNull();
    expect(server.tables.get(tableId)!.seatOf(guest.playerId)).toBeTruthy();

    laptop.socket.emit('seat:stand', {});
    await laptop.until((v) => v.seats.every((x) => !x));
    expect((await signIn(LAPTOP)).status).toBe(200);
  });

  it('also counts a seat at a table that was put away while nobody had it open', async () => {
    // A server that saves tables to the database, as the real one does.
    await server.close();
    server = createApp({ clock, identity: dbIdentity(db), store: dbStore(db), accounts: db, idleUnloadMs: 60_000, log: (m, e) => console.error(m, e) });
    await new Promise<void>((resolve) => server.http.listen(0, resolve));
    url = `http://localhost:${(server.http.address() as AddressInfo).port}`;
    await signUp(PHONE);
    const laptop = socketClient(url, LAPTOP, clients);
    await new Promise((r) => laptop.socket.once('session', r));
    const { tableId } = await laptop.call<{ tableId: string }>('table:create', { settings: { table: { name: 'Garage' }, seating: { requireApproval: false }, timing: { autoStartNextHand: false } } });
    await laptop.call('table:join', { tableId });
    await laptop.call('seat:request', { seat: 0, name: 'Guest', stack: 100 });
    await laptop.until((v) => v.seats.some((x) => !!x));
    laptop.socket.disconnect();
    await vi.waitFor(() => {
      clock.advance(61_000);
      expect(server.unloadIdle()).toEqual([tableId]);
    });
    await vi.waitFor(async () => expect((await loadSnapshot<RuntimeState>(db, tableId))?.state.seats.some(Boolean)).toBe(true));

    const refused = await signIn(LAPTOP);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/Garage/);
    expect(refused.body.href).toBe(`/t/${tableId}`);

    // Following the link opens the table again, and standing up there lets the sign-in through.
    const back = socketClient(url, LAPTOP, clients);
    await new Promise((r) => back.socket.once('session', r));
    await back.call('table:join', { tableId });
    back.socket.emit('seat:stand', {});
    await back.until((v) => v.seats.every((x) => !x));
    expect((await signIn(LAPTOP)).status).toBe(200);
  });

  it('won’t sign in on a device whose guest is on a waitlist or has a seat held for it, and links to the table', async () => {
    await signUp(PHONE);
    const laptop = socketClient(url, LAPTOP, clients);
    const guest = await new Promise<{ playerId: string }>((r) => laptop.socket.once('session', r));
    const { tableId } = await laptop.call<{ tableId: string }>('table:create', {
      settings: { table: { name: 'Porch', maxSeats: 2 }, seating: { requireApproval: false, waitlist: true }, timing: { autoStartNextHand: false } },
    });
    await laptop.call('table:join', { tableId });
    const rt = server.tables.get(tableId)!;
    rt.requestSeat('ann', { seat: 0, name: 'Ann', stack: 100 });
    rt.requestSeat('bo', { seat: 1, name: 'Bo', stack: 100 });
    await laptop.call('waitlist:join', { name: 'Guest', stack: 100 });
    expect(rt.state.waitlist!.map((w) => w.playerId)).toEqual([guest.playerId]);

    const refused = await signIn(LAPTOP);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/Porch/);
    expect(refused.body.error).toMatch(/waitlist/);
    expect(refused.body).toMatchObject({ code: 'seated', href: `/t/${tableId}` });

    // A seat held for the guest from the waitlist counts too.
    rt.stand('bo');
    expect(rt.state.offers!.map((o) => o.playerId)).toEqual([guest.playerId]);
    rt.state.waitlist = [];
    expect((await signIn(LAPTOP)).status).toBe(409);

    rt.state.offers = [];
    expect((await signIn(LAPTOP)).status).toBe(200);
  });

  it('counts a waitlist place or a held seat in a put-away table’s last save, but not someone else’s', async () => {
    const host = (await sessionOf(PHONE)).playerId;
    const save = async (id: string, name: string, state: Partial<RuntimeState>) => {
      await createTable(db, { id, ownerPlayerId: host, settings: { table: { name } }, mode: 'cash' });
      await saveSnapshot(db, id, { version: RUNTIME_VERSION, state: { settings: { table: { name } }, seats: [], requests: [], ...state } });
    };
    await save('t-line', 'Line', { waitlist: [{ playerId: 'me', name: 'Me', stack: 100, at: 0 }] });
    await save('t-held', 'Held', { offers: [{ seat: 1, playerId: 'me', expiresAt: 0 }] });
    await save('t-sat', 'Sat', { seats: [{ playerId: 'me' } as never] });
    await save('t-other', 'Other', { waitlist: [{ playerId: 'you', name: 'You', stack: 100, at: 0 }] });
    const found = await tablesSeatingInSaves(db, 'me', RUNTIME_VERSION);
    expect(found.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: 't-held', name: 'Held', seated: false },
      { id: 't-line', name: 'Line', seated: false },
      { id: 't-sat', name: 'Sat', seated: true },
    ]);
  });

  it('won’t sign in on a device whose guest is entered in a tournament that isn’t over', async () => {
    await signUp(PHONE);
    const laptop = socketClient(url, LAPTOP, clients);
    await new Promise((r) => laptop.socket.once('session', r));
    const { id } = await laptop.call<{ id: string }>('tournament:create', { settings: defaultSettings({ name: 'Sunday Cup', startingStack: 1500 }) });
    await laptop.call('tournament:command', { id, command: { type: 'register', displayName: 'Guest' } });

    const refused = await signIn(LAPTOP);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/Sunday Cup/);
    expect(refused.body.href).toBe(`/tn/${id}`);
    expect((await me(LAPTOP)).account).toBeNull();

    await laptop.call('tournament:command', { id, command: { type: 'unregister' } });
    expect((await signIn(LAPTOP)).status).toBe(200);
  });

  it('signing out ends the session and the device starts over as a new guest', async () => {
    const before = await sessionOf(PHONE);
    const { body } = await signUp(PHONE);
    expect((await post('/api/account/signout', {}, { guest: PHONE, session: body.session as string })).status).toBe(200);
    const after = await sessionOf(PHONE, body.session as string);
    expect(after.account).toBeNull();
    expect(after.playerId).not.toBe(before.playerId);
  });

  it('signing out as a plain guest changes nothing', async () => {
    const before = await sessionOf(PHONE);
    await post('/api/account/signout', {}, { guest: PHONE });
    expect((await sessionOf(PHONE)).playerId).toBe(before.playerId);
  });

  it('changing the password needs the old one and signs other devices out', async () => {
    const { body } = await signUp(PHONE);
    const laptop = (await signIn(LAPTOP)).body.session as string;
    const open = connect(url, { auth: { token: LAPTOP, session: laptop }, transports: ['websocket'], forceNew: true });
    clients.push(open);
    await new Promise((r) => open.once('session', r));
    const dropped = new Promise((r) => open.once('disconnect', r));
    expect((await post('/api/account/password', { current: 'nope', password: 'new password 1' }, { guest: PHONE, session: body.session as string })).status).toBe(401);
    expect((await post('/api/account/password', { current: 'correct horse', password: 'new password 1' }, { guest: PHONE, session: body.session as string })).status).toBe(200);
    await dropped;
    expect((await sessionOf(LAPTOP, laptop)).account).toBeNull();
    expect((await sessionOf(PHONE, body.session as string)).account).toEqual({ username: 'Mike' });
    expect((await sessionOf(PHONE)).account).toEqual({ username: 'Mike' });
    expect((await signIn(LAPTOP, 'Mike', 'new password 1')).status).toBe(200);
  });

  it('resets a forgotten password with a one-time code from the admin', async () => {
    await signUp(PHONE);
    const laptop = (await signIn(LAPTOP)).body.session as string;
    expect((await post('/api/admin/accounts/reset-code', { username: 'mike' }, { admin: 'wrong-key-0123456789' })).status).toBe(401);
    expect((await post('/api/admin/accounts/reset-code', { username: 'nobody' }, { admin: KEY })).status).toBe(404);
    const issued = await post('/api/admin/accounts/reset-code', { username: 'mike' }, { admin: KEY });
    expect(issued.body).toMatchObject({ username: 'Mike', code: expect.stringMatching(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/) });
    const code = issued.body.code as string;

    expect((await post('/api/account/reset', { username: 'Mike', code: 'AAAA-BBBB-CCCC', password: 'brand new pw' })).status).toBe(401);
    // Typed in lower case without dashes still works.
    expect((await post('/api/account/reset', { username: 'Mike', code: code.toLowerCase().replace(/-/g, ''), password: 'brand new pw' })).status).toBe(200);
    expect((await post('/api/account/reset', { username: 'Mike', code, password: 'another new pw' })).status).toBe(401);
    expect((await sessionOf(LAPTOP, laptop)).account).toBeNull();
    // The device that made the account is signed out too, and starts over as a new guest.
    expect((await sessionOf(PHONE)).account).toBeNull();
    expect((await signIn(LAPTOP, 'Mike', 'brand new pw')).status).toBe(200);
  });

  it('reset codes expire after a day', async () => {
    await signUp(PHONE);
    const { code } = (await post('/api/admin/accounts/reset-code', { username: 'Mike' }, { admin: KEY })).body as { code: string };
    clock.advance(24 * 60 * 60_000 + 1);
    expect((await post('/api/account/reset', { username: 'Mike', code, password: 'brand new pw' })).status).toBe(401);
  });

  it('deleting the account needs the password, then wipes the name and sign-in', async () => {
    const phone = socketClient(url, PHONE, clients);
    const { playerId } = await new Promise<{ playerId: string }>((r) => phone.socket.once('session', r));
    await phone.call('session:name', { name: 'Mike' });
    const { body } = await signUp(PHONE);
    const session = body.session as string;
    expect((await post('/api/account/delete', { password: 'wrong' }, { guest: PHONE, session })).status).toBe(401);
    const gone = new Promise((r) => phone.socket.once('disconnect', r));
    expect((await post('/api/account/delete', { password: 'correct horse' }, { guest: PHONE, session })).status).toBe(200);
    await gone;
    expect((await getPlayer(db, playerId))?.displayName).toBe('');
    expect((await signIn(LAPTOP)).status).toBe(401);
    const fresh = await sessionOf(PHONE, session);
    expect(fresh.account).toBeNull();
    expect(fresh.playerId).not.toBe(playerId);
  });

  it('shows the cash tables you played, across your devices, with your result from the ledger', async () => {
    const phone = await sessionOf(PHONE);
    const { body } = await signUp(PHONE);
    const laptop = await sessionOf(LAPTOP);
    for (const [id, pid, name, buyIn, stack] of [
      ['t1', phone.playerId, 'Friday game', 200, 350],
      ['t2', laptop.playerId, 'Laptop game', 100, 40],
    ] as const) {
      await createTable(db, { id, ownerPlayerId: pid, settings: { table: { name } }, mode: 'cash' });
      await saveHand(db, { id: `${id}-h1`, tableId: id, number: 1, gameId: 'nlhe', startedAt: new Date(), endedAt: new Date(), header: { seats: [{ seat: 0, playerId: pid }] }, events: [], results: {} });
      await saveSnapshot(db, id, { version: 1, state: { ledger: { [pid]: { buyIn, cashOut: 0 } }, seats: [{ playerId: pid, stack }], settings: { stakes: { centsMode: false } } } });
    }
    // Before signing in on the laptop, the account sees only its own table.
    expect((await me(PHONE, body.session as string)).tables.map((t) => t.name)).toEqual(['Friday game']);
    const session = (await signIn(LAPTOP)).body.session as string;
    const tables = (await me(LAPTOP, session)).tables;
    expect(tables.map((t) => [t.name, t.hands, t.net]).sort()).toEqual([
      ['Friday game', 1, 150],
      ['Laptop game', 1, -60],
    ]);
  });

  it('says accounts are unavailable without a database', async () => {
    const bare = createApp({ clock });
    await new Promise<void>((resolve) => bare.http.listen(0, resolve));
    const res = await fetch(`http://localhost:${(bare.http.address() as AddressInfo).port}/api/account/me`, { headers: { 'x-guest-token': PHONE } });
    expect(res.status).toBe(503);
    await bare.close();
  });
});

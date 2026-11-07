// Phone alerts (push/alerts.ts): turning them on and off, who they go to,
// the visibility rule for "your turn", the four alerts the server sends, and
// what happens to a subscription that has gone (404, 410), signed out, sat
// unused, or belonged to a deleted account. The push services are faked:
// nothing here leaves the machine.

import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { variants } from '@rsdp/engine/core';
import { registerAllVariants } from '@rsdp/engine/variants';
import type { TableView } from '@rsdp/engine/wire';
import { defaultSettings, type TournamentState } from '@rsdp/tournament';
import { createApp, TURN_ALERT_DELAY_MS } from '../src/app';
import { closeDb, queryRows, prunePushSubscriptions, pushTargetsOf, savePushSubscription, vapidKeys, type Db } from '../src/db';
import { createTestDb, resetTestDb } from '../src/db/testing';
import { createAccount, deleteAccount, forgetToken, hashSecret, login, logout, resolveToken } from '../src/identity';
import { dbPushStore, memoryPushStore, PUSH_DEVICES_MAX, PUSH_KEEP_MS } from '../src/push/alerts';
import { START_LEAD_MS, StartAlerts } from '../src/push/starts';
import { dbIdentity } from '../src/storage';
import { FakeClock } from './fake-clock';
import { browser, fakePushService, opened, verifies } from './push-helpers';
import { socketClient, type Client } from './socket-client';

const SITE = 'https://poker.example';
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

beforeAll(() => registerAllVariants(variants));

type Res = { status: number; body: Record<string, unknown> };
async function request(url: string, method: 'GET' | 'POST', path: string, body?: object, h: { guest?: string; session?: string } = {}): Promise<Res> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (h.guest) headers['x-guest-token'] = h.guest;
  if (h.session) headers['x-session-token'] = h.session;
  const res = await fetch(`${url}${path}`, { method, headers, body: body && JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function listen(server: ReturnType<typeof createApp>) {
  await new Promise<void>((resolve) => server.http.listen(0, resolve));
  return `http://localhost:${(server.http.address() as AddressInfo).port}`;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('phone alerts on the database', () => {
  let db: Db;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await closeDb(db);
  });
  afterEach(async () => {
    await resetTestDb(db);
  });

  const row = (endpoint: string, playerId: string, device: string, extra: { session?: string | null; seenAt?: Date } = {}) => ({
    endpoint,
    playerId,
    device,
    session: extra.session ?? null,
    p256dh: 'BKey',
    auth: 'auth',
    seenAt: extra.seenAt ?? new Date(),
  });

  it('makes the VAPID key pair once and keeps it', async () => {
    const first = await vapidKeys(db);
    expect(Buffer.from(first.publicKey, 'base64url')).toHaveLength(65);
    expect(await vapidKeys(db)).toEqual(first);
    expect(await dbPushStore(db).keys()).toEqual(first);
  });

  it("adds and refreshes a browser's subscription, and keeps at most the player's newest few", async () => {
    const me = await resolveToken(db, 'push-guest-secret-0001');
    const device = hashSecret('push-guest-secret-0001');
    const t0 = Date.now() - DAY;
    for (let i = 0; i <= PUSH_DEVICES_MAX; i++) await savePushSubscription(db, row(`https://fcm.googleapis.com/fcm/send/${i}`, me.id, device, { seenAt: new Date(t0 + i * MINUTE) }), PUSH_DEVICES_MAX);
    const kept = (await pushTargetsOf(db, me.id, new Date())).map((t) => t.endpoint).sort();
    expect(kept).toHaveLength(PUSH_DEVICES_MAX);
    // The least recently seen went.
    expect(kept).not.toContain('https://fcm.googleapis.com/fcm/send/0');
    // Seeing it again brings it back up to date rather than adding another.
    await savePushSubscription(db, { ...row('https://fcm.googleapis.com/fcm/send/5', me.id, device), p256dh: 'BNew' }, PUSH_DEVICES_MAX);
    const again = await pushTargetsOf(db, me.id, new Date());
    expect(again).toHaveLength(PUSH_DEVICES_MAX);
    expect(again.find((t) => t.endpoint.endsWith('/5'))?.p256dh).toBe('BNew');
  });

  it('alerts only browsers that still play as the player, and forgets the rest', async () => {
    const now = new Date();
    // My phone made the account; a friend's phone signed in to it without becoming mine.
    const mine = await resolveToken(db, 'push-my-phone-secret-01');
    const friend = await resolveToken(db, 'push-friends-phone-secret');
    await createAccount(db, 'pushy', 'correct horse', mine.id);
    const { token } = await login(db, 'pushy', 'correct horse');
    await savePushSubscription(db, row('https://fcm.googleapis.com/fcm/send/mine', mine.id, hashSecret('push-my-phone-secret-01')), PUSH_DEVICES_MAX);
    await savePushSubscription(db, row('https://web.push.apple.com/friend', mine.id, hashSecret('push-friends-phone-secret'), { session: hashSecret(token) }), PUSH_DEVICES_MAX);
    // The friend's own alerts, as their guest.
    await savePushSubscription(db, row('https://web.push.apple.com/friend-own', friend.id, hashSecret('push-friends-phone-secret')), PUSH_DEVICES_MAX);
    const endpoints = async (id: string) => (await pushTargetsOf(db, id, now)).map((t) => t.endpoint).sort();
    expect(await endpoints(mine.id)).toEqual(['https://fcm.googleapis.com/fcm/send/mine', 'https://web.push.apple.com/friend']);

    // Signing out on the friend's phone ends the session: my alerts stop there, the friend's own carry on.
    await logout(db, token);
    expect(await endpoints(mine.id)).toEqual(['https://fcm.googleapis.com/fcm/send/mine']);
    expect(await endpoints(friend.id)).toEqual(['https://web.push.apple.com/friend-own']);
    expect(await prunePushSubscriptions(db, new Date(now.getTime() - PUSH_KEEP_MS), now)).toBe(1);

    // A browser secret that is forgotten (signing out on my own phone) takes its alerts with it.
    await forgetToken(db, 'push-my-phone-secret-01');
    expect(await endpoints(mine.id)).toEqual([]);
  });

  it("stops alerting a browser whose session ran out, and forgets browsers that haven't opened the site for 60 days", async () => {
    const owner = await resolveToken(db, 'push-owner-secret-000001');
    await resolveToken(db, 'push-borrowed-secret-0001');
    await createAccount(db, 'expiring', 'correct horse', owner.id);
    const { token } = await login(db, 'expiring', 'correct horse', { ttlMs: MINUTE });
    const now = Date.now();
    await savePushSubscription(db, row('https://fcm.googleapis.com/fcm/send/borrowed', owner.id, hashSecret('push-borrowed-secret-0001'), { session: hashSecret(token) }), PUSH_DEVICES_MAX);
    await savePushSubscription(db, row('https://fcm.googleapis.com/fcm/send/old', owner.id, hashSecret('push-owner-secret-000001'), { seenAt: new Date(now - PUSH_KEEP_MS - MINUTE) }), PUSH_DEVICES_MAX);
    expect(await pushTargetsOf(db, owner.id, new Date(now))).toHaveLength(2);
    expect(await pushTargetsOf(db, owner.id, new Date(now + 2 * MINUTE))).toHaveLength(1);
    expect(await prunePushSubscriptions(db, new Date(now + 2 * MINUTE - PUSH_KEEP_MS), new Date(now + 2 * MINUTE))).toBe(2);
    expect(await pushTargetsOf(db, owner.id, new Date(now))).toEqual([]);
  });

  it("deleting an account removes its alerts on every browser, a friend's included", async () => {
    const mine = await resolveToken(db, 'push-deleting-secret-001');
    await resolveToken(db, 'push-deleting-friend-0001');
    await createAccount(db, 'leaving', 'correct horse', mine.id);
    const { token } = await login(db, 'leaving', 'correct horse');
    await savePushSubscription(db, row('https://fcm.googleapis.com/fcm/send/a', mine.id, hashSecret('push-deleting-secret-001')), PUSH_DEVICES_MAX);
    await savePushSubscription(db, row('https://fcm.googleapis.com/fcm/send/b', mine.id, hashSecret('push-deleting-friend-0001'), { session: hashSecret(token) }), PUSH_DEVICES_MAX);
    const { accountId } = (await resolveToken(db, 'push-deleting-secret-001')) as { accountId: string };
    await deleteAccount(db, accountId);
    expect(await queryRows(db, sql`select endpoint from push_subscriptions`)).toEqual([]);
  });

  it('turns alerts on and off over HTTP, and deleting the account takes them away', async () => {
    const service = fakePushService();
    const clock = new FakeClock();
    clock.t = Date.now();
    const store = dbPushStore(db);
    const server = createApp({ clock, identity: dbIdentity(db), accounts: db, push: { config: { subject: SITE }, store, fetch: service.fetch }, log: () => {} });
    const url = await listen(server);
    try {
      const guest = 'push-http-guest-secret-01';
      const signup = await request(url, 'POST', '/api/account/signup', { username: 'alerted', password: 'correct horse' }, { guest });
      expect(signup.status).toBe(200);
      const session = String(signup.body.session);
      const phone = browser();
      expect((await request(url, 'POST', '/api/push/subscribe', phone.subscription, { guest, session })).status).toBe(200);
      const me = await resolveToken(db, guest);
      expect(await store.targets(me.id, new Date())).toHaveLength(1);
      // Off, and on again.
      expect((await request(url, 'POST', '/api/push/unsubscribe', { endpoint: phone.subscription.endpoint }, { guest, session })).status).toBe(200);
      expect(await store.targets(me.id, new Date())).toHaveLength(0);
      expect((await request(url, 'POST', '/api/push/subscribe', phone.subscription, { guest, session })).status).toBe(200);
      expect(await store.targets(me.id, new Date())).toHaveLength(1);
      expect((await request(url, 'POST', '/api/account/delete', { password: 'correct horse' }, { guest, session })).status).toBe(200);
      expect(await store.targets(me.id, new Date())).toHaveLength(0);
      expect((await request(url, 'POST', '/api/push/subscribe', phone.subscription, { guest: 'bad' })).status).toBe(401);
    } finally {
      await server.close();
    }
  });
});

describe('phone alerts from the server', () => {
  const service = fakePushService();
  const clock = new FakeClock();
  const logged: string[] = [];
  let server: ReturnType<typeof createApp>;
  let url = '';
  const clients: Client[] = [];
  const client = (token: string) => socketClient(url, token, clients);

  beforeAll(async () => {
    server = createApp({ clock, push: { config: { subject: SITE }, store: memoryPushStore(), fetch: service.fetch }, log: (m) => void logged.push(m) });
    url = await listen(server);
  });

  afterAll(async () => {
    for (const c of clients.splice(0)) c.close();
    await server.close();
  });

  const subscribe = async (guest: string, b = browser()) => {
    const res = await request(url, 'POST', '/api/push/subscribe', b.subscription, { guest });
    expect(res.status).toBe(200);
    return b;
  };
  /** Lets alerts queued by a timer go out to the fake push service. */
  const flush = async () => {
    await pause(20);
    await server.push.idle();
  };

  it('hands out its public key, and none when alerts are off', async () => {
    const key = (await request(url, 'GET', '/api/push/key')).body.key as string;
    expect(Buffer.from(key, 'base64url')).toHaveLength(65);
    expect((await request(url, 'GET', '/api/push/key')).body.key).toBe(key);
    const off = createApp({ log: () => {} });
    const offUrl = await listen(off);
    try {
      expect((await request(offUrl, 'GET', '/api/push/key')).body).toEqual({ key: null });
      expect((await request(offUrl, 'POST', '/api/push/subscribe', browser().subscription, { guest: 'push-off-guest-secret-01' })).status).toBe(400);
    } finally {
      await off.close();
    }
  });

  it('refuses a subscription that is not from a browser push service, or has bad keys', async () => {
    const guest = 'push-refuse-guest-secret';
    const good = browser().subscription;
    expect((await request(url, 'POST', '/api/push/subscribe', { ...good, endpoint: 'https://evil.example/collect' }, { guest })).status).toBe(400);
    expect((await request(url, 'POST', '/api/push/subscribe', { ...good, endpoint: 'http://fcm.googleapis.com/fcm/send/x' }, { guest })).status).toBe(400);
    expect((await request(url, 'POST', '/api/push/subscribe', { ...good, keys: { ...good.keys, p256dh: 'BAAA' } }, { guest })).status).toBe(400);
    expect((await request(url, 'POST', '/api/push/subscribe', { ...good, keys: { ...good.keys, auth: 'c2hvcnQ' } }, { guest })).status).toBe(400);
    expect((await request(url, 'POST', '/api/push/subscribe', good, {})).status).toBe(401);
    expect((await request(url, 'POST', '/api/push/subscribe', good, { guest })).status).toBe(200);
  });

  /** Two players sit down and the host starts; returns them with whoever must act first. */
  async function headsUp(name: string, hostToken: string, guestToken: string) {
    const host = client(hostToken);
    const guest = client(guestToken);
    const { tableId } = await host.call<{ tableId: string }>('table:create', { settings: { table: { name }, seating: { requireApproval: false }, timing: { autoStartNextHand: false } } });
    await host.call('table:join', { tableId });
    await guest.call('table:join', { tableId });
    await host.call('seat:request', { seat: 0, name: 'Host', stack: 10_000 });
    await guest.call('seat:request', { seat: 1, name: 'Guest', stack: 10_000 });
    await host.until((v) => v.seats.filter(Boolean).length === 2);
    await host.call('host:start');
    const hv = await host.until((v) => !!v.hand);
    const gv = await guest.until((v) => !!v.hand);
    const first = hv.legal ? { me: host, view: hv, other: guest } : { me: guest, view: gv, other: host };
    return { tableId, host, guest, ...first };
  }

  const hidden = async (c: ReturnType<typeof client>, visible = false) => {
    c.socket.emit('page:visible', { visible });
    // The server hears a tab's messages in order: once this one is answered, it has heard that one.
    await c.call('notes:list');
  };

  const tagOf = (tableId: string, v: TableView) => `turn:${tableId}:${v.hand!.handNumber}:${v.hand!.events.length}`;

  it("sends 'your turn' once per turn, a moment after it starts, only while none of the player's tabs at the table is on screen", async () => {
    const t = await headsUp('Turn alerts', 'push-turn-host-secret-01', 'push-turn-guest-secret-1');
    const myPhone = await subscribe(t.me === t.host ? 'push-turn-host-secret-01' : 'push-turn-guest-secret-1');
    const theirPhone = await subscribe(t.me === t.host ? 'push-turn-guest-secret-1' : 'push-turn-host-secret-01');
    await hidden(t.me);
    clock.advance(TURN_ALERT_DELAY_MS - 1);
    await flush();
    expect(opened(service, myPhone)).toEqual([]);
    clock.advance(1);
    await flush();
    expect(opened(service, myPhone)).toEqual([{ title: 'Your turn', body: 'Turn alerts', url: `/t/${t.tableId}`, tag: tagOf(t.tableId, t.view), replaces: `turn:${t.tableId}:` }]);
    const sent = service.delivered.find((d) => d.endpoint === myPhone.subscription.endpoint)!;
    expect(sent.headers).toMatchObject({ TTL: '60', Urgency: 'high', 'Content-Encoding': 'aes128gcm' });
    // The claim is for Google's push service, from this site, signed with the key browsers were given.
    const [, token, key] = /^vapid t=([^,]+), k=(.+)$/.exec(sent.headers.Authorization)!;
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    expect(claims).toMatchObject({ aud: 'https://fcm.googleapis.com', sub: SITE });
    expect(claims.exp * 1000).toBeGreaterThan(clock.now());
    expect(claims.exp * 1000).toBeLessThanOrEqual(clock.now() + 24 * 60 * MINUTE);
    expect(key).toBe((await request(url, 'GET', '/api/push/key')).body.key);
    expect(verifies(token, key)).toBe(true);

    // Only once for that turn, however long it lasts.
    clock.advance(5_000);
    await flush();
    expect(opened(service, myPhone)).toHaveLength(1);

    // The other player has the table on screen: their turn makes no alert.
    await t.me.call('hand:act', { type: 'call' });
    await t.other.until((v) => v.legal !== null);
    clock.advance(TURN_ALERT_DELAY_MS);
    await flush();
    expect(opened(service, theirPhone)).toEqual([]);
  });

  it('sends nothing when the turn is answered within the moment, or to a tab that comes back on screen', async () => {
    const t = await headsUp('Quick', 'push-quick-host-secret-1', 'push-quick-guest-secret');
    const myPhone = await subscribe(t.me === t.host ? 'push-quick-host-secret-1' : 'push-quick-guest-secret');
    await hidden(t.me);
    // A queued "call any" answers straight away.
    await t.me.call('hand:act', { type: 'call' });
    clock.advance(TURN_ALERT_DELAY_MS);
    await flush();
    expect(opened(service, myPhone)).toEqual([]);

    // The other player is away from the table, then looks again before the moment is up.
    const theirPhone = await subscribe(t.me === t.host ? 'push-quick-guest-secret' : 'push-quick-host-secret-1');
    await t.other.until((v) => v.legal !== null);
    await hidden(t.other);
    await hidden(t.other, true);
    clock.advance(TURN_ALERT_DELAY_MS);
    await flush();
    expect(opened(service, theirPhone)).toEqual([]);
  });

  it('holds the alert while the table is paused, and still sends it only once', async () => {
    const t = await headsUp('Paused', 'push-pause-host-secret-1', 'push-pause-guest-secret');
    const myPhone = await subscribe(t.me === t.host ? 'push-pause-host-secret-1' : 'push-pause-guest-secret');
    await hidden(t.me);
    await t.host.call('host:pause', { value: true });
    clock.advance(TURN_ALERT_DELAY_MS);
    await flush();
    expect(opened(service, myPhone)).toEqual([]);
    await t.host.call('host:pause', { value: false });
    await t.me.until((v) => !v.paused && v.legal !== null);
    clock.advance(TURN_ALERT_DELAY_MS);
    await flush();
    expect(opened(service, myPhone).map((a) => a.title)).toEqual(['Your turn']);
    // Paused and resumed again on the same turn: no second alert.
    await t.host.call('host:pause', { value: true });
    await t.host.call('host:pause', { value: false });
    await t.me.until((v) => !v.paused && v.legal !== null);
    clock.advance(TURN_ALERT_DELAY_MS);
    await flush();
    expect(opened(service, myPhone)).toHaveLength(1);
  });

  it('drops a subscription its push service says has gone (404 or 410), and keeps one that only failed', async () => {
    const t = await headsUp('Gone', 'push-gone-host-secret-01', 'push-gone-guest-secret-1');
    const meToken = t.me === t.host ? 'push-gone-host-secret-01' : 'push-gone-guest-secret-1';
    const otherToken = t.me === t.host ? 'push-gone-guest-secret-1' : 'push-gone-host-secret-01';
    const gone = await subscribe(meToken);
    const flaky = await subscribe(otherToken);
    service.answers.set(gone.subscription.endpoint, 410);
    service.answers.set(flaky.subscription.endpoint, 500);
    await hidden(t.me);
    await hidden(t.other);
    clock.advance(TURN_ALERT_DELAY_MS);
    await flush();
    expect(opened(service, gone)).toHaveLength(1);
    const meId = (await t.me.until((v) => !!v.me.playerId)).me.playerId;
    const otherId = (await t.other.until((v) => !!v.me.playerId)).me.playerId;
    const store = (server.push as unknown as { deps: { store: ReturnType<typeof memoryPushStore> } }).deps.store;
    expect(await store.targets(meId, new Date())).toEqual([]);

    await t.me.call('hand:act', { type: 'call' });
    await t.other.until((v) => v.legal !== null);
    clock.advance(TURN_ALERT_DELAY_MS);
    await flush();
    expect(opened(service, flaky)).toHaveLength(1);
    // A 500 is the push service's trouble, not the browser's: it stays. The log says so once, without the address.
    expect(await store.targets(otherId, new Date())).toHaveLength(1);
    expect(logged).toEqual(['phone alerts failed 1 time; the last: fcm.googleapis.com answered 500']);
  });

  it("tells every player still in a scheduled tournament that it starts soon, and then that they're seated", async () => {
    const host = client('push-tn-host-secret-0001');
    const ana = client('push-tn-ana-secret-00001');
    const bo = client('push-tn-bo-secret-000001');
    await host.call('session:name', { name: 'Host' });
    await ana.call('session:name', { name: 'Ana' });
    await bo.call('session:name', { name: 'Bo' });
    const startAt = clock.now() + 20 * MINUTE;
    const { id } = await host.call<{ id: string }>('tournament:create', { settings: defaultSettings({ name: 'Friday Push', start: { kind: 'scheduled', startAt } }) });
    await ana.call('tournament:command', { id, command: { type: 'register' } });
    await bo.call('tournament:command', { id, command: { type: 'register' } });
    const anaPhone = await subscribe('push-tn-ana-secret-00001');
    const boPhone = await subscribe('push-tn-bo-secret-000001');
    await hidden(ana);
    await hidden(bo);

    clock.advance(20 * MINUTE - START_LEAD_MS - 1);
    await flush();
    expect(opened(service, anaPhone)).toEqual([]);
    clock.advance(1);
    await flush();
    const soon = { title: 'Starting soon', body: 'Friday Push starts in 5 minutes.', url: `/tn/${id}`, tag: `start:${id}:${startAt}` };
    expect(opened(service, anaPhone)).toEqual([soon]);
    expect(opened(service, boPhone)).toEqual([soon]);
    expect(service.delivered.find((d) => d.endpoint === anaPhone.subscription.endpoint)!.headers).toMatchObject({ Urgency: 'normal', TTL: '300' });

    // The cards are drawn a minute before the start.
    clock.advance(START_LEAD_MS);
    await flush();
    const seated = opened(service, anaPhone).slice(1);
    expect(seated).toHaveLength(1);
    expect(seated[0]).toMatchObject({ title: "You're seated", body: 'Your tournament table is ready. Cards are in the air soon.' });
    expect(seated[0].url).toMatch(new RegExp(`^/t/${id}-t\\d+$`));
    expect(seated[0].tag).toBe(`seat:${id}:${seated[0].url.slice(3)}`);
  });
});

describe('starting soon', () => {
  const clock = new FakeClock();
  const event = (startAt: number | null, players: string[], extra: Partial<TournamentState> = {}) =>
    ({ id: 'tn1', status: 'registering', startAt, archivedAt: null, settings: { name: 'Weekly' }, entries: players.map((playerId) => ({ playerId, status: 'registered' })), ...extra }) as unknown as TournamentState;

  it('tells each player once, five minutes before; a late registrant on joining; again if the start moves', () => {
    let state: TournamentState | null = event(clock.now() + 60 * MINUTE, ['a', 'b']);
    const told: string[] = [];
    const alerts = new StartAlerts({ clock, state: () => state, send: (playerId, s, startAt) => told.push(`${playerId}@${startAt - s.startAt!}`) });
    alerts.check('tn1');
    clock.advance(55 * MINUTE - 1);
    expect(told).toEqual([]);
    clock.advance(1);
    expect(told).toEqual(['a@0', 'b@0']);
    alerts.check('tn1');
    expect(told).toHaveLength(2);
    state = event(state.startAt, ['a', 'b', 'c']);
    alerts.check('tn1');
    expect(told).toEqual(['a@0', 'b@0', 'c@0']);
    // The host moves the start: a new time, a new alert when it comes round.
    state = event(clock.now() + 30 * MINUTE, ['a', 'b', 'c']);
    alerts.check('tn1');
    clock.advance(25 * MINUTE);
    expect(told).toHaveLength(6);
    alerts.dispose();
  });

  it('says nothing for an event that has started, was archived, has no start time or is weeks away', () => {
    const told: string[] = [];
    let state: TournamentState | null = event(clock.now() + 3 * MINUTE, ['a'], { status: 'running' } as Partial<TournamentState>);
    const alerts = new StartAlerts({ clock, state: () => state, send: (playerId) => told.push(playerId) });
    alerts.check('tn1');
    state = event(clock.now() + 3 * MINUTE, ['a'], { archivedAt: clock.now() } as Partial<TournamentState>);
    alerts.check('tn1');
    state = event(null, ['a']);
    alerts.check('tn1');
    state = null;
    alerts.check('tn1');
    expect(told).toEqual([]);
    // Weeks away: it waits in hour-long steps (a timer can't wait that long in one go) and still comes.
    state = event(clock.now() + 40 * DAY, ['a']);
    alerts.check('tn1');
    clock.advance(40 * DAY - START_LEAD_MS);
    expect(told).toEqual(['a']);
    alerts.dispose();
  });
});

import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { io as connect } from 'socket.io-client';
import { createApp } from '../src/app';
import { closeDb, type Db } from '../src/db';
import { createTestDb, resetTestDb } from '../src/db/testing';
import { dbIdentity } from '../src/storage';
import { FakeClock } from './fake-clock';
import type { Client } from './socket-client';

const CLIENT_ID = 'test-client.apps.googleusercontent.com';
const PHONE = 'guest-secret-phone-aaaaaaaaaaaa';
const LAPTOP = 'guest-secret-laptop-bbbbbbbbbbb';

let db: Db;
let clock: FakeClock;
let server: ReturnType<typeof createApp>;
let url = '';
const clients: Client[] = [];
/** What the fake Google puts in the next ID token, and the token requests it saw. */
let nextClaims: Record<string, unknown> = {};
let seen: URLSearchParams[] = [];

const jwt = (claims: object) => ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.');

beforeAll(async () => {
  db = await createTestDb();
});

beforeEach(async () => {
  await resetTestDb(db);
  clock = new FakeClock();
  clock.t = Date.now();
  seen = [];
  server = createApp({
    clock,
    identity: dbIdentity(db),
    accounts: db,
    google: {
      clientId: CLIENT_ID,
      clientSecret: 'shh',
      publicUrl: 'https://poker.example',
      exchange: async (form) => {
        seen.push(form);
        return { id_token: jwt({ iss: 'https://accounts.google.com', aud: CLIENT_ID, exp: Math.floor(clock.t / 1000) + 3600, ...nextClaims }) };
      },
    },
    log: () => {},
  });
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

function headers(guest: string, session?: string) {
  const h: Record<string, string> = { 'content-type': 'application/json', 'x-guest-token': guest };
  if (session) h['x-session-token'] = session;
  return h;
}

/** Starts at our server, "visits Google", and follows the callback; returns the fragment the page gets. */
async function googleSignIn(guest: string, opts: { sub: string; name?: string; given?: string; mode?: 'signin' | 'link'; session?: string; bringOver?: boolean; tamper?: object }) {
  const begin = await fetch(`${url}/api/auth/google/begin`, { method: 'POST', headers: headers(guest, opts.session), body: JSON.stringify({ mode: opts.mode ?? 'signin', bringOver: opts.bringOver ?? true }) });
  const body = (await begin.json()) as { url?: string; error?: string };
  if (!begin.ok) return { status: begin.status, error: body.error };
  const google = new URL(body.url!);
  expect(google.origin + google.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
  expect(google.searchParams.get('redirect_uri')).toBe('https://poker.example/auth/google/callback');
  expect(google.searchParams.get('code_challenge_method')).toBe('S256');
  nextClaims = { sub: opts.sub, nonce: google.searchParams.get('nonce'), name: opts.name, given_name: opts.given, ...opts.tamper };
  const back = await fetch(`${url}/auth/google/callback?code=abc&state=${google.searchParams.get('state')}`, { redirect: 'manual' });
  expect(back.status).toBe(303);
  const location = back.headers.get('location')!;
  expect(location.startsWith('/auth/done#')).toBe(true);
  return { status: 303, fragment: Object.fromEntries(new URLSearchParams(location.split('#')[1])) };
}

function sessionOf(guest: string, session?: string) {
  const c = connect(url, { auth: { token: guest, session }, transports: ['websocket'], forceNew: true });
  clients.push(c);
  return new Promise<{ playerId: string; displayName: string; account: { username: string } | null }>((resolve) => c.once('session', resolve));
}

describe('sign in with Google', () => {
  it('says whether it is on', async () => {
    expect(await (await fetch(`${url}/api/auth/config`)).json()).toEqual({ google: true });
    const bare = createApp({ clock });
    await new Promise<void>((r) => bare.http.listen(0, r));
    const port = (bare.http.address() as AddressInfo).port;
    expect(await (await fetch(`http://localhost:${port}/api/auth/config`)).json()).toEqual({ google: false });
    expect((await fetch(`http://localhost:${port}/api/auth/google/begin`, { method: 'POST', headers: headers(PHONE), body: '{}' })).status).toBe(404);
    await bare.close();
  });

  it('makes an account the first time, keeping the guest and naming it after Google', async () => {
    const before = await sessionOf(PHONE);
    const r = await googleSignIn(PHONE, { sub: 'g-1', name: 'Mike Price', given: 'Mike' });
    expect(r.fragment).toMatchObject({ welcome: '1', session: expect.any(String) });
    // The code was swapped with the PKCE verifier and our redirect address.
    expect(seen[0].get('code_verifier')).toBeTruthy();
    expect(seen[0].get('redirect_uri')).toBe('https://poker.example/auth/google/callback');
    const after = await sessionOf(PHONE, r.fragment!.session);
    expect(after).toMatchObject({ playerId: before.playerId, displayName: 'Mike', account: { username: 'MikePrice' } });
    const me = (await (await fetch(`${url}/api/account/me`, { headers: headers(PHONE, r.fragment!.session) })).json()) as { account: object };
    expect(me.account).toMatchObject({ google: true, hasPassword: false });
  });

  it('signs the same Google account in on another device as the same player', async () => {
    const first = await googleSignIn(PHONE, { sub: 'g-1', name: 'Mike' });
    const phone = await sessionOf(PHONE, first.fragment!.session);
    const second = await googleSignIn(LAPTOP, { sub: 'g-1', name: 'Mike' });
    expect(second.fragment!.welcome).toBeUndefined();
    expect((await sessionOf(LAPTOP, second.fragment!.session)).playerId).toBe(phone.playerId);
  });

  it('turns away a token for another app, an expired one, or a replayed state', async () => {
    expect((await googleSignIn(PHONE, { sub: 'g-1', tamper: { aud: 'someone-else' } })).fragment!.error).toMatch(/did not work/);
    expect((await googleSignIn(PHONE, { sub: 'g-1', tamper: { nonce: 'wrong' } })).fragment!.error).toMatch(/did not work/);
    expect((await googleSignIn(PHONE, { sub: 'g-1', tamper: { exp: 1 } })).fragment!.error).toMatch(/did not work/);
    const replay = await fetch(`${url}/auth/google/callback?code=abc&state=made-up`, { redirect: 'manual' });
    expect(replay.headers.get('location')).toMatch(/error=/);
  });

  it('links Google to a password account, after which either works; refuses a Google account already used', async () => {
    const up = await fetch(`${url}/api/account/signup`, { method: 'POST', headers: headers(PHONE), body: JSON.stringify({ username: 'Mike', password: 'correct horse' }) });
    const session = ((await up.json()) as { session: string }).session;
    expect((await googleSignIn(PHONE, { sub: 'g-9', mode: 'link', session })).fragment).toEqual({ linked: '1' });
    const viaGoogle = await googleSignIn(LAPTOP, { sub: 'g-9' });
    expect((await sessionOf(LAPTOP, viaGoogle.fragment!.session)).account).toEqual({ username: 'Mike' });

    await googleSignIn('guest-secret-tablet-cccccccccccc', { sub: 'g-other', name: 'Bo' });
    expect((await googleSignIn(PHONE, { sub: 'g-other', mode: 'link', session })).fragment!.error).toMatch(/already belongs/);
  });

  it('lets a Google-only account set a password, and only then unlink Google', async () => {
    const r = await googleSignIn(PHONE, { sub: 'g-1', name: 'Mike' });
    const h = headers(PHONE, r.fragment!.session);
    expect((await fetch(`${url}/api/account/google/unlink`, { method: 'POST', headers: h })).status).toBe(400);
    expect((await fetch(`${url}/api/account/password`, { method: 'POST', headers: h, body: JSON.stringify({ password: 'my new password' }) })).status).toBe(200);
    expect((await fetch(`${url}/api/account/google/unlink`, { method: 'POST', headers: h })).status).toBe(200);
    const signIn = await fetch(`${url}/api/account/signin`, { method: 'POST', headers: headers(LAPTOP), body: JSON.stringify({ username: 'Mike', password: 'my new password' }) });
    expect(signIn.status).toBe(200);
  });

  it('deletes a Google-only account when the username is typed to confirm', async () => {
    const r = await googleSignIn(PHONE, { sub: 'g-1', name: 'Mike' });
    const h = headers(PHONE, r.fragment!.session);
    expect((await fetch(`${url}/api/account/delete`, { method: 'POST', headers: h, body: JSON.stringify({ username: 'nope' }) })).status).toBe(401);
    expect((await fetch(`${url}/api/account/delete`, { method: 'POST', headers: h, body: JSON.stringify({ username: 'mike' }) })).status).toBe(200);
    // Signing in with that Google account again makes a brand new account.
    expect((await googleSignIn(LAPTOP, { sub: 'g-1', name: 'Mike' })).fragment!.welcome).toBe('1');
  });
});

// Unlinking Google asks for the account password, so it counts wrong passwords like every other password check:
// whoever holds a session (another device, a copied token) can't guess the password as fast as the server hashes.

import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { closeDb, type Db } from '../src/db';
import { createTestDb } from '../src/db/testing';
import { dbIdentity } from '../src/storage';

let db: Db;
let server: ReturnType<typeof createApp>;
let url = '';
const GUEST = 'unlink-limit-guest-secret-0123456789';

beforeAll(async () => {
  db = await createTestDb();
  server = createApp({ identity: dbIdentity(db), accounts: db, log: () => {} });
  await new Promise<void>((resolve) => server.http.listen(0, resolve));
  url = `http://localhost:${(server.http.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await server.close();
  await closeDb(db);
});

const post = (path: string, body: object, headers: Record<string, string> = {}) =>
  fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-guest-token': GUEST, ...headers }, body: JSON.stringify(body) });

describe('password guessing through Google unlink', () => {
  it('stops answering wrong passwords after ten, as the password change does', async () => {
    const made = await (await post('/api/account/signup', { username: 'victim', password: 'correct horse battery' })).json();
    const session = made.session as string;
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) statuses.push((await post('/api/account/google/unlink', { password: `guess-${i}-xxxx` }, { 'x-session-token': session })).status);
    expect(statuses.every((s) => s === 401)).toBe(true);
    // The right password is refused too now, so a guess that happens to be right gives nothing away.
    expect((await post('/api/account/google/unlink', { password: 'correct horse battery' }, { 'x-session-token': session })).status).toBe(429);
  }, 60_000);
});

import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { closeDb, type Db } from '../src/db';
import { createTestDb, resetTestDb } from '../src/db/testing';
import { dbSuggestions } from '../src/suggestions';
import { FakeClock } from './fake-clock';

const KEY = 'test-admin-key-0123456789';
let db: Db;
let clock: FakeClock;
let server: ReturnType<typeof createApp>;
let url = '';

beforeAll(async () => {
  db = await createTestDb();
});

beforeEach(async () => {
  await server?.close();
  await resetTestDb(db);
  clock = new FakeClock();
  server = createApp({ clock, suggestions: dbSuggestions(db), adminKey: KEY, log: (m, e) => console.error(m, e) });
  await new Promise<void>((resolve) => server.http.listen(0, resolve));
  url = `http://localhost:${(server.http.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await server.close();
  await closeDb(db);
});

const send = (body: object, ip = '203.0.113.1') =>
  fetch(`${url}/api/suggestions`, { method: 'POST', headers: { 'content-type': 'application/json', 'fly-client-ip': ip }, body: JSON.stringify(body) });
const admin = (method: string, path: string, body?: object, key = KEY) =>
  fetch(`${url}/api/suggestions${path}`, { method, headers: { 'content-type': 'application/json', 'x-admin-key': key }, body: body && JSON.stringify(body) });
const list = async (q = '') => ((await (await fetch(`${url}/api/suggestions${q}`)).json()) as { suggestions: { id: number; name: string; title: string; detail: string; status: string; reply: string }[] }).suggestions;

describe('roadmap suggestions', () => {
  it('saves an idea with its name, cleaned up, and lists it publicly as new', async () => {
    const res = await send({ name: '  Mike ', title: 'High hand\tjackpot', detail: 'Pay the\n\n\n\nbest hand of the night' });
    expect(res.status).toBe(200);
    expect(await list()).toMatchObject([{ name: 'Mike', title: 'High hand jackpot', detail: 'Pay the\n\nbest hand of the night', status: 'new', reply: '' }]);
  });

  it('turns away missing or overlong fields, and quietly drops bot-filled forms', async () => {
    expect((await send({ title: 'No name' })).status).toBe(400);
    expect((await send({ name: 'Al' })).status).toBe(400);
    expect((await send({ name: 'Al', title: 'x'.repeat(101) })).status).toBe(400);
    expect((await send({ name: 'Al', title: 'ok', detail: 'x'.repeat(1001) })).status).toBe(400);
    expect((await send({ name: 'Al', title: 'Buy pills', website: 'http://spam' })).status).toBe(200);
    expect(await list()).toEqual([]);
  });

  it('limits how fast one address can send ideas', async () => {
    for (let i = 0; i < 3; i++) expect((await send({ name: 'Al', title: `Idea ${i}` })).status).toBe(200);
    expect((await send({ name: 'Al', title: 'Idea 4' })).status).toBe(429);
    expect((await send({ name: 'Bo', title: 'Other address' }, '203.0.113.2')).status).toBe(200);
    clock.advance(10 * 60_000 + 1);
    expect((await send({ name: 'Al', title: 'Later' })).status).toBe(200);
  });

  it('lets only the admin key change a status, reply, or remove spam', async () => {
    await send({ name: 'Mike', title: 'Pineapple' });
    const [{ id }] = await list();
    expect((await admin('PATCH', `/${id}`, { status: 'approved' }, 'wrong-key-0123456789')).status).toBe(401);
    expect((await fetch(`${url}/api/suggestions/${id}`, { method: 'PATCH' })).status).toBe(401);
    expect((await admin('GET', '/admin')).status).toBe(200);
    expect((await admin('PATCH', `/${id}`, { status: 'bogus' })).status).toBe(400);
    expect((await admin('PATCH', `/${id}`, { status: 'approved', reply: 'Great idea' })).status).toBe(200);
    expect(await list()).toMatchObject([{ status: 'approved', reply: 'Great idea' }]);
    expect((await admin('DELETE', `/${id}`)).status).toBe(200);
    expect(await list()).toEqual([]);
    expect((await admin('DELETE', `/${id}`)).status).toBe(404);
  });

  it('lists only some statuses for planning, e.g. approved ideas', async () => {
    await send({ name: 'A', title: 'one' });
    await send({ name: 'B', title: 'two' });
    const [first] = await list();
    await admin('PATCH', `/${first.id}`, { status: 'approved' });
    expect((await list('?status=approved')).map((s) => s.title)).toEqual(['one']);
    expect((await list('?status=new,approved')).map((s) => s.title)).toEqual(['one', 'two']);
    expect((await fetch(`${url}/api/suggestions?status=nope`)).status).toBe(400);
  });

  it('locks out an address after too many wrong keys', async () => {
    for (let i = 0; i < 10; i++) expect((await admin('GET', '/admin', undefined, `wrong-key-${i}-0123456789`)).status).toBe(401);
    expect((await admin('GET', '/admin')).status).toBe(429);
  });

  it('has no admin at all when no key is set up', async () => {
    await server.close();
    server = createApp({ clock, suggestions: dbSuggestions(db), adminKey: '' });
    await new Promise<void>((resolve) => server.http.listen(0, resolve));
    url = `http://localhost:${(server.http.address() as AddressInfo).port}`;
    expect((await admin('GET', '/admin', undefined, '')).status).toBe(403);
  });
});

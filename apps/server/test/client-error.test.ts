// When something breaks in a player's browser, the page reports it and the server logs one line:
// what broke, the kind of page (never its address: a table link is a private invite) and the build.
// Nothing is saved, and the line never says who sent it.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { limiterKeys } from '../src/admin';
import { createApp } from '../src/app';
import { FakeClock } from './fake-clock';

const ENTRY = '/assets/index-AbC123.js';
const COMMIT = '0123456789abcdef0123456789abcdef01234567';
let dir = '';
let clock: FakeClock;
let server: ReturnType<typeof createApp>;
let url = '';
let lines: string[] = [];

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'rsdp-web-'));
  await writeFile(path.join(dir, 'index.html'), `<!doctype html><html><head><script type="module" crossorigin src="${ENTRY}"></script></head><body><div id="root"></div></body></html>`);
});

beforeEach(async () => {
  await server?.close();
  lines = [];
  clock = new FakeClock();
  server = createApp({ clock, webDist: dir, build: { commit: COMMIT, image: null, machine: null }, log: (m, e) => lines.push(e ? `${m} ${String(e)}` : m) });
  await new Promise<void>((resolve) => server.http.listen(0, resolve));
  url = `http://localhost:${(server.http.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await server?.close();
  await rm(dir, { recursive: true, force: true });
});

const report = (body: unknown, ip = '203.0.113.9', headers: Record<string, string> = {}) =>
  fetch(`${url}/api/client-error`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'fly-client-ip': ip, 'user-agent': 'Mozilla/5.0 (iPhone) TestBrowser/1.0', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
const crash = { message: 'TypeError: seat is undefined', stack: 'TypeError: seat is undefined\n    at Seat (https://x.test/assets/index-AbC123.js:1:200)\n    at div', route: '/t/:id', build: ENTRY, kind: 'crash' };
const reported = () => lines.filter((l) => l.startsWith('browser error'));

describe('POST /api/client-error', () => {
  it('logs one line with what broke, the kind of page and the commit, and answers 204', async () => {
    const res = await report(crash);
    expect(res.status).toBe(204);
    expect(reported()).toEqual(['browser error (the page crashed) on /t/:id, build index-AbC123 (commit 0123456): TypeError: seat is undefined | at Seat (https://x.test/assets/index-AbC123.js:1:200) | at div']);
  });

  it('says when the page ran a build other than the one served now, or an unknown one', async () => {
    await report({ ...crash, build: '/assets/index-Old999.js', kind: 'error' });
    await report({ ...crash, message: 'other', build: 'https://evil.test/x.js', kind: 'bogus' });
    expect(reported()).toEqual([
      expect.stringMatching(/^browser error \(uncaught\) on \/t\/:id, build index-Old999 \(not the build served now\): TypeError/),
      expect.stringMatching(/^browser error \(uncaught\) on \/t\/:id, build unknown: other/),
    ]);
  });

  it('cuts a long message and stack down, and keeps it to one line', async () => {
    await report({ ...crash, message: `Error: ${'m'.repeat(1_000)}`, stack: `Error\n${'    at f (a.js:1:1)\n'.repeat(200)}`, kind: 'rejection' });
    const [line] = reported();
    expect(line).not.toMatch(/[\r\n]/);
    const [, message, stack] = /^browser error \(unhandled rejection\) on \/t\/:id, build index-AbC123 \(commit 0123456\): (.*?) \| (Error \| at f.*)$/.exec(line)!;
    expect(message.length).toBeLessThanOrEqual(300);
    expect(message.endsWith('…')).toBe(true);
    expect(stack.length).toBeLessThanOrEqual(2_000);
    expect(line.length).toBeLessThan(2_500);
  });

  it('logs the kind of page, never its address, even when the text names a private link', async () => {
    await report({ ...crash, route: '/t/Xy3_k9-Qa1', message: 'Error: could not load https://x.test/t/Xy3_k9-Qa1?seat=2', stack: 'at /tn/AbCdEfGhIjKlMnOpQrStU and /h/s3cr3tHandLink0123456789' });
    await report({ ...crash, route: '/tn/:id' });
    const [first, second] = reported();
    expect(first).not.toMatch(/Xy3_k9|AbCdEfGh|s3cr3t/);
    expect(first).toMatch(/^browser error \(the page crashed\) on an unknown page, .*could not load https:\/\/x\.test\/t\/:id\?seat=2 \| at \/tn\/:id and \/h\/:id$/);
    expect(second).toMatch(/ on \/tn\/:id, /);
  });

  it('never logs the address, the browser or anything else about the sender', async () => {
    await report(crash, '198.51.100.77', { cookie: 'rsdp.session=secret-session-token' });
    const all = lines.join('\n');
    expect(all).toContain('TypeError: seat is undefined');
    expect(all).not.toMatch(/198\.51\.100\.77|TestBrowser|iPhone|secret-session-token/);
  });

  it('turns away a body that is too big, or not an error, without logging it', async () => {
    expect((await report({ ...crash, stack: 'x'.repeat(20_000) })).status).toBe(413);
    expect((await report('{not json')).status).toBe(400);
    expect((await report({ route: '/' })).status).toBe(400);
    expect((await report([1, 2])).status).toBe(400);
    expect(lines).toEqual([]);
  });

  it('limits how often one address, and the whole site, can report', async () => {
    for (let i = 0; i < 10; i++) expect((await report({ ...crash, message: `Error ${i}` })).status).toBe(204);
    expect((await report({ ...crash, message: 'Error 11' })).status).toBe(429);
    // Junk counts too, so oversize bodies can't flood the server either.
    expect((await report('x'.repeat(20_000), '203.0.113.10')).status).toBe(413);
    expect((await report(crash, '203.0.113.11')).status).toBe(204);
    expect(reported()).toHaveLength(11);
    clock.advance(10 * 60_000 + 1);
    expect((await report({ ...crash, message: 'Later' })).status).toBe(204);
    // The whole site: at most 120 an hour, whoever sends them.
    let sent = 13;
    for (let ip = 0; sent < 120; ip++) for (let i = 0; i < 10 && sent < 120; i++, sent++) expect((await report(crash, `192.0.2.${ip}`)).status).toBe(204);
    expect((await report(crash, '198.51.100.1')).status).toBe(429);
  });

  it('forgets each address once its window is over', async () => {
    await report(crash, '192.0.2.200');
    expect(limiterKeys('192.0.2.200')).toBeGreaterThan(0);
    clock.advance(10 * 60_000 + 1);
    server.forgetOldAddresses();
    expect(limiterKeys('192.0.2.200')).toBe(0);
  });
});

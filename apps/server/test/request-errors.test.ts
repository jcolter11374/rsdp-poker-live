// What a request the server can't read gets back, and what reaches the log.

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, requestFailed } from '../src/app';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function listen(server: import('node:http').Server) {
  await new Promise<void>((r) => server.listen(0, r));
  closers.push(() => new Promise((r) => server.close(() => r())));
  return `http://localhost:${(server.address() as AddressInfo).port}`;
}

describe('a request body the server cannot read', () => {
  // /api/client-error answers these itself, with no body (client-error.test.ts).
  const routes = ['/api/suggestions', '/api/hands/share', '/api/auth/google/begin'];

  it('is answered 400 or 413 with a short JSON error, and never logged', async () => {
    const logged: unknown[][] = [];
    const server = createApp({ log: (...args) => logged.push(args) });
    const base = await listen(server.http);
    for (const route of routes) {
      const junk = await fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name": nope' });
      expect(junk.status, route).toBe(400);
      expect(await junk.json(), route).toEqual({ error: 'That request could not be read.' });
      const huge = await fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x'.repeat(20_000) }) });
      expect(huge.status, route).toBe(413);
      expect(await huge.json(), route).toEqual({ error: 'That request is too large.' });
    }
    expect(logged).toEqual([]);
  });
});

describe('a route that fails', () => {
  it('is logged once by its pattern, never its address, and answered 500 without the details', async () => {
    const logged: unknown[][] = [];
    const app = express();
    app.get('/api/hands/:id', () => {
      throw new Error('secret detail');
    });
    app.use(requestFailed((...args) => logged.push(args)));
    const base = await listen(createServer(app));
    const res = await fetch(`${base}/api/hands/abc123`);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain('secret detail');
    expect(JSON.parse(text)).toEqual({ error: 'Something went wrong on the server.' });
    expect(logged).toHaveLength(1);
    expect(logged[0]![0]).toBe('GET /api/hands/:id failed');
    expect(String(logged[0]![0])).not.toContain('abc123');
    expect((logged[0]![1] as Error).message).toBe('secret detail');
  });
});

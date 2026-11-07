// Stopping the server: each step timed in the log, a limit that says where it was stuck, and nothing a client
// leaves open (a download, a half-sent request, a websocket that never answers) can hold up the final saves.

import { randomBytes } from 'node:crypto';
import net, { type AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { io as connect } from 'socket.io-client';
import { createApp } from '../src/app';
import { closeDb, type Db } from '../src/db';
import { createTestDb, resetTestDb } from '../src/db/testing';
import { FINISHED, GAVE_UP, shutDown, type ShutdownSteps } from '../src/shutdown';

const KEY = 'test-admin-key-0123456789';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Resolves to what `p` gave, or 'still waiting' if it hasn't settled within `ms`. */
const within = <T>(p: Promise<T>, ms: number) => Promise.race([p, sleep(ms).then(() => 'still waiting' as const)]);

/** A shutdown run with a fake exit, collecting what it logs. */
function run(steps: (s: ShutdownSteps) => Promise<void>, limitMs = 1_000) {
  const lines: string[] = [];
  const exits: number[] = [];
  const exited = new Promise<void>((resolve) =>
    shutDown(3, {
      run: steps,
      exit: (code) => (exits.push(code), resolve()),
      info: (line) => lines.push(line),
      error: (line) => lines.push(line),
      limitMs,
    }),
  );
  return { lines, exits, exited };
}

describe('the shutdown log', () => {
  it('times each step and says when it has finished', async () => {
    const r = run(async (s) => {
      s.step('saving tables');
      await sleep(30);
      s.note('cut 1 connection still open after 2000 ms');
      s.step('closing the database');
    });
    await r.exited;
    expect(r.exits).toEqual([3]);
    expect(r.lines[0]).toBe('shutdown: started (exit code 3)');
    expect(r.lines[1]).toBe('shutdown: cut 1 connection still open after 2000 ms');
    expect(r.lines[2]).toMatch(/^shutdown: saving tables took \d+ ms$/);
    expect(Number(r.lines[2].match(/(\d+) ms/)![1])).toBeGreaterThanOrEqual(25);
    expect(r.lines[3]).toMatch(/^shutdown: closing the database took \d+ ms$/);
    expect(r.lines[4]).toMatch(new RegExp(`^${FINISHED} in \\d+ ms$`));
    expect(r.lines.join('\n')).not.toContain(GAVE_UP);
  });

  it('gives up at the limit, saying which step it was stuck on, and exits once', async () => {
    let release = () => {};
    const r = run(async (s) => {
      s.step('saving tables');
      s.step('closing connections');
      await new Promise<void>((resolve) => (release = resolve));
    }, 50);
    await r.exited;
    expect(r.exits).toEqual([3]);
    const gaveUp = r.lines.find((l) => l.startsWith(GAVE_UP));
    expect(gaveUp).toMatch(/^shutdown: gave up after 50 ms, stuck closing connections for \d+ ms; exiting without finishing$/);
    // Finishing late changes nothing: the process has already gone.
    release();
    await sleep(10);
    expect(r.exits).toEqual([3]);
    expect(r.lines.join('\n')).not.toContain(FINISHED);
  });

  it('says which step failed, and still exits', async () => {
    const r = run(async (s) => {
      s.step('saving tournaments');
      throw new Error('disk full');
    });
    await r.exited;
    expect(r.exits).toEqual([3]);
    expect(r.lines).toContain('shutdown failed while saving tournaments');
    expect(r.lines.join('\n')).not.toContain(FINISHED);
  });
});

describe('closing the server', () => {
  async function serve() {
    const server = createApp({ log: () => {} });
    await new Promise<void>((r) => server.http.listen(0, r));
    return { server, port: (server.http.address() as AddressInfo).port };
  }

  /** Steps told to close(), in order, with its notes. */
  function steps() {
    const told: string[] = [];
    return { told, steps: { step: (name: string) => told.push(name), note: (text: string) => told.push(`note: ${text}`) } };
  }

  it('cuts a websocket that never answers and a half-sent request after the grace, then writes the public record', async () => {
    const { server, port } = await serve();
    // A browser that has stopped reading (a phone asleep) never answers the websocket's close.
    const sleepy = connect(`http://localhost:${port}`, { auth: { token: 'sleepy-tab-0123456789' }, transports: ['websocket'], reconnection: false });
    await new Promise<void>((r) => sleepy.on('connect', () => r()));
    (sleepy.io.engine.transport as unknown as { ws: { _socket: net.Socket } }).ws._socket.pause();
    // A request whose headers never finish.
    const half = net.connect(port);
    await new Promise((r) => half.on('connect', r));
    half.write('GET /api/health HTTP/1.1\r\nHost: x\r\n');
    await sleep(50);
    const { told, steps: s } = steps();
    const started = Date.now();
    expect(await within(server.close({ steps: s, graceMs: 300 }), 5_000)).toBeUndefined();
    // Without the cut, the websocket alone holds the server open 30 s.
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(told).toEqual([
      'stopping play',
      'putting tables away',
      'saving tournaments',
      'saving tables',
      'closing connections',
      'note: cut 2 connections still open after 300 ms',
      'writing the public record',
      'recording the stop',
    ]);
    sleepy.close();
    half.destroy();
  });

  it('cuts nothing when every connection ends by itself', async () => {
    const { server, port } = await serve();
    const tab = connect(`http://localhost:${port}`, { auth: { token: 'awake-tab-0123456789' }, transports: ['websocket'], reconnection: false });
    await new Promise<void>((r) => tab.on('connect', () => r()));
    expect((await fetch(`http://localhost:${port}/api/health`)).status).toBe(200);
    const { told, steps: s } = steps();
    await server.close({ steps: s, graceMs: 5_000 });
    expect(told.some((t) => t.startsWith('note:'))).toBe(false);
    tab.close();
  });
});

describe('a backup download and the shutdown', { timeout: 60_000 }, () => {
  let db: Db;
  beforeAll(async () => {
    db = await createTestDb();
    await resetTestDb(db);
    // About 16 MB that hardly compresses, so a client that stops reading fills every buffer on the way. On Linux a
    // connection on this machine held about 4 MB of it before the server had to wait.
    const at = new Date();
    for (let i = 0; i < 16; i++) {
      const messages = Array.from({ length: 256 }, () => `'${randomBytes(3_000).toString('base64')}'`);
      await db.execute(sql`insert into ops_log (at, kind, message) select ${at}, 'server', m from unnest(${sql.raw(`array[${messages.join(',')}]`)}::text[]) as m`);
    }
  }, 120_000);
  afterAll(async () => {
    await closeDb(db);
  });

  async function serveBackups() {
    const logged: string[] = [];
    const server = createApp({ accounts: db, adminKey: KEY, log: (m) => logged.push(m) });
    await new Promise<void>((r) => server.http.listen(0, r));
    const port = (server.http.address() as AddressInfo).port;
    return { server, port, logged };
  }

  /** Starts a backup download from a client that reads nothing after asking, and waits until the server is held up by it. */
  async function stalledDownload(server: ReturnType<typeof createApp>, port: number) {
    let serverSide: net.Socket | undefined;
    server.http.once('connection', (s: net.Socket) => (serverSide = s));
    const client = net.connect(port);
    await new Promise((r) => client.on('connect', r));
    client.pause();
    client.write(`GET /api/admin/backup HTTP/1.1\r\nHost: x\r\nX-Admin-Key: ${KEY}\r\n\r\n`);
    // Until the server's side of the connection has stayed full for a moment: the backup is waiting for room.
    for (let full = 0, tries = 0; full < 5; tries++) {
      if (tries > 600) throw new Error('the download never filled the connection: give the database more rows');
      await sleep(50);
      full = serverSide?.writableNeedDrain ? full + 1 : 0;
    }
    return client;
  }

  it("doesn't hold up the final saves when the client has stopped reading", async () => {
    const { server, port, logged } = await serveBackups();
    const client = await stalledDownload(server, port);
    const started = Date.now();
    expect(await within(server.close({ graceMs: 300 }), 8_000)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(logged).toContain('backup failed');
    // The database is free again: the backup's transaction is over.
    expect(await within(db.execute(sql`select 1`), 2_000)).not.toBe('still waiting');
    client.destroy();
  });

  it('ends when the client goes away part-way, so the database is free and the next backup can start', async () => {
    const { server, port, logged } = await serveBackups();
    try {
      const client = await stalledDownload(server, port);
      client.destroy();
      // Saves would wait behind the backup's transaction for as long as it lasts.
      expect(await within(db.execute(sql`select 1`), 3_000)).not.toBe('still waiting');
      expect(logged).toContain('backup failed');
      const next = await fetch(`http://localhost:${port}/api/admin/backup`, { headers: { 'x-admin-key': KEY } });
      expect(next.status).toBe(200);
      await next.body?.cancel();
    } finally {
      await within(server.close({ graceMs: 300 }), 8_000);
    }
  });
});

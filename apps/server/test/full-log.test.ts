import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { variants } from '@rsdp/engine/core';
import { registerAllVariants } from '@rsdp/engine/variants';
import { createApp } from '../src/app';
import { closeDb, queryRows, type Db } from '../src/db';
import { createTestDb, resetTestDb } from '../src/db/testing';
import { dbIdentity, dbStore } from '../src/storage';
import { FakeClock } from './fake-clock';
import { socketClient, type Client } from './socket-client';

type FullLog = { log: { at: number; text: string }[]; chat: { at: number; name: string; text: string }[]; hands: unknown[] };

let db: Db;
let clock: FakeClock;
let server: ReturnType<typeof createApp>;
let url = '';
let clients: Client[] = [];
const client = (token: string) => socketClient(url, token, clients);

async function start() {
  server = createApp({ clock, identity: dbIdentity(db), store: dbStore(db), log: (m, e) => console.error(m, e) });
  await new Promise<void>((resolve) => server.http.listen(0, resolve));
  url = `http://localhost:${(server.http.address() as AddressInfo).port}`;
}

async function stop() {
  for (const c of clients.splice(0)) c.close();
  await server.close();
}

beforeAll(async () => {
  registerAllVariants(variants);
  db = await createTestDb();
});

beforeEach(async () => {
  await resetTestDb(db);
  clock = new FakeClock();
  clock.t = Date.now();
  clients = [];
  await start();
});

afterEach(stop);

afterAll(async () => {
  await closeDb(db);
});

/** A table with `logLines` host actions in its log and `chatLines` chat messages, the host not seated. */
async function busyTable(logLines: number, chatLines: number) {
  const host = client('full-log-host-0123456789');
  const { tableId } = await host.call<{ tableId: string }>('table:create', { settings: { table: { name: 'Long night' } } });
  await host.call('table:join', { tableId });
  for (let i = 0; i < logLines; i++) await host.call('host:bombPot', { value: i % 2 === 0 });
  for (let i = 0; i < chatLines; i++) {
    // Chat is limited to a few lines every ten seconds per player.
    if (i % 8 === 0) clock.advance(11_000);
    await host.call('chat:send', { text: `line ${i}` });
  }
  return { host, tableId };
}

const tableLogRows = async (tableId: string) =>
  Number((await queryRows<{ n: number }>(db, sql`select count(*)::int as n from table_log where table_id = ${tableId}`))[0]?.n ?? 0);

describe('download full log', () => {
  it('includes every log line and chat message since the table started, not just the latest ones', async () => {
    const { host } = await busyTable(320, 220);
    // The side panel still shows only the recent ones.
    expect(host.view().chat.length).toBeLessThan(220);

    const full = await host.call<FullLog>('table:fullLog');
    const bombs = full.log.filter((l) => /bomb pot/.test(l.text));
    expect(bombs).toHaveLength(320);
    expect(bombs[0].text).toBe('The host made the next hand a bomb pot');
    expect(full.chat.map((c) => c.text)).toEqual(Array.from({ length: 220 }, (_, i) => `line ${i}`));
    // Oldest first.
    expect(full.log.map((l) => l.at)).toEqual([...full.log.map((l) => l.at)].sort((a, b) => a - b));
  });

  it('keeps them across a restart', async () => {
    const { tableId } = await busyTable(305, 205);
    // Let the table's last save run, then start a new server on the same database.
    clock.advance(10_000);
    await new Promise((r) => setTimeout(r, 200));
    await stop();
    await start();
    const host = client('full-log-host-0123456789');
    await host.call('table:join', { tableId });
    clock.advance(11_000);
    await host.call('chat:send', { text: 'after the restart' });
    const full = await host.call<FullLog>('table:fullLog');
    expect(full.log.filter((l) => /bomb pot/.test(l.text))).toHaveLength(305);
    expect(full.chat.map((c) => c.text)).toEqual([...Array.from({ length: 205 }, (_, i) => `line ${i}`), 'after the restart']);
  });

  it('still downloads what a table saved before every line was kept still holds', async () => {
    const { tableId } = await busyTable(3, 2);
    clock.advance(10_000);
    await new Promise((r) => setTimeout(r, 200));
    await stop();
    // As if these lines were written before the server kept them for good: only the table's snapshot has them.
    await db.execute(sql`delete from table_log where table_id = ${tableId}`);
    await start();
    const host = client('full-log-host-0123456789');
    await host.call('table:join', { tableId });
    clock.advance(11_000);
    await host.call('chat:send', { text: 'new' });
    const full = await host.call<FullLog>('table:fullLog');
    expect(full.log.filter((l) => /bomb pot/.test(l.text))).toHaveLength(3);
    expect(full.chat.map((c) => c.text)).toEqual(['line 0', 'line 1', 'new']);
  });

  it('keeps the lines an older table had, once newer ones push them out of its snapshot', async () => {
    const { tableId } = await busyTable(3, 2);
    clock.advance(10_000);
    await new Promise((r) => setTimeout(r, 200));
    await stop();
    // As if the table was saved before the server kept every line: only its snapshot has them.
    await db.execute(sql`delete from table_log where table_id = ${tableId}`);
    await start();
    const host = client('full-log-host-0123456789');
    await host.call('table:join', { tableId });
    // Enough new lines that the old ones leave the table's snapshot (the third old call left a bomb pot on, so start by turning it off).
    for (let i = 0; i < 300; i++) await host.call('host:bombPot', { value: i % 2 === 1 });
    for (let i = 0; i < 200; i++) {
      if (i % 8 === 0) clock.advance(11_000);
      await host.call('chat:send', { text: `later ${i}` });
    }
    expect(host.view().chat.some((c) => c.text === 'line 0')).toBe(false);
    const full = await host.call<FullLog>('table:fullLog');
    expect(full.log.filter((l) => /bomb pot/.test(l.text))).toHaveLength(303);
    expect(full.chat.map((c) => c.text)).toEqual(['line 0', 'line 1', ...Array.from({ length: 200 }, (_, i) => `later ${i}`)]);
    // Kept once: loading the table again doesn't save them a second time.
    await new Promise((r) => setTimeout(r, 200));
    const rows = await tableLogRows(tableId);
    await stop();
    await start();
    await client('full-log-host-0123456789').call('table:join', { tableId });
    await new Promise((r) => setTimeout(r, 200));
    expect(await tableLogRows(tableId)).toBe(rows);
  });

  it('goes with the table when the host deletes it, as its hands do', async () => {
    const { host, tableId } = await busyTable(4, 3);
    await new Promise((r) => setTimeout(r, 100));
    expect(await tableLogRows(tableId)).toBeGreaterThan(0);
    await host.call('host:deleteTable');
    expect(await tableLogRows(tableId)).toBe(0);
  });
});

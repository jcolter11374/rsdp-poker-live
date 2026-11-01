// scripts/upgrade/saved.mjs and compare.mjs, run as their own processes against a real server on a database that
// is then restarted on the same data, as a release is: the upgrade rehearsal must notice a release that can't read
// the saved tables and tournaments, even though the leaderboard and the public record don't change.

import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { variants } from '@rsdp/engine/core';
import { registerAllVariants } from '@rsdp/engine/variants';
import { defaultSettings } from '@rsdp/tournament';
import { createApp } from '../src/app';
import { closeDb, type Db } from '../src/db';
import { createTestDb } from '../src/db/testing';
import { dbIdentity, dbStore } from '../src/storage';
import { dbTournamentStore } from '../src/tournament/store';
import { socketClient, type Client } from './socket-client';

const run = promisify(execFile);
const root = path.resolve(__dirname, '../../..');
const KEY = 'test-admin-key-0123456789';
const INDEX = '<!doctype html><html><head><title>RSDP Poker Live!</title></head><body><div id="root"></div></body></html>';

let db: Db;
let dir = '';
let server: ReturnType<typeof createApp>;
let url = '';
const clients: Client[] = [];
const client = (token: string) => socketClient(url, token, clients);

async function start() {
  server = createApp({ identity: dbIdentity(db), store: dbStore(db), tournaments: dbTournamentStore(db), accounts: db, adminKey: KEY, webDist: dir, log: () => {} });
  await new Promise<void>((resolve) => server.http.listen(0, resolve));
  url = `http://localhost:${(server.http.address() as AddressInfo).port}`;
}

/** Stops the server (it saves everything), changes the saved data if asked, and starts a new one on it. */
async function restart(change?: () => Promise<unknown>) {
  for (const c of clients.splice(0)) c.close();
  await server.close();
  await change?.();
  await start();
}

/** Runs a script in scripts/upgrade as the workflow does: its exit code and what it printed. */
function script(name: string, ...args: string[]) {
  return run(process.execPath, [path.join(root, 'scripts/upgrade', name), ...args], { env: { ...process.env, ADMIN_KEY: KEY } }).then(
    (r) => ({ code: 0, out: r.stdout, err: r.stderr }),
    (e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, out: e.stdout, err: e.stderr }),
  );
}

/** What the workflow saves at each step: expect.sh's answers (none here) joined with saved.mjs's. */
async function answers(file: string, ...args: string[]) {
  const r = await script('saved.mjs', url, ...args);
  expect(r.err).toBe('');
  expect(r.code).toBe(0);
  const saved = JSON.parse(r.out);
  await writeFile(path.join(dir, file), JSON.stringify({ leaderboard: [], record: null, ...saved }));
  return saved;
}

beforeAll(async () => {
  registerAllVariants(variants);
  db = await createTestDb();
  dir = await mkdtemp(path.join(tmpdir(), 'rsdp-upgrade-saved-'));
  await writeFile(path.join(dir, 'index.html'), INDEX);
  await start();
});

afterAll(async () => {
  for (const c of clients) c.close();
  await server.close();
  await closeDb(db);
  await rm(dir, { recursive: true, force: true });
});

describe('upgrade rehearsal: saved tables and tournaments', { timeout: 30_000 }, () => {
  let tableId = '';
  let tournamentId = '';

  it('finds every saved table and tournament in the backup, and reads each one', async () => {
    const host = client('upgrade-host-secret-0123456789');
    const guest = client('upgrade-guest-secret-0123456789');
    ({ tableId } = await host.call<{ tableId: string }>('table:create', { settings: { table: { name: 'Friday game' } } }));
    await host.call('table:join', { tableId });
    await guest.call('table:join', { tableId });
    await host.call('seat:request', { seat: 0, name: 'Host', stack: 100 });
    await guest.call('seat:request', { seat: 1, name: 'Jo', stack: 100 });
    const pending = await host.until((v) => v.requests.length === 1);
    await host.call('host:approve', { requestId: pending.requests[0].id });
    await host.call('host:settings', { patch: { timing: { autoStartNextHand: false } } });
    await host.call('host:start');
    const hv = await host.until((v) => !!v.hand);
    await (hv.legal ? host : guest).call('hand:act', { type: 'fold' });
    await host.until((v) => v.hand?.phase === 'complete');
    const hostId = host.view().me.playerId;
    tournamentId = await server.tournaments.create(hostId, defaultSettings({ name: 'Upgrade Cup' }));

    const saved = await answers('before.json');
    expect(saved.tables).toEqual([expect.objectContaining({ id: tableId, name: 'Friday game', mode: 'cash', hands: 1, players: expect.arrayContaining(['Host', 'Jo']) })]);
    expect(saved.tournaments).toEqual([expect.objectContaining({ id: tournamentId, status: 'registering', title: 'Upgrade Cup · RSDP Poker Live!' })]);
  });

  it('passes a restart that reads them all back', async () => {
    await restart();
    const saved = await answers('after.json', path.join(dir, 'before.json'));
    expect(saved.tables[0]).toMatchObject({ id: tableId, hands: 1, live: false });
    const r = await script('compare.mjs', path.join(dir, 'before.json'), path.join(dir, 'after.json'));
    expect(r.out).toContain('✓ Saved tables: all 1 read back the same');
    expect(r.out).toContain('✓ Saved tournaments: all 1 read back');
    expect(r.code).toBe(0);
  });

  it("fails a release that can't read the saved snapshots, though nothing else changed", async () => {
    // As if the new release had bumped RUNTIME_VERSION and STATE_VERSION: what is saved is now the old layout.
    await restart(async () => {
      await db.execute(sql`update table_snapshots set version = version - 1`);
      await db.execute(sql`update tournaments set state = jsonb_set(state, '{version}', to_jsonb((state->>'version')::int - 1))`);
    });
    const saved = await answers('after.json', path.join(dir, 'before.json'));
    expect(saved.tables).toEqual([{ id: tableId, missing: true }]);
    expect(saved.tournaments[0].title).toBe('RSDP Poker Live!');
    const r = await script('compare.mjs', path.join(dir, 'before.json'), path.join(dir, 'after.json'));
    expect(r.code).toBe(1);
    expect(r.out).toContain(`Friday game (${tableId}) can't be read any more`);
    expect(r.out).toContain(`${tournamentId}: its page showed "Upgrade Cup · RSDP Poker Live!", now "RSDP Poker Live!"`);
  });

  it('never runs against the live site', async () => {
    const r = await script('saved.mjs', 'https://rsdp-poker-live.fly.dev');
    expect(r.code).toBe(2);
    expect(r.err).toContain('never the live site');
  });
});

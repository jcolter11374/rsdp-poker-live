// The public record: hands, chip totals, admin actions and server starts,
// hash-chained, saved in order and readable by anyone (docs/FAIRNESS.md).

import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditHash, chainProblem, handDigest, playerRef, tableRef, type AuditEntry } from '@rsdp/engine';
import { variants } from '@rsdp/engine/core';
import { registerAllVariants } from '@rsdp/engine/variants';
import type { HandRecordView } from '@rsdp/engine/wire';
import { createApp } from '../src/app';
import { AuditLog, dbAuditStore, memoryAuditStore } from '../src/audit';
import { closeDb, loadSnapshot, saveSnapshot, type Db } from '../src/db';
import { createTestDb } from '../src/db/testing';
import { dbIdentity, dbStore } from '../src/storage';
import { socketClient, type Client } from './socket-client';

const KEY = 'admin-key-for-tests-0123';
let db: Db;
let server: ReturnType<typeof createApp>;
let url = '';
const clients: Client[] = [];
const client = (token: string) => socketClient(url, token, clients);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function start() {
  const audit = await AuditLog.open(dbAuditStore(db), { log: () => {} });
  server = createApp({ identity: dbIdentity(db), store: dbStore(db), accounts: db, adminKey: KEY, audit, build: { commit: 'abc1234', image: null, machine: null }, log: () => {} });
  await new Promise<void>((resolve) => server.http.listen(0, resolve));
  url = `http://localhost:${(server.http.address() as AddressInfo).port}`;
}

async function stop() {
  for (const c of clients.splice(0)) c.close();
  await server.close();
}

const get = async <T>(path: string) => (await (await fetch(`${url}${path}`)).json()) as T;
const everything = async () => {
  const out: AuditEntry[] = [];
  for (;;) {
    const { entries } = await get<{ entries: AuditEntry[] }>(`/api/audit/entries?after=${out.at(-1)?.seq ?? 0}`);
    if (!entries.length) return out;
    out.push(...entries);
  }
};

beforeAll(async () => {
  registerAllVariants(variants);
  db = await createTestDb();
  await start();
});

afterAll(async () => {
  await stop();
  await closeDb(db);
});

/** A host and a guest sit down with 100 each and play one hand (someone folds). */
async function playedTable(name: string, hostToken: string, guestToken: string) {
  const host = client(hostToken);
  const guest = client(guestToken);
  const { tableId } = await host.call<{ tableId: string }>('table:create', { settings: { table: { name }, seating: { requireApproval: false }, timing: { autoStartNextHand: false } } });
  await host.call('table:join', { tableId });
  await guest.call('table:join', { tableId });
  await host.call('seat:request', { seat: 0, name: 'Host', stack: 100 });
  await guest.call('seat:request', { seat: 1, name: 'Guest', stack: 100 });
  await host.until((v) => v.seats.filter(Boolean).length === 2);
  await host.call('host:start');
  const hv = await host.until((v) => !!v.hand);
  await (hv.legal ? host : guest).call('hand:act', { type: 'fold' });
  await host.until((v) => v.hand?.phase === 'complete');
  await pause(900);
  return { host, guest, tableId };
}

describe('the chain', () => {
  it('links every entry to the one before and catches any edit', async () => {
    const log = AuditLog.after(memoryAuditStore(), null, { now: () => 1_000, log: () => {} });
    log.boot({ commit: 'abc1234', image: null, machine: null });
    log.admin('test', null);
    log.record('hand', { table: 'x', hand: 1, digest: 'd' });
    const entries = await log.after(0, 100);
    expect(entries.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(chainProblem(entries)).toBeNull();
    expect(log.latest()).toEqual({ seq: 3, hash: entries[2].hash });

    const edited = entries.map((e) => ({ ...e, data: { ...e.data } }));
    edited[1].data.action = 'something else';
    expect(chainProblem(edited)).toMatch(/entry 2 was changed/);
    // Rehashing the edited entry breaks the link from the next one instead.
    edited[1].hash = auditHash(edited[1]);
    expect(chainProblem(edited)).toMatch(/entry 3 doesn't point to entry 2/);
    expect(chainProblem(entries.slice(1), { seq: 1, hash: 'f'.repeat(64) })).toMatch(/doesn't point/);
    expect(chainProblem([entries[0], entries[2]])).toMatch(/follows/);
  });
});

describe('what the server records', () => {
  it('records a server start, then hands and chip totals as they happen', { timeout: 20_000 }, async () => {
    const { host, tableId } = await playedTable('Recorded', 'aud-host-secret-0123456789', 'aud-guest-secret-0123456789');
    const all = await everything();
    expect(chainProblem(all)).toBeNull();
    expect(all[0]).toMatchObject({ seq: 1, kind: 'boot', data: { commit: 'abc1234' } });
    expect(await get('/api/audit/head')).toEqual({ seq: all.at(-1)!.seq, hash: all.at(-1)!.hash });
    expect(await get('/api/version')).toMatchObject({ commit: 'abc1234' });

    const ref = tableRef(tableId);
    const { entries } = await get<{ entries: AuditEntry[] }>(`/api/audit/table/${ref}`);
    const view = host.view();
    const chips = entries.filter((e) => e.kind === 'chips');
    expect(chips).toHaveLength(2);
    for (const row of view.ledger) expect(chips.find((e) => e.data.player === playerRef(tableId, row.playerId))?.data).toMatchObject({ buyIn: 100, cashOut: 0 });

    // Once revealed, the hand's fingerprint can be worked out from what "Check this hand" gets.
    await host.call('host:stop');
    const { hand } = await host.call<{ hand: HandRecordView }>('table:history', { handNumber: 1 });
    expect(hand.fair?.events).toBeTruthy();
    const digest = handDigest({ handId: hand.fair!.handId, commit: hand.fair!.commit, button: hand.button, seats: hand.seats, events: hand.fair!.events! });
    const recorded = entries.find((e) => e.kind === 'hand' && e.data.hand === 1);
    expect(recorded?.data.digest).toBe(digest);
  });

  it('records chips again when a total changes, and only then', { timeout: 20_000 }, async () => {
    const { host, guest, tableId } = await playedTable('Leaving', 'aud2-host-secret-0123456789', 'aud2-guest-secret-0123456789');
    const before = (await everything()).length;
    guest.socket.emit('seat:stand', {});
    await host.until((v) => v.seats.filter(Boolean).length === 1);
    await pause(100);
    const ref = tableRef(tableId);
    const { entries } = await get<{ entries: AuditEntry[] }>(`/api/audit/table/${ref}`);
    const guestId = host.view().ledger.find((r) => r.name === 'Guest')!.playerId;
    const latest = entries.find((e) => e.kind === 'chips' && e.data.player === playerRef(tableId, guestId));
    expect(Number(latest?.data.cashOut)).toBeGreaterThan(0);
    // Leaving moves one total; nothing else was recorded twice.
    expect((await everything()).length - before).toBe(1);
  });

  it('carries on across a restart and records totals that were edited while it was down', { timeout: 20_000 }, async () => {
    const { tableId } = await playedTable('Edited', 'aud3-host-secret-0123456789', 'aud3-guest-secret-0123456789');
    const head = (await everything()).at(-1)!;
    await stop();

    const snap = await loadSnapshot<{ ledger: Record<string, { buyIn: number }> }>(db, tableId);
    const [someone] = Object.keys(snap!.state.ledger);
    snap!.state.ledger[someone].buyIn = 5;
    await saveSnapshot(db, tableId, snap!);

    await start();
    const host = client('aud3-host-secret-0123456789');
    await host.call('table:join', { tableId });
    await pause(200);
    const after = await get<{ entries: AuditEntry[] }>(`/api/audit/entries?after=${head.seq - 1}`);
    expect(chainProblem(after.entries.slice(1), head)).toBeNull();
    expect(after.entries[1]).toMatchObject({ seq: head.seq + 1, kind: 'boot' });
    expect(after.entries.find((e) => e.kind === 'chips')?.data).toMatchObject({ player: playerRef(tableId, someone), buyIn: 5 });
  });

  it('records deleted tables and admin actions', { timeout: 20_000 }, async () => {
    const host = client('aud4-host-secret-0123456789');
    const { tableId } = await host.call<{ tableId: string }>('table:create', { settings: { table: { name: 'Gone' } } });
    await host.call('table:join', { tableId });
    await host.call('host:deleteTable');
    const { tableId: other } = await host.call<{ tableId: string }>('table:create', { settings: { table: { name: 'Gone too' } } });
    await fetch(`${url}/api/admin/tables/${other}/delete`, { method: 'POST', headers: { 'x-admin-key': KEY } });
    const made = await fetch(`${url}/api/suggestions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Ann', title: 'More games' }) });
    const { suggestion } = (await made.json()) as { suggestion: { id: number } };
    await fetch(`${url}/api/suggestions/${suggestion.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-admin-key': KEY }, body: JSON.stringify({ status: 'planned' }) });

    const { entries } = await get<{ entries: AuditEntry[] }>('/api/audit/entries?after=0&kind=deleted,admin');
    expect(entries.filter((e) => e.kind === 'deleted').slice(-2).map((e) => e.data)).toEqual([
      { table: tableRef(tableId), by: 'host' },
      { table: tableRef(other), by: 'admin' },
    ]);
    expect(entries.at(-1)?.data).toEqual({ action: 'suggestion marked planned', target: `#${suggestion.id}` });
  });
});

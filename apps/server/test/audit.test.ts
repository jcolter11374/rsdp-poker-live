// The public record: hands, chip totals, admin actions and server starts,
// hash-chained, saved in order and readable by anyone (docs/FAIRNESS.md).

import type { AddressInfo } from 'node:net';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AUDIT_GENESIS, auditHash, chainProblem, handDigest, playerRef, tableRef, type AuditEntry } from '@rsdp/engine';
import { variants } from '@rsdp/engine/core';
import { defaultSettings } from '@rsdp/engine/settings';
import { registerAllVariants } from '@rsdp/engine/variants';
import type { HandRecordView } from '@rsdp/engine/wire';
import { createApp, memoryStore, type TableStore } from '../src/app';
import { AuditLog, dbAuditStore, memoryAuditStore, PENDING_HAND_KIND, type AuditStore, type PendingHand } from '../src/audit';
import { closeDb, loadSnapshot, queryRows, saveSnapshot, type Db } from '../src/db';
import { createTestDb } from '../src/db/testing';
import { TableRuntime } from '../src/runtime/table';
import { Scheduler } from '../src/scheduler';
import { dbIdentity, dbStore } from '../src/storage';
import { FakeClock, seeded } from './fake-clock';
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
  server = createApp({ identity: dbIdentity(db), store: dbStore(db), accounts: db, adminKey: KEY, audit, fairStopRevealMs: 0, build: { commit: 'abc1234', image: null, machine: null }, log: () => {} });
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
  it('records a server start, then chip totals as they change and hands as they end at a table watched live', { timeout: 20_000 }, async () => {
    const { host, tableId } = await playedTable('Recorded', 'aud-host-secret-0123456789', 'aud-guest-secret-0123456789');
    const all = await everything();
    expect(chainProblem(all)).toBeNull();
    expect(all[0]).toMatchObject({ seq: 1, kind: 'boot', data: { commit: 'abc1234' } });
    expect(await get('/api/audit/head')).toEqual({ seq: all.at(-1)!.seq, hash: all.at(-1)!.hash });
    expect(await get('/api/version')).toMatchObject({ commit: 'abc1234' });

    const ref = tableRef(tableId);
    const { entries: chips } = await get<{ entries: AuditEntry[] }>(`/api/audit/table/${ref}/chips`);
    const view = host.view();
    expect(chips).toHaveLength(2);
    for (const row of view.ledger) expect(chips.find((e) => e.data.player === playerRef(tableId, row.playerId))?.data).toMatchObject({ buyIn: 100, cashOut: 0 });

    // While sealed, the fingerprint is public but its server seed isn't: even someone who guessed every folded card couldn't confirm it.
    const { hand: sealed } = await host.call<{ hand: HandRecordView }>('table:history', { handNumber: 1 });
    expect(sealed.fair?.serverSeed).toBeNull();
    // Once revealed, the hand's fingerprint can be worked out from what "Check this hand" gets.
    await host.call('host:stop');
    const { hand } = await host.call<{ hand: HandRecordView }>('table:history', { handNumber: 1 });
    expect(hand.fair?.events).toBeTruthy();
    const digest = handDigest({ handId: hand.fair!.handId, commit: hand.fair!.commit, serverSeed: hand.fair!.serverSeed!, button: hand.button, seats: hand.seats, events: hand.fair!.events! });
    const recorded = await get<{ entries: AuditEntry[]; before: boolean; after: boolean }>(`/api/audit/table/${ref}/hand/1`);
    expect(recorded.entries.map((e) => e.data.digest)).toContain(digest);
    const guessed = handDigest({ handId: hand.fair!.handId, commit: hand.fair!.commit, serverSeed: '', button: hand.button, seats: hand.seats, events: hand.fair!.events! });
    expect(recorded.entries.map((e) => e.data.digest)).not.toContain(guessed);
    expect(recorded).toMatchObject({ before: false });
    expect((await get<{ entries: AuditEntry[] }>(`/api/audit/table/${ref}/hand/99`)).entries).toEqual([]);
  });

  it('records chips again when a total changes, and only then', { timeout: 20_000 }, async () => {
    const { host, guest, tableId } = await playedTable('Leaving', 'aud2-host-secret-0123456789', 'aud2-guest-secret-0123456789');
    const before = (await everything()).length;
    guest.socket.emit('seat:stand', {});
    await host.until((v) => v.seats.filter(Boolean).length === 1);
    await pause(100);
    const ref = tableRef(tableId);
    const { entries } = await get<{ entries: AuditEntry[] }>(`/api/audit/table/${ref}/chips`);
    const guestId = host.view().ledger.find((r) => r.name === 'Guest')!.playerId;
    const latest = entries.find((e) => e.data.player === playerRef(tableId, guestId));
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
    expect(after.entries.find((e) => e.kind === 'chips')?.data).toMatchObject({ player: playerRef(tableId, someone), buyIn: 5, loaded: true });
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

// D38 (#435): at a table whose spectators watch on a delay, a hand goes in the record only once they see it end, so the
// record can't tell anyone a hand is over before the table they watch is.
describe('hands at a table watched on a delay', () => {
  const DELAY = 60_000;
  let clock: FakeClock;
  let delayed: ReturnType<typeof createApp> | null = null;
  let base = '';
  const read = async <T>(path: string) => (await (await fetch(`${base}${path}`)).json()) as T;
  const all = async () => (await read<{ entries: AuditEntry[] }>('/api/audit/entries?after=0')).entries;
  const handsOf = async (id: string) => (await all()).filter((e) => e.kind === 'hand' && e.data.table === tableRef(id));
  const handEntries = (id: string, n: number) => read<{ entries: AuditEntry[]; before: boolean; after: boolean }>(`/api/audit/table/${tableRef(id)}/hand/${n}`);

  /** One server's life on these stores, as a deploy ends one and the next starts. */
  async function serve(auditStore: AuditStore, store: TableStore) {
    const audit = await AuditLog.open(auditStore, { now: () => clock.now(), log: () => {} });
    delayed = createApp({ clock, store, audit, adminKey: KEY, rng: seeded(3), log: () => {} });
    await new Promise<void>((resolve) => delayed!.http.listen(0, resolve));
    base = `http://localhost:${(delayed.http.address() as AddressInfo).port}`;
    return delayed;
  }

  async function shutDown() {
    await delayed?.close();
    delayed = null;
  }

  afterEach(shutDown);

  /** A cash table on this server, with Host and Ann sitting down with 100 each. */
  async function table(app: ReturnType<typeof createApp>, store: TableStore, id: string, delaySeconds: number) {
    const settings = defaultSettings('cash');
    settings.seating.requireApproval = false;
    settings.timing.autoStartNextHand = false;
    settings.spectators.delaySeconds = delaySeconds;
    const made = TableRuntime.create({ id, hostId: 'host', settings }, { clock, rng: seeded() });
    made.dispose();
    await store.createTable(made.state);
    const rt = (await app.getTable(id))!;
    for (const p of ['host', 'ann']) rt.connect(p);
    rt.requestSeat('host', { seat: 0, name: 'Host', stack: 100 });
    rt.requestSeat('ann', { seat: 1, name: 'Ann', stack: 100 });
    return rt;
  }

  /** Deals the next hand and the first to act folds. Returns who won it. */
  function playHand(rt: TableRuntime) {
    if (rt.state.handNumber === 0) rt.start('host');
    else rt.dealNext('host');
    expect(rt.handInProgress).toBe(true);
    const folder = rt.state.seats[rt.state.hand!.toAct!]!.playerId;
    rt.act(folder, { type: 'fold' });
    expect(rt.handInProgress).toBe(false);
    return folder === 'host' ? 'ann' : 'host';
  }

  it('keeps a finished hand out of the record until the delay has passed, then puts it in once', { timeout: 20_000 }, async () => {
    clock = new FakeClock();
    const store = memoryStore();
    const app = await serve(memoryAuditStore(), store);
    const rt = await table(app, store, 'delay-one', DELAY / 1000);

    const head = await read<{ seq: number; hash: string }>('/api/audit/head');
    playHand(rt);
    // Nothing a spectator could read the end of the hand from: no entry, no new head, nothing for the hand.
    expect(await handsOf('delay-one')).toEqual([]);
    expect(await read('/api/audit/head')).toEqual(head);
    expect((await handEntries('delay-one', 1)).entries).toEqual([]);
    clock.advance(DELAY - 1);
    expect(await handsOf('delay-one')).toEqual([]);
    expect(await read('/api/audit/head')).toEqual(head);

    clock.advance(1);
    const entries = await all();
    expect(chainProblem(entries)).toBeNull();
    const [first] = await handsOf('delay-one');
    expect(first).toMatchObject({ seq: head.seq + 1, at: clock.now(), data: { hand: 1 } });
    expect((await handEntries('delay-one', 1)).entries).toEqual([first]);
    expect(await read('/api/audit/head')).toEqual({ seq: first.seq, hash: first.hash });

    // The next hand doesn't show through hand 1's neighbours either, until it goes in itself.
    clock.advance(5_000);
    const winner = playHand(rt);
    expect(await handEntries('delay-one', 1)).toMatchObject({ before: false, after: false });
    // A card shown after the hand goes in as an entry of its own, that long after it is shown.
    clock.advance(1_000);
    rt.show(winner, [0, 1]);
    clock.advance(DELAY - 1_000);
    expect(await handEntries('delay-one', 1)).toMatchObject({ after: true });
    expect((await handEntries('delay-one', 2)).entries).toHaveLength(1);
    clock.advance(999);
    expect((await handEntries('delay-one', 2)).entries).toHaveLength(1);
    clock.advance(1);
    const shown = (await handEntries('delay-one', 2)).entries;
    expect(shown).toHaveLength(2);
    expect(shown[0].data.digest).not.toBe(shown[1].data.digest);
    expect((await handsOf('delay-one')).map((e) => e.data.hand)).toEqual([1, 2, 2]);
    expect(chainProblem(await all())).toBeNull();
    // Each went in once.
    clock.advance(10 * DELAY);
    expect(await handsOf('delay-one')).toHaveLength(3);
  });

  it('keeps a table\'s hands in order when its delay is shortened, and leaves tables watched live as they were', { timeout: 20_000 }, async () => {
    clock = new FakeClock();
    const store = memoryStore();
    const app = await serve(memoryAuditStore(), store);
    const slow = await table(app, store, 'delay-slow', DELAY / 1000);
    const live = await table(app, store, 'delay-live', 0);

    const start = clock.now();
    playHand(slow);
    slow.updateSettings('host', { spectators: { delaySeconds: 10 } });
    clock.advance(1_000);
    playHand(slow);
    expect(slow.settings.spectators.delaySeconds).toBe(10);
    // A table watched live is recorded the moment its hand ends, whatever another table is waiting for.
    playHand(live);
    expect(await handsOf('delay-live')).toHaveLength(1);

    // Hand 2's own delay has passed, but it waits behind hand 1.
    clock.advance(20_000);
    expect(await handsOf('delay-slow')).toEqual([]);
    clock.advance(start + DELAY - clock.now());
    expect((await handsOf('delay-slow')).map((e) => e.data.hand)).toEqual([1, 2]);
    expect(chainProblem(await all())).toBeNull();
  });

  it('puts a deleted table\'s waiting hands in before the entry that ends it', { timeout: 20_000 }, async () => {
    clock = new FakeClock();
    const store = memoryStore();
    const app = await serve(memoryAuditStore(), store);
    const rt = await table(app, store, 'delay-gone', DELAY / 1000);
    playHand(rt);
    clock.advance(1_000);
    playHand(rt);
    const res = await fetch(`${base}/api/admin/tables/delay-gone/delete`, { method: 'POST', headers: { 'x-admin-key': KEY } });
    expect(res.status).toBe(200);
    const mine = (await all()).filter((e) => e.data.table === tableRef('delay-gone') && e.kind !== 'chips');
    expect(mine.map((e) => [e.kind, e.data.hand ?? null])).toEqual([
      ['hand', 1],
      ['hand', 2],
      ['deleted', null],
    ]);
    clock.advance(DELAY);
    expect(await handsOf('delay-gone')).toHaveLength(2);
    expect(chainProblem(await all())).toBeNull();
  });

  it('puts a hand still waiting at shutdown in on time, after the next server\'s boot entry, once', { timeout: 20_000 }, async () => {
    clock = new FakeClock();
    const auditStore = memoryAuditStore();
    const store = memoryStore();
    const first = await serve(auditStore, store);
    const rt = await table(first, store, 'delay-restart', DELAY / 1000);
    const ended = clock.now();
    playHand(rt);
    await shutDown();
    // Saved, and not put in by the server that stopped.
    expect(await auditStore.pending()).toHaveLength(1);
    clock.advance(DELAY / 2);
    expect((await auditStore.after(0, 1000, ['hand'])).length).toBe(0);

    await serve(auditStore, store);
    const booted = await all();
    expect(booted.at(-1)?.kind).toBe('boot');
    expect(await handsOf('delay-restart')).toEqual([]);
    clock.advance(ended + DELAY - clock.now() - 1);
    expect(await handsOf('delay-restart')).toEqual([]);
    clock.advance(1);
    const entries = await all();
    expect(entries.slice(booted.length).map((e) => [e.kind, e.data.hand])).toEqual([['hand', 1]]);
    expect(chainProblem(entries)).toBeNull();
    expect(await auditStore.pending()).toEqual([]);
    clock.advance(10 * DELAY);
    expect(await handsOf('delay-restart')).toHaveLength(1);
  });

  it('puts hands that came due while the server was down in right after its boot entry', { timeout: 20_000 }, async () => {
    clock = new FakeClock();
    const auditStore = memoryAuditStore();
    const store = memoryStore();
    const first = await serve(auditStore, store);
    const rt = await table(first, store, 'delay-down', DELAY / 1000);
    playHand(rt);
    clock.advance(1_000);
    playHand(rt);
    await shutDown();
    clock.advance(5 * DELAY);

    await serve(auditStore, store);
    const entries = await all();
    expect(entries.slice(-3).map((e) => [e.kind, e.data.hand ?? null])).toEqual([
      ['boot', null],
      ['hand', 1],
      ['hand', 2],
    ]);
    expect(chainProblem(entries)).toBeNull();
  });
});

describe('hands waiting in the database', () => {
  let wdb: Db;
  const p: PendingHand = { id: 'waiting-hand-1', table: 'a'.repeat(32), hand: 3, digest: 'd'.repeat(64), at: 5_000 };
  const entry = (seq: number, prev: string, kind: AuditEntry['kind'], data: AuditEntry['data']) => {
    const e = { seq, at: 6_000 + seq, kind, data, prev };
    return { ...e, hash: auditHash(e) };
  };
  const counts = async () => {
    const [row] = await queryRows<{ jobs: number; entries: number }>(
      wdb,
      sql`select (select count(*)::int from jobs where id = ${p.id}) as jobs, (select count(*)::int from audit_log where kind = 'hand') as entries`,
    );
    return row;
  };

  beforeAll(async () => {
    wdb = await createTestDb();
  });

  afterAll(async () => {
    await closeDb(wdb);
  });

  it('keeps a waiting hand until it goes in, and lets it go in the same step as it goes in', async () => {
    const store = dbAuditStore(wdb);
    const boot = entry(1, AUDIT_GENESIS, 'boot', { commit: null, image: null });
    await store.append(boot);
    await store.hold(p);
    // Saving it again (a retry after a save that went through) changes nothing.
    await store.hold(p);
    expect(await store.pending()).toEqual([p]);
    // Another kind of job is left alone, and the Scheduler leaves waiting hands alone.
    await new Scheduler(wdb, { other: async () => {} }, { now: () => 1e13 }).runDue();
    expect(await store.pending()).toEqual([p]);

    const hand = (seq: number, prev: string) => entry(seq, prev, 'hand', { table: p.table, hand: p.hand, digest: p.digest });
    // The entry can't go in (its number is taken): the hand keeps waiting.
    await expect(store.append(hand(1, AUDIT_GENESIS), p.id)).rejects.toThrow();
    expect(await counts()).toEqual({ jobs: 1, entries: 0 });
    // Letting it go fails after the entry went in: the entry is taken back with it.
    await wdb.execute(sql.raw(`create function refuse_delete() returns trigger language plpgsql as $$ begin raise exception 'refused'; end $$`));
    await wdb.execute(sql.raw(`create trigger refuse_delete before delete on jobs for each row execute function refuse_delete()`));
    await expect(store.append(hand(2, boot.hash), p.id)).rejects.toThrow();
    expect(await counts()).toEqual({ jobs: 1, entries: 0 });
    await wdb.execute(sql.raw('drop trigger refuse_delete on jobs'));
    // Both at once.
    await store.append(hand(2, boot.hash), p.id);
    expect(await counts()).toEqual({ jobs: 0, entries: 1 });
    expect(await store.pending()).toEqual([]);
    expect(chainProblem(await store.after(0, 10))).toBeNull();
  });

  it('carries a waiting hand over to the next server, which puts it in when it is due', async () => {
    const clock = new FakeClock();
    const timer = (fn: () => void, ms: number) => {
      const id = clock.setTimeout(fn, ms);
      return () => clock.clearTimeout(id);
    };
    const settings = defaultSettings('cash');
    settings.seating.requireApproval = false;
    const rt = TableRuntime.create({ id: 'db-waiting', hostId: 'host', settings }, { clock, rng: seeded() });
    for (const x of ['host', 'ann']) rt.connect(x);
    rt.requestSeat('host', { seat: 0, name: 'Host', stack: 100 });
    rt.requestSeat('ann', { seat: 1, name: 'Ann', stack: 100 });
    rt.start('host');
    rt.act(rt.state.seats[rt.state.hand!.toAct!]!.playerId, { type: 'fold' });
    const record = rt.state.history.at(-1)!;
    rt.dispose();

    const first = await AuditLog.open(dbAuditStore(wdb), { now: () => clock.now(), log: () => {} });
    first.boot({ commit: null, image: null, machine: null });
    first.start(timer);
    first.hand('db-waiting', record, clock.now() + 30_000);
    first.stop();
    await first.flush();
    const [waiting] = await dbAuditStore(wdb).pending();
    expect(waiting).toMatchObject({ table: tableRef('db-waiting'), hand: 1, at: clock.now() + 30_000 });
    const { c } = (await queryRows<{ c: number }>(wdb, sql`select count(*)::int as c from jobs where kind = ${PENDING_HAND_KIND} and status = 'pending'`))[0];
    expect(c).toBe(1);

    const second = await AuditLog.open(dbAuditStore(wdb), { now: () => clock.now(), log: () => {} });
    second.boot({ commit: null, image: null, machine: null });
    second.start(timer);
    clock.advance(29_999);
    await second.flush();
    expect((await second.after(0, 100)).filter((e) => e.data.table === tableRef('db-waiting'))).toEqual([]);
    clock.advance(1);
    await second.flush();
    const entries = await second.after(0, 100);
    expect(entries.slice(-2).map((e) => e.kind)).toEqual(['boot', 'hand']);
    expect(entries.at(-1)?.data).toEqual({ table: waiting.table, hand: 1, digest: waiting.digest });
    expect(chainProblem(entries)).toBeNull();
    expect(await dbAuditStore(wdb).pending()).toEqual([]);
    second.stop();
  });
});

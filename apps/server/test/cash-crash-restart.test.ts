// Issue #224: a cash table is saved up to half a second after it changes, a finished hand at once.
// A crash in between leaves the table saved mid-hand next to that hand saved as finished; loading the
// table must close the hand with its saved result, not deal the rest of it again.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tableRef } from '@rsdp/engine';
import { engine, variants } from '@rsdp/engine/core';
import { defaultSettings } from '@rsdp/engine/settings';
import { registerAllVariants } from '@rsdp/engine/variants';
import { createApp, memoryIdentity, memoryStore, type IdentityService, type TableStore } from '../src/app';
import { AuditLog, memoryAuditStore, type AuditStore } from '../src/audit';
import { closeDb, type Db } from '../src/db';
import { createTestDb } from '../src/db/testing';
import { TableRuntime } from '../src/runtime/table';
import type { RuntimeState } from '../src/runtime/types';
import { pastHand } from '../src/runtime/view';
import { dbIdentity, dbStore } from '../src/storage';
import { FakeClock, seeded } from './fake-clock';

let db: Db;

beforeAll(async () => {
  registerAllVariants(variants);
  db = await createTestDb();
});

afterAll(async () => {
  await closeDb(db);
});

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One server's life on the shared stores, as a deploy or crash ends one and the next starts. */
async function serverOn(store: TableStore, auditStore: AuditStore, clock: FakeClock) {
  const audit = await AuditLog.open(auditStore, { now: () => clock.now(), log: () => {} });
  return createApp({ clock, store, audit, rng: seeded(3), log: () => {} });
}

const toAct = (rt: TableRuntime) => rt.state.seats[rt.state.hand!.toAct!]!.playerId;
const stacks = (state: RuntimeState) => state.seats.map((s) => s && { playerId: s.playerId, stack: s.stack });

describe('a crash right after a cash hand ends (#224)', () => {
  const stores: [string, () => { store: TableStore; identity: IdentityService }][] = [
    ['in memory', () => ({ store: memoryStore(), identity: memoryIdentity() })],
    ['in the database', () => ({ store: dbStore(db), identity: dbIdentity(db) })],
  ];
  /** The first server plays out a hand and crashes before the table's own save; the next one loads the table. */
  async function crashRightAfterHand(where: string, open: () => { store: TableStore; identity: IdentityService }, delaySeconds: number) {
    const clock = new FakeClock();
    const { store, identity } = open();
    const auditStore = memoryAuditStore();
    const id = `crash224-${where === 'in memory' ? 'm' : 'd'}${delaySeconds ? '-delayed' : ''}`;
    const host = (await identity.resolve(`${id}-host-secret-0123456789`)).playerId;
    const ann = (await identity.resolve(`${id}-ann-secret-0123456789`)).playerId;

    // A table with a hand being played, saved as it is.
    const settings = defaultSettings('cash');
    settings.seating.requireApproval = false;
    settings.spectators.delaySeconds = delaySeconds;
    const made = TableRuntime.create({ id, hostId: host, settings }, { clock, rng: seeded() });
    for (const p of [host, ann]) made.connect(p);
    made.requestSeat(host, { seat: 0, name: 'Host', stack: 100 });
    made.requestSeat(ann, { seat: 1, name: 'Ann', stack: 100 });
    made.start(host);
    expect(made.handInProgress).toBe(true);
    made.dispose();
    await store.createTable(made.state);
    const midHand = JSON.stringify(await store.loadTable(id));

    // The first server plays the hand out: it is saved straight away, and fingerprinted straight away or, at a table
    // watched on a delay, once the delay has passed.
    const prints = async () => (await auditStore.after(0, 1000, ['hand'])).filter((e) => e.data.table === tableRef(id) && e.data.hand === 1);
    const first = await serverOn(store, auditStore, clock);
    const rt = (await first.getTable(id))!;
    const folder = toAct(rt);
    rt.act(folder, { type: 'fold' });
    expect(rt.handInProgress).toBe(false);
    const ended = clock.now();
    const after = stacks(rt.state);
    // It crashes before the table's own save: the store still holds the table mid-hand.
    first.tables.delete(id);
    rt.dispose();
    await first.close();
    if (delaySeconds) expect((await auditStore.pending()).map((p) => p.hand)).toEqual([1]);
    await pause(700);
    await store.saveTable(JSON.parse(midHand) as RuntimeState);
    expect((await store.loadHands(id)).map((h) => h.handNumber)).toEqual([1]);
    expect((await store.loadHand(id, 1))?.handNumber).toBe(1);
    expect(await store.loadHand(id, 2)).toBeNull();

    // The next server loads the table: the hand is over, with the stacks it ended with.
    const second = await serverOn(store, auditStore, clock);
    // A fingerprint waiting for the delay came through the crash, and is still waiting.
    if (delaySeconds) expect(await prints()).toEqual([]);
    const back = (await second.getTable(id))!;
    expect(back.handInProgress).toBe(false);
    expect(back.state.handNumber).toBe(1);
    expect(stacks(back.state)).toEqual(after);
    expect(Object.values(back.state.ledger).map((r) => r.buyIn)).toEqual([100, 100]);
    // Nobody gets to play it differently this time.
    expect(() => back.act(folder, { type: 'call' })).toThrow();
    // The next hand is dealt as usual, numbered on from it.
    clock.advance(60_000);
    expect(back.state.handNumber).toBe(2);
    await second.close();

    // The public record has one fingerprint for hand 1. One that waited went in as the delay passed, after the boot.
    const [print, ...more] = await prints();
    expect(print).toBeTruthy();
    expect(more).toEqual([]);
    if (delaySeconds) {
      expect(print.at).toBe(ended + delaySeconds * 1000);
      expect(print.seq).toBeGreaterThan((await auditStore.after(0, 1000, ['boot'])).at(-1)!.seq);
      expect(await auditStore.pending()).toEqual([]);
    }
  }

  it.each(stores)('closes the hand with its saved result instead of playing it again (%s)', (where, open) => crashRightAfterHand(where, open, 0));

  it.each(stores)("keeps the hand's fingerprint back for the spectator delay through the crash, then puts it in once (%s)", (where, open) => crashRightAfterHand(where, open, 30));

  it('lets a player who asked to leave during the hand go with what the hand left them', () => {
    const clock = new FakeClock();
    const settings = defaultSettings('cash');
    settings.seating.requireApproval = false;
    const rt = TableRuntime.create({ id: 'crash224-r', hostId: 'host', settings }, { clock, rng: seeded() });
    for (const p of ['host', 'a', 'b']) rt.connect(p);
    ['host', 'a', 'b'].forEach((p, seat) => rt.requestSeat(p, { seat, name: p.toUpperCase(), stack: 100 }));
    rt.start('host');
    const leaver = toAct(rt);
    rt.stand(leaver, { afterHand: true });
    const midHand = JSON.stringify(rt.state);
    while (rt.handInProgress) rt.act(toAct(rt), { type: 'fold' });
    const record = rt.state.history.at(-1)!;
    rt.dispose();

    const back = new TableRuntime(JSON.parse(midHand) as RuntimeState, { clock, rng: seeded(5) });
    // Only the hand saved in progress is closed.
    expect(back.closeSavedHand({ ...pastHand(record), handNumber: 2 })).toBe(false);
    expect(back.handInProgress).toBe(true);
    expect(back.closeSavedHand(pastHand(record))).toBe(true);
    expect(back.handInProgress).toBe(false);
    expect(back.seatOf(leaver)).toBeNull();
    expect(back.state.ledger[leaver].cashOut).toBe(rt.state.ledger[leaver].cashOut);
    expect(stacks(back.state)).toEqual(stacks(rt.state));
    expect(back.state.nextHandAt).not.toBeNull();
    back.resume();
    clock.advance(60_000);
    expect(back.state.handNumber).toBe(2);
    back.dispose();
  });

  it('counts the closed hand\'s house fee, so the settle-up books still balance', () => {
    const clock = new FakeClock();
    const settings = defaultSettings('cash');
    settings.seating.requireApproval = false;
    settings.modifiers.rake = { ...(settings.modifiers.rake as object), enabled: true, percent: 10, noFlopNoDrop: false };
    const rt = TableRuntime.create({ id: 'crash224-f', hostId: 'host', settings }, { clock, rng: seeded() });
    for (const p of ['host', 'a']) rt.connect(p);
    ['host', 'a'].forEach((p, seat) => rt.requestSeat(p, { seat, name: p.toUpperCase(), stack: 100 }));
    rt.start('host');
    const midHand = JSON.stringify(rt.state);
    rt.act(toAct(rt), { type: 'raise', to: 20 });
    for (let i = 0; i < 50 && rt.handInProgress; i++) {
      const legal = engine.legalActions(rt.state.hand!, rt.state.hand!.toAct!)!;
      rt.act(toAct(rt), legal.canCheck ? { type: 'check' } : { type: 'call' });
    }
    const fee = rt.state.sideGames?.rakeTotal ?? 0;
    expect(fee).toBeGreaterThan(0);
    const record = rt.state.history.at(-1)!;
    rt.dispose();

    const back = new TableRuntime(JSON.parse(midHand) as RuntimeState, { clock, rng: seeded(5) });
    const before = back.state.sideGames?.rakeTotal ?? 0;
    expect(back.closeSavedHand(pastHand(record))).toBe(true);
    expect(back.state.sideGames?.rakeTotal ?? 0).toBe(before + fee);
    // Buy-ins = stacks + cash-outs + fees, as the settle-up panel checks.
    const chips = back.state.seats.reduce((n, x) => n + (x?.stack ?? 0), 0);
    const ledger = Object.values(back.state.ledger);
    expect(chips + ledger.reduce((n, r) => n + (r.cashOut ?? 0), 0) + back.state.sideGames!.rakeTotal!).toBe(ledger.reduce((n, r) => n + r.buyIn, 0));
    back.dispose();
  });
});

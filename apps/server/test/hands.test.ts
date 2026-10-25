import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db } from '../src/db/client';
import { StorageError } from '../src/db/errors';
import { getHand, listHandsByTable, saveHand } from '../src/db/hands';
import { newHandId } from '../src/db/ids';
import { createTable } from '../src/db/tables';
import { createTestDb, resetTestDb } from '../src/db/testing';
import { resolveToken } from '../src/identity';

let db: Db;
let tableId: string;

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await closeDb(db);
});
beforeEach(async () => {
  await resetTestDb(db);
  const host = (await resolveToken(db, 'host-browser-secret-0001')).id;
  tableId = (await createTable(db, { ownerPlayerId: host, settings: {} })).id;
});

async function expectStorageError(p: Promise<unknown>, code: StorageError['code']) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(StorageError);
  expect((err as StorageError).code).toBe(code);
}

const started = new Date('2026-08-01T20:00:00Z');

function handAt(number: number, extra: Partial<Parameters<typeof saveHand>[1]> = {}) {
  return saveHand(db, {
    tableId,
    number,
    gameId: 'nlh',
    startedAt: new Date(started.getTime() + number * 60_000),
    endedAt: new Date(started.getTime() + number * 60_000 + 45_000),
    header: { button: number % 6, stakes: { smallBlind: 1, bigBlind: 2 } },
    events: [
      { seq: 0, t: 'hand-start', handNumber: number },
      { seq: 1, t: 'deal', seat: 0, cards: [{ card: 'As', up: false }] },
      { seq: 2, t: 'hand-end', stacks: { 0: 210, 3: 190 } },
    ],
    results: { winners: [0] },
    ...extra,
  });
}

describe('hands', () => {
  it('saves a hand with a hard-to-guess id and reads it back with its events', async () => {
    const saved = await handAt(1);
    expect(saved.id).toMatch(/^[\w-]{24}$/);
    const loaded = await getHand(db, saved.id);
    expect(loaded).toEqual(saved);
    expect(loaded?.events).toHaveLength(3);
    expect(loaded?.events[1]).toEqual({ seq: 1, t: 'deal', seat: 0, cards: [{ card: 'As', up: false }] });
    expect(await getHand(db, 'missing')).toBeNull();
  });

  it('keeps the id the hand was dealt with and lets it be finished later', async () => {
    const id = newHandId();
    const dealt = await saveHand(db, {
      id,
      tableId,
      number: 7,
      gameId: 'plo',
      startedAt: started,
      header: { button: 2 },
      events: [{ seq: 0, t: 'hand-start' }],
    });
    expect(dealt).toMatchObject({ id, endedAt: null, results: null });

    const ended = new Date(started.getTime() + 90_000);
    await saveHand(db, {
      id,
      tableId,
      number: 7,
      gameId: 'plo',
      startedAt: started,
      endedAt: ended,
      header: { button: 2 },
      events: [
        { seq: 0, t: 'hand-start' },
        { seq: 1, t: 'hand-end' },
      ],
      results: { winners: [2] },
    });
    const loaded = await getHand(db, id);
    expect(loaded).toMatchObject({ endedAt: ended, results: { winners: [2] } });
    expect(loaded?.events).toHaveLength(2);
  });

  it('refuses a second hand with the same table and number', async () => {
    await handAt(3);
    await expectStorageError(handAt(3), 'conflict');
  });

  it('refuses to move a saved id to another hand number', async () => {
    const first = await handAt(3);
    await expectStorageError(handAt(4, { id: first.id }), 'conflict');
    expect((await getHand(db, first.id))?.number).toBe(3);
  });

  it('validates the number and events', async () => {
    await expectStorageError(handAt(1.5), 'invalid');
    await expectStorageError(handAt(-1), 'invalid');
    await expectStorageError(handAt(2, { events: 'nope' as unknown as unknown[] }), 'invalid');
  });

  it('lists a table newest first in pages without the event logs', async () => {
    for (let n = 1; n <= 7; n++) await handAt(n);
    const other = await createTable(db, { ownerPlayerId: (await resolveToken(db, 'other-browser-secret-01')).id, settings: {} });
    await saveHand(db, { tableId: other.id, number: 1, gameId: 'nlh', startedAt: started, header: {}, events: [] });

    const page1 = await listHandsByTable(db, tableId, { limit: 3 });
    expect(page1.hands.map((h) => h.number)).toEqual([7, 6, 5]);
    expect(page1.nextBefore).toBe(5);
    expect(page1.hands[0]).not.toHaveProperty('events');
    expect(page1.hands[0]).toMatchObject({ gameId: 'nlh', header: { button: 1 }, results: { winners: [0] } });

    const page2 = await listHandsByTable(db, tableId, { limit: 3, before: page1.nextBefore! });
    expect(page2.hands.map((h) => h.number)).toEqual([4, 3, 2]);
    const page3 = await listHandsByTable(db, tableId, { limit: 3, before: page2.nextBefore! });
    expect(page3.hands.map((h) => h.number)).toEqual([1]);
    expect(page3.nextBefore).toBeNull();
  });

  it('ends paging exactly on a full last page and clamps silly limits', async () => {
    for (let n = 1; n <= 4; n++) await handAt(n);
    const page = await listHandsByTable(db, tableId, { limit: 4 });
    expect(page.hands).toHaveLength(4);
    expect(page.nextBefore).toBeNull();
    expect((await listHandsByTable(db, tableId, { limit: 0 })).hands).toHaveLength(1);
    expect((await listHandsByTable(db, tableId, { limit: 1e9 })).hands).toHaveLength(4);
    expect((await listHandsByTable(db, 'nothing-here')).hands).toEqual([]);
  });
});

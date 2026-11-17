// A real game watched on a delay stays off the leaderboards while it has a hand in play, or one whose end its
// spectators haven't seen yet (#469): the boards are public, so they would tell anyone the hand is over, and who won.

import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { variants } from '@rsdp/engine/core';
import { registerAllVariants } from '@rsdp/engine/variants';
import { createApp } from '../src/app';
import { closeDb, type Db } from '../src/db';
import { createTestDb } from '../src/db/testing';
import { dbIdentity, dbStore } from '../src/storage';
import { FakeClock } from './fake-clock';
import { socketClient, type Client } from './socket-client';

let db: Db;
let server: ReturnType<typeof createApp>;
let url = '';
const clock = new FakeClock();
const clients: Client[] = [];
const client = (token: string) => socketClient(url, token, clients);
/** Real time: the table's save is debounced on the real clock. */
const saved = () => new Promise((r) => setTimeout(r, 900));

beforeAll(async () => {
  registerAllVariants(variants);
  clock.t = Date.now();
  db = await createTestDb();
  server = createApp({ clock, identity: dbIdentity(db), store: dbStore(db), accounts: db, log: () => {} });
  await new Promise<void>((resolve) => server.http.listen(0, resolve));
  url = `http://localhost:${(server.http.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const c of clients) c.close();
  await server.close();
  await closeDb(db);
});

/** Ann and Ben heads-up at a table with this spectator delay, the first hand dealt. */
async function table(name: string, delaySeconds: number) {
  const ann = client(`board-${name}-ann-0123456789`);
  const ben = client(`board-${name}-ben-0123456789`);
  const { tableId } = await ann.call<{ tableId: string }>('table:create', {
    settings: { table: { name }, seating: { requireApproval: false }, spectators: { allowed: true, delaySeconds }, timing: { decisionSeconds: 0, autoStartNextHand: false } },
  });
  await ann.call('table:join', { tableId });
  await ben.call('table:join', { tableId });
  await ann.call('seat:request', { seat: 0, name: `Ann ${name}`, stack: 100 });
  await ben.call('seat:request', { seat: 1, name: `Ben ${name}`, stack: 100 });
  await ann.until((v) => v.seats.filter(Boolean).length === 2);
  await ann.call('host:start');
  return { ann, ben, tableId };
}

type Player = ReturnType<typeof client>;

/** Whoever acts first folds hand `n`. */
async function foldHand(ann: Player, ben: Player, n: number) {
  const v = await ann.until((x) => !!x.hand && x.hand.phase !== 'complete' && x.hand.handNumber === n);
  await (v.legal ? ann : ben).call('hand:act', { type: 'fold' });
  await ann.until((x) => x.hand?.handNumber === n && x.hand.phase === 'complete');
  await saved();
}

/** How many hands the board counts for this name; null when they aren't on it. */
async function handsOf(name: string) {
  const res = (await (await fetch(`${url}/api/leaderboard?period=all`, { headers: { 'x-guest-token': 'a-board-reader-0123456789' } })).json()) as { rows: { name: string; hands: number }[] };
  return res.rows.find((r) => r.name === name)?.hands ?? null;
}

describe('the leaderboard and a game watched on a delay (#469)', () => {
  it('leaves the game out until its spectators have seen the last hand end, and again once a hand is in play', { timeout: 40_000 }, async () => {
    const live = await table('Live', 0);
    const slow = await table('Slow', 120);
    await foldHand(live.ann, live.ben, 1);
    await foldHand(slow.ann, slow.ben, 1);

    // The hand at the live table counts at once. The one watched on a delay ended live, but nobody watching has seen it.
    expect(await handsOf('Ann Live')).toBe(1);
    expect(await handsOf('Ann Slow')).toBeNull();

    // Just before spectators see it end, it is still out, though the minute the boards are kept for has passed.
    clock.advance(119_000);
    expect(await handsOf('Ann Slow')).toBeNull();
    clock.advance(1_000);
    expect(await handsOf('Ann Slow')).toBe(1);
    expect(await handsOf('Ben Slow')).toBe(1);

    // The next hand is dealt: the game is out again at once, within the minute, and stays out when the hand ends.
    await slow.ann.call('host:deal');
    await slow.ann.until((x) => x.hand?.handNumber === 2 && x.hand.phase !== 'complete');
    expect(await handsOf('Ann Slow')).toBeNull();
    await foldHand(slow.ann, slow.ben, 2);
    clock.advance(61_000);
    expect(await handsOf('Ann Slow')).toBeNull();
    expect(await handsOf('Ann Live')).toBe(1);
    clock.advance(60_000);
    expect(await handsOf('Ann Slow')).toBe(2);
  });
});

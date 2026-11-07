// Hand search: filters on my cards, other players, pot size and result, paging, and share links.

import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { variants } from '@rsdp/engine/core';
import { registerAllVariants } from '@rsdp/engine/variants';
import { createApp } from '../src/app';
import { closeDb, loadSnapshot, saveSnapshot, schema, type Db } from '../src/db';
import { createTestDb } from '../src/db/testing';
import { dbIdentity, dbStore } from '../src/storage';
import { dbSharedHands } from '../src/shared';
import { parseCards } from '../src/handSearch';
import { socketClient, type Client } from './socket-client';
import { FakeClock } from './fake-clock';

let db: Db;
let server: ReturnType<typeof createApp>;
let url = '';
const clients: Client[] = [];
const client = (token: string) => socketClient(url, token, clients);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ANN = 'hs-ann-secret-0123456789';
const BEN = 'hs-ben-secret-0123456789';
const CAL = 'hs-cal-secret-0123456789';

beforeAll(async () => {
  registerAllVariants(variants);
  db = await createTestDb();
  server = createApp({ identity: dbIdentity(db), store: dbStore(db), shared: dbSharedHands(db), accounts: db, log: () => {} });
  await new Promise<void>((resolve) => server.http.listen(0, resolve));
  url = `http://localhost:${(server.http.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const c of clients) c.close();
  await server.close();
  await closeDb(db);
});

type Found = { handId: string; tableId: string; tableName: string; myId: string; pot: number; hand: { fair?: { serverSeed: string | null } | null; handNumber: number; seats: { name: string }[]; events: { t: string; seat?: number; cards?: { card: string }[] }[] } };
const search = async (query: string, guest = ANN) => {
  const res = await fetch(`${url}/api/hands/search?${query}`, { headers: { 'x-guest-token': guest } });
  return { status: res.status, ...((await res.json()) as { hands: Found[]; next: string | null; error?: string }) };
};

/** Two players play `hands` hands where whoever acts first folds. */
async function play(name: string, a: string, b: string, names: [string, string], hands: number, game?: { gameId: string; betting: string }) {
  const x = client(a);
  const y = client(b);
  const { tableId } = await x.call<{ tableId: string }>('table:create', { settings: { table: { name }, seating: { requireApproval: false }, timing: { autoStartNextHand: false }, ...(game ? { game } : {}) } });
  await x.call('table:join', { tableId });
  await y.call('table:join', { tableId });
  await x.call('seat:request', { seat: 0, name: names[0], stack: 100 });
  await y.call('seat:request', { seat: 1, name: names[1], stack: 100 });
  await x.until((v) => v.seats.filter(Boolean).length === 2);
  await x.call('host:start');
  for (let i = 0; i < hands; i++) {
    const v = await x.until((h) => !!h.hand && h.hand.phase !== 'complete' && h.hand.handNumber === i + 1);
    await (v.legal ? x : y).call('hand:act', { type: 'fold' });
    await x.until((h) => h.hand?.handNumber === i + 1 && h.hand.phase === 'complete');
    if (i + 1 < hands) await x.call('host:deal');
  }
  await pause(900);
  return tableId;
}

describe('reading cards', () => {
  it('understands ranks, suited and offsuit, and exact cards', () => {
    expect(parseCards('AA')!(['As', 'Ad'])).toBe(true);
    expect(parseCards('AA')!(['As', 'Kd'])).toBe(false);
    expect(parseCards('AKs')!(['Ah', 'Kh'])).toBe(true);
    expect(parseCards('AKs')!(['Ah', 'Kd'])).toBe(false);
    expect(parseCards('ak o')!(['Ah', 'Kd'])).toBe(true);
    expect(parseCards('AsKs')!(['Ks', 'As', '2c'])).toBe(true);
    expect(parseCards('10 10')!(['Th', 'Td'])).toBe(true);
    expect(parseCards('Q')!(['2c', 'Qd'])).toBe(true);
    expect(parseCards('hello')).toBeNull();
  });
});

describe('hand search', () => {
  it('finds my hands newest first, filters them, pages and shares', { timeout: 40_000 }, async () => {
    await play('With Ben', ANN, BEN, ['Ann', 'Ben'], 3);
    await play('With Cal', ANN, CAL, ['Ann', 'Cal'], 2);
    // A game Ann wasn't in never shows up for her.
    await play('Ben and Cal', BEN, CAL, ['Ben', 'Cal'], 1);

    const all = await search('');
    expect(all.hands.map((h) => `${h.tableName} ${h.hand.handNumber}`)).toEqual(['With Cal 2', 'With Cal 1', 'With Ben 3', 'With Ben 2', 'With Ben 1']);
    expect(all.next).toBeNull();
    // Only my cards come face up: the other player's are hidden or missing.
    const first = all.hands[0];
    const mySeat = first.hand.seats.findIndex((s) => s.name === 'Ann');
    for (const e of first.hand.events.filter((x) => x.t === 'deal' && x.seat !== mySeat)) for (const c of e.cards ?? []) expect(c.card).toBe('??');

    expect((await search('player=ben')).hands.every((h) => h.tableName === 'With Ben')).toBe(true);
    expect((await search('player=ben')).hands).toHaveLength(3);
    // Blinds only: every pot here is 1.5 big blinds.
    expect((await search('minPot=1')).hands).toHaveLength(5);
    expect((await search('minPot=2')).hands).toHaveLength(0);
    const won = (await search('result=won')).hands.length;
    const lost = (await search('result=lost')).hands.length;
    expect(won + lost).toBe(5);

    // My actual cards in the newest hand find it.
    const mine = first.hand.events.find((x) => x.t === 'deal' && x.seat === mySeat)!.cards!.map((c) => c.card).join('');
    expect((await search(`cards=${mine}`)).hands.map((h) => h.handId)).toContain(first.handId);
    expect((await search('cards=nonsense')).status).toBe(400);

    // Sharing: my own hand makes a link anyone can open; someone else's hand looks missing.
    const share = await fetch(`${url}/api/hands/share`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-guest-token': ANN }, body: JSON.stringify({ handId: first.handId, hideMine: true }) });
    const { id } = (await share.json()) as { id: string };
    const link = (await (await fetch(`${url}/api/shared/${id}`)).json()) as { tableName: string; sharerSeat?: number; hand: Found['hand'] };
    expect(link.tableName).toBe('With Cal');
    // Hidden: my cards are face down too, and the link carries no sharerSeat, since there are no cards of mine to show.
    // (It still names me as the sharer, so this isn't anonymous.)
    for (const e of link.hand.events.filter((x) => x.t === 'deal')) for (const c of e.cards ?? []) expect(c.card).toBe('??');
    expect(link.sharerSeat).toBeUndefined();
    // Shown: my cards are face up, and the link names my seat so the replay shows them.
    const shown = await fetch(`${url}/api/hands/share`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-guest-token': ANN }, body: JSON.stringify({ handId: first.handId }) });
    const shownLink = (await (await fetch(`${url}/api/shared/${((await shown.json()) as { id: string }).id}`)).json()) as { sharerSeat?: number; hand: Found['hand'] };
    expect(shownLink.sharerSeat).toBe(mySeat);
    for (const c of shownLink.hand.events.find((x) => x.t === 'deal' && x.seat === mySeat)!.cards!) expect(c.card).not.toBe('??');
    const bensHands = (await search('', BEN)).hands.filter((h) => h.tableName === 'Ben and Cal');
    const theirs = await fetch(`${url}/api/hands/share`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-guest-token': ANN }, body: JSON.stringify({ handId: bensHands[0].handId }) });
    expect(theirs.status).toBe(404);

    const games = (await (await fetch(`${url}/api/hands/games`, { headers: { 'x-guest-token': ANN } })).json()) as { games: { id: string; hands: number }[] };
    expect(games.games).toEqual([expect.objectContaining({ hands: 5 })]);
  });
});

describe('hand search and a stopped game', () => {
  it('follows the running table, not a save left from before the game started again', { timeout: 30_000 }, async () => {
    const DAN = 'hs-dan-secret-0123456789';
    const EVE = 'hs-eve-secret-0123456789';
    const tableId = await play('Stopped and started', DAN, EVE, ['Dan', 'Eve'], 1);
    // The save still says the game was stopped after hand 1, long enough ago that its hands would be open
    // (a save that failed after the host started again); the table running now says otherwise.
    const snap = await loadSnapshot<{ fair: { stopped?: { through: number; at: number } } }>(db, tableId);
    snap!.state.fair.stopped = { through: 1, at: 0 };
    await saveSnapshot(db, tableId, snap!);
    const found = (await search('', DAN)).hands.find((h) => h.tableId === tableId)!;
    expect(found.hand.fair).toBeTruthy();
    expect(found.hand.fair!.serverSeed).toBeNull();
  });
});

describe('hand search for someone now watching on a delay (#435)', () => {
  it('keeps the reveal time their view has when the host stops the game at the end of the live hand', { timeout: 30_000 }, async () => {
    const FAY = 'hs-ivy-secret-0123456789';
    const GUS = 'hs-jon-secret-0123456789';
    const HAL = 'hs-kim-secret-0123456789';
    const fay = client(FAY);
    const gus = client(GUS);
    const hal = client(HAL);
    const { tableId } = await fay.call<{ tableId: string }>('table:create', {
      settings: { table: { name: 'Delayed search' }, seating: { requireApproval: false }, spectators: { allowed: true, delaySeconds: 60 }, timing: { autoStartNextHand: false } },
    });
    for (const c of [fay, gus, hal]) await c.call('table:join', { tableId });
    await fay.call('seat:request', { seat: 0, name: 'Fay', stack: 100 });
    await gus.call('seat:request', { seat: 1, name: 'Gus', stack: 100 });
    await hal.call('seat:request', { seat: 2, name: 'Hal', stack: 100 });
    await fay.until((v) => v.seats.filter(Boolean).length === 3);
    await fay.call('host:start');
    const players = [fay, gus, hal];
    const playOut = async (n: number) => {
      for (let i = 0; i < 10; i++) {
        const v = await fay.until((h) => h.hand?.handNumber === n);
        if (v.hand!.phase === 'complete') return;
        const mover = players.find((c) => c.view()?.legal && c.view()?.hand?.handNumber === n);
        if (mover) await mover.call('hand:act', { type: 'fold' }).catch(() => {});
        await pause(50);
      }
    };
    await playOut(1);
    await fay.until((h) => h.hand?.phase === 'complete');
    // Hal stands up and watches, a minute behind; hand 2 is dealt without him and the host stops the game in it.
    (hal.socket.emit as (e: string, ...a: unknown[]) => void)('seat:stand', {});
    await fay.until((v) => !v.seats[2]);
    await fay.call('host:deal');
    await fay.until((h) => h.hand?.handNumber === 2 && h.hand.phase !== 'complete');
    await fay.call('host:stop');
    await pause(900);
    const revealsAt = async () => (await search('', HAL)).hands.find((h) => h.tableId === tableId)!.hand.fair as { revealsAt: number | null; serverSeed: string | null };
    const before = await revealsAt();
    expect(before.serverSeed).toBeNull();
    // The live hand ends and the stop takes effect: a minute behind, Hal's search still has the reveal time as it was.
    await playOut(2);
    await fay.until((h) => !h.started);
    await pause(900);
    expect(await revealsAt()).toEqual(before);
  });
});

describe('hand search for someone who just left a table with a delay (#435)', () => {
  it('has their last hand to its end at once, but a card shown after they left only once their view has it', { timeout: 30_000 }, async () => {
    // A server of its own on a fake clock, on the same database, so the hand can run longer than the delay.
    const clock = new FakeClock();
    clock.t = Date.now();
    const own = createApp({ clock, identity: dbIdentity(db), store: dbStore(db), shared: dbSharedHands(db), accounts: db, log: () => {} });
    await new Promise<void>((resolve) => own.http.listen(0, resolve));
    const at = `http://localhost:${(own.http.address() as AddressInfo).port}`;
    const mine: Client[] = [];
    try {
      const FAY = 'hs-lou-secret-0123456789';
      const GUS = 'hs-max-secret-0123456789';
      const HAL = 'hs-ned-secret-0123456789';
      const [fay, gus, hal] = [FAY, GUS, HAL].map((t) => socketClient(at, t, mine));
      const { tableId } = await fay.call<{ tableId: string }>('table:create', {
        settings: { table: { name: 'Left on a delay' }, seating: { requireApproval: false }, spectators: { allowed: true, delaySeconds: 15 }, timing: { decisionSeconds: 0, autoStartNextHand: false } },
      });
      for (const c of [fay, gus, hal]) await c.call('table:join', { tableId });
      await fay.call('seat:request', { seat: 0, name: 'Lou', stack: 100 });
      await gus.call('seat:request', { seat: 1, name: 'Max', stack: 100 });
      await hal.call('seat:request', { seat: 2, name: 'Ned', stack: 100 });
      await fay.until((v) => v.seats.filter(Boolean).length === 3);
      await fay.call('host:start');
      await fay.until((v) => !!v.hand && v.hand.phase !== 'complete');
      // The hand runs past the delay, so what spectators are shown is the hand being played.
      clock.advance(20_000);
      const players = [fay, gus, hal];
      for (let i = 0; i < 10; i++) {
        const v = await fay.until((h) => !!h.hand);
        if (v.hand!.phase === 'complete') break;
        const mover = players.find((c) => c.view()?.legal);
        if (mover) await mover.call('hand:act', { type: 'fold' }).catch(() => {});
        await pause(50);
      }
      await fay.until((v) => v.hand?.phase === 'complete');
      // Ned stands up as it ends: he now watches 15 s behind, his view still in the hand.
      (hal.socket.emit as (e: string, ...a: unknown[]) => void)('seat:stand', {});
      await fay.until((v) => !v.seats[2]);
      await pause(300);
      type Hand = { handId: string; tableId: string; seatCount: number; hand: { events: { t: string }[] } };
      const find = async () => {
        const res = await fetch(`${at}/api/hands/search`, { headers: { 'x-guest-token': HAL } });
        return ((await res.json()) as { hands: Hand[] }).hands.find((h) => h.tableId === tableId)!;
      };
      const kinds = (h: { events: { t: string }[] }) => h.events.map((e) => e.t);
      const found = await find();
      expect(kinds(found.hand)).toContain('hand-end');
      expect(found.seatCount).toBe(10);
      const share = await fetch(`${at}/api/hands/share`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-guest-token': HAL }, body: JSON.stringify({ handId: found.handId }) });
      const link = (await (await fetch(`${at}/api/shared/${((await share.json()) as { id: string }).id}`)).json()) as { seatCount: number; hand: { events: { t: string }[] } };
      expect(kinds(link.hand)).toEqual(kinds(found.hand));
      // A player still seated shows a card: Ned's search has it only once his view shows it.
      await fay.call('hand:show', { cards: [0], handNumber: 1 });
      await pause(300);
      expect(kinds((await find()).hand)).not.toContain('show');
      // The table gets smaller: the hand keeps the size it was played at.
      await fay.call('host:settings', { patch: { table: { maxSeats: 6 } } });
      await fay.until((v) => v.seats.length === 6);
      clock.advance(1_000);
      await pause(900);
      expect((await find()).seatCount).toBe(10);
      clock.advance(20_000);
      await pause(300);
      expect(kinds((await find()).hand)).toContain('show');
    } finally {
      for (const c of mine) c.close();
      await own.close();
    }
  });
});

describe('hand search by game and betting', () => {
  it("keeps Limit and No-Limit Hold'em apart, and counts an older hand with no betting saved as No-Limit", { timeout: 40_000 }, async () => {
    const FAY = 'hs-fay-secret-0123456789';
    const GUS = 'hs-gus-secret-0123456789';
    await play('Limit', FAY, GUS, ['Fay', 'Gus'], 2, { gameId: 'nlhe', betting: 'fixed-limit' });
    await play('No-Limit', FAY, GUS, ['Fay', 'Gus'], 3);
    // Saved before the betting was kept with each hand.
    const old = await play('Old', FAY, GUS, ['Fay', 'Gus'], 1);
    await db.update(schema.hands).set({ header: sql`${schema.hands.header} #- '{input,betting}'` }).where(eq(schema.hands.tableId, old));
    const [saved] = await db.select({ betting: sql<string | null>`${schema.hands.header} -> 'input' ->> 'betting'` }).from(schema.hands).where(eq(schema.hands.tableId, old));
    expect(saved.betting).toBeNull();

    const games = (await (await fetch(`${url}/api/hands/games`, { headers: { 'x-guest-token': FAY } })).json()) as { games: { id: string; betting?: string; name: string; hands: number }[] };
    expect(games.games).toEqual([
      { id: 'nlhe', betting: 'no-limit', name: "No-Limit Hold'em", hands: 4 },
      { id: 'nlhe', betting: 'fixed-limit', name: "Limit Hold'em", hands: 2 },
    ]);

    const tables = async (query: string) => (await search(query, FAY)).hands.map((h) => h.tableName).sort();
    expect(await tables('game=nlhe&betting=no-limit')).toEqual(['No-Limit', 'No-Limit', 'No-Limit', 'Old']);
    expect(await tables('game=nlhe&betting=fixed-limit')).toEqual(['Limit', 'Limit']);
    // A link from before: the game alone finds every betting of it.
    expect(await tables('game=nlhe')).toHaveLength(6);
    // A betting that isn't one is ignored.
    expect(await tables('game=nlhe&betting=table-stakes')).toHaveLength(6);
    expect(await tables('game=plo4&betting=no-limit')).toEqual([]);
  });
});

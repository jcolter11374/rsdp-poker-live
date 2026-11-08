// Spectators on a delay, end to end through the socket server (#435): what reaches them, and when.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { variants } from '@rsdp/engine/core';
import { registerAllVariants } from '@rsdp/engine/variants';
import type { TableView } from '@rsdp/engine/wire';
import { createApp } from '../src/app';
import { FAIR_REVEAL_AFTER_MS, FAIR_STOP_REVEAL_MS } from '../src/runtime/table';
import { FakeClock } from './fake-clock';
import { socketClient, type Client } from './socket-client';

const INDEX = '<!doctype html><html><head><title>RSDP Live!</title></head><body><div id="root"></div></body></html>';

let dir = '';
let clock: FakeClock;
let server: ReturnType<typeof createApp>;
let url = '';
let clients: Client[] = [];
const client = (token: string) => socketClient(url, token, clients);
type Player = ReturnType<typeof client>;
/** Real time, for messages already sent to arrive. */
const settle = () => new Promise((r) => setTimeout(r, 60));

beforeAll(async () => {
  registerAllVariants(variants);
  dir = await mkdtemp(path.join(tmpdir(), 'rsdp-web-'));
  await writeFile(path.join(dir, 'index.html'), INDEX);
});

beforeEach(async () => {
  clock = new FakeClock();
  clock.t = Date.now();
  clients = [];
  server = createApp({ clock, webDist: dir, log: () => {} });
  await new Promise<void>((resolve) => server.http.listen(0, resolve));
  url = `http://localhost:${(server.http.address() as AddressInfo).port}`;
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await server.close();
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Ann (the host) and Ben heads-up with `delaySeconds`, a fan watching, the first hand dealt and not yet shown to the fan. */
async function table(name: string, delaySeconds: number, settings: object = {}) {
  const ann = client(`gap-${name}-ann-0123456789`);
  const ben = client(`gap-${name}-ben-0123456789`);
  const fan = client(`gap-${name}-fan-0123456789`);
  const { tableId } = await ann.call<{ tableId: string }>('table:create', {
    settings: { seating: { requireApproval: false }, spectators: { allowed: true, delaySeconds }, timing: { decisionSeconds: 0, autoStartNextHand: false }, ...settings },
  });
  for (const c of [ann, ben, fan]) await c.call('table:join', { tableId });
  await ann.call('seat:request', { seat: 0, name: 'Ann', stack: 10_000 });
  await ben.call('seat:request', { seat: 1, name: 'Ben', stack: 10_000 });
  await ann.until((v) => v.seats.filter(Boolean).length === 2);
  await ann.call('host:start');
  await ann.until((v) => !!v.hand);
  await ben.until((v) => !!v.hand);
  return { ann, ben, fan, tableId };
}

/** Whoever is to act in the live hand. */
const toAct = (ann: Player, ben: Player) => (ann.view().legal ? ann : ben);

/** Every table:state the fan is sent from now on. */
function record(fan: Player) {
  const views: TableView[] = [];
  fan.socket.on('table:state', (v) => views.push(v));
  return views;
}

describe('a spectator on a delay', () => {
  it('is sent nothing while the live table plays on, only what changes in their view when it comes due (item 6)', async () => {
    const { ann, ben, fan } = await table('quiet', 30);
    // Thirty seconds on, the fan sees the first hand dealt.
    clock.advance(30_000);
    const seen = await fan.until((v) => v.hand?.handNumber === 1);
    const views = record(fan);
    // The live hand ends: a fold, a rabbit hunt, a show, the next hand dealt and played on.
    const sb = toAct(ann, ben);
    await sb.call('hand:act', { type: 'fold' });
    await ann.until((v) => v.hand?.phase === 'complete' && v.rabbit.available);
    clock.advance(1_000);
    await ann.call('hand:rabbit');
    await (sb === ann ? ben : ann).call('hand:show', { cards: [0], handNumber: 1 }).catch(() => {});
    clock.advance(1_000);
    await ann.call('host:deal');
    await ann.until((v) => v.hand?.handNumber === 2);
    await toAct(ann, ben).call('hand:act', { type: 'call' });
    clock.advance(3_000);
    await settle();
    // Not one update: nothing they are shown has changed, and the time of one would say when the live hand ended.
    expect(views).toHaveLength(0);
    expect(fan.view()).toEqual(seen);
    // Chat is live for everyone: one update with it.
    await ben.call('chat:send', { text: 'nh' });
    await fan.until((v) => v.chat.some((m) => m.text === 'nh'));
    await settle();
    expect(views).toHaveLength(1);
    expect(views[0].hand?.handNumber).toBe(1);
    expect(views[0].hand?.phase).not.toBe('complete');
    // The fold is shown thirty seconds after it was made.
    clock.advance(24_999);
    await settle();
    expect(views.filter((v) => v.hand?.phase === 'complete')).toHaveLength(0);
    clock.advance(1);
    const ended = await fan.until((v) => v.hand?.handNumber === 1 && v.hand.phase === 'complete');
    expect(ended.spectator?.delaySeconds).toBe(30);
    // Never the rabbit hunt: that is for whoever asked for it.
    expect(ended.rabbit).toEqual({ available: false, cards: null });
    // Joining again always sends the view, unchanged or not.
    const before = views.length;
    await fan.call('table:join', { tableId: ended.id });
    await settle();
    expect(views.length).toBe(before + 1);
  }, 30_000);

  it('stays on the old delay through the hand dealt under it when the host lengthens it, then waits out the difference (item 2)', async () => {
    const { ann, ben, fan } = await table('longer', 10);
    clock.advance(10_000);
    await fan.until((v) => v.hand?.handNumber === 1);
    // During the hand: the longer delay applies at the next deal, and the seats too (item 1).
    await ann.call('host:settings', { patch: { spectators: { delaySeconds: 40 }, table: { maxSeats: 6 } } });
    await toAct(ann, ben).call('hand:act', { type: 'fold' });
    const endedAt = clock.now();
    await ann.until((v) => v.hand?.phase === 'complete');
    clock.advance(1_000);
    await ann.call('host:deal');
    const dealtAt = clock.now();
    const live = await ann.until((v) => v.hand?.handNumber === 2);
    expect(live.seats).toHaveLength(6);
    expect(live.settings.spectators.delaySeconds).toBe(40);
    await settle();
    // Still ten seconds behind, ten seats and the banner saying 10 until the fan reaches the second hand.
    expect(fan.view().seats).toHaveLength(10);
    expect(fan.view().spectator?.delaySeconds).toBe(10);
    // The end of the first hand is shown ten seconds after it, as it would have been.
    clock.advance(endedAt + 10_000 - clock.now());
    const ended = await fan.until((v) => v.hand?.handNumber === 1 && v.hand.phase === 'complete');
    expect(ended.seats).toHaveLength(10);
    expect(ended.spectator?.delaySeconds).toBe(10);
    // The gap between the hands lasts thirty seconds longer for them; the second hand comes forty seconds after its deal.
    clock.advance(dealtAt + 40_000 - 1 - clock.now());
    await settle();
    expect(fan.view().hand?.handNumber).toBe(1);
    clock.advance(1);
    const second = await fan.until((v) => v.hand?.handNumber === 2);
    expect(second.seats).toHaveLength(6);
    expect(second.spectator?.delaySeconds).toBe(40);
  }, 30_000);

  it('sees the end of the hand before in full when the host shortens the delay, then skips ahead within the new hand (item 2)', async () => {
    const { ann, ben, fan } = await table('shorter', 40);
    clock.advance(40_000);
    await fan.until((v) => v.hand?.handNumber === 1);
    await ann.call('host:settings', { patch: { spectators: { delaySeconds: 5 } } });
    await toAct(ann, ben).call('hand:act', { type: 'fold' });
    const endedAt = clock.now();
    await ann.until((v) => v.hand?.phase === 'complete');
    clock.advance(1_000);
    await ann.call('host:deal');
    const dealtAt = clock.now();
    await ann.until((v) => v.hand?.handNumber === 2);
    const views = record(fan);
    // Not before forty seconds after the live fold (five after the deal) does the fan see anything new.
    clock.advance(dealtAt + 5_000 - clock.now());
    await settle();
    expect(views.filter((v) => v.hand?.handNumber === 2 || v.hand?.phase === 'complete')).toHaveLength(0);
    clock.advance(endedAt + 40_000 - clock.now());
    await fan.until((v) => v.hand?.handNumber === 1 && v.hand.phase === 'complete');
    // Then the second hand, dealt a second after the fold: shown at once after the gap as it was, a second.
    clock.advance(1_000);
    const second = await fan.until((v) => v.hand?.handNumber === 2);
    expect(second.spectator?.delaySeconds).toBe(5);
    // From there on, five seconds behind.
    const callAt = clock.now();
    await toAct(ann, ben).call('hand:act', { type: 'call' });
    clock.advance(callAt + 5_000 - 1 - clock.now());
    await settle();
    expect(fan.view().hand?.events.length).toBe(second.hand?.events.length);
    clock.advance(1);
    await fan.until((v) => (v.hand?.events.length ?? 0) > (second.hand?.events.length ?? 0));
  }, 30_000);

  it('sees the table live once the delay is turned off and what it showed has run out', async () => {
    const { ann, ben, fan } = await table('off', 20);
    clock.advance(20_000);
    await fan.until((v) => v.hand?.handNumber === 1);
    await ann.call('host:settings', { patch: { spectators: { delaySeconds: 0 } } });
    await toAct(ann, ben).call('hand:act', { type: 'fold' });
    await ann.until((v) => v.hand?.phase === 'complete');
    await ann.call('host:deal');
    await ann.until((v) => v.hand?.handNumber === 2);
    await settle();
    expect(fan.view().hand?.handNumber).toBe(1);
    expect(fan.view().hand?.phase).not.toBe('complete');
    clock.advance(20_000);
    const live = await fan.until((v) => v.hand?.handNumber === 2);
    expect(live.spectator?.delaySeconds ?? 0).toBe(0);
    // Live from here: the next move reaches them at once.
    const events = live.hand!.events.length;
    await toAct(ann, ben).call('hand:act', { type: 'call' });
    await fan.until((v) => (v.hand?.events.length ?? 0) > events);
  }, 30_000);
});

describe('a spectator on a delay on the waitlist, after the host lengthens the delay (#452)', () => {
  it('still gets the whole minute from when their view shows the seat free', async () => {
    const { ann, ben, fan } = await table('offer-longer', 10, { table: { maxSeats: 2 }, seating: { requireApproval: false, waitlist: true } });
    clock.advance(10_000);
    await fan.until((v) => v.hand?.handNumber === 1);
    await fan.call('waitlist:join', { name: 'Fan', stack: 10_000 });
    // Forty seconds from the next hand; Ben leaves after that one.
    await ann.call('host:settings', { patch: { spectators: { delaySeconds: 40 } } });
    await toAct(ann, ben).call('hand:act', { type: 'fold' });
    await ann.until((v) => v.hand?.phase === 'complete');
    clock.advance(1_000);
    await ann.call('host:deal');
    await ann.until((v) => v.hand?.handNumber === 2);
    (ben.socket.emit as (e: string, ...a: unknown[]) => void)('seat:stand', { afterHand: true });
    await ann.until((v) => !!v.seats[1]?.leaving);
    clock.advance(2_000);
    await toAct(ann, ben).call('hand:act', { type: 'fold' });
    const freedAt = clock.now();
    await ann.until((v) => !v.seats[1] && v.offers.some((o) => o.name === 'Fan'));
    // The hand it came free in is shown forty seconds on, and so is the offer, with a minute to go.
    clock.advance(39_999);
    await settle();
    expect(fan.view().offers).toEqual([]);
    clock.advance(1);
    const offered = await fan.until((v) => v.offers.some((o) => o.playerId === v.me.playerId));
    expect(offered.seats[1]).toBeNull();
    const mine = offered.offers.find((o) => o.playerId === offered.me.playerId)!;
    expect(mine.expiresAt - offered.serverNow).toBe(60_000);
    expect(mine.expiresAt).toBe(freedAt + 100_000);
    clock.advance(59_000);
    await settle();
    expect(fan.view().waitlist.some((w) => w.playerId === offered.me.playerId)).toBe(true);
    await fan.call('seat:request', { seat: 1, name: 'Fan', stack: 10_000 });
    await fan.until((v) => v.seats[1]?.name === 'Fan');
  }, 30_000);
});

describe('a spectator asking for a seat just after the host turns a delay on', () => {
  it('may take a seat left before the delay went on, which their view shows free', async () => {
    const ann = client('gap-on-ann-0123456789');
    const ben = client('gap-on-ben-0123456789');
    const cal = client('gap-on-cal-0123456789');
    const fan = client('gap-on-fan-0123456789');
    const { tableId } = await ann.call<{ tableId: string }>('table:create', {
      settings: { seating: { requireApproval: false }, spectators: { allowed: true, delaySeconds: 0 }, timing: { decisionSeconds: 0, autoStartNextHand: false } },
    });
    for (const c of [ann, ben, cal, fan]) await c.call('table:join', { tableId });
    await ann.call('seat:request', { seat: 0, name: 'Ann', stack: 10_000 });
    await ben.call('seat:request', { seat: 1, name: 'Ben', stack: 10_000 });
    await cal.call('seat:request', { seat: 2, name: 'Cal', stack: 10_000 });
    await fan.until((v) => v.seats.filter(Boolean).length === 3);
    (cal.socket.emit as (e: string, ...a: unknown[]) => void)('seat:stand', {});
    await fan.until((v) => !v.seats[2]);
    clock.advance(10_000);
    await ann.call('host:settings', { patch: { spectators: { delaySeconds: 60 } } });
    await settle();
    clock.advance(5_000);
    await settle();
    // Nobody has sat there since the moment their view shows, so a yes tells them nothing.
    expect(fan.view().seats[2]).toBeNull();
    await fan.call('seat:request', { seat: 2, name: 'Fan', stack: 10_000 });
    await ann.until((v) => v.seats[2]?.name === 'Fan');
  });
});

describe('gestures, seen by a spectator on a delay', () => {
  it('only between players their view has seated, so one at a player who just sat down tells them nothing', async () => {
    const { ann, ben, fan } = await table('gesture', 30);
    clock.advance(30_000);
    await fan.until((v) => v.hand?.handNumber === 1);
    const gestures: { to: string }[] = [];
    fan.socket.on('table:gesture', (g) => gestures.push(g));
    // Dee sits down at the live table; thirty seconds behind, the fan doesn't see her yet.
    const dee = client('gap-gesture-dee-0123456789');
    await dee.call('table:join', { tableId: ann.view().id });
    await dee.call('seat:request', { seat: 2, name: 'Dee', stack: 10_000 });
    const deeId = (await ann.until((v) => v.seats[2]?.name === 'Dee')).seats[2]!.playerId;
    const benId = ann.view().seats[1]!.playerId;
    await ann.call('table:gesture', { to: deeId, kind: 'rose' });
    await dee.call('table:gesture', { to: benId, kind: 'fish' });
    await ann.call('table:gesture', { to: benId, kind: 'clap' });
    await settle();
    expect(gestures.map((g) => g.to)).toEqual([benId]);
    void ben;
  }, 30_000);
});

describe('a spectator on a delay on the waitlist (#452)', () => {
  it('is offered the seat a player left only when their view shows it free, with the whole minute to take it', async () => {
    const { ann, ben, fan } = await table('offer', 30, { table: { maxSeats: 2 }, seating: { requireApproval: false, waitlist: true } });
    clock.advance(30_000);
    await fan.until((v) => v.hand?.handNumber === 1);
    await fan.call('waitlist:join', { name: 'Fan', stack: 10_000 });
    await fan.until((v) => v.waitlist.some((w) => w.name === 'Fan'));
    // Ben leaves after this hand; it ends, and seat 2 is the fan's at the live table.
    (ben.socket.emit as (e: string, ...a: unknown[]) => void)('seat:stand', { afterHand: true });
    await ann.until((v) => !!v.seats[1]?.leaving);
    await toAct(ann, ben).call('hand:act', { type: 'fold' });
    const freedAt = clock.now();
    await ann.until((v) => !v.seats[1] && v.offers.some((o) => o.name === 'Fan'));
    await settle();
    // Thirty seconds behind, Ben is still in seat 2 and there is no offer.
    expect(fan.view().seats[1]?.name).toBe('Ben');
    expect(fan.view().offers).toEqual([]);
    clock.advance(29_999);
    await settle();
    expect(fan.view().offers).toEqual([]);
    clock.advance(1);
    const offered = await fan.until((v) => v.offers.some((o) => o.playerId === v.me.playerId));
    expect(offered.seats[1]).toBeNull();
    // A whole minute from when they see it.
    const mine = offered.offers.find((o) => o.playerId === offered.me.playerId)!;
    expect(mine.expiresAt - offered.serverNow).toBe(60_000);
    expect(mine.expiresAt).toBe(freedAt + 90_000);
    // Still theirs fifty-nine seconds on, and they can take it.
    clock.advance(59_000);
    await settle();
    await fan.call('seat:request', { seat: 1, name: 'Fan', stack: 10_000 });
    await fan.until((v) => v.seats[1]?.name === 'Fan');
  }, 30_000);
});

describe('what a spectator on a delay can fetch', () => {
  it('a pasted link shows the stakes they are shown, not the new ones the live table dealt with (item 4)', async () => {
    const { ann, ben, tableId } = await table('preview', 60, { stakes: { smallBlind: 100, bigBlind: 200, centsMode: true } });
    const preview = async () => (await (await fetch(`${url}/t/${tableId}`)).text()).match(/og:description" content="([^"]*)"/)?.[1] ?? '';
    clock.advance(60_000);
    expect(await preview()).toContain('1/2');
    await ann.call('host:settings', { patch: { stakes: { smallBlind: 500, bigBlind: 1_000 } } });
    await toAct(ann, ben).call('hand:act', { type: 'fold' });
    await ann.until((v) => v.hand?.phase === 'complete');
    await ann.call('host:deal');
    await ann.until((v) => v.hand?.handNumber === 2 && v.settings.stakes.bigBlind === 1_000);
    expect(await preview()).toContain('1/2');
    expect(await preview()).not.toContain('5/10');
    clock.advance(60_000);
    expect(await preview()).toContain('5/10');
  }, 30_000);

  it("sees a card shown after the hand in its hand list and downloads only when their view shows it", async () => {
    const { ann, ben, fan } = await table('late-show', 30);
    clock.advance(30_000);
    await fan.until((v) => v.hand?.handNumber === 1);
    const folder = toAct(ann, ben);
    const winner = folder === ann ? ben : ann;
    await folder.call('hand:act', { type: 'fold' });
    await ann.until((v) => v.hand?.phase === 'complete');
    clock.advance(30_000);
    await fan.until((v) => v.hand?.phase === 'complete');
    type Hand = { hand: { events: { t: string }[] } };
    const shows = async () => (await fan.call<Hand>('table:history', { handNumber: 1 })).hand.events.filter((e) => e.t === 'show').length;
    const exported = async () => (await fan.call<{ hands: { events: { t: string }[] }[] }>('table:export')).hands[0].events.filter((e) => e.t === 'show').length;
    expect(await shows()).toBe(0);
    // The winner shows a card live, thirty seconds after the hand ended.
    await winner.call('hand:show', { cards: [0], handNumber: 1 });
    await winner.until((v) => (v.hand?.events ?? []).some((e) => e.t === 'show'));
    expect(await shows()).toBe(0);
    expect(await exported()).toBe(0);
    clock.advance(30_000);
    await fan.until((v) => (v.hand?.events ?? []).some((e) => e.t === 'show'));
    expect(await shows()).toBe(1);
    expect(await exported()).toBe(1);
  }, 30_000);

  it('cannot fetch or share the hand before when the host shortens the delay, until their view shows it end', async () => {
    const { ann, ben, fan } = await table('shorter-fetch', 40);
    clock.advance(40_000);
    await fan.until((v) => v.hand?.handNumber === 1);
    await ann.call('host:settings', { patch: { spectators: { delaySeconds: 5 } } });
    await toAct(ann, ben).call('hand:act', { type: 'fold' });
    const endedAt = clock.now();
    await ann.until((v) => v.hand?.phase === 'complete');
    clock.advance(1_000);
    await ann.call('host:deal');
    await ann.until((v) => v.hand?.handNumber === 2);
    // Well past the new five seconds, but their view still has hand 1 being played.
    clock.advance(10_000);
    await settle();
    expect(fan.view().hand?.phase).not.toBe('complete');
    await expect(fan.call('table:history', { handNumber: 1 })).rejects.toThrow(/that hand isn’t available/);
    await expect(fan.call('hand:share', { handNumber: 1 })).rejects.toThrow(/that hand isn’t available/);
    clock.advance(endedAt + 40_000 - clock.now());
    await fan.until((v) => v.hand?.handNumber === 1 && v.hand.phase === 'complete');
    expect((await fan.call<{ hand: { handNumber: number } }>('table:history', { handNumber: 1 })).hand.handNumber).toBe(1);
    await fan.call('hand:share', { handNumber: 1 });
  }, 30_000);

  it('who never played can download the full log only once their view shows the game stopped', async () => {
    const { ann, ben, fan } = await table('full-log', 30);
    await toAct(ann, ben).call('hand:act', { type: 'fold' });
    await ann.until((v) => v.hand?.phase === 'complete');
    // Once their view has a real hand played, the game is on and downloads are closed to them.
    clock.advance(30_000);
    await fan.until((v) => v.hand?.phase === 'complete');
    await expect(fan.call('table:fullLog')).rejects.toThrow(/downloads open/);
    await ann.call('host:stop');
    await ann.until((v) => !v.started);
    await expect(fan.call('table:fullLog')).rejects.toThrow(/downloads open/);
    clock.advance(30_000);
    await fan.until((v) => !v.started);
    const full = await fan.call<{ hands: unknown[] }>('table:fullLog');
    expect(full.hands).toHaveLength(1);
  }, 30_000);

  it('is told when a hand opens as their view stands, when the host stops and starts again within the delay', async () => {
    const { ann, ben, fan } = await table('reveal', 30);
    await toAct(ann, ben).call('hand:act', { type: 'fold' });
    const endedAt = clock.now();
    await ann.until((v) => v.hand?.phase === 'complete');
    clock.advance(1_000);
    await ann.call('host:stop');
    const stoppedAt = clock.now();
    clock.advance(10_000);
    await ann.call('host:start');
    await ann.until((v) => v.hand?.handNumber === 2);
    type Fair = { hand: { fair: { revealsAt: number | null } } };
    const revealsAt = async () => (await fan.call<Fair>('table:history', { handNumber: 1 })).hand.fair.revealsAt;
    // Live, starting again before the half hour keeps the hand private for its 12 hours.
    expect((await ann.call<Fair>('table:history', { handNumber: 1 })).hand.fair.revealsAt).toBe(endedAt + FAIR_REVEAL_AFTER_MS);
    // Their view shows the game stopped: it opens half an hour after the stop, as it would have then.
    clock.advance(stoppedAt + 30_000 - clock.now());
    await fan.until((v) => !v.started);
    expect(await revealsAt()).toBe(stoppedAt + FAIR_STOP_REVEAL_MS);
    // Once their view reaches the start, the 12 hours.
    clock.advance(10_000);
    await fan.until((v) => v.hand?.handNumber === 2);
    expect(await revealsAt()).toBe(endedAt + FAIR_REVEAL_AFTER_MS);
  }, 30_000);

  it('can share a hand only once it has ended in their view, as the table it was played at (item 4)', async () => {
    const { ann, ben, fan, tableId } = await table('share', 30);
    clock.advance(30_000);
    await fan.until((v) => v.hand?.handNumber === 1);
    await toAct(ann, ben).call('hand:act', { type: 'fold' });
    await ann.until((v) => v.hand?.phase === 'complete');
    // Between hands, so the new seats and name apply at once at the live table.
    await ann.call('host:settings', { patch: { table: { maxSeats: 6, name: 'Renamed' } } });
    await ann.until((v) => v.seats.length === 6);
    await expect(fan.call('hand:share', { handNumber: 1 })).rejects.toThrow(/that hand isn’t available/);
    clock.advance(30_000);
    await fan.until((v) => v.hand?.phase === 'complete');
    const { id } = await fan.call<{ id: string }>('hand:share', { handNumber: 1 });
    const shared = (await (await fetch(`${url}/api/shared/${id}`)).json()) as { seatCount: number; tableName: string };
    // The hand as it was played, at ten seats; the name changes at once for everyone, so it is the new one.
    expect(shared.seatCount).toBe(10);
    expect(shared.tableName).toBe('Renamed');
    void tableId;
  }, 30_000);
});

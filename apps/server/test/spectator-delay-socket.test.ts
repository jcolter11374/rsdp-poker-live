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

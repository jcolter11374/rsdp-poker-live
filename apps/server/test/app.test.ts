import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import { variants } from '@rsdp/engine/core';
import { registerAllVariants } from '@rsdp/engine/variants';
import type { ClientToServer, ServerToClient } from '@rsdp/engine/wire';
import { createApp } from '../src/app';
import { socketClient } from './socket-client';

type Client = Socket<ServerToClient, ClientToServer>;

let server: ReturnType<typeof createApp>;
let url = '';
const clients: Client[] = [];

beforeAll(async () => {
  registerAllVariants(variants);
  server = createApp({ log: () => {} });
  await new Promise<void>((resolve) => server.http.listen(0, resolve));
  url = `http://localhost:${(server.http.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const c of clients) c.close();
  await server.close();
});

const client = (token: string) => socketClient(url, token, clients);

describe('socket server', () => {
  it('shrugs off malformed messages instead of crashing (one bad client must not restart every table)', async () => {
    const c = client('malformed-0123456789');
    const { tableId } = await c.call<{ tableId: string }>('table:create', {});
    await c.call('table:join', { tableId });
    (c.socket.emit as (e: string, ...a: unknown[]) => void)('seat:sitOut');
    (c.socket.emit as (e: string, ...a: unknown[]) => void)('hand:draw');
    (c.socket.emit as (e: string, ...a: unknown[]) => void)('seat:prefs', null, null);
    // Still connected and answering.
    await c.call('seat:request', { seat: 0, name: 'Still here', stack: 100 });
    expect((await c.until((v) => !!v.seats[0])).seats[0]?.name).toBe('Still here');
  });

  it('exports every finished hand, hiding cards the viewer never saw', async () => {
    const host = client('export-host-0123456789');
    const guest = client('export-guest-0123456789');
    const { tableId } = await host.call<{ tableId: string }>('table:create', { settings: { seating: { requireApproval: false } } });
    await host.call('table:join', { tableId });
    await guest.call('table:join', { tableId });
    await host.call('seat:request', { seat: 0, name: 'Host', stack: 100 });
    await guest.call('seat:request', { seat: 1, name: 'Guest', stack: 100 });
    await host.call('host:start');
    const v = await host.until((x) => !!x.hand);
    // Whoever acts first folds, which ends the hand.
    const first = v.hand!.toAct === v.me.seat ? host : guest;
    await first.until((x) => x.legal !== null);
    await first.call('hand:act', { type: 'fold' });
    await host.until((x) => x.history.length === 1);
    const { hands } = await guest.call<{ hands: import('@rsdp/engine/wire').HandRecordView[] }>('table:export');
    expect(hands).toHaveLength(1);
    expect(hands[0].seats.map((s) => s.name).sort()).toEqual(['Guest', 'Host']);
    const deals = hands[0].events.filter((e) => e.t === 'deal') as Extract<(typeof hands)[0]['events'][number], { t: 'deal' }>[];
    const hostSeat = v.me.seat!;
    expect(deals.find((d) => d.seat === hostSeat)!.cards.every((c) => c.card === '??')).toBe(true);
    expect(deals.find((d) => d.seat !== hostSeat)!.cards.every((c) => c.card !== '??')).toBe(true);
  });

  it('starts a practice table against bots, and lets a seated player add and remove their own', async () => {
    const host = client('practice-host-0123456789');
    const { tableId } = await host.call<{ tableId: string }>('table:create', { settings: { seating: { requireApproval: false } }, practice: { name: 'John', bots: 2 } });
    await host.call('table:join', { tableId });
    const v = await host.until((x) => !!x.hand);
    expect(v.seats.filter(Boolean).map((s) => s!.name)).toEqual(['John', "John's Poker Bot", "John's Poker Bot 2"]);
    expect(v.seats[1]!.bot).toEqual({ ownerId: v.me.playerId, ownerName: 'John' });

    const ann = client('practice-ann-0123456789');
    await ann.call('table:join', { tableId });
    await expect(ann.call('bot:add', {})).rejects.toThrow(/take a seat/);
    await ann.call('seat:request', { seat: 5, name: 'Ann', stack: 100 });
    const { playerId } = await ann.call<{ playerId: string }>('bot:add', {});
    const seated = await ann.until((x) => x.seats.some((s) => s?.playerId === playerId));
    expect(seated.seats.find((s) => s?.playerId === playerId)!.name).toBe("Ann's Poker Bot");
    await expect(host.call('bot:remove', { playerId: v.seats[1]!.playerId })).resolves.toBeTruthy();
    await ann.call('bot:remove', { playerId });
    await ann.until((x) => !x.seats.some((s) => s?.playerId === playerId && !s.leaving));
  });

  it('lists people watching the table by name, but not seated players', async () => {
    const host = client('watch-host-0123456789');
    const fan = client('watch-fan-0123456789');
    await fan.call('session:name', { name: 'Railbird' });
    const { tableId } = await host.call<{ tableId: string }>('table:create', { settings: {} });
    await host.call('table:join', { tableId });
    await host.call('seat:request', { seat: 0, name: 'Host', stack: 100 });
    await fan.call('table:join', { tableId });
    const v = await host.until((x) => x.watchers.length === 1);
    expect(v.watchers[0].name).toBe('Railbird');
    fan.socket.emit('table:leave');
    await host.until((x) => x.watchers.length === 0);
  });

  it('shows spectators every card, a delay behind the table', async () => {
    const host = client('delay-host-0123456789');
    const guest = client('delay-guest-0123456789');
    const fan = client('delay-fan-0123456789');
    const settings = { seating: { requireApproval: false }, spectators: { seeAllCards: true, delaySeconds: 2 }, timing: { decisionSeconds: 0 } };
    const { tableId } = await host.call<{ tableId: string }>('table:create', { settings });
    for (const c of [host, guest, fan]) await c.call('table:join', { tableId });
    await host.call('seat:request', { seat: 0, name: 'Host', stack: 100 });
    await guest.call('seat:request', { seat: 1, name: 'Guest', stack: 100 });
    await host.call('host:start');
    const started = Date.now();
    await host.until((x) => !!x.hand);
    // The players have a hand; the spectator doesn't yet.
    expect(fan.view().hand).toBeNull();
    expect(fan.view().spectator).toEqual({ delaySeconds: 2, seeAll: true, blocked: false });
    const later = await fan.until((x) => !!x.hand);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
    expect(later.seats.filter(Boolean).every((s) => s!.cards.length === 2 && s!.cards.every((c) => c.card !== '??'))).toBe(true);
    // Hand history can't get ahead of the delay.
    // Whoever is to act folds, which ends the hand.
    const first = await Promise.race([host, guest].map((c) => c.until((x) => x.legal !== null).then(() => c)));
    await first.call('hand:act', { type: 'fold' });
    await host.until((x) => x.history.length === 1);
    await expect(fan.call('table:history', { handNumber: 1 })).rejects.toThrow(/once the delay has passed/);
    // Chat stays live for everyone.
    await guest.call('chat:send', { text: 'gl' });
    await fan.until((x) => x.chat.some((m) => m.text === 'gl'));
  }, 30_000);

  it('acks a chat message the table refuses', async () => {
    const host = client('chat-host-0123456789');
    const fan = client('chat-fan-0123456789');
    const { tableId } = await host.call<{ tableId: string }>('table:create', { settings: { chat: { guestChat: false } } });
    await host.call('table:join', { tableId });
    await fan.call('table:join', { tableId });
    await expect(fan.call('chat:send', { text: 'hi' })).rejects.toThrow(/only players/);
  });

  it('rejects connections without a browser secret', async () => {
    const c: Client = connect(url, { auth: {}, transports: ['websocket'], forceNew: true });
    clients.push(c);
    const err = await new Promise<Error>((resolve) => c.on('connect_error', resolve));
    expect(err.message).toMatch(/token/);
  });

  it('plays a hand between two browsers with hole cards kept private', async () => {
    const host = client('host-secret-0123456789');
    const guest = client('guest-secret-0123456789');
    const { tableId } = await host.call<{ tableId: string }>('table:create', { settings: { table: { name: 'Test night' } } });
    await host.call('table:join', { tableId });
    await guest.call('table:join', { tableId });
    expect(guest.view().name).toBe('Test night');

    await host.call('seat:request', { seat: 0, name: 'Host', stack: 100 });
    await guest.call('seat:request', { seat: 3, name: 'Guest', stack: 100 });
    const pending = await host.until((v) => v.requests.length === 1);
    expect(guest.view().requests).toHaveLength(1);
    await host.call('host:approve', { requestId: pending.requests[0].id });
    await expect(guest.call('host:start')).rejects.toThrow(/host/);
    await host.call('host:start');

    const hv = await host.until((v) => !!v.hand);
    const gv = await guest.until((v) => !!v.hand);
    const hostSeat = hv.seats[0]!;
    const guestSeatFromHost = hv.seats[3]!;
    expect(hostSeat.cards.every((c) => c.card !== '??')).toBe(true);
    expect(guestSeatFromHost.cards.every((c) => c.card === '??')).toBe(true);
    expect(gv.seats[3]!.cards.every((c) => c.card !== '??')).toBe(true);

    // Whoever is to act folds; the other wins the blinds.
    const actor = hv.legal ? host : guest;
    await actor.call('hand:act', { type: 'fold' });
    const done = await host.until((v) => v.hand?.phase === 'complete');
    expect(done.seats[0]!.stack + done.seats[3]!.stack).toBe(200);
    await expect(actor.call('hand:act', { type: 'nonsense' })).rejects.toThrow();
  });

  it('a table survives a restart from its saved state', async () => {
    const host = client('host-secret-restart-0123');
    const { tableId } = await host.call<{ tableId: string }>('table:create', { settings: {} });
    const rt = server.tables.get(tableId)!;
    server.tables.delete(tableId);
    rt.dispose();
    // Not in memory any more: joining loads it back from the store after the debounced save.
    await new Promise((r) => setTimeout(r, 700));
    await host.call('table:join', { tableId });
    expect(host.view().id).toBe(tableId);
  });
});

describe('operator cleanup', () => {
  it('answers only a shell on the server, never a request through the proxy', async () => {
    expect((await fetch(`${url}/api/admin/tournaments`)).status).toBe(200);
    expect((await fetch(`${url}/api/admin/tournaments`, { headers: { 'Fly-Client-IP': '203.0.113.9' } })).status).toBe(404);
    expect((await fetch(`${url}/api/admin/tournaments`, { headers: { 'X-Forwarded-For': '203.0.113.9' } })).status).toBe(404);
    const missing = await fetch(`${url}/api/admin/tournaments/0123456789abcdef/archive`, { method: 'POST', headers: { 'X-Forwarded-For': '203.0.113.9' } });
    expect(missing.status).toBe(404);
    expect((await fetch(`${url}/api/admin/tournaments/0123456789abcdef/archive`, { method: 'POST' })).status).toBe(400);
  });
});

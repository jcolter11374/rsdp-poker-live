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

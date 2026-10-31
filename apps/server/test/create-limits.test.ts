// Making tables and tournaments has a limit per player and per address: far more than a host needs,
// but a script can't fill the server's memory with tables or bury the home page under made-up events.

import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { variants } from '@rsdp/engine/core';
import { registerAllVariants } from '@rsdp/engine/variants';
import { defaultSettings } from '@rsdp/tournament';
import { createApp } from '../src/app';
import { FakeClock } from './fake-clock';
import { socketClient, type Client } from './socket-client';

const MINUTE = 60_000;
let server: ReturnType<typeof createApp>;
let url = '';
const clock = new FakeClock();
const clients: Client[] = [];
/** A browser at an address, as Fly's proxy tells the server. */
const client = (token: string, address: string) => socketClient(url, token, clients, { 'fly-client-ip': address });
const settled = async (calls: Promise<unknown>[]) => (await Promise.allSettled(calls)).map((r) => (r.status === 'fulfilled' ? 'ok' : (r.reason as Error).message));

beforeAll(async () => {
  registerAllVariants(variants);
  server = createApp({ clock, log: () => {} });
  await new Promise<void>((resolve) => server.http.listen(0, resolve));
  url = `http://localhost:${(server.http.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const c of clients.splice(0)) c.close();
  await server.close();
});

describe('limits on making tables and tournaments', () => {
  it('lets one player or one address make 20 cash tables in 10 minutes, then asks them to wait', async () => {
    const before = server.tables.size;
    const script = client('limit-tables-script-0123456789', '203.0.113.1');
    const made = await settled(Array.from({ length: 50 }, () => script.call('table:create', {})));
    expect(made.filter((r) => r === 'ok')).toHaveLength(20);
    expect(made.at(-1)).toMatch(/a lot of new tables/);
    expect(server.tables.size - before).toBe(20);
    // The same player from another address, and someone else from the same address, wait too.
    await expect(client('limit-tables-script-0123456789', '203.0.113.2').call('table:create', {})).rejects.toThrow(/a lot of new tables/);
    await expect(client('limit-tables-neighbour-0123456789', '203.0.113.1').call('table:create', {})).rejects.toThrow(/a lot of new tables/);
    // Anyone else is not held up.
    await client('limit-tables-other-0123456789', '203.0.113.3').call('table:create', {});
    // Ten minutes on, there's room again.
    clock.advance(10 * MINUTE);
    await script.call('table:create', {});
  });

  it('lets one player or one address make 10 tournaments in 10 minutes, so spam can’t bury the home page', async () => {
    const settings = { ...defaultSettings(), name: 'Free chips' };
    const script = client('limit-events-script-0123456789', '198.51.100.1');
    const made = await settled(Array.from({ length: 30 }, () => script.call('tournament:create', { settings })));
    expect(made.filter((r) => r === 'ok')).toHaveLength(10);
    expect(made.at(-1)).toMatch(/a lot of new tournaments/);
    await expect(client('limit-events-script-0123456789', '198.51.100.2').call('tournament:create', { settings })).rejects.toThrow(/a lot of new tournaments/);
    await expect(client('limit-events-neighbour-0123456789', '198.51.100.1').call('tournament:create', { settings })).rejects.toThrow(/a lot of new tournaments/);
    const visitor = client('limit-events-visitor-0123456789', '198.51.100.3');
    const { tournaments } = await visitor.call<{ tournaments: { name: string }[] }>('tournament:list');
    expect(tournaments.filter((t) => t.name === 'Free chips')).toHaveLength(10);
    // Archiving one leaves room under the open limit (below), but not under this one until ten minutes are up.
    const mine = (await script.call<{ tournaments: { id: string; name: string; me: { hosting: boolean } }[] }>('tournament:list')).tournaments.filter((t) => t.name === 'Free chips' && t.me.hosting);
    await script.call('tournament:command', { id: mine[0].id, command: { type: 'archive' } });
    await expect(script.call('tournament:create', { settings })).rejects.toThrow(/a lot of new tournaments/);
    clock.advance(10 * MINUTE);
    await script.call('tournament:create', { settings });
  });

  it('keeps at most 10 open tournaments per player or address, so waiting out the limit can’t fill the home page', async () => {
    const settings = { ...defaultSettings(), name: 'Spam night' };
    // Every 10 minutes: a new guest from the same address, and the same guest from a new address, each try 10 more.
    const roamer = 'open-cap-roamer-0123456789';
    for (let round = 0; round < 4; round++) {
      const guest = client(`open-cap-guest-${round}-0123456789`, '192.0.2.1');
      const moved = client(roamer, `192.0.2.${10 + round}`);
      const made = await settled([
        ...Array.from({ length: 10 }, () => guest.call('tournament:create', { settings })),
        ...Array.from({ length: 10 }, () => moved.call('tournament:create', { settings })),
      ]);
      if (round > 0) expect(made.filter((r) => r === 'ok')).toHaveLength(0);
      clock.advance(10 * MINUTE);
    }
    const visitor = client('open-cap-visitor-0123456789', '192.0.2.99');
    const listed = async () => (await visitor.call<{ tournaments: { name: string }[] }>('tournament:list')).tournaments.filter((t) => t.name === 'Spam night');
    expect(await listed()).toHaveLength(20);
    // Archiving one makes room for one more.
    const host = client(roamer, '192.0.2.20');
    const mine = (await host.call<{ tournaments: { id: string; name: string; me: { hosting: boolean } }[] }>('tournament:list')).tournaments.filter((t) => t.name === 'Spam night' && t.me.hosting);
    await expect(host.call('tournament:create', { settings })).rejects.toThrow(/a lot of open tournaments/);
    await host.call('tournament:command', { id: mine[0].id, command: { type: 'archive' } });
    await host.call('tournament:create', { settings });
    expect(await listed()).toHaveLength(20);
  });
});

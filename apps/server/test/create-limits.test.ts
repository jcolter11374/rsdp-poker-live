// Making tables and tournaments has a limit per player and per address: far more than a host needs,
// but a script can't fill the server's memory with tables or bury the home page under made-up events.

import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { variants } from '@rsdp/engine/core';
import { registerAllVariants } from '@rsdp/engine/variants';
import { defaultSettings } from '@rsdp/tournament';
import { limiterKeys } from '../src/admin';
import { createApp, memoryStore } from '../src/app';
import { memoryTournamentStore } from '../src/tournament/store';
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
/** A server of its own on these stores, as after a restart, with browsers that connect to it. */
async function boot(at: FakeClock, tables: ReturnType<typeof memoryStore>, saved: ReturnType<typeof memoryTournamentStore>) {
  const app = createApp({ clock: at, store: tables, tournaments: saved, log: () => {} });
  await new Promise<void>((resolve) => app.http.listen(0, resolve));
  await app.resume();
  const there = `http://localhost:${(app.http.address() as AddressInfo).port}`;
  return { app, client: (token: string, address: string) => socketClient(there, token, clients, { 'fly-client-ip': address }) };
}

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

  it('tells someone who made none that their network has too many open, not to archive one of theirs', async () => {
    const settings = { ...defaultSettings(), name: 'Club night' };
    // Ten friends behind one address each make one.
    const made = await settled(Array.from({ length: 10 }, (_, i) => client(`open-cap-club-${i}-0123456789`, '192.0.2.30').call('tournament:create', { settings })));
    expect(made.filter((r) => r === 'ok')).toHaveLength(10);
    clock.advance(10 * MINUTE);
    const late = client('open-cap-club-late-0123456789', '192.0.2.30');
    const refused = late.call('tournament:create', { settings });
    await expect(refused).rejects.toThrow(/too many tournaments are open from your network/);
    await expect(refused).rejects.not.toThrow(/archive one you made/);
    // One of the ten, now on another network, still has room for more of their own.
    await client('open-cap-club-0-0123456789', '192.0.2.31').call('tournament:create', { settings });
  });

  it('doesn’t count a create refused for too many open tournaments against the 10 in 10 minutes', async () => {
    const settings = { ...defaultSettings(), name: 'Full house' };
    const host = client('open-cap-retry-host-0123456789', '192.0.2.40');
    expect((await settled(Array.from({ length: 10 }, () => host.call('tournament:create', { settings })))).filter((r) => r === 'ok')).toHaveLength(10);
    clock.advance(60 * MINUTE);
    // Trying again and again while all ten are open costs nothing...
    const tries = await settled(Array.from({ length: 10 }, () => host.call('tournament:create', { settings })));
    expect(tries.every((r) => /a lot of open tournaments/.test(r))).toBe(true);
    // ...so archiving one makes room straight away.
    const mine = (await host.call<{ tournaments: { id: string; name: string; me: { hosting: boolean } }[] }>('tournament:list')).tournaments.filter((t) => t.name === 'Full house' && t.me.hosting);
    await host.call('tournament:command', { id: mine[0].id, command: { type: 'archive' } });
    await host.call('tournament:create', { settings });
  });

  it('still counts a create that fails on the server, so made-up season ids can’t be looked up for free', async () => {
    const settings = { ...defaultSettings(), name: 'Lost season' };
    const script = client('season-probe-script-0123456789', '192.0.2.45');
    const tries = await settled(Array.from({ length: 10 }, (_, i) => script.call('tournament:create', { settings: { ...settings, season: { id: `no-such-season-${i}`, name: 'Nope' } } })));
    expect(tries.every((r) => /that season was not found/.test(r))).toBe(true);
    await expect(script.call('tournament:create', { settings })).rejects.toThrow(/a lot of new tournaments/);
  });

  it('still counts a player’s open tournaments after the server restarts', async () => {
    const settings = { ...defaultSettings(), name: 'Deploy day' };
    const tables = memoryStore();
    const saved = memoryTournamentStore();
    const at = new FakeClock();
    const token = 'open-cap-restart-host-0123456789';
    const before = await boot(at, tables, saved);
    const host = before.client(token, '192.0.2.50');
    expect((await settled(Array.from({ length: 10 }, () => host.call('tournament:create', { settings })))).filter((r) => r === 'ok')).toHaveLength(10);
    at.advance(10 * MINUTE);
    await expect(host.call('tournament:create', { settings })).rejects.toThrow(/a lot of open tournaments/);
    host.socket.close();
    await before.app.close();

    // An update restarts the server; the ten events come back, and still count.
    const after = await boot(at, tables, saved);
    try {
      const again = after.client(token, '192.0.2.51');
      await expect(again.call('tournament:create', { settings })).rejects.toThrow(/a lot of open tournaments/);
      const visitor = after.client('open-cap-restart-visitor-0123456789', '192.0.2.52');
      const listed = async () => (await visitor.call<{ tournaments: { name: string }[] }>('tournament:list')).tournaments.filter((t) => t.name === 'Deploy day');
      expect(await listed()).toHaveLength(10);
      // Archiving one still makes room for one more.
      const mine = (await again.call<{ tournaments: { id: string; name: string; me: { hosting: boolean } }[] }>('tournament:list')).tournaments.filter((t) => t.name === 'Deploy day' && t.me.hosting);
      await again.call('tournament:command', { id: mine[0].id, command: { type: 'archive' } });
      await again.call('tournament:create', { settings });
      await expect(again.call('tournament:create', { settings })).rejects.toThrow(/a lot of open tournaments/);
      expect(await listed()).toHaveLength(10);
    } finally {
      await after.app.close();
    }
  });

  it('doesn’t count the Sit & Gos the server opens after each one fills against the host’s 10 open', async () => {
    const tables = memoryStore();
    const saved = memoryTournamentStore();
    const at = new FakeClock();
    const token = 'open-cap-spawn-host-0123456789';
    const sng = { ...defaultSettings(), name: 'Heads-up turbo', start: { kind: 'sng', playersNeeded: 2, startDelaySeconds: 0, autoSpawn: true } };
    const before = await boot(at, tables, saved);
    const host = before.client(token, '192.0.2.60');
    const hosted = async () => (await host.call<{ tournaments: { id: string; name: string; status: string; me: { hosting: boolean } }[] }>('tournament:list')).tournaments.filter((t) => t.name === 'Heads-up turbo' && t.me.hosting);
    await host.call('tournament:create', { settings: sng });
    // Players fill it ten times over; each time it fills, the server opens the next one for the same host.
    for (let i = 0; i < 10; i++) {
      let waiting: string | undefined;
      for (let tries = 0; !waiting && tries < 50; tries++) waiting = (await hosted()).find((t) => t.status === 'registering')?.id;
      for (const seat of [0, 1]) {
        const player = before.client(`open-cap-spawn-player-${i}-${seat}-0123456789`, '192.0.2.61');
        await player.call('tournament:command', { id: waiting, command: { type: 'register', displayName: `Player ${i}-${seat}` } });
      }
    }
    for (let tries = 0; (await hosted()).length < 11 && tries < 50; tries++);
    const open = await hosted();
    expect(open.filter((t) => t.status === 'registering')).toHaveLength(1);
    expect(open.filter((t) => t.status !== 'registering')).toHaveLength(10);
    // The server knows which event each was opened after, but browsers aren't told: it would let anyone walk back through the chain.
    const next = open.find((t) => t.status === 'registering')!.id;
    expect((await before.app.tournaments.peek(next))?.spawnedFrom).toBeTruthy();
    expect(before.app.tournaments.view(next, 'someone-else')!.state).not.toHaveProperty('spawnedFrom');
    expect(before.app.tournaments.view(next)!.state).not.toHaveProperty('spawnedFrom');
    // They made one, so they have room for more of their own.
    const plain = { ...defaultSettings(), name: 'Sunday main' };
    await host.call('tournament:create', { settings: plain });
    host.socket.close();
    await before.app.close();

    // After a restart too.
    const after = await boot(at, tables, saved);
    try {
      await after.client(token, '192.0.2.62').call('tournament:create', { settings: plain });
    } finally {
      await after.app.close();
    }
  });

  it('forgets an address once nothing made from it is open and its limits have passed (the privacy page says at most about an hour)', async () => {
    const at = new FakeClock();
    const own = await boot(at, memoryStore(), memoryTournamentStore());
    try {
      const settings = { ...defaultSettings(), name: 'Forget me' };
      const host = own.client('open-cap-forget-host-0123456789', '192.0.2.70');
      const { id } = await host.call<{ id: string }>('tournament:create', { settings });
      expect(own.app.openTournamentAddresses()).toBe(1);
      // A create refused on the server leaves nothing behind in the open count for its address.
      await expect(own.client('open-cap-forget-other-0123456789', '192.0.2.71').call('tournament:create', { settings: { ...settings, season: { id: 'no-such-season', name: 'Nope' } } })).rejects.toThrow(/season was not found/);
      expect(own.app.openTournamentAddresses()).toBe(1);
      // Once the one made from 192.0.2.70 is put away, the open count forgets the address at the next sweep...
      await host.call('tournament:command', { id, command: { type: 'archive' } });
      expect(own.app.openTournamentAddresses()).toBe(1);
      own.app.forgetOldAddresses();
      expect(own.app.openTournamentAddresses()).toBe(0);
      // ...and the 10-in-10-minutes count forgets both addresses at the first sweep after its window.
      expect(limiterKeys('192.0.2.70')).toBeGreaterThan(0);
      at.advance(10 * MINUTE + 1);
      own.app.forgetOldAddresses();
      expect(limiterKeys('192.0.2.70')).toBe(0);
      expect(limiterKeys('192.0.2.71')).toBe(0);
    } finally {
      await own.app.close();
    }
  });
});

import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { variants } from '@rsdp/engine/core';
import { registerAllVariants } from '@rsdp/engine/variants';
import type { SharedHandView } from '@rsdp/engine/wire';
import { createApp } from '../src/app';
import { closeDb, type Db } from '../src/db';
import { createTestDb } from '../src/db/testing';
import { dbSharedHands } from '../src/shared';
import { dbIdentity, dbStore } from '../src/storage';
import { socketClient, type Client } from './socket-client';

let db: Db;
let server: ReturnType<typeof createApp>;
let url = '';
const clients: Client[] = [];
const client = (token: string) => socketClient(url, token, clients);

beforeAll(async () => {
  registerAllVariants(variants);
  db = await createTestDb();
  server = createApp({ identity: dbIdentity(db), store: dbStore(db), shared: dbSharedHands(db), log: (m, e) => console.error(m, e) });
  await new Promise<void>((resolve) => server.http.listen(0, resolve));
  url = `http://localhost:${(server.http.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const c of clients) c.close();
  await server.close();
  await closeDb(db);
});

const deals = (h: SharedHandView['hand']) => h.events.filter((e) => e.t === 'deal') as Extract<SharedHandView['hand']['events'][number], { t: 'deal' }>[];

describe('shared hands and the full log', () => {
  it('freezes a hand as the sharer saw it behind a link, optionally hiding their cards, until they stop it', async () => {
    const host = client('share-host-0123456789');
    const guest = client('share-guest-0123456789');
    const { tableId } = await host.call<{ tableId: string }>('table:create', { settings: { table: { name: 'Share night' }, seating: { requireApproval: false } } });
    await host.call('table:join', { tableId });
    await guest.call('table:join', { tableId });
    await host.call('seat:request', { seat: 0, name: 'Host', stack: 100 });
    await guest.call('seat:request', { seat: 1, name: 'Guest', stack: 100 });
    await host.call('host:start');
    const v = await host.until((x) => !!x.hand);
    const first = v.hand!.toAct === v.me.seat ? host : guest;
    await first.until((x) => x.legal !== null);
    await first.call('hand:act', { type: 'fold' });
    await host.until((x) => x.history.length === 1);
    const handNumber = host.view().history[0].handNumber;

    const { id } = await host.call<{ id: string }>('hand:share', { handNumber });
    const res = await fetch(`${url}/api/shared/${id}`);
    expect(res.status).toBe(200);
    const shared = (await res.json()) as SharedHandView;
    expect(shared).toMatchObject({ id, tableName: 'Share night', seatCount: v.seats.length, sharedBy: 'Host' });
    const mine = deals(shared.hand).find((d) => d.seat === 0)!;
    expect(mine.cards.every((c) => c.card !== '??')).toBe(true);
    expect(
      deals(shared.hand)
        .find((d) => d.seat === 1)!
        .cards.every((c) => c.card === '??'),
    ).toBe(true);

    const hidden = await host.call<{ id: string }>('hand:share', { handNumber, hideMine: true });
    const hiddenHand = (await (await fetch(`${url}/api/shared/${hidden.id}`)).json()) as SharedHandView;
    expect(deals(hiddenHand.hand).every((d) => d.cards.every((c) => c.card === '??'))).toBe(true);

    await expect(guest.call('hand:unshare', { id })).rejects.toThrow(/not one of yours/);
    await host.call('hand:unshare', { id });
    expect((await fetch(`${url}/api/shared/${id}`)).status).toBe(404);
    expect((await fetch(`${url}/api/shared/nope`)).status).toBe(404);
    await expect(host.call('hand:share', { handNumber: 999 })).rejects.toThrow(/no longer available/);

    // No full log while seated in a running game (no live HUDs); stopping the game opens it.
    expect(host.view().recordsLocked).toBe(true);
    await expect(host.call('table:fullLog')).rejects.toThrow(/leave your seat or the game stops/);
    await host.call('host:stop');
    await host.until((x) => !x.started && !x.recordsLocked);
    const full = await host.call<{ log: { text: string }[]; chat: unknown[]; hands: unknown[] }>('table:fullLog');
    expect(full.log.some((l) => /started the game/.test(l.text))).toBe(true);
    expect(full.hands).toHaveLength(1);
    await expect(host.call('table:fullLog')).rejects.toThrow(/every few seconds/);
  });
});

import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { variants } from '@rsdp/engine/core';
import { registerAllVariants } from '@rsdp/engine/variants';
import type { ServerToClient } from '@rsdp/engine/wire';
import { createApp } from '../src/app';
import { avatarToken, cleanAvatar, dbAvatars } from '../src/avatars';
import { cleanMood } from '../src/runtime/table';
import { closeDb, type Db } from '../src/db';
import { createTestDb } from '../src/db/testing';
import { dbIdentity, dbStore } from '../src/storage';
import { socketClient, type Client } from './socket-client';

type Gesture = Parameters<ServerToClient['table:gesture']>[0];

let db: Db;
let server: ReturnType<typeof createApp>;
let url = '';
const clients: Client[] = [];
const client = (token: string) => socketClient(url, token, clients);

beforeAll(async () => {
  registerAllVariants(variants);
  db = await createTestDb();
  server = createApp({ identity: dbIdentity(db), store: dbStore(db), avatars: dbAvatars(db), log: (m, e) => console.error(m, e) });
  await new Promise<void>((resolve) => server.http.listen(0, resolve));
  url = `http://localhost:${(server.http.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const c of clients) c.close();
  await server.close();
  await closeDb(db);
});

// A 1x1 PNG.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

async function twoSeated(prefix: string, settings: object = {}) {
  const host = client(`${prefix}-host-0123456789`);
  const guest = client(`${prefix}-guest-0123456789`);
  const { tableId } = await host.call<{ tableId: string }>('table:create', { settings: { seating: { requireApproval: false }, ...settings } });
  await host.call('table:join', { tableId });
  await guest.call('table:join', { tableId });
  await host.call('seat:request', { seat: 0, name: 'Host', stack: 100 });
  await guest.call('seat:request', { seat: 1, name: 'Guest', stack: 100 });
  await host.until((v) => !!v.seats[1]);
  return { host, guest, tableId };
}

describe('avatars', () => {
  it('checks pictures from clients', () => {
    expect(cleanAvatar(null)).toBeNull();
    expect(cleanAvatar({ library: 'fox' })).toEqual({ kind: 'library', value: 'fox' });
    expect(() => cleanAvatar({ library: 'toString' })).toThrow(/unknown/);
    expect(() => cleanAvatar({ image: 'data:image/svg+xml;base64,PHN2Zz4=' })).toThrow(/JPEG/);
    expect(() => cleanAvatar({ image: 'data:image/png;base64,' + 'A'.repeat(70_000) })).toThrow(/too big/);
    expect(() => cleanAvatar({})).toThrow();
    expect(avatarToken({ kind: 'library', value: 'owl', updatedAt: 1 })).toBe('lib:owl');
    expect(avatarToken({ kind: 'upload', value: PNG, updatedAt: 36 })).toBe('up:10');
  });

  it('shows a player’s picture on their seat and serves uploads, kept across reconnects', async () => {
    const { host, guest } = await twoSeated('avatar');
    const { avatar } = await guest.call<{ avatar: string }>('avatar:set', { library: 'octopus' });
    expect(avatar).toBe('lib:octopus');
    await host.until((v) => v.seats[1]?.avatar === 'lib:octopus');

    const up = await guest.call<{ avatar: string }>('avatar:set', { image: PNG });
    expect(up.avatar).toMatch(/^up:/);
    const v = await host.until((x) => x.seats[1]?.avatar === up.avatar);
    const res = await fetch(`${url}/api/avatars/${v.seats[1]!.playerId}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(
      Buffer.from(await res.arrayBuffer())
        .subarray(1, 4)
        .toString(),
    ).toBe('PNG');
    expect((await fetch(`${url}/api/avatars/${v.seats[0]!.playerId}`)).status).toBe(404);

    // A new tab of the same browser learns its picture with its session.
    const again = client('avatar-guest-0123456789');
    const session = await new Promise<Parameters<ServerToClient['session']>[0]>((resolve) => again.socket.once('session', resolve));
    expect(session.avatar).toBe(up.avatar);

    await guest.call('avatar:set', null);
    await host.until((x) => x.seats[1]?.avatar === null);
    await expect(guest.call('avatar:set', { library: 'nope' })).rejects.toThrow(/unknown avatar/);
    await guest.call('avatar:set', { library: 'owl' });
    await expect(guest.call('avatar:set', { library: 'fox' })).rejects.toThrow(/too many picture changes/);
  });
});

describe('moods', () => {
  it('takes one emoji, with skin tones and joiners, and nothing else', () => {
    expect(cleanMood('😎')).toBe('😎');
    expect(cleanMood('👍🏽')).toBe('👍🏽');
    expect(cleanMood('🧑‍🚀')).toBe('🧑‍🚀');
    expect(cleanMood(null)).toBeNull();
    expect(cleanMood(' ')).toBeNull();
    expect(() => cleanMood('hello')).toThrow();
    expect(() => cleanMood('😎 nice')).toThrow();
    expect(() => cleanMood('😎😎😎😎😎😎😎😎😎')).toThrow();
    expect(() => cleanMood(5)).toThrow();
    expect(cleanMood('1️⃣')).toBe('1️⃣');
    expect(() => cleanMood('🔥\u202E')).toThrow();
    expect(() => cleanMood('🔥' + '\u0301'.repeat(10))).toThrow();
  });

  it('shows a seat’s mood to everyone', async () => {
    const { host, guest } = await twoSeated('mood');
    await guest.call('seat:prefs', { mood: '🤠' });
    await host.until((v) => v.seats[1]?.mood === '🤠');
    await guest.call('seat:prefs', { mood: null });
    await host.until((v) => v.seats[1]?.mood === null);
    await expect(guest.call('seat:prefs', { mood: 'all in' })).rejects.toThrow(/emoji/);
  });
});

describe('gestures', () => {
  it('reaches everyone at the table, at seated players only, a few at a time', async () => {
    const { host, guest } = await twoSeated('gesture');
    const fan = client('gesture-fan-0123456789');
    await fan.call('table:join', { tableId: host.view().id });
    const guestId = host.view().seats[1]!.playerId;
    const hostId = host.view().seats[0]!.playerId;
    const seen = new Promise<Gesture>((resolve) => fan.socket.once('table:gesture', resolve));
    await host.call('table:gesture', { to: guestId, kind: 'fish' });
    expect(await seen).toMatchObject({ from: hostId, to: guestId, kind: 'fish' });

    // Spectators may throw too, but only at someone seated, and never at themselves.
    await fan.call('table:gesture', { to: hostId, kind: 'clap' });
    await expect(host.call('table:gesture', { to: hostId, kind: 'clap' })).rejects.toThrow(/another player/);
    await expect(host.call('table:gesture', { to: 'someone-else', kind: 'clap' })).rejects.toThrow(/not seated/);
    await expect(host.call('table:gesture', { to: guestId, kind: 'brick' })).rejects.toThrow(/unknown gesture/);

    await host.call('table:gesture', { to: guestId, kind: 'heart' });
    await host.call('table:gesture', { to: guestId, kind: 'heart' });
    await host.call('table:gesture', { to: guestId, kind: 'heart' });
    await expect(host.call('table:gesture', { to: guestId, kind: 'heart' })).rejects.toThrow(/easy there/);
    void guest;
  });

  it('can be turned off by the host', async () => {
    const { host, guest } = await twoSeated('gesture-off', { chat: { guestChat: true, profanityFilter: false, gestures: false } });
    const hostId = host.view().seats[0]!.playerId;
    await expect(guest.call('table:gesture', { to: hostId, kind: 'rose' })).rejects.toThrow(/turned gestures off/);
    await host.call('host:settings', { patch: { chat: { gestures: true } } });
    await host.until((v) => v.settings.chat.gestures === true);
    await guest.call('table:gesture', { to: hostId, kind: 'rose' });
  });
});

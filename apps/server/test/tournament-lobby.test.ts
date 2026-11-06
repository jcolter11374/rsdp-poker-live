import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { variants } from '@rsdp/engine/core';
import { registerAllVariants } from '@rsdp/engine/variants';
import { defaultSettings, type LobbyItem, type TournamentState } from '@rsdp/tournament';
import { createApp } from '../src/app';
import { closeDb, type Db } from '../src/db';
import { createTestDb } from '../src/db/testing';
import { tournamentLog } from '../src/db/schema';
import { systemClock, type Clock } from '../src/runtime/types';
import { dbIdentity, dbStore } from '../src/storage';
import { dbLobbyStore } from '../src/tournament/lobby';
import { dbTournamentStore } from '../src/tournament/store';
import { socketClient, type Client } from './socket-client';

beforeAll(() => registerAllVariants(variants));

let db: Db | undefined;
let server: ReturnType<typeof createApp> | undefined;
const clients: Client[] = [];
/** Time skipped on the server's clock, so a test needn't wait out the gap between one player's lobby messages. */
let skipped = 0;
const clock: Clock = { ...systemClock, now: () => Date.now() + skipped };
const skip = () => {
  skipped += 2_000;
};

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await server?.close();
  if (db) await closeDb(db);
  server = db = undefined;
});

type On = { on: (e: string, cb: (x: never) => void) => void };

/** A server on the test database, and a way to open test browsers on it that follow lobbies. */
async function listen() {
  server = createApp({ clock, identity: dbIdentity(db!), store: dbStore(db!), tournaments: dbTournamentStore(db!), lobby: dbLobbyStore(db!), log: (m, e) => console.error(m, e) });
  await new Promise<void>((resolve) => server!.http.listen(0, resolve));
  const url = `http://localhost:${(server.http.address() as AddressInfo).port}`;
  return (token: string) => {
    const c = socketClient(url, token, clients);
    const logs: LobbyItem[][] = [];
    let items: LobbyItem[] = [];
    let state: TournamentState | null = null;
    const deleted: string[] = [];
    const socket = c.socket as unknown as On;
    socket.on('tournament:log', ({ items: got, append }: { items: LobbyItem[]; append: boolean }) => {
      items = append ? [...items, ...got] : got;
      logs.push(items);
    });
    socket.on('tournament:chatDeleted', ({ itemId }: { itemId: string }) => {
      deleted.push(itemId);
      items = items.filter((x) => x.id !== itemId);
    });
    socket.on('tournament:state', ({ view }: { view: { state: TournamentState } }) => {
      state = view.state;
    });
    const until = async (test: (items: LobbyItem[]) => boolean) => {
      for (let i = 0; i < 100 && !test(items); i++) await new Promise((r) => setTimeout(r, 20));
      expect(test(items)).toBe(true);
      return items;
    };
    /** The tournament as this browser was last sent it, once it passes `test`. */
    const untilState = async (test: (s: TournamentState) => boolean) => {
      for (let i = 0; i < 100 && !(state && test(state)); i++) await new Promise((r) => setTimeout(r, 20));
      expect(state && test(state)).toBe(true);
      return state!;
    };
    return { ...c, until, untilState, items: () => items, deleted };
  };
}

async function start() {
  db = await createTestDb();
  return listen();
}

/** Stops the server (it saves everything) and starts a new one on the same database, as a release does. */
async function restart() {
  for (const c of clients.splice(0)) c.close();
  await server!.close();
  return listen();
}

const text = (items: LobbyItem[]) => items.map((x) => (x.kind === 'chat' ? `${x.name}: ${x.text}` : x.event.type));

describe('tournament lobby chat and log', () => {
  it('logs public events and chat, sends them to watchers and keeps them in the database', async () => {
    const client = await start();
    const host = client('lobby-host-secret-000000');
    const ana = client('lobby-ana-secret-0000000');
    await host.call('session:name', { name: 'Host' });
    await ana.call('session:name', { name: 'Ana' });
    const { id } = await host.call<{ id: string }>('tournament:create', { settings: defaultSettings({ name: 'Lobby', registrationApproval: true }) });
    await host.call('tournament:subscribe', { id });
    await ana.call('tournament:command', { id, command: { type: 'register' } });
    // A request waiting for the host is not news; the approval is.
    await host.call('tournament:command', { id, command: { type: 'approve', requestId: 'x' } }).catch(() => {});
    await expect(ana.call('tournament:chat', { id, text: 'hi' })).rejects.toThrow('open the tournament first');
    await ana.call('tournament:subscribe', { id });
    await ana.call('tournament:chat', { id, text: '  good luck all \u0007\u202e ' });
    await expect(ana.call('tournament:chat', { id, text: 'again' })).rejects.toThrow('slow down');
    const seen = await host.until((items) => items.some((x) => x.kind === 'chat'));
    expect(text(seen)).toEqual(['Ana: good luck all']);

    const state = server!.tournaments.view(id)!.state;
    await host.call('tournament:command', { id, command: { type: 'approve', requestId: state.requests[0].id } });
    await host.until((items) => items.some((x) => x.kind === 'event' && x.event.type === 'registered'));

    // A new watcher gets the history.
    const late = client('lobby-late-secret-000000');
    await late.call('tournament:subscribe', { id });
    const history = await late.until((items) => items.length === 2);
    expect(text(history)).toEqual(['Ana: good luck all', 'registered']);
    expect(history[1]).toMatchObject({ kind: 'event', event: { type: 'registered', name: 'Ana' } });
    // Player ids of the log's people are not in events.
    expect(JSON.stringify(history[1])).not.toContain(state.requests[0].playerId);

    // Saved: a fresh server reads it back.
    await server!.close();
    const fresh = createApp({ identity: dbIdentity(db!), store: dbStore(db!), tournaments: dbTournamentStore(db!), lobby: dbLobbyStore(db!) });
    server = fresh;
    await new Promise<void>((resolve) => fresh.http.listen(0, resolve));
    const url = `http://localhost:${(fresh.http.address() as AddressInfo).port}`;
    const again = socketClient(url, 'lobby-late-secret-000000', clients);
    const got = new Promise<LobbyItem[]>((resolve) => (again.socket as unknown as { on: (e: string, cb: (x: { items: LobbyItem[] }) => void) => void }).on('tournament:log', (x) => resolve(x.items)));
    await again.call('tournament:subscribe', { id });
    expect(text(await got)).toEqual(['Ana: good luck all', 'registered']);
  });

  it('needs a name to chat', async () => {
    const client = await start();
    const host = client('lobby-host2-secret-00000');
    const { id } = await host.call<{ id: string }>('tournament:create', { settings: defaultSettings({ name: 'Quiet' }) });
    await expect(host.call('tournament:chat', { id, text: 'hi' })).rejects.toThrow('pick a name');
  });
});

describe('lobby chat moderation', () => {
  /** A lobby everyone follows, with a plain player (Bob), a co-host who may manage chat (Dan) and one who may not (Cyd). */
  async function lobby() {
    const client = await start();
    const host = client('mod-host-secret-00000000');
    const ana = client('mod-ana-secret-000000000');
    const bob = client('mod-bob-secret-000000000');
    const cyd = client('mod-cyd-secret-000000000');
    const dan = client('mod-dan-secret-000000000');
    for (const [c, name] of [[host, 'Host'], [ana, 'Ana'], [bob, 'Bob'], [cyd, 'Cyd'], [dan, 'Dan']] as const) await c.call('session:name', { name });
    const { id } = await host.call<{ id: string }>('tournament:create', { settings: defaultSettings({ name: 'Moderated' }) });
    for (const c of [ana, bob, cyd, dan]) await c.call('tournament:command', { id, command: { type: 'register' } });
    const state = server!.tournaments.view(id)!.state;
    const ids = Object.fromEntries([['Host', state.hostId], ...state.entries.map((e) => [e.displayName, e.playerId])]) as Record<string, string>;
    await host.call('tournament:command', { id, command: { type: 'setCoHost', playerId: ids.Cyd, powers: ['approve'] } });
    await host.call('tournament:command', { id, command: { type: 'setCoHost', playerId: ids.Dan, powers: ['players'] } });
    for (const c of [host, ana, bob, cyd, dan]) await c.call('tournament:subscribe', { id });
    return { client, id, ids, host, ana, bob, cyd, dan };
  }
  const chatText = (items: LobbyItem[]) => text(items.filter((x) => x.kind === 'chat'));

  it('lets the host, and co-hosts given the power, mute and unmute a player, whose messages are then refused', async () => {
    const { id, ids, host, ana, bob, cyd, dan } = await lobby();
    const mute = (by: typeof host, who: string, value = true) => by.call('tournament:chatMute', { id, playerId: ids[who], value });
    await expect(mute(bob, 'Ana')).rejects.toThrow('only the host can do that');
    await expect(mute(cyd, 'Ana')).rejects.toThrow('the host has not given you that power');
    await expect(mute(dan, 'Host')).rejects.toThrow('only the host can do that to the host or a co-host');
    await expect(mute(dan, 'Cyd')).rejects.toThrow('only the host can do that to the host or a co-host');
    await expect(mute(host, 'Host')).rejects.toThrow("you can't mute yourself");
    await expect(host.call('tournament:chatMute', { id, playerId: '', value: true })).rejects.toThrow('pick a player');

    await mute(dan, 'Ana');
    // Those who can unmute see who is muted; the muted player sees only that they are, and nobody else sees anyone.
    expect((await host.untilState((s) => !!s.lobbyChat?.muted?.length)).lobbyChat!.muted).toEqual([ids.Ana]);
    expect((await dan.untilState((s) => !!s.lobbyChat?.muted?.length)).lobbyChat!.muted).toEqual([ids.Ana]);
    expect((await ana.untilState((s) => !!s.lobbyChat?.muted?.length)).lobbyChat!.muted).toEqual([ids.Ana]);
    expect((await bob.untilState((s) => !!s.lobbyChat)).lobbyChat!.muted).toEqual([]);
    expect((await cyd.untilState((s) => !!s.lobbyChat)).lobbyChat!.muted).toEqual([]);
    await expect(ana.call('tournament:chat', { id, text: 'let me talk' })).rejects.toThrow('the host has muted you in this chat');
    await bob.call('tournament:chat', { id, text: 'Ana is quiet now' });
    // The host can mute a co-host as well; a co-host can't.
    await mute(host, 'Dan');
    await expect(dan.call('tournament:chat', { id, text: 'hey' })).rejects.toThrow('the host has muted you in this chat');

    await mute(host, 'Ana', false);
    await ana.untilState((s) => s.lobbyChat?.muted?.length === 0);
    expect(server!.tournaments.view(id)!.state.lobbyChat!.muted).toEqual([ids.Dan]);
    skip();
    await ana.call('tournament:chat', { id, text: 'thanks' });
    // Refused messages were never kept.
    expect(chatText(await host.until((items) => chatText(items).length === 2))).toEqual(['Bob: Ana is quiet now', 'Ana: thanks']);
  });

  it('lets the host delete a message for everyone, for good', async () => {
    const { client, id, host, ana, bob, dan } = await lobby();
    await ana.call('tournament:chat', { id, text: 'something rude' });
    await host.call('tournament:chat', { id, text: 'play nice' });
    await bob.call('tournament:chat', { id, text: 'agreed' });
    const items = await bob.until((xs) => chatText(xs).length === 3);
    const said = (t: string) => items.find((x) => x.kind === 'chat' && x.text === t)!.id;
    const del = (by: typeof host, itemId: string) => by.call('tournament:chatDelete', { id, itemId });
    await expect(del(bob, said('something rude'))).rejects.toThrow('only the host can do that');
    await expect(del(dan, said('play nice'))).rejects.toThrow('only the host can do that to the host or a co-host');
    // Only chat: the activity log isn't the host's to edit.
    await expect(del(host, items.find((x) => x.kind === 'event')!.id)).rejects.toThrow('that message is already gone');

    await del(host, said('something rude'));
    // Everyone following the lobby drops it at once.
    for (const c of [host, ana, bob, dan]) await c.until((xs) => chatText(xs).length === 2);
    expect(bob.deleted).toEqual([said('something rude')]);
    await expect(del(host, said('something rude'))).rejects.toThrow('that message is already gone');
    // A co-host with the power deletes a player's message.
    await del(dan, said('agreed'));
    await bob.until((xs) => chatText(xs).length === 1);

    // A reload never gets them back.
    const late = client('mod-late-secret-00000000');
    await late.call('tournament:subscribe', { id });
    expect(chatText(await late.until((xs) => xs.length > 0))).toEqual(['Host: play nice']);
    // They are gone from the database, not just hidden, so a restart doesn't bring them back either.
    const rows = JSON.stringify(await db!.select().from(tournamentLog).where(eq(tournamentLog.tournamentId, id)));
    expect(rows).toContain('play nice');
    expect(rows).not.toContain('something rude');
    expect(rows).not.toContain('agreed');
    const after = await restart();
    const again = after('mod-late-secret-00000000');
    await again.call('tournament:subscribe', { id });
    expect(chatText(await again.until((xs) => xs.length > 0))).toEqual(['Host: play nice']);
  });

  it('lets the host turn the chat off and back on, and keeps that and the mutes through a restart and after the end', async () => {
    const { id, ids, host, ana, bob, cyd, dan } = await lobby();
    await expect(ana.call('tournament:chatOff', { id, off: true })).rejects.toThrow('only the host can do that');
    await expect(cyd.call('tournament:chatOff', { id, off: true })).rejects.toThrow('the host has not given you that power');
    await host.call('tournament:chatOff', { id, off: true });
    // Everyone is told, so their lobby can say why the message box is gone. Nobody can send, the host included.
    for (const c of [ana, bob, cyd]) await c.untilState((s) => s.lobbyChat?.off === true);
    for (const c of [host, ana, dan]) await expect(c.call('tournament:chat', { id, text: 'anyone?' })).rejects.toThrow('the host has turned chat off');
    await host.call('tournament:chatMute', { id, playerId: ids.Bob, value: true });

    // Kept with the tournament.
    const after = await restart();
    const [host2, ana2, bob2, dan2] = ['mod-host-secret-00000000', 'mod-ana-secret-000000000', 'mod-bob-secret-000000000', 'mod-dan-secret-000000000'].map(after);
    for (const c of [host2, ana2, bob2, dan2]) await c.call('tournament:subscribe', { id });
    expect((await ana2.untilState(() => true)).lobbyChat).toEqual({ off: true, muted: [] });
    expect((await bob2.untilState(() => true)).lobbyChat).toEqual({ off: true, muted: [ids.Bob] });
    await expect(ana2.call('tournament:chat', { id, text: 'still off?' })).rejects.toThrow('the host has turned chat off');
    // A co-host with the power turns it back on; the mute stays.
    await dan2.call('tournament:chatOff', { id, off: false });
    await ana2.untilState((s) => s.lobbyChat?.off === false);
    skip();
    await ana2.call('tournament:chat', { id, text: 'back on' });
    await expect(bob2.call('tournament:chat', { id, text: 'me too' })).rejects.toThrow('the host has muted you in this chat');

    // The lobby chat stays open once the event is over, and so do the host's tools for it.
    await host2.call('tournament:command', { id, command: { type: 'end' } });
    await host2.untilState((s) => s.status === 'cancelled');
    const back = (await host2.until((xs) => chatText(xs).includes('Ana: back on'))).find((x) => x.kind === 'chat' && x.text === 'back on')!;
    await host2.call('tournament:chatDelete', { id, itemId: back.id });
    await host2.call('tournament:chatMute', { id, playerId: ids.Bob, value: false });
    await host2.call('tournament:chatOff', { id, off: true });
    expect(server!.tournaments.view(id)!.state.lobbyChat).toEqual({ off: true, muted: [] });
    // The finished event's chat download holds the tables' chat only, so a deleted lobby message can't be in it.
    const download = await host2.call<{ tables: unknown[] }>('tournament:tableChat', { id });
    expect(JSON.stringify(download)).not.toContain('back on');
  });
});

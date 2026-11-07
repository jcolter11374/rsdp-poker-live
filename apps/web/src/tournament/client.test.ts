import { describe, expect, it, vi } from 'vitest';
import type { LobbyItem } from '@rsdp/tournament';
import { SocketTournamentClient } from './client';

const fake = vi.hoisted(() => ({
  handlers: new Map<string, (input: never) => void>(),
  call: vi.fn(async () => ({})),
}));
vi.mock('../socket', () => ({
  socket: { on: (event: string, cb: (input: never) => void) => fake.handlers.set(event, cb), emit: vi.fn(), connected: false },
  call: fake.call,
  currentSession: () => null,
  NoAnswerError: class extends Error {},
  onSession: () => () => {},
  setName: vi.fn(),
}));

/** What the server sends, as the socket would hand it on. */
const receive = (event: string, input: unknown) => fake.handlers.get(event)!(input as never);
const said = (id: string, at: number): LobbyItem => ({ id, at, kind: 'chat', playerId: 'p', name: 'Pat', text: id });

describe('the lobby log in the browser', () => {
  it('drops a message the host deleted, even from a full list that crossed the deletion', () => {
    const client = new SocketTournamentClient();
    client.subscribe('T', () => {}, () => {});
    let shown: LobbyItem[] = [];
    client.onLog('T', (items) => (shown = items));
    receive('tournament:log', { id: 'T', items: [said('a', 1), said('b', 2)], append: false });
    expect(shown.map((x) => x.id)).toEqual(['a', 'b']);

    receive('tournament:chatDeleted', { id: 'T', itemId: 'a' });
    expect(shown.map((x) => x.id)).toEqual(['b']);
    // A full list the server read just before the deletion, arriving after it, doesn't bring it back.
    receive('tournament:log', { id: 'T', items: [said('a', 1), said('b', 2)], append: false });
    expect(shown.map((x) => x.id)).toEqual(['b']);
    receive('tournament:log', { id: 'T', items: [said('a', 1), said('c', 3)], append: true });
    expect(shown.map((x) => x.id)).toEqual(['b', 'c']);
    // Another lobby's deletion is not this one's.
    receive('tournament:chatDeleted', { id: 'U', itemId: 'b' });
    expect(shown.map((x) => x.id)).toEqual(['b', 'c']);
  });

  it('keeps a message that beat the full list here, and drops one deleted while the connection was down', () => {
    const client = new SocketTournamentClient();
    client.subscribe('T', () => {}, () => {});
    let shown: LobbyItem[] = [];
    client.onLog('T', (items) => (shown = items));
    receive('connect', undefined);
    // Said while the lobby loaded: it comes before the list, which was read without it.
    receive('tournament:log', { id: 'T', items: [said('c', 3)], append: true });
    receive('tournament:log', { id: 'T', items: [said('a', 1), said('b', 2)], append: false });
    expect(shown.map((x) => x.id)).toEqual(['a', 'b', 'c']);
    // The connection drops, and meanwhile the host deletes the newest message: the list sent on the way back lacks it.
    receive('connect', undefined);
    receive('tournament:log', { id: 'T', items: [said('a', 1), said('b', 2)], append: false });
    expect(shown.map((x) => x.id)).toEqual(['a', 'b']);
    expect(fake.call).toHaveBeenCalledWith('tournament:subscribe', { id: 'T' });
  });

  it('sends the host tools for the lobby chat to the server', async () => {
    fake.call.mockClear();
    const client = new SocketTournamentClient();
    await client.chatMute('T', 'p', true);
    await client.chatOff('T', true);
    await client.chatDelete('T', 'a');
    expect(fake.call.mock.calls).toEqual([
      ['tournament:chatMute', { id: 'T', playerId: 'p', value: true }],
      ['tournament:chatOff', { id: 'T', off: true }],
      ['tournament:chatDelete', { id: 'T', itemId: 'a' }],
    ]);
  });
});

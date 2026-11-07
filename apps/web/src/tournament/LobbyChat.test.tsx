// @vitest-environment jsdom
import { fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apply, createTournament, defaultSettings, type LobbyChatRules, type LobbyItem } from '@rsdp/tournament';
import { setChatMuted } from '../chatMutes';
import { LobbyChat, useUnreadChat } from './LobbyLog';

const server = vi.hoisted(() => ({
  chat: vi.fn(async () => {}),
  chatMute: vi.fn(async () => {}),
  chatOff: vi.fn(async () => {}),
  chatDelete: vi.fn(async () => {}),
  setName: vi.fn(async () => {}),
}));
vi.mock('./client', () => ({ tournamentClient: () => server }));
vi.mock('../socket', () => ({ savedName: () => '' }));

const T0 = Date.parse('2026-11-01T20:00:00Z');

/** A lobby with players Ana and Bob, and Dan, a co-host who may manage chat. */
function lobbyState(lobbyChat?: LobbyChatRules) {
  let s = createTournament({ id: 'T', hostId: 'host', settings: defaultSettings({ name: 'Friday' }), now: T0, seed: 'a1'.repeat(32), legacyRng: 7 });
  for (const [playerId, displayName] of [['ana', 'Ana'], ['bob', 'Bob'], ['dan', 'Dan']]) s = apply(s, { type: 'register', playerId, displayName }, T0).state;
  s = apply(s, { type: 'setCoHost', by: 'host', playerId: 'dan', powers: ['players'] }, T0).state;
  return lobbyChat ? { ...s, lobbyChat } : s;
}

const said = (id: string, playerId: string, name: string, text: string, at = T0): LobbyItem => ({ id, at, kind: 'chat', playerId, name, text });
const items = [said('1', 'ana', 'Ana', 'hi all'), said('2', 'bob', 'Bob', 'good luck'), said('3', 'host', 'Host', 'welcome')];

function show(me: string, lobbyChat?: LobbyChatRules) {
  render(<LobbyChat id="T" items={items} session={{ playerId: me, displayName: me, account: null }} state={lobbyState(lobbyChat)} />);
}
/** The tools beside one message. */
const message = (text: string) => within(screen.getByText(text).closest('li')!);

beforeEach(() => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => {
  for (const id of ['ana', 'bob', 'host']) setChatMuted(id, false);
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('lobby chat', () => {
  it('lets a player hide someone just for themselves, and show them again', () => {
    show('bob');
    // A plain player gets no host tools.
    expect(screen.queryByRole('button', { name: 'Mute' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Turn chat off' })).toBeNull();
    // Nobody hides themselves.
    expect(message('good luck').queryByRole('button', { name: 'Hide' })).toBeNull();

    fireEvent.click(message('hi all').getByRole('button', { name: 'Hide' }));
    expect(screen.queryByText('hi all')).toBeNull();
    expect(screen.getByText('welcome')).toBeTruthy();
    // The same list the tables use, so Ana stays hidden at a table too.
    expect(JSON.parse(localStorage.getItem('rsdp.chatMuted')!)).toEqual(['ana']);
    expect(server.chatMute).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Ana ✕' }));
    expect(screen.getByText('hi all')).toBeTruthy();
    expect(screen.queryByText(/Hidden for you/)).toBeNull();
  });

  it('gives the host and co-hosts with the power mute, delete and the chat switch, only for whom they may', () => {
    show('dan');
    // A co-host doesn't act on the host's messages.
    expect(message('welcome').queryByRole('button', { name: 'Mute' })).toBeNull();
    expect(message('welcome').queryByRole('button', { name: 'Delete' })).toBeNull();

    fireEvent.click(message('hi all').getByRole('button', { name: 'Mute' }));
    expect(window.confirm).toHaveBeenCalledWith('Mute Ana for everyone? They can still read this chat, but not send to it.');
    expect(server.chatMute).toHaveBeenCalledWith('T', 'ana', true);
    fireEvent.click(message('hi all').getByRole('button', { name: 'Delete' }));
    expect(window.confirm).toHaveBeenCalledWith('Delete this message for everyone?');
    expect(server.chatDelete).toHaveBeenCalledWith('T', '1');
    fireEvent.click(screen.getByRole('button', { name: 'Turn chat off' }));
    expect(server.chatOff).toHaveBeenCalledWith('T', true);
  });

  it('mutes and deletes nothing when the host thinks better of it', () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    show('host');
    fireEvent.click(message('welcome').getByRole('button', { name: 'Delete' }));
    expect(server.chatDelete).not.toHaveBeenCalled();
    fireEvent.click(message('hi all').getByRole('button', { name: 'Mute' }));
    expect(server.chatMute).not.toHaveBeenCalled();
  });

  it('says the host turned chat off, and takes the message box away', () => {
    show('bob', { off: true });
    expect(screen.getByText('The host turned chat off.')).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull();
    expect(screen.getByText('hi all')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Turn chat back on' })).toBeNull();
  });

  it('lets the host turn the chat back on', () => {
    show('host', { off: true });
    expect(screen.getByText('The host turned chat off.')).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Turn chat back on' }));
    expect(server.chatOff).toHaveBeenCalledWith('T', false);
  });

  it("tells a muted player why they can't send", () => {
    show('ana', { muted: ['ana'] });
    expect(screen.getByText('The host has muted you in this chat.')).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull();
  });

  it('shows the host whom they muted, to unmute them', () => {
    show('host', { muted: ['ana'] });
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeTruthy();
    expect(message('hi all').getByRole('button', { name: 'Unmute' })).toBeTruthy();
    expect(screen.getByText(/Muted for everyone/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Ana ✕' }));
    expect(server.chatMute).toHaveBeenCalledWith('T', 'ana', false);
    // Letting someone talk again needs no second thought.
    fireEvent.click(message('hi all').getByRole('button', { name: 'Unmute' }));
    expect(server.chatMute).toHaveBeenCalledTimes(2);
    expect(window.confirm).not.toHaveBeenCalled();
  });

  it('offers a co-host an unmute only for those they may unmute', () => {
    // The host muted Ana and Dan, a co-host: Dan may let Ana talk again, but not himself.
    show('dan', { muted: ['ana', 'dan'] });
    expect(screen.getByText('The host has muted you in this chat.')).toBeTruthy();
    const list = within(screen.getByText(/Muted for everyone/));
    expect(list.getByRole('button', { name: 'Ana ✕' })).toBeTruthy();
    expect(list.queryByRole('button', { name: /Dan/ })).toBeNull();
    expect(list.getByText('Dan')).toBeTruthy();
  });

  it('shows the server’s reason when it refuses', async () => {
    server.chat.mockRejectedValueOnce(new Error('the host has turned chat off'));
    show('bob');
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'hello?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    // Read out as it appears.
    expect((await screen.findByRole('alert')).textContent).toBe('The host has turned chat off');
  });

  it("doesn't count messages from someone you hid as unread", () => {
    const later = Date.now() + 60_000;
    const fresh = [said('4', 'ana', 'Ana', 'one', later), said('5', 'host', 'Host', 'two', later), said('6', 'bob', 'Bob', 'mine', later)];
    expect(renderHook(() => useUnreadChat(fresh, false, 'bob', 0)).result.current).toBe(2);
    setChatMuted('ana', true);
    expect(renderHook(() => useUnreadChat(fresh, false, 'bob', 0)).result.current).toBe(1);
  });
});

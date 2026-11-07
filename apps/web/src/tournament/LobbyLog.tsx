import { useEffect, useRef, useState } from 'react';
import { chatModerationRefusal, LOBBY_CHAT_MAX, namesIn, type LobbyItem, type TournamentState } from '@rsdp/tournament';
import { savedName } from '../socket';
import { setChatMuted, useChatMutes } from '../chatMutes';
import { tournamentClient, type Session } from './client';
import { activityLines } from './logText';

/** A followed tournament's lobby chat and activity, kept up to date. */
export function useLobbyLog(id: string): LobbyItem[] {
  const [items, setItems] = useState<LobbyItem[]>([]);
  useEffect(() => tournamentClient().onLog(id, setItems), [id]);
  return items;
}

const time = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

type ChatItem = Extract<LobbyItem, { kind: 'chat' }>;
const isChat = (x: LobbyItem): x is ChatItem => x.kind === 'chat';

/**
 * The lobby chat. Anyone can hide someone's messages just for themselves (the same list as at the tables). The host,
 * and co-hosts with the players power, can also mute someone for everyone, delete a message, or turn the chat off.
 */
export function LobbyChat({ id, items, session, state }: { id: string; items: LobbyItem[]; session: Session | null; state: TournamentState }) {
  const me = session?.playerId;
  const hidden = useChatMutes();
  const all = items.filter(isChat);
  const chat = all.filter((m) => m.playerId === me || !hidden.includes(m.playerId));
  const [text, setText] = useState('');
  const [name, setName] = useState(() => session?.displayName || savedName());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const list = useRef<HTMLOListElement>(null);
  const needsName = !!session && !session.displayName;
  const off = !!state.lobbyChat?.off;
  const mutedByHost = !!me && !!state.lobbyChat?.muted?.includes(me);
  // The server checks all of this again; these only decide which buttons to show.
  const moderator = !!me && chatModerationRefusal(state, me) === null;
  const mayModerate = (playerId: string) => !!me && chatModerationRefusal(state, me, playerId) === null;
  // Nobody unmutes themselves but the host, so a co-host the host muted stays muted.
  const mayUnmute = (playerId: string) => mayModerate(playerId) && (playerId !== me || me === state.hostId);
  const muted = (moderator && state.lobbyChat?.muted) || [];
  const nameOf = (playerId: string) => [...all].reverse().find((m) => m.playerId === playerId)?.name ?? namesIn(state)(playerId);
  // Only people from this lobby: the list is kept for every table and lobby.
  const hiddenHere = hidden.filter((p) => p !== me && all.some((m) => m.playerId === p));

  // Stay at the newest message unless the reader has scrolled up (judged before the new one lands).
  const atBottom = useRef(true);
  const last = chat.at(-1)?.id;
  useEffect(() => {
    const el = list.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [last]);
  useEffect(() => {
    if (list.current) list.current.scrollTop = list.current.scrollHeight;
  }, []);

  const report = (err: unknown) => {
    const m = (err as Error).message;
    setError(m.charAt(0).toUpperCase() + m.slice(1));
  };
  const act = (p: Promise<void>) => p.then(() => setError(''), report);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim() || busy) return;
    setError('');
    setBusy(true);
    try {
      if (needsName) {
        if (!name.trim()) throw new Error('Pick the name other players will see.');
        await tournamentClient().setName(name);
      }
      await tournamentClient().chat(id, text);
      setText('');
    } catch (err) {
      report(err);
    } finally {
      setBusy(false);
    }
  };

  /** With a message: hide its writer (just for me) and, for the host, mute them or delete it for everyone. */
  const tools = (m: ChatItem) => {
    const theirs = m.playerId !== me;
    const mod = mayModerate(m.playerId);
    if (!theirs && !mod) return null;
    const isMuted = !!state.lobbyChat?.muted?.includes(m.playerId);
    return (
      <span className="tn-chat-tools">
        {theirs && (
          <button type="button" title={`Hide ${m.name}'s messages from you`} onClick={() => confirm(`Hide ${m.name}'s messages? Only you stop seeing them.`) && setChatMuted(m.playerId, true)}>
            Hide
          </button>
        )}
        {theirs && mod && (
          <button
            type="button"
            title={isMuted ? `Let ${m.name} chat here again` : `Stop ${m.name} chatting here`}
            onClick={() => (isMuted || confirm(`Mute ${m.name} for everyone? They can still read this chat, but not send to it.`)) && act(tournamentClient().chatMute(id, m.playerId, !isMuted))}
          >
            {isMuted ? 'Unmute' : 'Mute'}
          </button>
        )}
        {mod && (
          <button type="button" title="Delete this message for everyone" onClick={() => confirm('Delete this message for everyone?') && act(tournamentClient().chatDelete(id, m.id))}>
            Delete
          </button>
        )}
      </span>
    );
  };

  return (
    <div className="tn-chat">
      {chat.length === 0 ? (
        !off && <p className="muted">No messages yet. Say hello, or talk about the structure before the start.</p>
      ) : (
        <ol
          className="tn-chat-list"
          ref={list}
          onScroll={(e) => {
            const el = e.currentTarget;
            atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          }}
        >
          {chat.map((m) => (
            <li key={m.id} className={m.playerId === me ? 'mine' : ''}>
              <span className="tn-chat-meta">
                <b>{m.name}</b> <span className="muted">{time(m.at)}</span>
              </span>
              <span className="tn-chat-text">{m.text}</span>
              {tools(m)}
            </li>
          ))}
        </ol>
      )}
      {off ? <p className="tn-chat-note">The host turned chat off.</p> : mutedByHost && <p className="tn-chat-note">The host has muted you in this chat.</p>}
      {hiddenHere.length > 0 && (
        <p className="tn-chat-tools muted">
          Hidden for you:{' '}
          {hiddenHere.map((p) => (
            <button key={p} type="button" title="Show their messages again" onClick={() => setChatMuted(p, false)}>
              {nameOf(p)} ✕
            </button>
          ))}
        </p>
      )}
      {muted.length > 0 && (
        <p className="tn-chat-tools muted">
          Muted for everyone:{' '}
          {muted.map((p) =>
            mayUnmute(p) ? (
              <button key={p} type="button" title="Let them chat here again" onClick={() => act(tournamentClient().chatMute(id, p, false))}>
                {nameOf(p)} ✕
              </button>
            ) : (
              // Only the host unmutes a co-host, this one included.
              <span key={p}>{nameOf(p)}</span>
            ),
          )}
        </p>
      )}
      {!off && !mutedByHost && (
        <form className="tn-chat-form" onSubmit={send}>
          {needsName && <input value={name} maxLength={20} placeholder="Your name" aria-label="Your name" onChange={(e) => setName(e.target.value)} />}
          <input value={text} maxLength={LOBBY_CHAT_MAX} placeholder="Message the lobby" aria-label="Message" onChange={(e) => setText(e.target.value)} />
          <button className="primary" disabled={busy || !text.trim()}>
            Send
          </button>
        </form>
      )}
      {moderator && (
        <p>
          <button type="button" onClick={() => act(tournamentClient().chatOff(id, !off))}>
            {off ? 'Turn chat back on' : 'Turn chat off'}
          </button>
        </p>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

/** Everything that happened, newest first: registrations, levels, breaks, rebuys, knockouts. */
export function Activity({ items }: { items: LobbyItem[] }) {
  const events = activityLines(items);
  if (!events.length) return <p className="muted">Nothing has happened yet. Registrations, levels, breaks and knockouts show up here.</p>;
  return (
    <ol className="tn-activity">
      {events.map((e) => (
        <li key={e.id}>
          <span className="muted">{time(e.at)}</span> {e.text}
        </li>
      ))}
    </ol>
  );
}

/**
 * Chat messages from others since this page opened that arrived while the chat tab was closed, leaving out anyone this
 * browser hid. `skew` is server minus local time.
 */
export function useUnreadChat(items: LobbyItem[], open: boolean, me: string | undefined, skew: number): number {
  const hidden = useChatMutes();
  const [readUntil, setReadUntil] = useState(() => Date.now());
  const newest = items.reduce((t, x) => (x.kind === 'chat' ? Math.max(t, x.at) : t), 0);
  useEffect(() => {
    if (open) setReadUntil((t) => Math.max(t, newest - skew, Date.now()));
  }, [open, newest, skew]);
  if (open) return 0;
  return items.filter((x) => x.kind === 'chat' && x.playerId !== me && !hidden.includes(x.playerId) && x.at - skew > readUntil).length;
}

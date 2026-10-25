import { useEffect, useRef, useState } from 'react';
import { LOBBY_CHAT_MAX, type LobbyItem } from '@rsdp/tournament';
import { savedName } from '../socket';
import { tournamentClient, type Session } from './client';
import { logText } from './logText';

/** A followed tournament's lobby chat and activity, kept up to date. */
export function useLobbyLog(id: string): LobbyItem[] {
  const [items, setItems] = useState<LobbyItem[]>([]);
  useEffect(() => tournamentClient().onLog(id, setItems), [id]);
  return items;
}

const time = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

export function LobbyChat({ id, items, session }: { id: string; items: LobbyItem[]; session: Session | null }) {
  const chat = items.filter((x): x is Extract<LobbyItem, { kind: 'chat' }> => x.kind === 'chat');
  const [text, setText] = useState('');
  const [name, setName] = useState(() => session?.displayName || savedName());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const list = useRef<HTMLOListElement>(null);
  const needsName = !!session && !session.displayName;

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
      const m = (err as Error).message;
      setError(m.charAt(0).toUpperCase() + m.slice(1));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="tn-chat">
      {chat.length === 0 ? (
        <p className="muted">No messages yet. Say hello, or talk about the structure before the start.</p>
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
            <li key={m.id} className={m.playerId === session?.playerId ? 'mine' : ''}>
              <span className="tn-chat-meta">
                <b>{m.name}</b> <span className="muted">{time(m.at)}</span>
              </span>
              <span className="tn-chat-text">{m.text}</span>
            </li>
          ))}
        </ol>
      )}
      <form className="tn-chat-form" onSubmit={send}>
        {needsName && <input value={name} maxLength={20} placeholder="Your name" aria-label="Your name" onChange={(e) => setName(e.target.value)} />}
        <input value={text} maxLength={LOBBY_CHAT_MAX} placeholder="Message the lobby" aria-label="Message" onChange={(e) => setText(e.target.value)} />
        <button className="primary" disabled={busy || !text.trim()}>
          Send
        </button>
      </form>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

/** Everything that happened, newest first: registrations, levels, breaks, rebuys, knockouts. */
export function Activity({ items }: { items: LobbyItem[] }) {
  const events = items
    .flatMap((x) => (x.kind === 'event' ? [{ id: x.id, at: x.at, text: logText(x.event) }] : []))
    .filter((x) => x.text)
    .reverse();
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

/** Chat messages from others since this page opened that arrived while the chat tab was closed. `skew` is server minus local time. */
export function useUnreadChat(items: LobbyItem[], open: boolean, me: string | undefined, skew: number): number {
  const [readUntil, setReadUntil] = useState(() => Date.now());
  const newest = items.reduce((t, x) => (x.kind === 'chat' ? Math.max(t, x.at) : t), 0);
  useEffect(() => {
    if (open) setReadUntil((t) => Math.max(t, newest - skew, Date.now()));
  }, [open, newest, skew]);
  if (open) return 0;
  return items.filter((x) => x.kind === 'chat' && x.playerId !== me && x.at - skew > readUntil).length;
}

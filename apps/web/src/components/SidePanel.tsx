import { useEffect, useMemo, useRef, useState } from 'react';
import type { HandRecordView, TableView } from '@rsdp/engine/wire';
import { call, socket } from '../socket';
import { eventLines, type Fmt } from '../format';
import { LogText } from './PlayingCard';

type Tab = 'log' | 'chat' | 'ledger' | 'hands';
const TAB_NAMES: Record<Tab, string> = { log: 'Log', chat: 'Chat', ledger: 'Ledger', hands: 'Hands' };

export function SidePanel({ view, fmt }: { view: TableView; fmt: Fmt }) {
  const [tab, setTab] = useState<Tab>('log');
  const [text, setText] = useState('');
  const [seenChat, setSeenChat] = useState(view.chat.length);
  const scroller = useRef<HTMLDivElement>(null);

  const names = useMemo(() => {
    const m = new Map<number, string>();
    view.seats.forEach((s, i) => s && m.set(i, s.name));
    return m;
  }, [view.seats]);
  const handLines = view.hand ? eventLines(view.hand.events, (seat) => names.get(seat) ?? `Seat ${seat + 1}`, fmt, view.me.seat) : [];

  useEffect(() => {
    if (tab === 'chat') setSeenChat(view.chat.length);
  }, [tab, view.chat.length]);
  useEffect(() => {
    scroller.current?.scrollTo(0, scroller.current.scrollHeight);
  }, [tab, view.log.length, view.chat.length, handLines.length]);

  const unread = tab === 'chat' ? 0 : Math.max(0, view.chat.length - seenChat);

  return (
    <div className="panel side-panel">
      <div className="tabs">
        {(Object.keys(TAB_NAMES) as Tab[]).map((t) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {TAB_NAMES[t]}
            {t === 'chat' && unread > 0 && <span className="badge">{unread}</span>}
          </button>
        ))}
      </div>
      <div className="scroll" ref={scroller}>
        {tab === 'log' && (
          <>
            {view.log.map((l, i) => (
              <div key={`t${i}`} className="log-table">
                {l.text}
              </div>
            ))}
            {handLines.map((line, i) => (
              <div key={`h${i}`} className={line.startsWith('---') ? 'log-hand' : ''}>
                <LogText text={line.replace(/^--- /, '')} />
              </div>
            ))}
          </>
        )}
        {tab === 'chat' &&
          (view.chat.length ? (
            view.chat.map((m, i) => (
              <div key={i} className={m.playerId ? '' : 'log-table'}>
                {m.playerId ? <b>{m.name}: </b> : null}
                {m.text}
              </div>
            ))
          ) : (
            <p className="muted">No messages yet.</p>
          ))}
        {tab === 'ledger' && <Ledger view={view} fmt={fmt} />}
        {tab === 'hands' && <Hands view={view} fmt={fmt} />}
      </div>
      {tab === 'chat' && (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            if (!text.trim()) return;
            socket.emit('chat:send', { text });
            setText('');
          }}
        >
          <input value={text} maxLength={300} placeholder="Say something" onChange={(e) => setText(e.target.value)} />
          <button>Send</button>
        </form>
      )}
    </div>
  );
}

function Ledger({ view, fmt }: { view: TableView; fmt: Fmt }) {
  if (!view.ledger.length) return <p className="muted">Nobody has bought in yet.</p>;
  return (
    <table className="ledger">
      <thead>
        <tr>
          <th>Player</th>
          <th>Buy-in</th>
          <th>Out</th>
          <th>Stack</th>
          <th>Net</th>
        </tr>
      </thead>
      <tbody>
        {view.ledger.map((e) => (
          <tr key={e.playerId}>
            <td>{e.name}</td>
            <td>{fmt(e.buyIn)}</td>
            <td>{e.cashOut ? fmt(e.cashOut) : ''}</td>
            <td>{fmt(e.stack)}</td>
            <td className={e.net > 0 ? 'up' : e.net < 0 ? 'down' : ''}>{e.net > 0 ? `+${fmt(e.net)}` : fmt(e.net)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Hands({ view, fmt }: { view: TableView; fmt: Fmt }) {
  const [open, setOpen] = useState<HandRecordView | null>(null);
  const [error, setError] = useState('');

  if (open) {
    const names = new Map(open.seats.map((s) => [s.seat, s.name]));
    const mySeat = open.seats.find((s) => s.playerId === view.me.playerId)?.seat ?? null;
    const lines = eventLines(open.events, (seat) => names.get(seat) ?? `Seat ${seat + 1}`, fmt, mySeat);
    return (
      <div className="hand-record">
        <button onClick={() => setOpen(null)}>← All hands</button>
        <div className="muted">
          {new Date(open.startedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · {open.seats.map((s) => `${s.name} ${fmt(s.stack)}`).join(', ')}
        </div>
        {lines.map((line, i) => (
          <div key={i} className={line.startsWith('---') ? 'log-hand' : ''}>
            <LogText text={line.replace(/^--- /, '')} />
          </div>
        ))}
      </div>
    );
  }
  if (!view.history.length) return <p className="muted">Finished hands show up here.</p>;
  return (
    <>
      {error && <p className="error">{error}</p>}
      {[...view.history].reverse().map((h) => (
        <button
          key={h.handNumber}
          className="hand-row"
          onClick={() =>
            call<{ hand: HandRecordView }>('table:history', { handNumber: h.handNumber })
              .then((r) => setOpen(r.hand))
              .catch((e: Error) => setError(e.message))
          }
        >
          <b>#{h.handNumber}</b> {h.gameName}
          <span className="muted"> {new Date(h.endedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
        </button>
      ))}
    </>
  );
}

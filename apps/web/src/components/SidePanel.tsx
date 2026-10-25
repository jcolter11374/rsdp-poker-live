import { useEffect, useMemo, useRef, useState } from 'react';
import type { HandRecordView, TableView } from '@rsdp/engine/wire';
import { call, socket } from '../socket';
import { eventLines, type Fmt } from '../format';
import { LogText } from './PlayingCard';
import { download, fileStem, handHistoryText, ledgerCsv, settleUp } from '../records';

export type Tab = 'log' | 'chat' | 'ledger' | 'hands';
const TAB_NAMES: Record<Tab, string> = { log: 'Log', chat: 'Chat', ledger: 'Ledger', hands: 'Hands' };

export function SidePanel({
  view,
  fmt,
  initialTab = 'log',
  chatSeen,
  onChatSeen,
}: {
  view: TableView;
  fmt: Fmt;
  initialTab?: Tab;
  /** Chat messages already read, when the page keeps count (the phone sheet comes and goes). */
  chatSeen?: number;
  onChatSeen?: (count: number) => void;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [text, setText] = useState('');
  const [ownSeen, setOwnSeen] = useState(view.chat.length);
  const seenChat = chatSeen ?? ownSeen;
  const setSeenChat = onChatSeen ?? setOwnSeen;
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

type SortKey = 'name' | 'buyIn' | 'cashOut' | 'stack' | 'net';
const SORT_KEY = 'rsdp.ledgerSort';

function Ledger({ view, fmt }: { view: TableView; fmt: Fmt }) {
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>(() => {
    try {
      return JSON.parse(localStorage.getItem(SORT_KEY) ?? '') as { key: SortKey; desc: boolean };
    } catch {
      return { key: 'net', desc: true };
    }
  });
  const [settle, setSettle] = useState(false);
  const [copied, setCopied] = useState(false);
  if (!view.ledger.length) return <p className="muted">Nobody has bought in yet.</p>;

  const seated = new Set(view.seats.filter((s) => s !== null).map((s) => s.playerId));
  const rows = [...view.ledger].sort((a, b) => {
    const d = sort.key === 'name' ? a.name.localeCompare(b.name) : a[sort.key] - b[sort.key];
    return sort.desc ? -d : d;
  });
  const total = (k: 'buyIn' | 'cashOut' | 'stack' | 'net') => view.ledger.reduce((a, r) => a + r[k], 0);
  const pick = (key: SortKey) => {
    const next = { key, desc: sort.key === key ? !sort.desc : key !== 'name' };
    setSort(next);
    try {
      localStorage.setItem(SORT_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };
  const head = (key: SortKey, label: string) => (
    <th onClick={() => pick(key)} className="sortable">
      {label}
      {sort.key === key ? (sort.desc ? ' ▾' : ' ▴') : ''}
    </th>
  );
  const signed = (n: number) => (n > 0 ? `+${fmt(n)}` : fmt(n));
  const { transfers, off } = settleUp(view.ledger);
  const summary = [
    `${view.name}: settle up`,
    ...transfers.map((t) => `${t.from} pays ${t.to} ${fmt(t.amount)}`),
    ...(transfers.length ? [] : ['Everyone is square.']),
  ].join('\n');

  return (
    <div className="ledger-panel">
      <div className="row wrap ledger-actions">
        <button className={settle ? 'active' : ''} onClick={() => setSettle(!settle)}>
          {settle ? 'Show ledger' : 'Settle up'}
        </button>
        <button onClick={() => download(`${fileStem(view.name)}-ledger.csv`, ledgerCsv(rows, seated, view.settings.stakes.centsMode), 'text/csv')}>Download CSV</button>
      </div>
      {settle ? (
        <div className="settle">
          {transfers.length === 0 ? (
            <p className="muted">Everyone is square.</p>
          ) : (
            transfers.map((t, i) => (
              <div className="transfer" key={i}>
                <b>{t.from}</b> pays <b>{t.to}</b> <span className="amount">{fmt(t.amount)}</span>
              </div>
            ))
          )}
          {off !== 0 && <p className="error">The books are off by {signed(off)}; check the buy-ins.</p>}
          <p className="hint">Counts chips still on the table as if everyone cashed out now.</p>
          <button
            onClick={() =>
              navigator.clipboard.writeText(summary).then(
                () => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                },
                () => prompt('Copy this', summary),
              )
            }
          >
            {copied ? 'Copied!' : 'Copy for the group chat'}
          </button>
        </div>
      ) : (
        <table className="ledger">
          <thead>
            <tr>
              {head('name', 'Player')}
              {head('buyIn', 'In')}
              {head('cashOut', 'Out')}
              {head('stack', 'Stack')}
              {head('net', 'Net')}
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.playerId} className={seated.has(e.playerId) ? '' : 'departed'}>
                <td>
                  {e.name}
                  {!seated.has(e.playerId) && <span className="muted"> · left</span>}
                </td>
                <td>{fmt(e.buyIn)}</td>
                <td>{e.cashOut ? fmt(e.cashOut) : ''}</td>
                <td>{seated.has(e.playerId) ? fmt(e.stack) : ''}</td>
                <td className={e.net > 0 ? 'up' : e.net < 0 ? 'down' : ''}>{signed(e.net)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td>Total</td>
              <td>{fmt(total('buyIn'))}</td>
              <td>{fmt(total('cashOut'))}</td>
              <td>{fmt(total('stack'))}</td>
              <td className={total('net') !== 0 ? 'down' : ''}>{signed(total('net'))}</td>
            </tr>
          </tfoot>
        </table>
      )}
    </div>
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
  const exportAll = (kind: 'txt' | 'json') =>
    call<{ hands: HandRecordView[] }>('table:export')
      .then(({ hands }) => {
        const stem = `${fileStem(view.name)}-hands`;
        if (kind === 'json') download(`${stem}.json`, JSON.stringify({ format: 'rsdp-hands', version: 1, table: view.name, exportedAt: new Date().toISOString(), centsMode: view.settings.stakes.centsMode, hands }, null, 1), 'application/json');
        else download(`${stem}.txt`, handHistoryText(view.name, hands, view.me.playerId, fmt));
      })
      .catch((e: Error) => setError(e.message));
  return (
    <>
      <div className="row wrap ledger-actions">
        <button onClick={() => exportAll('txt')}>Download all hands</button>
        <button onClick={() => exportAll('json')}>JSON</button>
      </div>
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

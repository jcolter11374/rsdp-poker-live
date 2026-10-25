import { useEffect, useMemo, useRef, useState } from 'react';
import type { HandRecordView, TableView } from '@rsdp/engine/wire';
import { call } from '../socket';
import { eventLines, type Fmt } from '../format';
import { LogText } from './PlayingCard';
import { download, fileStem, handHistoryText, ledgerCsv, settleUp } from '../records';
import { handNet, isReplayable, playerStats } from '../replay';
import { Replayer } from './Replayer';
import { setChatMuted, useChatMutes } from '../chatMutes';
import { FullLogDownload, Highlights, ohhDownload, ShareHandDialog } from './table/Records';

export type Tab = 'log' | 'chat' | 'ledger' | 'hands' | 'stats';
const TAB_NAMES: Record<Tab, string> = { log: 'Log', chat: 'Chat', ledger: 'Ledger', hands: 'Hands', stats: 'Stats' };

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
  const [chatError, setChatError] = useState('');
  const mutes = useChatMutes();
  const [ownSeen, setOwnSeen] = useState(view.chat.length);
  const seenChat = chatSeen ?? ownSeen;
  const setSeenChat = onChatSeen ?? setOwnSeen;
  const scroller = useRef<HTMLDivElement>(null);

  const names = useMemo(() => {
    const m = new Map<number, string>();
    view.seats.forEach((s, i) => s && m.set(i, s.name));
    return m;
  }, [view.seats]);
  const handLines = view.hand ? eventLines(view.hand.events, (seat) => view.hand?.names?.[seat] ?? names.get(seat) ?? `Seat ${seat + 1}`, fmt, view.me.seat) : [];

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
            <FullLogDownload view={view} fmt={fmt} />
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
            view.chat
              .filter((m) => !m.playerId || !mutes.includes(m.playerId))
              .map((m, i) => (
                <div key={i} className={m.playerId ? '' : 'log-table'}>
                  {m.playerId ? (
                    m.playerId === view.me.playerId ? (
                      <b>{m.name}: </b>
                    ) : (
                      <b className="chat-name" title={`Click to mute ${m.name} for you`} onClick={() => confirm(`Mute ${m.name}? Only you stop seeing their messages.`) && setChatMuted(m.playerId!, true)}>
                        {m.name}:{' '}
                      </b>
                    )
                  ) : null}
                  {m.text}
                </div>
              ))
          ) : (
            <p className="muted">No messages yet.</p>
          ))}
        {tab === 'ledger' && <Ledger view={view} fmt={fmt} />}
        {tab === 'hands' && <Hands view={view} fmt={fmt} />}
        {tab === 'stats' && <Stats view={view} fmt={fmt} />}
      </div>
      {tab === 'chat' && <ChatNotes view={view} mutes={mutes} error={chatError} />}
      {tab === 'chat' && (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            if (!text.trim()) return;
            call('chat:send', { text })
              .then(() => setChatError(''))
              .catch((err: Error) => setChatError(err.message));
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

/** Under the chat: whom you muted, and why you can't talk if you can't. */
function ChatNotes({ view, mutes, error }: { view: TableView; mutes: string[]; error: string }) {
  const name = (id: string) => [...view.chat].reverse().find((m) => m.playerId === id)?.name ?? view.seats.find((s) => s?.playerId === id)?.name ?? view.watchers.find((w) => w.playerId === id)?.name ?? 'Guest';
  const shown = mutes.filter((id) => view.chat.some((m) => m.playerId === id) || view.seats.some((s) => s?.playerId === id) || view.watchers.some((w) => w.playerId === id));
  const mutedByHost = view.muted.includes(view.me.playerId);
  const quiet = !view.settings.chat.guestChat && view.me.seat === null && !view.isHost;
  if (!shown.length && !mutedByHost && !quiet && !error) return null;
  return (
    <div className="chat-notes muted">
      {mutedByHost ? <div>The host has muted you.</div> : quiet ? <div>Only players at the table can chat here.</div> : error && <div className="error">{error}</div>}
      {shown.length > 0 && (
        <div>
          Muted for you:{' '}
          {shown.map((id) => (
            <button key={id} className="link" title="Unmute" onClick={() => setChatMuted(id, false)}>
              {name(id)} ✕
            </button>
          ))}
        </div>
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

const handCache = new Map<string, HandRecordView[]>();
const loading = new Map<string, Promise<HandRecordView[]>>();
/**
 * Every finished hand at the table: the full download once, then each new
 * hand on its own as it finishes. One request at a time per table. The last
 * hand is fetched again too, since cards shown and bounties claimed after a
 * hand ends are added to it until the next one starts.
 */
function allHands(view: TableView): Promise<HandRecordView[]> {
  const pending = loading.get(view.id);
  // Wait for the request in flight, then pick up anything it missed.
  if (pending) return pending.catch(() => undefined).then(() => allHands(view));
  const job = (async () => {
    let hands = handCache.get(view.id);
    if (!hands) hands = (await call<{ hands: HandRecordView[] }>('table:export')).hands;
    const last = hands.at(-1)?.handNumber;
    const have = new Set(hands.filter((h) => h.handNumber !== last).map((h) => h.handNumber));
    const missing = view.history.filter((h) => !have.has(h.handNumber));
    if (missing.length) {
      const more = await Promise.all(missing.map((h) => call<{ hand: HandRecordView }>('table:history', { handNumber: h.handNumber }).then((r) => r.hand)));
      const fresh = new Set(more.map((h) => h.handNumber));
      hands = [...hands.filter((h) => !fresh.has(h.handNumber)), ...more].sort((a, b) => a.handNumber - b.handNumber);
    }
    handCache.set(view.id, hands);
    return hands;
  })().finally(() => loading.delete(view.id));
  loading.set(view.id, job);
  return job;
}

/** All hands, loading while `active`, refreshed as hands finish and as the next one starts. */
function useAllHands(view: TableView, active: boolean) {
  const [hands, setHands] = useState<HandRecordView[] | null>(() => handCache.get(view.id) ?? null);
  const [error, setError] = useState('');
  const [tries, setTries] = useState(0);
  const latest = view.history.at(-1)?.handNumber ?? 0;
  const dealing = view.hand?.handNumber ?? 0;
  useEffect(() => {
    if (!active || !latest) return;
    let live = true;
    allHands(view)
      .then((h) => live && (setHands(h), setError('')))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [active, latest, dealing, tries]);
  return { hands, error, retry: () => setTries((t) => t + 1), setHands };
}

function Hands({ view, fmt }: { view: TableView; fmt: Fmt }) {
  const [open, setOpen] = useState<HandRecordView | null>(null);
  const [replay, setReplay] = useState<number | null>(null);
  const [sharing, setSharing] = useState<HandRecordView | null>(null);
  const { hands, error: loadError, retry, setHands } = useAllHands(view, true);
  const [error, setError] = useState('');
  const [fromFile, setFromFile] = useState<HandRecordView[] | null>(null);
  const opener = (
    <OpenHandsFile
      fmt={fmt}
      onOpen={(h) => (setFromFile(h), setError(''))}
      onError={setError}
    />
  );
  const fileReplay = fromFile && (
    <Replayer hands={fromFile} start={0} tableName={view.name} seatCount={Math.max(view.seats.length, ...fromFile.flatMap((h) => h.seats.map((s) => s.seat + 1)))} myId={view.me.playerId} felt={view.settings.table.felt} fmt={fmt} onClose={() => setFromFile(null)} />
  );

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
  if (!view.history.length || !hands)
    return (
      <>
        <p className="muted">
          {!view.history.length ? 'Finished hands show up here.' : loadError || 'Loading hands…'}
          {loadError && <button onClick={retry}>Try again</button>}
        </p>
        <div className="row wrap ledger-actions">{opener}</div>
        {error && <p className="error">{error}</p>}
        {fileReplay}
      </>
    );
  const exportAll = async (kind: 'txt' | 'json') => {
    // A fresh copy, with anything shown since; the list on screen if the server says to wait.
    let all = hands;
    try {
      all = (await call<{ hands: HandRecordView[] }>('table:export')).hands;
      handCache.set(view.id, all);
      setHands(all);
    } catch {
      /* use what's loaded */
    }
    const stem = `${fileStem(view.name)}-hands`;
    if (kind === 'json') download(`${stem}.json`, JSON.stringify({ format: 'rsdp-hands', version: 1, table: view.name, exportedAt: new Date().toISOString(), centsMode: view.settings.stakes.centsMode, hands: all }, null, 1), 'application/json');
    else download(`${stem}.txt`, handHistoryText(view.name, all, view.me.playerId, fmt));
  };
  return (
    <>
      <div className="row wrap ledger-actions">
        <button onClick={() => void exportAll('txt')}>Download all hands</button>
        <button onClick={() => void exportAll('json')}>JSON</button>
        <button onClick={() => setError(ohhDownload(view, hands) ?? '')} title="Open Hand History, for PokerTracker, Holdem Manager and other trackers (Hold'em and Omaha)">
          Tracker (OHH)
        </button>
        {opener}
      </div>
      {(error || loadError) && <p className="error">{error || loadError}</p>}
      <Highlights view={view} hands={hands} fmt={fmt} onReplay={setReplay} onShare={setSharing} />
      {hands
        .map((h, i) => ({ h, i, net: handNet(h, view.me.playerId) }))
        .reverse()
        .map(({ h, i, net }) => (
          <div key={h.handNumber} className="hand-row">
            <button className="hand-open" onClick={() => setReplay(i)} title="Replay this hand">
              <span className="hand-name">
                ▶ <b>#{h.handNumber}</b> {h.gameName}
              </span>
              <span className="muted">{new Date(h.endedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
              {net !== null && net !== 0 && <span className={net > 0 ? 'up' : 'down'}>{net > 0 ? `+${fmt(net)}` : fmt(net)}</span>}
            </button>
            <button className="hand-text" onClick={() => (setOpen(h), setError(''))} title="Read the log">
              Log
            </button>
            <button className="hand-text" onClick={() => setSharing(h)} title="Share a link to this hand">
              Share
            </button>
          </div>
        ))}
      {replay !== null && (
        <Replayer hands={hands} start={replay} tableName={view.name} seatCount={view.seats.length} myId={view.me.playerId} felt={view.settings.table.felt} fmt={fmt} onClose={() => setReplay(null)} />
      )}
      {fileReplay}
      {sharing && <ShareHandDialog hand={sharing} onClose={() => setSharing(null)} />}
    </>
  );
}

/** Loads a hands file saved from the Hands tab (JSON) and hands it to the replayer. */
function OpenHandsFile({ fmt, onOpen, onError }: { fmt: Fmt; onOpen: (hands: HandRecordView[]) => void; onError: (msg: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const read = async (file: File) => {
    try {
      const data = JSON.parse(await file.text());
      if (data?.format !== 'rsdp-hands' || !Array.isArray(data.hands)) throw new Error();
      // Keep only hands the replayer can draw, so one bad entry doesn't stop the rest.
      const hands = (data.hands as unknown[]).filter((h): h is HandRecordView => isReplayable(h, fmt));
      if (!hands.length) throw new Error();
      onOpen(hands);
    } catch {
      onError('That isn’t a hands file saved from this site (use the JSON download).');
    }
  };
  return (
    <>
      <button onClick={() => input.current?.click()} title="Replay a JSON file saved from the Hands tab">
        Open file
      </button>
      <input
        ref={input}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void read(f);
        }}
      />
    </>
  );
}

function Stats({ view, fmt }: { view: TableView; fmt: Fmt }) {
  const { hands, error } = useAllHands(view, true);
  if (!view.history.length) return <p className="muted">Stats show up once hands are played.</p>;
  if (!hands) return <p className="muted">{error || 'Loading…'}</p>;
  const rows = playerStats(hands);
  const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : '');
  return (
    <>
      <table className="ledger stats">
        <thead>
          <tr>
            <th>Player</th>
            <th title="Hands dealt">Hands</th>
            <th title="Put money in voluntarily before the flop (or on the first round)">VPIP</th>
            <th title="Raised before the flop (or on the first round)">PFR</th>
            <th title="Pots won">Won</th>
            <th>Net</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.playerId}>
              <td>{r.name}</td>
              <td>{r.hands}</td>
              <td>{pct(r.vpip, r.counted)}</td>
              <td>{pct(r.pfr, r.counted)}</td>
              <td>{r.won}</td>
              <td className={r.net > 0 ? 'up' : r.net < 0 ? 'down' : ''}>{r.net > 0 ? `+${fmt(r.net)}` : fmt(r.net)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint">
        Over {hands.length} {hands.length === 1 ? 'hand' : 'hands'} at this table. VPIP: how often a player puts chips in by choice on the first betting round; PFR: how often they raise it.
      </p>
    </>
  );
}

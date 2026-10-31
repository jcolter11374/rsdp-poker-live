import { useEffect, useMemo, useState } from 'react';
import type { HandRecordView, SharedHandView, TableView } from '@rsdp/engine/wire';
import { call } from '../../socket';
import { chipFormat, type Fmt } from '../../format';
import { download, fileStem, fullLogCsv, fullLogLines, fullLogText } from '../../records';
import { findHighlights, HIGHLIGHT_ICON } from '../../highlights';
import { ohhFile } from '../../ohh';
import { Modal } from '../SeatDialog';
import { Replayer } from '../Replayer';
import { sharedHandViewer } from '../../replay';

/*
 * Records beyond the hand list: share a hand as a link, the table's
 * highlights, the full log download and the tracker (Open Hand History) export.
 */

const shareUrl = (id: string) => `${location.origin}/h/${id}`;

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    prompt('Copy this link', text);
    return false;
  }
}

/** Make a link to one hand, with or without my cards, and take it back. */
export function ShareHandDialog({ hand, onClose }: { hand: HandRecordView; onClose: () => void }) {
  const [showMine, setShowMine] = useState(true);
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const make = () => {
    setBusy(true);
    call<{ id: string }>('hand:share', { handNumber: hand.handNumber, hideMine: !showMine })
      .then(async ({ id }) => {
        setLink(id);
        setError('');
        setCopied(await copy(shareUrl(id)));
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };
  const stop = () => {
    setBusy(true);
    call('hand:unshare', { id: link })
      .then(() => setLink(null))
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };
  return (
    <Modal title={`Share hand #${hand.handNumber}`} onClose={onClose}>
      <div className="form share-hand">
        {link ? (
          <>
            <p>{copied ? 'Link copied. ' : ''}Anyone with this link can watch the hand, no sign-up needed:</p>
            <div className="row">
              <input readOnly value={shareUrl(link)} onFocus={(e) => e.target.select()} aria-label="Share link" />
              <button onClick={() => void copy(shareUrl(link)).then(setCopied)}>{copied ? 'Copied!' : 'Copy'}</button>
            </div>
            <button disabled={busy} onClick={stop}>
              Stop sharing (the link stops working)
            </button>
          </>
        ) : (
          <>
            <p className="muted">The link shows the hand as you saw it. Other players' cards appear only if they were shown.</p>
            <label className="toggle">
              <input type="checkbox" checked={showMine} onChange={(e) => setShowMine(e.target.checked)} />
              Show my cards
            </label>
            <button className="primary" disabled={busy} onClick={make}>
              Make a link
            </button>
          </>
        )}
        {error && <p className="error">{error}</p>}
        <button onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}

/** The table's best moments so far, each one replayable and shareable. */
export function Highlights({
  view,
  hands,
  fmt,
  onReplay,
  onShare,
}: {
  view: TableView;
  hands: HandRecordView[];
  fmt: Fmt;
  onReplay: (index: number) => void;
  onShare: (hand: HandRecordView) => void;
}) {
  const picks = useMemo(() => findHighlights(hands, fmt), [hands, fmt]);
  if (!picks.length) return null;
  return (
    <div className="highlights">
      <h4>Highlights</h4>
      {picks.map((p) => (
        <div key={p.handNumber} className="hand-row highlight">
          <button className="hand-open" onClick={() => onReplay(p.index)} title="Replay this hand">
            <span className="hand-name">
              {HIGHLIGHT_ICON[p.kind]} {p.headline}
              {p.playerId === view.me.playerId && <span className="tag">you</span>}
            </span>
            <span className="muted">#{p.handNumber}</span>
          </button>
          <button className="hand-text" onClick={() => onShare(hands[p.index])} title="Share this hand">
            Share
          </button>
        </div>
      ))}
    </div>
  );
}

/** Why the download buttons are missing: no HUDs while you play, review afterwards. */
export function RecordsLockedNote() {
  return (
    <span className="muted records-locked" title="So nobody can run a HUD (PokerTracker, Holdem Manager and the like) while playing">
      Downloads open once you leave your seat or the game stops. Replays are here any time.
    </span>
  );
}

/** Every line the table has logged (joins, host actions, chat, every hand), as text or CSV. */
export function FullLogDownload({ view, fmt }: { view: TableView; fmt: Fmt }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  if (view.recordsLocked)
    return (
      <div className="row wrap ledger-actions">
        <RecordsLockedNote />
      </div>
    );
  const get = async (kind: 'txt' | 'csv') => {
    setBusy(true);
    try {
      const { log, chat, hands } = await call<{ log: { at: number; text: string }[]; chat: TableView['chat']; hands: HandRecordView[] }>('table:fullLog');
      const lines = fullLogLines(log, chat, hands, view.me.playerId, fmt);
      const stem = `${fileStem(view.name)}-log`;
      if (kind === 'csv') download(`${stem}.csv`, fullLogCsv(lines), 'text/csv');
      else download(`${stem}.txt`, fullLogText(view.name, lines));
      setError('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="row wrap ledger-actions">
      <button disabled={busy} onClick={() => void get('txt')} title="Joins, host actions, chat and every hand">
        Download full log
      </button>
      <button disabled={busy} onClick={() => void get('csv')}>
        CSV
      </button>
      {error && <span className="error">{error}</span>}
    </div>
  );
}

/** Hold'em and Omaha hands as an Open Hand History file for PokerTracker, Holdem Manager and friends. */
export function ohhDownload(view: TableView, hands: HandRecordView[]): string | null {
  const { text, count } = ohhFile(hands, { tableName: view.name, centsMode: view.settings.stakes.centsMode, seatCount: view.seats.length, myId: view.me.playerId, tournamentId: view.tournamentId });
  if (!count) return 'There are no Hold’em or Omaha hands to export yet.';
  download(`${fileStem(view.name)}-hands.ohh`, text, 'application/json');
  return null;
}

/** A shared hand link (/h/:id): the replayer on its own, for anyone. */
export function SharedHandPage({ id }: { id: string }) {
  const [data, setData] = useState<SharedHandView | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    fetch(`/api/shared/${encodeURIComponent(id)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status === 404 ? 'This hand isn’t shared any more, or the link is wrong.' : 'Couldn’t load the hand.'))))
      .then(setData, (e: Error) => setError(e.message));
  }, [id]);
  const fmt = useMemo(() => chipFormat(!!data?.centsMode), [data?.centsMode]);
  if (error || !data)
    return (
      <main className="home">
        <h1 className="logo">
          RSDP Poker <span>Live!</span>
        </h1>
        <p className={error ? 'error' : 'muted'}>{error || 'Loading the hand…'}</p>
        <a href="/">Start your own table</a>
      </main>
    );
  return (
    <main className="home shared-hand">
      <h1 className="logo">
        RSDP Poker <span>Live!</span>
      </h1>
      <p className="tagline">
        {data.sharedBy || 'A player'} shared hand #{data.hand.handNumber} from {data.tableName}.
      </p>
      <Replayer
        hands={[data.hand]}
        start={0}
        tableName={data.tableName}
        seatCount={Math.max(data.seatCount, ...data.hand.seats.map((s) => s.seat + 1))}
        myId={sharedHandViewer(data)}
        felt={(data.felt ?? undefined) as TableView['settings']['table']['felt']}
        fmt={fmt}
        onClose={() => (location.href = '/')}
      />
    </main>
  );
}

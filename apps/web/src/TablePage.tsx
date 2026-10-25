import { useEffect, useMemo, useRef, useState } from 'react';
import { getVariant } from '@rsdp/engine/variants';
import type { SeatView, TableView } from '@rsdp/engine/wire';
import { call, socket } from './socket';
import { isMuted, setMuted, sounds } from './sound';
import { chipFormat, clock, gameLabel, stakesLabel } from './format';
import { Table, useNow } from './components/Table';
import { ActionBar } from './components/ActionBar';
import { HostPanel } from './components/HostPanel';
import { SidePanel } from './components/SidePanel';
import { PlayerDialog, RebuyDialog, SeatDialog } from './components/SeatDialog';
import { SettingsDialog } from './components/SettingsDialog';
import { RulesDialog } from './components/RulesDialog';
import { TableStrip } from './tournament/TableStrip';
import { navigate, tournamentOfTable, useFollowSeat } from './tournament/hooks';

/** Plays sounds and flashes the tab title for what changed between two views. */
function useTableEffects(view: TableView | null) {
  const prev = useRef<TableView | null>(null);
  useEffect(() => {
    const before = prev.current;
    prev.current = view;
    if (!view || !before) return;
    const hand = view.hand;
    if (!hand) return;
    const fresh = hand.handNumber !== before.hand?.handNumber;
    const seen = fresh ? -1 : (before.hand?.events.at(-1)?.seq ?? -1);
    const events = hand.events.filter((e) => e.seq > seen);
    if (events.some((e) => e.t === 'deal' || e.t === 'board')) sounds.deal();
    for (const e of events) {
      if (e.t === 'action') {
        if (e.action === 'fold') sounds.fold();
        else if (e.action === 'check') sounds.check();
        else sounds.chips();
      }
    }
    const won = hand.phase === 'complete' && before.hand?.phase !== 'complete';
    if (won && view.me.seat !== null && hand.awards.some((a) => a.seat === view.me.seat)) sounds.win();
    const myTurn = !!view.legal || !!view.canDraw || view.canVoteRunItTwice;
    const wasMyTurn = !!before.legal || !!before.canDraw || before.canVoteRunItTwice;
    if (myTurn && !wasMyTurn) sounds.turn();
  }, [view]);

  // Flash the tab title while it's your turn and the tab is in the background.
  const myTurn = !!view?.legal || !!view?.canDraw || !!view?.canVoteRunItTwice;
  useEffect(() => {
    if (!myTurn) return;
    const original = document.title;
    let on = false;
    const t = setInterval(() => {
      if (document.hidden) {
        on = !on;
        document.title = on ? '▶ Your turn!' : original;
      } else document.title = original;
    }, 800);
    return () => {
      clearInterval(t);
      document.title = original;
    };
  }, [myTurn]);
}

type Dialog = { kind: 'seat'; seat: number } | { kind: 'player'; seat: SeatView } | { kind: 'rebuy' } | { kind: 'settings' } | { kind: 'rules' } | null;

export function TablePage({ tableId }: { tableId: string }) {
  const [view, setView] = useState<TableView | null>(null);
  const [skew, setSkew] = useState(0);
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [copied, setCopied] = useState(false);
  const [connected, setConnected] = useState(socket.connected);
  const [muted, setMutedState] = useState(isMuted);
  const [discard, setDiscard] = useState<number[]>([]);
  useTableEffects(view);
  const readyTable = useFollowSeat(tableId, view?.me.seat != null);

  useEffect(() => {
    const join = () => call('table:join', { tableId }).catch((e: Error) => setError(e.message));
    const onState = (v: TableView) => {
      if (v.id !== tableId) return;
      setView(v);
      setSkew(v.serverNow - Date.now());
    };
    const onConnect = () => {
      setConnected(true);
      join();
    };
    const onDisconnect = () => setConnected(false);
    socket.on('table:state', onState);
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    if (socket.connected) join();
    return () => {
      socket.off('table:state', onState);
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.emit('table:leave');
    };
  }, [tableId]);

  // The discard pick is for one draw only.
  const drawKey = view?.canDraw ? `${view.hand?.handNumber}:${view.hand?.street}` : '';
  useEffect(() => setDiscard([]), [drawKey]);

  const fmt = useMemo(() => chipFormat(!!view?.settings.stakes.centsMode), [view?.settings.stakes.centsMode]);
  const now = useNow(!!view?.level?.endsAt, 1000) + skew;

  if (error) {
    // A tournament table closes when it breaks; the lobby knows the new seat.
    const tournament = error === 'table not found' ? tournamentOfTable(tableId) : null;
    return (
      <main className="home">
        <h1 className="logo">
          RSDP Poker <span>Live!</span>
        </h1>
        <p className="error">{error === 'table not found' ? 'This table has closed or the link is wrong.' : error}</p>
        {tournament && (
          <p>
            <a href={`/tn/${tournament}`}>Back to the tournament lobby</a>
          </p>
        )}
        <a href="/">Start a new table</a>
      </main>
    );
  }
  if (!view) return <main className="home">Connecting…</main>;

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      prompt('Copy this link', location.href);
    }
  };

  const cash = view.mode === 'cash';
  const mySeat = view.me.seat !== null ? view.seats[view.me.seat] : null;
  const seatRequest = view.requests.find((r) => r.playerId === view.me.playerId && r.kind === 'seat');
  const rebuyRequest = view.requests.find((r) => r.playerId === view.me.playerId && r.kind === 'rebuy');
  const pending = view.isHost ? view.requests.length : 0;
  const handLive = !!view.hand && view.hand.phase !== 'complete';
  const inHand = !!mySeat?.inHand && handLive;
  const canRebuy = cash && !!mySeat && view.settings.seating.allowRebuys;

  const game = view.hand
    ? { label: gameLabel(view.hand.gameId, view.hand.betting), stakes: stakesLabel(view.hand.stakes, view.hand.family, view.hand.betting, fmt) }
    : view.upcoming
      ? {
          label: gameLabel(view.upcoming.gameId, view.upcoming.betting),
          stakes: stakesLabel(view.upcoming.stakes, gameFamily(view.upcoming.gameId), view.upcoming.betting, fmt),
        }
      : null;
  const level = view.level;
  const levelText = level
    ? `Level ${level.index + 1}/${level.count}${level.endsAt ? ` · ${clock(level.endsAt - now)}` : level.handsLeft !== null ? ` · ${level.handsLeft} hands` : ''}`
    : null;
  // Straddles need blinds, so stud tables never offer them.
  const nextFamily = view.hand?.family ?? (view.upcoming ? gameFamily(view.upcoming.gameId) : 'flop');
  const straddleOn = cash && view.settings.play.straddle !== 'off' && nextFamily !== 'stud';

  return (
    <div className="table-page">
      <header className="topbar">
        <a className="logo small" href="/">
          RSDP Poker <span>Live!</span>
        </a>
        <span className="stakes">
          <b>{view.name}</b>
          {game && (
            <>
              {' '}
              · {game.label} {game.stakes}
            </>
          )}
          {levelText && <> · {levelText}</>}
          {view.paused && <b className="paused"> · Paused</b>}
        </span>
        <button onClick={() => setDialog({ kind: 'rules' })}>Rules</button>
        <button onClick={copyLink}>{copied ? 'Copied!' : 'Invite'}</button>
        <button
          title={muted ? 'Sound off' : 'Sound on'}
          onClick={() => {
            setMuted(!muted);
            setMutedState(!muted);
          }}
        >
          {muted ? '🔇' : '🔊'}
        </button>
        {mySeat && (
          <>
            {canRebuy && <button onClick={() => setDialog({ kind: 'rebuy' })}>Add chips</button>}
            <button onClick={() => call('seat:sitOut', { value: !mySeat.sittingOut })}>{mySeat.sittingOut ? "I'm back" : 'Sit out'}</button>
            {cash && (
              <button
                onClick={() =>
                  confirm(inHand ? 'Leave your seat when this hand ends?' : 'Leave your seat?') && socket.emit('seat:stand', { afterHand: inHand })
                }
              >
                {mySeat.leaving ? 'Leaving…' : 'Leave'}
              </button>
            )}
          </>
        )}
      </header>

      {!connected && <div className="banner warn">Connection lost. Reconnecting…</div>}

      <div className="layout">
        <section className="felt-area">
          {view.tournamentId && <TableStrip tournamentId={view.tournamentId} tableId={tableId} seatedHere={view.me.seat !== null} />}
          {readyTable && (
            <div className="banner attention">
              Your tournament table is ready.{' '}
              <a
                href={`/t/${readyTable}`}
                onClick={(e) => {
                  e.preventDefault();
                  navigate(`/t/${readyTable}`);
                }}
              >
                Go to it
              </a>
            </div>
          )}
          {cash && !view.started && (
            <div className="banner">
              {view.isHost ? 'Take a seat, send friends the invite link, then press Start game.' : 'Waiting for the host to start the game.'}
            </div>
          )}
          {view.stopAfterHand && <div className="banner">The host is stopping the game after this hand.</div>}
          {pending > 0 && (
            <div className="banner attention">
              {pending} {pending === 1 ? 'request is' : 'requests are'} waiting for you. See Host controls.
            </div>
          )}
          {seatRequest && (
            <div className="banner">
              Waiting for the host to let you sit…{' '}
              <button onClick={() => socket.emit('seat:cancel')}>Cancel</button>
            </div>
          )}
          {rebuyRequest && <div className="banner">Waiting for the host to approve your {fmt(rebuyRequest.amount)} rebuy…</div>}
          {mySeat?.sittingOut && (
            <div className="banner">
              {mySeat.sitOutReason === 'busted'
                ? "You're out of chips."
                : mySeat.sitOutReason === 'timeouts'
                  ? 'You were marked away after running out of time.'
                  : mySeat.sitOutReason === 'host'
                    ? 'The host sat you out.'
                    : "You're sitting out."}
              {mySeat.owesBlinds && ' You will post the blinds you missed when you come back.'}{' '}
              {mySeat.sitOutReason === 'busted' && canRebuy ? (
                <button className="primary" onClick={() => setDialog({ kind: 'rebuy' })}>
                  Add chips
                </button>
              ) : (
                mySeat.stack > 0 && (
                  <button className="primary" onClick={() => call('seat:sitOut', { value: false })}>
                    I'm back
                  </button>
                )
              )}
            </div>
          )}
          <Table
            view={view}
            skew={skew}
            fmt={fmt}
            onPickSeat={cash && !mySeat && !seatRequest ? (seat) => setDialog({ kind: 'seat', seat }) : undefined}
            onSeatClick={view.isHost && cash ? (seat) => setDialog({ kind: 'player', seat }) : undefined}
            discard={view.canDraw ? { selected: discard, toggle: (i) => setDiscard((d) => (d.includes(i) ? d.filter((x) => x !== i) : [...d, i])) } : null}
          />
          <ActionBar view={view} fmt={fmt} skew={skew} discard={discard} clearDiscard={() => setDiscard([])} />
          {mySeat && cash && (
            <div className="seat-options">
              {straddleOn && (
                <label className="toggle">
                  <input type="checkbox" checked={mySeat.straddle} onChange={(e) => call('seat:prefs', { straddle: e.target.checked })} />
                  Straddle when I'm under the gun
                </label>
              )}
              {mySeat.waiting && (
                <label className="toggle">
                  <input type="checkbox" checked={mySeat.waitForBigBlind} onChange={(e) => call('seat:prefs', { waitForBigBlind: e.target.checked })} />
                  Wait for the big blind
                </label>
              )}
            </div>
          )}
        </section>
        <aside className="side">
          {view.isHost && cash && <HostPanel view={view} fmt={fmt} onSettings={() => setDialog({ kind: 'settings' })} />}
          <SidePanel view={view} fmt={fmt} />
        </aside>
      </div>

      {dialog?.kind === 'seat' && <SeatDialog view={view} seat={dialog.seat} fmt={fmt} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'player' && <PlayerDialog view={view} seat={dialog.seat} fmt={fmt} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'rebuy' && <RebuyDialog view={view} fmt={fmt} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'settings' && <SettingsDialog view={view} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'rules' && <RulesDialog view={view} onClose={() => setDialog(null)} />}
    </div>
  );
}

function gameFamily(gameId: string) {
  try {
    return getVariant(gameId).family;
  } catch {
    return 'flop';
  }
}

import { useEffect, useRef, useState } from 'react';
import type { RoomView } from '@rsdp/engine';
import { socket } from './socket';
import { isMuted, setMuted, sounds } from './sound';
import { Table } from './components/Table';
import { ActionBar } from './components/ActionBar';
import { HostPanel } from './components/HostPanel';
import { SidePanel } from './components/SidePanel';
import { SeatDialog } from './components/SeatDialog';

/** Plays sounds and flashes the tab title for what changed between two views. */
function useTableEffects(view: RoomView | null) {
  const prev = useRef<RoomView | null>(null);
  useEffect(() => {
    const before = prev.current;
    prev.current = view;
    if (!view || !before) return;

    if (view.hand && view.hand.number !== before.hand?.number) sounds.deal();
    else if (view.hand && before.hand && view.hand.board.length > before.hand.board.length) sounds.deal();

    for (const line of view.log.slice(before.log.length === 0 ? view.log.length : -(view.log.length - before.log.length) || view.log.length)) {
      if (/ (calls|bets|raises) /.test(line)) sounds.chips();
      else if (/ checks$/.test(line)) sounds.check();
      else if (/ folds$/.test(line)) sounds.fold();
    }
    const won = view.hand?.street === 'complete' && before.hand?.street !== 'complete';
    if (won && view.hand!.results.some((r) => r.winners.some((w) => w.playerId === view.you.playerId))) sounds.win();

    if (view.you.legal && !before.you.legal) sounds.turn();
  }, [view]);

  // Flash the tab title while it's your turn and the tab is in the background.
  const myTurn = !!view?.you.legal;
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

export function TablePage({ roomId }: { roomId: string }) {
  const [view, setView] = useState<RoomView | null>(null);
  const [error, setError] = useState('');
  const [seatPick, setSeatPick] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [connected, setConnected] = useState(socket.connected);
  const [muted, setMutedState] = useState(isMuted);
  useTableEffects(view);

  useEffect(() => {
    const join = () =>
      socket.emit('room:join', { roomId }, (res) => {
        if (!res.ok) setError(res.error);
      });
    const onConnect = () => {
      setConnected(true);
      join();
    };
    const onDisconnect = () => setConnected(false);
    socket.on('room:state', setView);
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    if (socket.connected) join();
    return () => {
      socket.off('room:state', setView);
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
    };
  }, [roomId]);

  if (error) {
    return (
      <main className="home">
        <h1 className="logo">
          RSDP Poker <span>Live!</span>
        </h1>
        <p className="error">{error === 'table not found' ? 'This table has closed or the link is wrong.' : error}</p>
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

  const seated = view.you.seat !== -1;
  const mySeat = seated ? view.seats[view.you.seat]! : null;
  const myRequest = view.requests.find((r) => r.playerId === view.you.playerId);
  const pending = view.isHost ? view.requests.length : 0;

  return (
    <div className="table-page">
      <header className="topbar">
        <a className="logo small" href="/">
          RSDP Poker <span>Live!</span>
        </a>
        <span className="stakes">
          NLH {view.config.smallBlind}/{view.config.bigBlind}
          {view.paused && <b className="paused"> · Paused</b>}
        </span>
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
            <button onClick={() => socket.emit('player:sitOut', { value: !mySeat.sittingOut })}>
              {mySeat.sittingOut ? "I'm back" : 'Sit out'}
            </button>
            <button onClick={() => confirm('Leave your seat?') && socket.emit('player:stand')}>Leave</button>
          </>
        )}
      </header>

      {!connected && <div className="banner warn">Connection lost. Reconnecting…</div>}

      <div className="layout">
        <section className="felt-area">
          {!view.running && (
            <div className="banner">
              {view.isHost
                ? 'Take a seat, send friends the invite link, then press Start game.'
                : 'Waiting for the host to start the game.'}
            </div>
          )}
          {view.isHost && pending > 0 && (
            <div className="banner attention">
              {pending} {pending === 1 ? 'player is' : 'players are'} waiting for a seat. See Host controls.
            </div>
          )}
          {myRequest && (
            <div className="banner">
              Waiting for the host to approve your seat…{' '}
              <button onClick={() => socket.emit('seat:cancel')}>Cancel</button>
            </div>
          )}
          {mySeat?.sittingOut && view.running && (
            <div className="banner">
              You're sitting out.{' '}
              <button className="primary" onClick={() => socket.emit('player:sitOut', { value: false })}>
                I'm back
              </button>
            </div>
          )}
          <Table view={view} onPickSeat={seated || myRequest ? undefined : setSeatPick} />
          <ActionBar view={view} />
        </section>
        <aside className="side">
          {view.isHost && <HostPanel view={view} />}
          <SidePanel view={view} />
        </aside>
      </div>

      {seatPick !== null && (
        <SeatDialog seat={seatPick} bigBlind={view.config.bigBlind} onClose={() => setSeatPick(null)} />
      )}
    </div>
  );
}

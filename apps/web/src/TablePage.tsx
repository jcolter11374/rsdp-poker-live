import { useEffect, useState } from 'react';
import type { RoomView } from '@rsdp/engine';
import { socket } from './socket';
import { Table } from './components/Table';
import { ActionBar } from './components/ActionBar';
import { HostPanel } from './components/HostPanel';
import { SidePanel } from './components/SidePanel';
import { SeatDialog } from './components/SeatDialog';

export function TablePage({ roomId }: { roomId: string }) {
  const [view, setView] = useState<RoomView | null>(null);
  const [error, setError] = useState('');
  const [seatPick, setSeatPick] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const join = () =>
      socket.emit('room:join', { roomId }, (res) => {
        if (!res.ok) setError(res.error);
      });
    socket.on('room:state', setView);
    socket.on('connect', join);
    if (socket.connected) join();
    return () => {
      socket.off('room:state', setView);
      socket.off('connect', join);
    };
  }, [roomId]);

  if (error) {
    return (
      <main className="home">
        <h1 className="logo">
          RSDP Poker <span>Live!</span>
        </h1>
        <p className="error">{error}</p>
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
  const myRequest = view.requests.find((r) => r.playerId === view.you.playerId);

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
        <button onClick={copyLink}>{copied ? 'Copied!' : 'Copy invite link'}</button>
        {seated && (
          <>
            <button onClick={() => socket.emit('player:sitOut', { value: !view.seats[view.you.seat]!.sittingOut })}>
              {view.seats[view.you.seat]!.sittingOut ? "I'm back" : 'Sit out'}
            </button>
            <button onClick={() => confirm('Leave your seat?') && socket.emit('player:stand')}>Stand up</button>
          </>
        )}
      </header>

      <div className="layout">
        <section className="felt-area">
          {!view.running && (
            <div className="banner">
              {view.isHost
                ? 'Take a seat, share the invite link, then press Start game.'
                : 'Waiting for the host to start the game.'}
            </div>
          )}
          {myRequest && (
            <div className="banner">
              Waiting for the host to approve your seat…{' '}
              <button onClick={() => socket.emit('seat:cancel')}>Cancel</button>
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

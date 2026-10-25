import { useState } from 'react';
import type { TableView } from '@rsdp/engine/wire';
import { call, socket } from '../socket';
import type { Fmt } from '../format';

export function HostPanel({ view, fmt, onSettings }: { view: TableView; fmt: Fmt; onSettings: () => void }) {
  const [msg, setMsg] = useState('');
  const run = (p: Promise<unknown>, okText = '') => p.then(() => setMsg(okText)).catch((e: Error) => setMsg(e.message));
  const handLive = !!view.hand && view.hand.phase !== 'complete';
  const tournament = view.mode === 'tournament';
  const canDeal = view.started && !handLive && !view.paused && !view.settings.timing.autoStartNextHand;
  const seated = view.seats.filter(Boolean).length;
  const held = new Set([...view.offers.map((o) => o.seat), ...view.requests.filter((r) => r.kind === 'seat').map((r) => r.seat)]);
  /** Open seats a seat request could go to instead of the one asked for. */
  const otherSeats = (asked: number | null) => view.seats.flatMap((s, i) => (s || (held.has(i) && i !== asked) ? [] : [i]));

  return (
    <div className="panel host-panel">
      <h3>Host controls</h3>
      {view.requests.length > 0 && (
        <div className="requests">
          {view.requests.map((r) => (
            <div className="request" key={r.id}>
              <span>
                <b>{r.name}</b> {r.kind === 'seat' ? `wants seat ${(r.seat ?? 0) + 1} with ${fmt(r.amount)}` : `wants to add ${fmt(r.amount)}`}
              </span>
              <button className="primary" onClick={() => run(call('host:approve', { requestId: r.id }))}>
                Approve
              </button>
              {r.kind === 'seat' && otherSeats(r.seat).length > 1 && (
                <select
                  value=""
                  title="Approve into another seat"
                  onChange={(e) => e.target.value !== '' && run(call('host:approve', { requestId: r.id, seat: Number(e.target.value) }))}
                >
                  <option value="">Seat…</option>
                  {otherSeats(r.seat).map((i) => (
                    <option key={i} value={i}>
                      Seat {i + 1}
                    </option>
                  ))}
                </select>
              )}
              <button onClick={() => socket.emit('host:reject', { requestId: r.id })}>Reject</button>
            </div>
          ))}
        </div>
      )}
      {!tournament && (
        <div className="row wrap">
          {!view.started ? (
            <button className="primary" onClick={() => run(call('host:start'))}>
              Start game
            </button>
          ) : (
            <button onClick={() => run(call('host:stop'), handLive ? 'The game stops after this hand.' : '')} disabled={view.stopAfterHand}>
              {view.stopAfterHand ? 'Stopping after this hand' : 'Stop game'}
            </button>
          )}
          {view.started && (
            <button onClick={() => run(call('host:pause', { value: !view.paused }))}>{view.paused ? 'Resume' : 'Pause'}</button>
          )}
          <button
            className={view.bombPotNext ? 'primary' : ''}
            title="Everyone posts the bomb pot amount and the flop comes straight away"
            onClick={() => run(call('host:bombPot', { value: !view.bombPotNext }))}
          >
            {view.bombPotNext ? 'Bomb pot next hand ✓' : 'Bomb pot next hand'}
          </button>
          {canDeal && (
            <button className="primary" onClick={() => run(call('host:deal'))}>
              Deal next hand
            </button>
          )}
        </div>
      )}
      {!tournament && (view.waitlist.length > 0 || view.settings.seating.waitlist) && (
        <div className="waitlist">
          <b>Waitlist</b>
          {view.waitlist.length === 0 ? (
            <span className="muted"> · nobody waiting</span>
          ) : (
            <ol>
              {view.waitlist.map((w) => {
                const offer = view.offers.find((o) => o.playerId === w.playerId);
                return (
                  <li key={w.playerId}>
                    {w.name}
                    {offer && <span className="muted"> · seat {offer.seat + 1} held</span>}{' '}
                    <button className="link" title="Take off the waitlist" onClick={() => run(call('host:kick', { playerId: w.playerId }))}>
                      ✕
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      )}
      {!tournament && !handLive && seated >= 2 && (
        <button
          title="Reseat everyone at random between hands; the button is drawn again and missed blinds are forgiven"
          onClick={() => confirm('Shuffle everyone into random seats?') && run(call('host:shuffle'), 'Seats shuffled.')}
        >
          Shuffle seats
        </button>
      )}
      <button onClick={onSettings}>Table settings</button>
      {view.pendingSettings && <p className="muted">Some setting changes take effect when this hand ends.</p>}
      {msg && <p className="muted">{msg}</p>}
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { playerOptions, standings, summarize, tableAddress, type Command } from '@rsdp/tournament';
import { tournamentClient } from './client';
import { blinds, chips, countdown, ordinal } from './format';
import { followMissedMove, navigate, useNow, useSession, useTournament } from './hooks';

/**
 * The tournament above a tournament table: level, blinds and clock, how many
 * are left, and the player's own rebuy and add-on choices. Points the player
 * to their seat when it is at another table than `tableId`, the one on screen.
 */
export function TableStrip({ tournamentId, tableId, seatedHere }: { tournamentId: string; tableId: string; seatedHere: boolean }) {
  const { state, skew } = useTournament(tournamentId);
  const session = useSession();
  const now = useNow(500) + skew;
  const [error, setError] = useState('');
  const o = state && session ? playerOptions(state, session.playerId) : null;
  const seat = o?.entry?.status === 'seated' && o.entry.tableId ? tableAddress(o.entry.tableId) : null;
  // A tab that was away when the player was moved (a dropped socket) never got
  // table:moved; the tournament state still says where the seat went.
  const wasHere = useRef(false);
  useEffect(() => {
    if (seat === tableId) wasHere.current = true;
    else if (followMissedMove(seat, tableId, wasHere.current, seatedHere)) navigate(`/t/${seat}`);
  }, [seat, tableId, seatedHere]);
  if (!state) return null;

  const sum = summarize(state, now);
  const me = session?.playerId ?? '';
  const send = (command: Command) => {
    setError('');
    tournamentClient()
      .send(tournamentId, command)
      .catch((e: Error) => setError(e.message.charAt(0).toUpperCase() + e.message.slice(1)));
  };
  const lobby = (
    <a
      href={`/tn/${tournamentId}`}
      onClick={(e) => {
        e.preventDefault();
        navigate(`/tn/${tournamentId}`);
      }}
    >
      Lobby
    </a>
  );

  const c = sum.clock;
  const place = o?.entry && !['registered', 'seated', 'rebuy-offer'].includes(o.entry.status) ? standings(state).find((s) => s.entryId === o.entry!.id)?.place : null;
  const winner = state.status === 'finished' ? standings(state).find((s) => s.place === 1) : null;
  const seatTable = seat && seat !== tableId ? state.tables.findIndex((t) => tableAddress(t.id) === seat) + 1 : 0;

  return (
    <div className="tn-strip">
      <div className="tn-strip-row">
        <b>{state.settings.name}</b>
        {c ? (
          <>
            <span>
              {c.onBreak ? 'Break' : `Level ${c.levelNumber}`} · {c.msLeft === null ? '∞' : countdown(c.msLeft)}
              {state.status === 'paused' ? ' · paused' : ''}
            </span>
            <span>{c.onBreak ? `Next ${blinds(c.level)}` : blinds(c.level)}</span>
            {!c.onBreak && c.nextLevel && <span className="muted">Next {blinds(c.nextLevel)}</span>}
            {sum.handForHand && <span className="tn-tag tn-tag-warn">hand for hand</span>}
          </>
        ) : sum.msToStart !== null ? (
          <span>Cards in the air in {countdown(sum.msToStart)}</span>
        ) : null}
        {winner ? (
          <span>🏆 {winner.displayName} wins</span>
        ) : (
          <span className="muted">
            {sum.playersLeft} of {sum.entrants} left · avg {chips(sum.averageStack)}
          </span>
        )}
        {lobby}
      </div>
      {seatTable > 0 && (
        <div className="tn-strip-row tn-alert">
          You're at Table {seatTable}.
          <a
            href={`/t/${seat}`}
            onClick={(e) => {
              e.preventDefault();
              navigate(`/t/${seat}`);
            }}
          >
            Go to my table
          </a>
        </div>
      )}
      {o?.entry?.status === 'rebuy-offer' && (
        <div className="tn-strip-row tn-alert">
          You're out of chips. Rebuy for {chips(state.settings.rebuy.chips)}? {countdown((o.entry.rebuyOfferExpiresAt ?? now) - now)}
          {o.canRebuy && (
            <button className="primary" onClick={() => send({ type: 'rebuy', playerId: me })}>
              Rebuy
            </button>
          )}
          {o.canDeclineRebuy && <button onClick={() => send({ type: 'declineRebuy', playerId: me })}>No thanks</button>}
        </div>
      )}
      {o?.canAddOn && (
        <div className="tn-strip-row">
          Add-ons are open.
          <button className="primary" onClick={() => send({ type: 'addOn', playerId: me })}>
            Add on {chips(state.settings.addOn.chips)}
          </button>
        </div>
      )}
      {o?.canReEnter && (
        <div className="tn-strip-row">
          You can re-enter.
          <button className="primary" onClick={() => send({ type: 'reEnter', playerId: me })}>
            Re-enter
          </button>
        </div>
      )}
      {o?.pending.map((r) => (
        <div className="tn-strip-row muted" key={r.id}>
          Waiting for the host to approve your {r.kind === 'add-on' ? 'add-on' : r.kind}.
        </div>
      ))}
      {place != null && !winner && <div className="tn-strip-row">You finished {ordinal(place)}.</div>}
      {error && <div className="tn-strip-row error">{error}</div>}
    </div>
  );
}

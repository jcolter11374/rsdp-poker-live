import { useState } from 'react';
import { playerOptions, standings, summarize, type Command } from '@rsdp/tournament';
import { tournamentClient } from './client';
import { blinds, chips, countdown, ordinal } from './format';
import { navigate, useNow, useSession, useTournament } from './hooks';

/**
 * The tournament above a tournament table: level, blinds and clock, how many
 * are left, and the player's own rebuy and add-on choices.
 */
export function TableStrip({ tournamentId }: { tournamentId: string }) {
  const { state, skew } = useTournament(tournamentId);
  const session = useSession();
  const now = useNow(500) + skew;
  const [error, setError] = useState('');
  if (!state) return null;

  const sum = summarize(state, now);
  const o = session ? playerOptions(state, session.playerId) : null;
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

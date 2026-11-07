import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { playerOptions, standings, summarize, tableAddress, type Command } from '@rsdp/tournament';
import { tournamentClient } from './client';
import { blinds, chips, countdown, ordinal } from './format';
import { followMissedMove, navigate, useHeld, useNow, useSession, useTournament } from './hooks';

/**
 * The tournament above a tournament table: level, blinds and clock, how many
 * are left, and the player's own rebuy and add-on choices. Points the player
 * to their seat when it is at another table than `tableId`, the one on screen.
 *
 * With `corner` (the wide layout), the level, clock, blinds and players left sit in a box in the bottom-right corner,
 * across from the chat, so they take no height from the table (#385). The rows that ask something of the player (a
 * rebuy offer, an add-on, your seat at another table) go into `asksIn`, a spot in the area under the table with the
 * other notes about you, and only while there is one. That area holds its height (Dock), so an ask coming or going
 * doesn't move the table: above the felt, a rebuy offer or an add-on break starting or ending slid every seat, often
 * as the next hand was dealt (#388 moved the cash tables' notes the same way).
 */
export function TableStrip({
  tournamentId,
  tableId,
  seatedHere,
  keptHere = false,
  emptyHere = false,
  holding = false,
  corner = false,
  asksIn = null,
}: {
  tournamentId: string;
  tableId: string;
  seatedHere: boolean;
  /**
   * The player was knocked out here and their seat still shows, marked out, until the next deal: above the table (not in
   * the corner box), "You finished" waits for it to go, so the felt doesn't move down as the result shows (#445).
   */
  keptHere?: boolean;
  /** Nobody is seated at the table on screen (the server's view, not the seats kept for a knocked-out player). */
  emptyHere?: boolean;
  holding?: boolean;
  corner?: boolean;
  /** With `corner`: where the asks go (TablePage's spot for them under the table). Until it exists they wait. */
  asksIn?: HTMLElement | null;
}) {
  const { state: latest, skew } = useTournament(tournamentId);
  // While an all-in runout is dealt here the strip stays as it was: places, rebuy offers and moves are the result.
  const state = useHeld(latest, holding);
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

  // A finished event's clock stopped at its last hand: the winner says it all, without a level and blinds (#446).
  const c = state.status === 'finished' ? null : sum.clock;
  const place = o?.entry && !['registered', 'seated', 'rebuy-offer'].includes(o.entry.status) ? standings(state).find((s) => s.entryId === o.entry!.id)?.place : null;
  const winner = state.status === 'finished' ? standings(state).find((s) => s.place === 1) : null;
  const seatTable = seat && seat !== tableId ? state.tables.findIndex((t) => tableAddress(t.id) === seat) + 1 : 0;

  const paused = state.status === 'paused';
  const finished = place != null && !winner && <div className="tn-strip-row">You finished {ordinal(place)}.</div>;
  // A table that broke: its players were moved and told, but someone only watching it would see the last hand stay
  // there for good (#446). Only once it is empty: a table opened while this page's tournament state is a moment old
  // has players.
  const closedHere =
    emptyHere && (state.status === 'running' || state.status === 'paused') && !state.tables.some((t) => tableAddress(t.id) === tableId) && (
      <div className="tn-strip-row" role="status">
        This table has closed. Play goes on at the other {state.tables.length === 1 ? 'table' : 'tables'}.
      </div>
    );
  const asks = (
    <>
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
    </>
  );

  if (corner) {
    const asking = seatTable > 0 || o?.entry?.status === 'rebuy-offer' || !!o?.canAddOn || !!o?.canReEnter || !!o?.pending.length;
    // An error stays until the next command, and once its ask has gone there may be no next one: it shows under the asks
    // while there are some, and in the corner box after, so it never keeps a row of its own under the table.
    const errorRow = error && <div className="tn-strip-row error">{error}</div>;
    return (
      <>
        {asking &&
          asksIn &&
          createPortal(
            <div className="tn-strip">
              {asks}
              {errorRow}
            </div>,
            asksIn,
          )}
        <div className="tn-corner panel">
          <div className="tn-corner-head">
            <b>{state.settings.name}</b>
            {lobby}
          </div>
          {c ? (
            <div className="tn-corner-now">
              <div className="tn-corner-clock">
                <span>{c.onBreak ? 'Break' : `Level ${c.levelNumber}`}</span>
                <b>{c.msLeft === null ? '∞' : countdown(c.msLeft)}</b>
                {paused && <span className="paused">paused</span>}
              </div>
              <div className="tn-corner-row">
                <span>{c.onBreak ? `Next ${blinds(c.level)}` : blinds(c.level)}</span>
                {!c.onBreak && c.nextLevel && <span className="muted">Next {blinds(c.nextLevel)}</span>}
                {sum.handForHand && <span className="tn-tag tn-tag-warn">hand for hand</span>}
              </div>
            </div>
          ) : sum.msToStart !== null ? (
            <div className="tn-corner-row">Cards in the air in {countdown(sum.msToStart)}</div>
          ) : null}
          <div className="tn-corner-row">
            {winner ? (
              <span>🏆 {winner.displayName} wins</span>
            ) : (
              <span className="muted">
                {sum.playersLeft} of {sum.entrants} left · avg {chips(sum.averageStack)}
              </span>
            )}
          </div>
          {finished}
          {closedHere}
          {!asking && errorRow}
        </div>
      </>
    );
  }

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
      {asks}
      {!keptHere && finished}
      {closedHere}
      {error && <div className="tn-strip-row error">{error}</div>}
    </div>
  );
}

import { useMemo, useState } from 'react';
import type { BettingKind } from '@rsdp/engine/core';
import type { SeatView, TableView } from '@rsdp/engine/wire';
import { gameTitle, getVariant } from '@rsdp/engine/variants';
import { call } from '../../socket';
import { Modal } from '../SeatDialog';
import { useNow } from '../Table';
import { choiceOf, comingSettings, leavingMenu } from '../settings/dealersChoice';
import { pickWait } from '../../announce';

/*
 * Dealer's choice at the table (D33): the Pick chip on the next chooser's seat, the line on the felt while they
 * pick, and the chooser's "Pick the next game" panel.
 */

/** Seconds left on a clock, or null. */
const secondsTo = (deadline: number | null | undefined, now: number) => (deadline == null ? null : Math.max(0, Math.ceil((deadline - now) / 1000)));

/**
 * I hold the Pick chip and may pick now. Not while a game rotation is coming instead: the host has switched the table
 * to one from the next hand (the two can't both be on), and a pick then would never be dealt.
 */
export const canPickNow = (view: TableView) => !!view.choice?.open && view.choice.chip !== null && view.choice.chip === view.me.seat && !view.rotation;

/** The table is waiting for my pick (its clock is running), so it calls me like a turn to act. */
export const myPickDue = (view: TableView) => canPickNow(view) && view.choice!.deadline !== null && !view.paused;

/** The Pick chip, on the nameplate of whoever picks the next game. */
export function PickTag({ view, seat }: { view: TableView; seat: SeatView }) {
  if (view.choice?.chip !== seat.seat) return null;
  return (
    <span className="tag pick-tag" title="Picks the next game (Dealer's choice)">
      Pick
    </span>
  );
}

/** Between hands while the table waits for a pick: who is picking, and the time left. In the "Next hand in" spot. */
export function ChoiceLine({ view, now }: { view: TableView; now: number }) {
  // A screen reader hears the same words as the line appears (announce.ts).
  const wait = pickWait(view);
  if (!wait) return null;
  return (
    <div className="next-hand choice-line">
      {wait.text}
      {view.paused ? '' : ` · ${secondsTo(view.choice!.deadline, now)}`}
    </div>
  );
}

/** Top bar: whose pick the game is, and how long it has left. */
export function choiceText(view: TableView): string | null {
  const c = view.choice;
  if (!c?.current) return null;
  const by = c.current.by ? `${c.current.by}'s pick` : null;
  const left = c.handsLeft === null ? null : c.handsLeft === 0 ? 'last hand' : `${c.handsLeft} more hand${c.handsLeft === 1 ? '' : 's'}`;
  return [by, left].filter(Boolean).join(' · ') || null;
}

/**
 * The chooser's panel: every game on the menu, with How to play for each (it opens on top), greyed out when it
 * seats fewer than are at the table, or when the host is taking it off the menu from the next hand (#441). Opens by itself when the table is waiting; during the last hand of a pick
 * the chooser opens it from the top bar.
 */
export function GamePicker({ view, skew, onClose, onRules }: { view: TableView; skew: number; onClose: () => void; onRules: (gameId: string, betting: BettingKind) => void }) {
  const c = view.choice;
  const now = useNow(!!c?.deadline && !view.paused, 250) + skew;
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const leaving = useMemo(() => leavingMenu(view.settings, view.pendingSettings), [view.settings, view.pendingSettings]);
  // How long the game picked now lasts: a change to it waiting for the next hand applies before the pick is dealt.
  const hands = useMemo(() => choiceOf(comingSettings(view.settings, view.pendingSettings)).hands, [view.settings, view.pendingSettings]);
  if (!c) return null;
  const menu = choiceOf(view.settings).games;
  const secs = view.paused ? secondsTo(c.deadline, view.serverNow) : secondsTo(c.deadline, now);
  const current = c.current;
  const pick = (index: number) => {
    setBusy(true);
    setError('');
    call('hand:chooseGame', { index, gameId: menu[index].gameId, betting: menu[index].betting, ...(view.hand ? { handNumber: view.hand.handNumber } : {}) })
      .then(onClose)
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };
  // The game being played (before the first pick, the one the table was dealing) can be kept: it's what a missed pick
  // deals, so the server's default points at it.
  // (Never one the host is taking off the menu, which the server wouldn't deal: #441.)
  const keepIndex = c.canKeep && menu[c.defaultIndex] && !leaving(menu[c.defaultIndex]) ? c.defaultIndex : -1;
  const keep = keepIndex >= 0 ? menu[keepIndex] : null;
  // What a missed pick deals: the server says (it can be a game the host's waiting change adds, #444); one from before
  // it did names the menu entry.
  const fallback = c.fallback ?? menu[c.defaultIndex];
  return (
    <Modal title="Pick the next game" onClose={onClose}>
      <div className="game-picker">
        <p className="muted">
          {c.deadline !== null
            ? `${secs} second${secs === 1 ? '' : 's'} left. `
            : 'You pick once this hand is over; you can choose now. '}
          {c.handsLeft === null && !current ? 'The first game' : 'Your game'} lasts {hands ? `${hands} hand${hands === 1 ? '' : 's'}` : 'one orbit'}
          {fallback ? `. If time runs out: ${gameTitle(fallback.gameId, fallback.betting)}.` : '.'}
        </p>
        {keep && (
          <button className="primary" disabled={busy} onClick={() => pick(keepIndex)}>
            Keep playing {gameTitle(keep.gameId, keep.betting)}
          </button>
        )}
        <ul className="game-picker-list">
          {menu.map((g, i) => {
            const seats = getVariant(g.gameId).maxPlayers;
            const fits = seats >= c.count;
            const off = leaving(g);
            const can = fits && !off;
            const title = gameTitle(g.gameId, g.betting);
            return (
              <li key={`${g.gameId}/${g.betting}`} className={can ? '' : 'greyed'}>
                <button className="game-picker-pick" disabled={busy || !can} onClick={() => pick(i)} aria-describedby={can ? undefined : `pick-why-${i}`}>
                  {title}
                </button>
                {!can && (
                  <span className="muted" id={`pick-why-${i}`}>
                    {off ? 'The host is taking it off the menu' : `Seats ${seats} · ${c.count} are sitting down`}
                  </span>
                )}
                <button type="button" className="link" onClick={() => onRules(g.gameId, g.betting)} aria-label={`How to play ${title}`}>
                  How to play
                </button>
              </li>
            );
          })}
        </ul>
        {error && <p className="error" role="alert">{error}</p>}
        <button onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}

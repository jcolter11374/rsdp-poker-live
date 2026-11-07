import type { ReactNode } from 'react';
import type { BettingKind } from '@rsdp/engine/core';
import { getVariant } from '@rsdp/engine/variants';
import type { TableView } from '@rsdp/engine/wire';
import { stakesLabel, type Fmt } from '../../format';
import { gameName, type GameName } from './gameChange';
import './gameline.css';

/*
 * The top bar at a table whose game changes (#305, #373): the game first, in bigger type; how long it has left and
 * the game after it, picked out; then the stakes and the table in small type.
 */

/**
 * One line on a computer, two on a phone. Each part keeps to its line and is cut short rather than wrapped, the
 * small type first, so the bar (and the table under it) never changes height as the words change from hand to hand.
 */
export function GameLine({
  portrait,
  game,
  chip,
  more,
  flags,
}: {
  portrait: boolean;
  game: GameName | null;
  /** How long this game has left and what comes next: "3 more hands, then Stud". */
  chip: GameName | null;
  /** The small type: stakes, level, table. On a phone the last one goes on the first line, the rest on the second. */
  more: string[];
  /** Bomb pot, Paused. */
  flags?: ReactNode;
}) {
  const parts = more.filter(Boolean);
  if (portrait) {
    const where = parts.length ? parts[parts.length - 1] : '';
    const rest = parts.slice(0, -1).join(' · ');
    return (
      <span className="stakes game-line">
        <span className="game-row">
          <b className="game-now">{game?.short ?? where}</b>
          {flags}
          {game && where && <span className="game-more"> {where}</span>}
        </span>
        <span className="game-row">
          {chip && <span className="game-chip">{chip.short}</span>}
          {rest && <span className="game-more"> {rest}</span>}
          {!chip && !rest && ' '}
        </span>
      </span>
    );
  }
  return (
    <span className="stakes game-line">
      {game && <b className="game-now">{game.full}</b>}
      {flags}
      {chip && <span className="game-chip">{chip.full}</span>}
      {parts.length > 0 && <span className="game-more">{parts.join(' · ')}</span>}
    </span>
  );
}

/** A game's family and usual betting, or Hold'em's for one this page doesn't know. */
export function familyOf(gameId: string): string {
  try {
    return getVariant(gameId).family;
  } catch {
    return 'flop';
  }
}

export function usualBetting(gameId: string): BettingKind {
  try {
    return getVariant(gameId).defaultBetting;
  } catch {
    return 'no-limit';
  }
}

/** "3 more hands" on a computer; "3 more" on a phone, where the bar has room for about twenty letters. */
const more = (n: number, pick: keyof GameName) => (pick === 'short' ? `${n} more` : `${n} more hand${n === 1 ? '' : 's'}`);

/**
 * A cash rotation's count, in words (#373): "3 more hands, then Stud" while a hand of the game is on the table,
 * "Last hand, then Stud" on its last one, and "6 hands, then Stud" before its first (on a phone, "3 more, then Stud"). When the game shown above isn't
 * the rotation's (a bomb pot in another game), the count says which game it is for. Null without a rotation.
 */
export function rotationChip(view: Pick<TableView, 'rotation' | 'hand' | 'upcoming'>): GameName | null {
  const r = view.rotation;
  if (!r) return null;
  const shown = view.hand ?? view.upcoming;
  const sameAsShown = !!shown && shown.gameId === r.gameId && shown.betting === r.betting;
  const name = gameName(r.gameId, r.betting);
  const next = gameName(r.next.gameId, r.next.betting);
  const words = (pick: keyof GameName): string | null => {
    const then = `then ${next[pick]}`;
    const of = sameAsShown ? '' : `${name[pick]}: `;
    if (r.handsLeft === null) return `${next[pick]} next`;
    // A hand of this game is on the table, dealing or just played.
    if (view.hand && r.dealt > 0) return r.handsLeft === 0 ? `${of}${of ? 'last' : 'Last'} hand, ${then}` : `${of}${more(r.handsLeft, pick)}, ${then}`;
    // Its hands are all played but nothing is on the table: the next hand is the next game, which the bar shows.
    if (r.handsLeft === 0) return null;
    return `${of}${r.handsLeft} hand${r.handsLeft === 1 ? '' : 's'}, ${then}`;
  };
  const full = words('full');
  const short = words('short');
  return full && short ? { full, short } : null;
}

/** The top bar at a cash table with a game rotation (#373). */
export function CashGameLine({ view, fmt, portrait, levelText }: { view: TableView; fmt: Fmt; portrait: boolean; levelText: string | null }) {
  const shown = view.hand
    ? { gameId: view.hand.gameId, betting: view.hand.betting, family: view.hand.family, stakes: view.hand.stakes }
    : view.upcoming
      ? { gameId: view.upcoming.gameId, betting: view.upcoming.betting, family: familyOf(view.upcoming.gameId), stakes: view.upcoming.stakes }
      : null;
  const flags = (
    <>
      {view.hand?.bombPot && view.hand.phase !== 'complete' && <b className="game-flag"> · Bomb pot</b>}
      {view.paused && <b className="game-flag paused"> · Paused</b>}
    </>
  );
  return (
    <GameLine
      portrait={portrait}
      game={shown ? gameName(shown.gameId, shown.betting) : null}
      chip={rotationChip(view)}
      more={[shown ? stakesLabel(shown.stakes, shown.family, shown.betting, fmt) : '', levelText ?? '', view.name]}
      flags={flags}
    />
  );
}

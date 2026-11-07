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
  narrow = false,
  game,
  chip,
  more,
  flags,
}: {
  portrait: boolean;
  /** A computer window too narrow for the count's long wording (a laptop, a tablet on its side): the short one. */
  narrow?: boolean;
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
      {chip && <span className="game-chip">{narrow ? chip.short : chip.full}</span>}
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

const hands = (n: number) => `${n} hand${n === 1 ? '' : 's'}`;

/**
 * A cash rotation's count, in words (#373). On a computer: "3 more hands, then Seven Card Stud" while a hand of the
 * game is on the table, "Last hand, then Seven Card Stud" on its last one, and "6 hands, then Seven Card Stud" before
 * its first. When the game shown above isn't the rotation's (a bomb pot in another game), it says which game the count
 * is for: "Razz: 3 more hands, then ...". A phone's bar has room for about fifteen letters (fewer on a 360px phone), so
 * there the next game leads, in short: "Stud after 3 more", "Stud next hand", "Stud after 6 hands". Null without a
 * rotation.
 */
export function rotationChip(view: Pick<TableView, 'rotation' | 'hand' | 'upcoming'>): GameName | null {
  const r = view.rotation;
  if (!r) return null;
  const shown = view.hand ?? view.upcoming;
  const sameAsShown = !!shown && shown.gameId === r.gameId && shown.betting === r.betting;
  const name = gameName(r.gameId, r.betting);
  const next = gameName(r.next.gameId, r.next.betting);
  // Too few players to count: the game carries on until there are, then the next one comes.
  if (r.handsLeft === null) {
    return sameAsShown ? { full: `Then ${next.full}`, short: `Then ${next.short}` } : { full: `${name.full}, then ${next.full}`, short: `${name.short}, then ${next.short}` };
  }
  // A hand of this game is on the table, dealing or just played (a bomb pot in it counts as one of its hands).
  if (view.hand && r.dealt > 0) {
    const of = sameAsShown ? '' : `${name.full}: `;
    if (r.handsLeft === 0) return { full: `${of}${of ? 'last' : 'Last'} hand, then ${next.full}`, short: `${next.short} next hand` };
    return { full: `${of}${r.handsLeft} more hand${r.handsLeft === 1 ? '' : 's'}, then ${next.full}`, short: `${next.short} after ${r.handsLeft} more` };
  }
  // Its hands are all played but nothing is on the table: the next hand is the next game, which the bar shows.
  if (r.handsLeft === 0) return null;
  const of = sameAsShown ? '' : `${name.full}: `;
  return { full: `${of}${hands(r.handsLeft)}, then ${next.full}`, short: `${next.short} after ${hands(r.handsLeft)}` };
}

/** The top bar at a cash table with a game rotation (#373). */
export function CashGameLine({ view, fmt, portrait, narrow, levelText }: { view: TableView; fmt: Fmt; portrait: boolean; narrow: boolean; levelText: string | null }) {
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
      narrow={narrow}
      game={shown ? gameName(shown.gameId, shown.betting) : null}
      chip={rotationChip(view)}
      more={[shown ? stakesLabel(shown.stakes, shown.family, shown.betting, fmt) : '', levelText ?? '', view.name]}
      flags={flags}
    />
  );
}

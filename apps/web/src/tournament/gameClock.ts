import type { Stakes } from '@rsdp/engine/core';
import { clockAt, clockElapsed, levelFor, type LevelStakes, type StructureRow, type TournamentState } from '@rsdp/tournament';
import { gameName, sameGame, type GameName, type GameStep } from '../components/table/gameChange';

export type { GameStep };
import { countdown } from './format';

/**
 * A tournament table's game and level as its players need them (#305): which game is on, which comes next and when,
 * and the line that announces a new level. Mixed-game events change game by time, one game per level, so the clock
 * the table already shows says how long the current game has left.
 */

/** The game and stakes that row `rowIndex` of the structure deals (on a break, the level after it), as the server works them out. */
export function rowGame(s: TournamentState, rowIndex: number): LevelStakes {
  return levelFor({ ...s, clock: { ...s.clock, rowIndex } }, '');
}

/** The level before row `rowIndex` (the one a break follows), or -1. */
function levelBefore(rows: StructureRow[], rowIndex: number): number {
  for (let i = rowIndex - 1; i >= 0; i--) if (rows[i].kind === 'level') return i;
  return -1;
}

/** How far behind the server's clock this page's may be. */
const CLOCK_SLACK_MS = 3000;

export interface NextGame extends GameStep {
  /** Running time until it starts on the tournament clock, or null when it starts with the next hand. */
  inMs: number | null;
}

/**
 * The next game the clock brings: the first level ahead whose game differs from the one being played. `playing` is
 * the game of the hand at this table (dealing or just finished), if there is one. When the clock has already moved
 * on to another game during that hand, the new game starts with the next hand. Null for a single-game event, when no
 * other game is ahead, and before the start or after the end.
 */
export function nextGame(s: TournamentState, now: number, playing: GameStep | null): NextGame | null {
  if (s.status !== 'running' && s.status !== 'paused') return null;
  const rows = s.settings.structure;
  let p = clockAt(rows, clockElapsed(s, now));
  // This page's clock can run a moment behind the server's: it ticks every half second, and its offset from the
  // server's is an estimate. A hand in the next level's game, dealt in the last moments of this one by this clock,
  // was really dealt in the next level, so read the clock from there (rather than calling the game that just ended
  // the next one).
  const ahead = rows[p.rowIndex + 1];
  if (playing && !p.onBreak && p.msLeft !== null && p.msLeft <= CLOCK_SLACK_MS && ahead?.kind === 'level' && !sameGame(rowGame(s, p.rowIndex), playing) && sameGame(rowGame(s, p.rowIndex + 1), playing)) {
    p = clockAt(rows, clockElapsed(s, now) + p.msLeft);
  }
  const level = rowGame(s, p.rowIndex);
  // On a break no hands are dealt: until one is, the game is the last level's.
  const last = p.onBreak ? levelBefore(rows, p.rowIndex) : p.rowIndex;
  const current = playing ?? (last >= 0 ? rowGame(s, last) : level);
  if (!p.onBreak && !sameGame(level, current)) return { gameId: level.gameId, ...(level.betting ? { betting: level.betting } : {}), inMs: null };
  if (p.msLeft === null) return null;
  let at = p.msLeft;
  for (let i = p.rowIndex + 1; i < rows.length; i++) {
    if (rows[i].kind === 'level') {
      const g = rowGame(s, i);
      if (!sameGame(g, current)) return { gameId: g.gameId, ...(g.betting ? { betting: g.betting } : {}), inMs: at };
    }
    at += rows[i].minutes * 60_000;
  }
  return null;
}

/**
 * "Pot-Limit Omaha next, in 3:20", or "Razz from the next hand" once the clock has moved on during a hand. On a
 * phone, where the bar has room for about twenty letters: "PLO in 3:20" and "Razz next hand".
 */
export function nextGameText(next: NextGame, length: keyof GameName = 'short'): string {
  const name = gameName(next.gameId, next.betting)[length];
  if (length === 'short') return next.inMs === null ? `${name} next hand` : `${name} in ${countdown(next.inMs)}`;
  return next.inMs === null ? `${name} from the next hand` : `${name} next, in ${countdown(next.inMs)}`;
}

/** The level being played, for the top bar: during a break, the level after it. Null before the start and after the end. */
export function levelNow(s: TournamentState, now: number): { number: number; onBreak: boolean } | null {
  if (s.status !== 'running' && s.status !== 'paused') return null;
  const p = clockAt(s.settings.structure, clockElapsed(s, now));
  return { number: p.onBreak ? p.levelNumber + 1 : p.levelNumber, onBreak: p.onBreak };
}

/**
 * The game and stakes the next hand is dealt at, for a table with no hand yet: the level on the clock (on a break,
 * the one after it), or the first level before the start. Null once the event is over.
 */
export function levelGameNow(s: TournamentState, now: number): LevelStakes | null {
  if (s.status === 'finished' || s.status === 'cancelled') return null;
  const started = s.status === 'running' || s.status === 'paused';
  return rowGame(s, started ? clockAt(s.settings.structure, clockElapsed(s, now)).rowIndex : 0);
}

/** A level's stakes in the shape a hand's take. */
export const levelStakes = (l: LevelStakes): Stakes => ({ smallBlind: l.sb, bigBlind: l.bb, ante: l.ante, anteType: l.anteType, bringIn: l.bringIn, smallBet: l.smallBet, bigBet: l.bigBet });

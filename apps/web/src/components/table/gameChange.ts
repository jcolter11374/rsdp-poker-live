import type { BettingKind, Stakes } from '@rsdp/engine/core';
import { gameCode, gameTitle } from '@rsdp/engine/variants';

/*
 * Naming games, and telling when the game or the level changed, for the top bar and the banner at a table whose game
 * changes (#305, #373).
 */

/** A game with its betting, as a hand or a level plays it (betting left out: the game's usual one). */
export interface GameStep {
  gameId: string;
  betting?: BettingKind;
}

/** The same game at the same betting: Limit and No-Limit Hold'em in 8-Game are different games. */
export const sameGame = (a: GameStep, b: GameStep) => gameCode(a.gameId, a.betting) === gameCode(b.gameId, b.betting);

/** A game's name for big type: its full name without "(8 or better)", which Hi-Lo already says. */
export const gameHeading = (gameId: string, betting?: BettingKind) => gameTitle(gameId, betting).replace(/ \(8 or better\)$/, '');

/** A game's name at two lengths: in full on a computer, its short code on a phone. */
export interface GameName {
  full: string;
  short: string;
}

export const gameName = (gameId: string, betting?: BettingKind): GameName => ({ full: gameHeading(gameId, betting), short: gameCode(gameId, betting) });

/** A dealt hand as the banner compares them. */
export interface DealtHand extends GameStep {
  stakes: Stakes;
}

const STAKES_KEYS = ['smallBlind', 'bigBlind', 'ante', 'anteType', 'bringIn', 'smallBet', 'bigBet'] as const;

/** What a newly dealt hand changes from the one before it at the same table: the game, only the stakes (a new level), or nothing. */
export function levelChange(before: DealtHand, after: DealtHand): 'game' | 'stakes' | null {
  if (!sameGame(before, after)) return 'game';
  return STAKES_KEYS.some((k) => before.stakes[k] !== after.stakes[k]) ? 'stakes' : null;
}

/**
 * The words on the banner, in three lines: "New game · Level 6" (or "New level · Level 6"), then the game, then the
 * stakes. A cash table has no level number.
 */
export function bannerText(change: 'game' | 'stakes', levelNumber: number | null, game: GameStep, stakes: string): { kicker: string; title: string; stakes: string } {
  return {
    kicker: [change === 'game' ? 'New game' : 'New level', levelNumber !== null && `Level ${levelNumber}`].filter(Boolean).join(' · '),
    title: gameHeading(game.gameId, game.betting),
    stakes,
  };
}

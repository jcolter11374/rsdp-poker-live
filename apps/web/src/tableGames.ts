import type { BettingKind } from '@rsdp/engine/core';
import { bombPotSchema } from '@rsdp/engine/modifiers';
import type { TableSettings } from '@rsdp/engine/settings';
import { getVariant } from '@rsdp/engine/variants';
import type { TournamentSettings } from '@rsdp/tournament';
import { dealtShapes, splitsPot } from './handSizes';

/*
 * Every game a table deals, so a mixed table is laid out once for all of them and its seats don't move when the
 * game changes (#409).
 */

/**
 * A cash table's games: its Dealer's choice menu, its rotation, or its one game, and the game its bomb pots are dealt
 * in when they come on their own (#418). A bomb pot only from the host's button (automatic ones off, or on with no
 * chance and no count of hands) isn't counted: it's a one-off, and the table isn't laid out for it the rest of the time.
 */
export function tableGames(settings: TableSettings): string[] {
  return [...new Set(tableDeals(settings).map((d) => d.gameId))];
}

/** A cash table's games with the betting each is dealt with, its bomb pots' included. */
function tableDeals(settings: TableSettings): { gameId: string; betting: BettingKind }[] {
  const game = settings.game;
  const games = game.dealersChoice?.enabled ? game.dealersChoice.games : game.rotation.enabled ? game.rotation.steps : [game];
  const bomb = bombPotSchema.get(settings);
  const own = bomb.enabled && (bomb.everyHands > 0 || bomb.chancePercent > 0);
  return own && bomb.gameId && bombPotGame(bomb.gameId) ? [...games, { gameId: bomb.gameId, betting: bomb.betting }] : games;
}

/** Whether the server deals bomb pots in this game: only in a flop game with blinds. */
function bombPotGame(gameId: string): boolean {
  try {
    const game = getVariant(gameId);
    return game.family === 'flop' && game.forcedBets === 'blinds';
  } catch {
    return false;
  }
}

/**
 * Whether every game a cash table deals is played Limit. Those have no bet slider, so the bar under the table needs
 * less room; a table that also deals a No-Limit or Pot-Limit game (a bomb pot in one included) keeps room for that bar
 * the whole time, so the felt doesn't shrink when such a game comes round (#409, #418).
 */
export function tableAllLimit(settings: TableSettings): boolean {
  return tableDeals(settings).every((d) => d.betting === 'fixed-limit');
}

/**
 * A tournament's games: its rotation, and any level that names its own game. A tournament table's own settings
 * always say Hold'em, so they can't tell.
 */
export function tournamentGames(settings: Pick<TournamentSettings, 'games' | 'structure'>): string[] {
  const own = settings.structure.flatMap((row) => (row.kind === 'level' && row.gameId !== undefined ? [row.gameId] : []));
  return [...new Set([...settings.games, ...own])];
}

/**
 * Whether every game a tournament deals is played Limit (see tableAllLimit): its rotation's games with the betting
 * chosen for each, or their usual betting, and any level's own game, which plays its usual betting.
 */
export function tournamentAllLimit(settings: Pick<TournamentSettings, 'games' | 'gameBetting' | 'structure'>): boolean {
  const usual = (gameId: string) => {
    try {
      return getVariant(gameId).defaultBetting;
    } catch {
      return null;
    }
  };
  const rotation = settings.games.map((g, i) => settings.gameBetting?.[i] ?? usual(g));
  const own = settings.structure.flatMap((row) => (row.kind === 'level' && row.gameId !== undefined ? [usual(row.gameId)] : []));
  return [...rotation, ...own].every((b) => b === 'fixed-limit');
}

/**
 * The games of these that can be dealt to this many players. A Dealer's choice menu can hold games the table is too
 * full to pick (stud with nine seated), and those needn't make room for their hands.
 */
export function dealableGames(games: readonly string[], players: number): string[] {
  return games.filter((g) => {
    try {
      return getVariant(g).maxPlayers >= players;
    } catch {
      return false;
    }
  });
}

/**
 * Games whose hands tuck four cards beside the nameplate (Table.tsx: a wider seat and felt margin). Stud's three or four
 * cards don't: its hand is a row over the nameplate from third street (#447).
 */
export const FOUR_CARD_GAMES: readonly string[] = ['plo4', 'plo8', 'badugi'];
/**
 * Games that show a row of cards over the nameplate from their first card (Table.tsx: more room above the top seats in
 * the wide layout): those whose hand ever goes past four cards (rowHand in handSizes.ts).
 */
export const LONG_HAND_GAMES: readonly string[] = ['plo5', 'plo6', 'plo5-8', 'plo6-8', 'stud', 'razz', 'stud8', 'td27'];

/**
 * Everything a table's layout takes from the games it's laid out for: their hand sizes, which of the lists above they
 * touch, and whether any is hi-lo (a longer showdown line, #427). Two lists with the same layout look the same, so a
 * hand in a game off the table's list that this says adds nothing doesn't move the seats (#418). Anything else
 * Table.tsx reads from its games belongs here too.
 */
export function layoutOf(games: readonly string[]): string {
  const any = (list: readonly string[]) => games.some((g) => list.includes(g));
  return `${dealtShapes(games).join('-')}|${any(FOUR_CARD_GAMES)}|${any(LONG_HAND_GAMES)}|${games.some((g) => splitsPot(g))}`;
}

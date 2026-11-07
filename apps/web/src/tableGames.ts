import type { BettingKind } from '@rsdp/engine/core';
import type { TableSettings } from '@rsdp/engine/settings';
import { getVariant } from '@rsdp/engine/variants';
import type { TournamentSettings } from '@rsdp/tournament';

/*
 * Every game a table deals, so a mixed table is laid out once for all of them and its seats don't move when the
 * game changes (#409).
 */

/** A cash table's games: its Dealer's choice menu, its rotation, or its one game. */
export function tableGames(settings: TableSettings): string[] {
  return tableDeals(settings).map((d) => d.gameId);
}

/** A cash table's games with the betting each is dealt with. */
function tableDeals(settings: TableSettings): { gameId: string; betting: BettingKind }[] {
  const game = settings.game;
  if (game.dealersChoice?.enabled) return game.dealersChoice.games;
  if (game.rotation.enabled) return game.rotation.steps;
  return [game];
}

/**
 * Whether every game a cash table deals is played Limit. Those have no bet slider, so the bar under the table needs
 * less room; a table that also deals a No-Limit or Pot-Limit game keeps room for that bar the whole time, so the felt
 * doesn't shrink when such a game comes round (#409).
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

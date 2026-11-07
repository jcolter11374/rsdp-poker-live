import type { TableSettings } from '@rsdp/engine/settings';
import type { TournamentSettings } from '@rsdp/tournament';

/*
 * Every game a table deals, so a mixed table is laid out once for all of them and its seats don't move when the
 * game changes (#409).
 */

/** A cash table's games: its Dealer's choice menu, its rotation, or its one game. */
export function tableGames(settings: TableSettings): string[] {
  const game = settings.game;
  if (game.dealersChoice?.enabled) return game.dealersChoice.games.map((g) => g.gameId);
  if (game.rotation.enabled) return game.rotation.steps.map((s) => s.gameId);
  return [game.gameId];
}

/**
 * A tournament's games: its rotation, and any level that names its own game. A tournament table's own settings
 * always say Hold'em, so they can't tell.
 */
export function tournamentGames(settings: Pick<TournamentSettings, 'games' | 'structure'>): string[] {
  const own = settings.structure.flatMap((row) => (row.kind === 'level' && row.gameId !== undefined ? [row.gameId] : []));
  return [...new Set([...settings.games, ...own])];
}

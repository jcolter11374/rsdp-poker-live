import type { BettingKind, Stakes } from '@rsdp/engine/core';
import type { TableView } from '@rsdp/engine/wire';
import { stakesLabel, type Fmt } from '../format';
import { familyOf, GameLine, usualBetting } from '../components/table/GameLine';
import { gameName } from '../components/table/gameChange';
import { levelGameNow, levelNow, levelStakes, nextGame, nextGameText } from './gameClock';
import { useHeld, useNow, useTournament } from './hooks';

/**
 * The top bar at a tournament table (#305): the game first, in big type, then in a mixed game how long until the
 * next one ("Razz next, in 3:20"), then its stakes, the level and the table in small type. While an all-in runout is
 * dealt here (`holding`) it keeps the tournament as it was, as the strip under it (on a wide window, the corner box)
 * does: an event that ends with this hand would otherwise lose its level and countdown before the cards show who won.
 */
export function TournamentGameLine({ view, fmt, portrait, narrow, tight, holding }: { view: TableView; fmt: Fmt; portrait: boolean; narrow: boolean; tight: boolean; holding: boolean }) {
  const { state: latest, skew } = useTournament(view.tournamentId!);
  const state = useHeld(latest, holding);
  // The strip's clock ticks every 500ms too, on the same timer, so the two countdowns turn over together.
  const now = useNow(500) + skew;
  const hand = view.hand;
  // The hand on the felt says what is being played; before the first one, the clock says what will be.
  const fromClock = !hand && state ? levelGameNow(state, now) : null;
  const game: { gameId: string; betting?: BettingKind; family: string; stakes: Stakes } | null = hand
    ? { gameId: hand.gameId, betting: hand.betting, family: hand.family, stakes: hand.stakes }
    : fromClock
      ? { gameId: fromClock.gameId, betting: fromClock.betting, family: familyOf(fromClock.gameId), stakes: levelStakes(fromClock) }
      : null;
  const level = state ? levelNow(state, now) : null;
  const next = state ? nextGame(state, now, hand ? { gameId: hand.gameId, betting: hand.betting } : null) : null;
  const table = view.name.match(/· (Table \d+)$/)?.[1] ?? view.name;
  const stakes = game ? stakesLabel(game.stakes, game.family, game.betting ?? usualBetting(game.gameId), fmt) : '';
  return (
    <GameLine
      portrait={portrait}
      narrow={narrow}
      tight={tight}
      game={game ? gameName(game.gameId, game.betting) : null}
      chip={next ? { full: nextGameText(next, 'full'), short: nextGameText(next, 'short') } : null}
      // On a break the stakes are still the last hand's, so the bar says Break rather than the coming level's number.
      more={[stakes, level ? (level.onBreak ? 'Break' : `Level ${level.number}`) : '', table]}
      flags={view.paused && <b className="game-flag paused"> · Paused</b>}
    />
  );
}

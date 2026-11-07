import { useEffect, useRef, useState } from 'react';
import type { TableView } from '@rsdp/engine/wire';
import { chipFormat, stakesLabel } from '../../format';
import { levelNow } from '../../tournament/gameClock';
import { useTournament } from '../../tournament/hooks';
import { bannerText, levelChange, type DealtHand } from './gameChange';

/** How long the banner stays up. */
export const BANNER_MS = 5000;

/**
 * A few seconds' banner on the felt when a hand is dealt in a new game, at any table, and at a tournament also when
 * a new level starts (#305, #373): "New game", "Seven Card Stud", "0.50/1 · ante 0.10 · bring-in 0.15". It goes by
 * the hands in this viewer's own view, so a spectator on a delay sees it with the hand and never early. A bomb pot in
 * another game is a one-off, not a new game. It floats over the felt and takes no room, so the table never changes
 * size for it, and it gives way as soon as the board has cards.
 */
export function GameBanner({ view }: { view: TableView }) {
  return view.tournamentId ? <TournamentBanner view={view} tournamentId={view.tournamentId} /> : <Banner view={view} level={null} tournament={false} />;
}

function TournamentBanner({ view, tournamentId }: { view: TableView; tournamentId: string }) {
  const { state, skew } = useTournament(tournamentId);
  const level = state ? (levelNow(state, Date.now() + skew)?.number ?? null) : null;
  return <Banner view={view} level={level} tournament />;
}

function Banner({ view, level, tournament }: { view: TableView; level: number | null; tournament: boolean }) {
  const hand = view.hand;
  const [shown, setShown] = useState<{ hand: number; change: 'game' | 'stakes' } | null>(null);
  /** The last hand this page saw dealt, and the last one that wasn't a bomb pot, at this table. */
  const seen = useRef<{ table: string; hand: number } | null>(null);
  const last = useRef<{ table: string; dealt: DealtHand } | null>(null);
  useEffect(() => {
    if (!hand) return;
    if (seen.current?.table === view.id && seen.current.hand === hand.handNumber) return;
    seen.current = { table: view.id, hand: hand.handNumber };
    if (hand.bombPot) return;
    const before = last.current;
    const dealt = { gameId: hand.gameId, betting: hand.betting, stakes: hand.stakes };
    last.current = { table: view.id, dealt };
    // The first hand this page sees at a table is not news.
    if (!before || before.table !== view.id) return;
    const change = levelChange(before.dealt, dealt);
    if (change === 'game' || (change === 'stakes' && tournament)) setShown({ hand: hand.handNumber, change });
  }, [view.id, hand?.handNumber]);
  useEffect(() => {
    if (!shown) return;
    const t = setTimeout(() => setShown(null), BANNER_MS);
    return () => clearTimeout(t);
  }, [shown]);
  const boardOut = !!hand?.boards.some((run) => run.some((cards) => cards.length > 0));
  if (!shown || !hand || hand.handNumber !== shown.hand || boardOut) return null;
  const words = bannerText(shown.change, tournament ? level : null, hand, stakesLabel(hand.stakes, hand.family, hand.betting, chipFormat(!!view.settings.stakes.centsMode)));
  return (
    <div className={`game-banner${shown.change === 'game' ? ' new-game' : ''}`} role="status">
      <span className="game-banner-kicker">{words.kicker}</span>
      <span className="game-banner-title">{words.title}</span>
      <span className="game-banner-stakes">{words.stakes}</span>
    </div>
  );
}

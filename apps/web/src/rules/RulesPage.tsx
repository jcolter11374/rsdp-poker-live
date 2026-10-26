import { GameGuide } from './GameGuide';
import { SiteFooter, SiteHeader } from '../components/SiteHeader';

/** Every game's guide on its own page, to read before sitting down. `/rules/razz` opens on Razz. */
export function RulesPage({ gameId }: { gameId: string | null }) {
  return (
    <div className="site-page">
      <SiteHeader />
      <main className="rules-page">
        <h1>How to play</h1>
        <GameGuide current={gameId} />
      </main>
      <SiteFooter />
    </div>
  );
}

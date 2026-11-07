import { GameGuide } from './GameGuide';
import { SiteFooter, SiteHeader } from '../components/SiteHeader';

/** Every game's guide on its own page, to read before sitting down. `/rules/razz` opens on Razz. */
export function RulesPage({ gameId }: { gameId: string | null }) {
  return (
    <div className="site-page">
      <SiteHeader />
      <main className="rules-page">
        <h1>How to play</h1>
        {/* Each guide is headed h3, as it is in the table's How to play dialog under the dialog's own title; this unseen
            level between them keeps the page's headings in order for screen readers. */}
        <h2 className="sr-only">The games</h2>
        <GameGuide current={gameId} />
      </main>
      <SiteFooter />
    </div>
  );
}

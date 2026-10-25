import { GameGuide } from './GameGuide';

/** Every game's guide on its own page, to read before sitting down. `/rules/razz` opens on Razz. */
export function RulesPage({ gameId }: { gameId: string | null }) {
  return (
    <main className="rules-page">
      <header>
        <h1>How to play</h1>
        <a href="/">Back to RSDP Poker Live!</a>
      </header>
      <GameGuide current={gameId} />
    </main>
  );
}

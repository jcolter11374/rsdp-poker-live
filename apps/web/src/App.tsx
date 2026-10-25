import { useEffect, useState } from 'react';
import { Home } from './Home';
import { RoadmapAdminPage } from './roadmap/AdminPage';
import { RoadmapPage } from './roadmap/RoadmapPage';
import { WhatsNewPage } from './roadmap/WhatsNewPage';
import { RulesPage } from './rules/RulesPage';
import { TablePage } from './TablePage';
import { SeasonPage } from './tournament/SeasonPage';
import { SharedHandPage } from './components/table/Records';
import { TournamentAlerts } from './tournament/TournamentAlerts';
import { TournamentCreatePage } from './tournament/TournamentCreate';
import { TournamentLobby } from './tournament/TournamentLobby';
import './tournament/tournament.css';

export function App() {
  return (
    <>
      <TournamentAlerts />
      <Page />
    </>
  );
}

function Page() {
  const [path, setPath] = useState(location.pathname);

  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const go = (to: string) => {
    history.pushState(null, '', to);
    setPath(to);
  };

  const rules = path.match(/^\/rules(?:\/([\w-]+))?\/?$/);
  if (rules) return <RulesPage gameId={rules[1] ?? null} />;
  if (/^\/roadmap\/?$/.test(path)) return <RoadmapPage />;
  if (/^\/roadmap\/admin\/?$/.test(path)) return <RoadmapAdminPage />;
  if (/^\/whats-new\/?$/.test(path)) return <WhatsNewPage />;
  if (path === '/tn/new') return <TournamentCreatePage from={new URLSearchParams(location.search).get('from')} onCreated={(id) => go(`/tn/${id}`)} />;
  const season = path.match(/^\/season\/([\w-]+)/);
  if (season) return <SeasonPage key={season[1]} id={season[1]} />;
  const tournament = path.match(/^\/tn\/([\w-]+)/);
  if (tournament) return <TournamentLobby id={tournament[1]} />;
  const shared = path.match(/^\/h\/([\w-]+)/);
  if (shared) return <SharedHandPage id={shared[1]} />;
  const table = path.match(/^\/t\/([\w-]+)/);
  return table ? <TablePage key={table[1]} tableId={table[1]} /> : <Home onCreated={(id) => go(`/t/${id}`)} />;
}

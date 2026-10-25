import { useEffect, useState } from 'react';
import { Home } from './Home';
import { TablePage } from './TablePage';
import { TournamentCreate } from './tournament/TournamentCreate';
import { TournamentLobby } from './tournament/TournamentLobby';
import './tournament/tournament.css';

export function App() {
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

  if (path === '/tn/new') return <TournamentCreate onCreated={(id) => go(`/tn/${id}`)} />;
  const tournament = path.match(/^\/tn\/([\w-]+)/);
  if (tournament) return <TournamentLobby id={tournament[1]} />;
  const room = path.match(/^\/t\/([\w-]+)/);
  return room ? <TablePage roomId={room[1]} /> : <Home onCreated={(id) => go(`/t/${id}`)} />;
}

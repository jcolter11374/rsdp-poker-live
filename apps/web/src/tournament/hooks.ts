import { useEffect, useState } from 'react';
import type { TournamentState } from '@rsdp/tournament';
import { socket } from '../socket';
import { tournamentClient, type Session } from './client';

/** Re-renders every `ms` with the current time. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function useSession(): Session | null {
  const client = tournamentClient();
  const [s, setS] = useState(client.session());
  useEffect(() => {
    const off = client.onSession(setS);
    // It may have arrived between the first render and now.
    setS(client.session());
    return off;
  }, [client]);
  return s;
}

/** Live tournament state plus the offset between the server clock and ours. */
export function useTournament(id: string) {
  const client = tournamentClient();
  const [state, setState] = useState<TournamentState | null>(null);
  const [skew, setSkew] = useState(0);
  const [nextId, setNextId] = useState<string | null>(null);
  const [error, setError] = useState('');
  useEffect(
    () =>
      client.subscribe(
        id,
        (v) => {
          setState(v.state);
          setSkew(v.serverNow - Date.now());
          setNextId(v.nextId ?? null);
          setError('');
        },
        setError,
      ),
    [client, id],
  );
  return { state, skew, nextId, error };
}

/** Changes page without reloading; App follows popstate. */
export function navigate(to: string) {
  history.pushState(null, '', to);
  dispatchEvent(new PopStateEvent('popstate'));
}

/**
 * Takes this tab to the player's table when the tournament first seats them,
 * and along with them when they are moved from the table on screen.
 */
export function useFollowSeat(currentTable: string | null) {
  useEffect(() => {
    const onMoved = ({ from, to }: { from: string; to: string }) => {
      if (from !== '' && from !== currentTable) return;
      if (to === currentTable) return;
      navigate(`/t/${to}`);
    };
    socket.on('table:moved', onMoved);
    return () => {
      socket.off('table:moved', onMoved);
    };
  }, [currentTable]);
}

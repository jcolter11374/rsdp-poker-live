import { useEffect, useState } from 'react';
import type { TournamentState } from '@rsdp/tournament';
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
  useEffect(() => client.onSession(setS), [client]);
  return s;
}

/** Live tournament state plus the offset between the server clock and ours. */
export function useTournament(id: string) {
  const client = tournamentClient();
  const [state, setState] = useState<TournamentState | null>(null);
  const [skew, setSkew] = useState(0);
  const [error, setError] = useState('');
  useEffect(
    () =>
      client.subscribe(
        id,
        (v) => {
          setState(v.state);
          setSkew(v.serverNow - Date.now());
          setError('');
        },
        setError,
      ),
    [client, id],
  );
  return { state, skew, error };
}

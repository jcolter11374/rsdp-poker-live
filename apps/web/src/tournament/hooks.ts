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
 * What a table:moved event means for a tab showing `currentTable` (null off
 * the tables): go to the new seat, offer a link to it, or nothing. A first
 * seat never pulls a tab where the player is seated, since leaving that page
 * leaves the seat there offline.
 */
export function followMove(move: { from: string; to: string }, currentTable: string | null, seatedHere: boolean): 'go' | 'offer' | null {
  if (move.to === currentTable) return null;
  if (move.from === '') return seatedHere ? 'offer' : 'go';
  return move.from === currentTable ? 'go' : null;
}

/**
 * Takes this tab to the player's table when the tournament first seats them,
 * and along with them when they are moved from the table on screen. Returns
 * the first seat it left alone because the player is seated here, for a link.
 */
export function useFollowSeat(currentTable: string | null, seatedHere = false): string | null {
  const [ready, setReady] = useState<string | null>(null);
  useEffect(() => {
    const onMoved = (move: { from: string; to: string }) => {
      const next = followMove(move, currentTable, seatedHere);
      if (next === 'go') navigate(`/t/${move.to}`);
      else if (next === 'offer') setReady(move.to);
      // Keep the link on the seat when the tournament moves it again.
      else setReady((r) => (r === move.from ? move.to : r));
    };
    socket.on('table:moved', onMoved);
    return () => {
      socket.off('table:moved', onMoved);
    };
  }, [currentTable, seatedHere]);
  return ready;
}

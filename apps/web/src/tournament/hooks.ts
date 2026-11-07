import { useEffect, useMemo, useRef, useState } from 'react';
import type { TournamentState } from '@rsdp/tournament';
import { socket } from '../socket';
import { tournamentClient, type Session } from './client';
import { tournamentAllLimit, tournamentGames } from '../tableGames';

/** One timer for each interval, so clocks on the same page (the strip's and the top bar's) tick together. */
interface Ticker {
  now: number;
  listeners: Set<(now: number) => void>;
  timer: ReturnType<typeof setInterval>;
}
const tickers = new Map<number, Ticker>();

/** Re-renders every `ms` with the current time, on the same tick as everything else here that asks for `ms`. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => tickers.get(ms)?.now ?? Date.now());
  useEffect(() => {
    let ticker = tickers.get(ms);
    if (!ticker) {
      const listeners = new Set<(now: number) => void>();
      const t: Ticker = { now: Date.now(), listeners, timer: setInterval(() => listeners.forEach((l) => l((t.now = Date.now()))), ms) };
      tickers.set(ms, t);
      ticker = t;
    }
    ticker.listeners.add(setNow);
    setNow(ticker.now);
    const mine = ticker;
    return () => {
      mine.listeners.delete(setNow);
      if (!mine.listeners.size) {
        clearInterval(mine.timer);
        tickers.delete(ms);
      }
    };
  }, [ms]);
  return now;
}

/** `value`, or while `holding`, the value it had when the holding began. */
export function useHeld<T>(value: T, holding: boolean): T {
  const kept = useRef(value);
  if (!holding) kept.current = value;
  return holding ? kept.current : value;
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
  const [nextError, setNextError] = useState<string | null>(null);
  const [error, setError] = useState('');
  useEffect(
    () =>
      client.subscribe(
        id,
        (v) => {
          setState(v.state);
          setSkew(v.serverNow - Date.now());
          setNextId(v.nextId ?? null);
          setNextError(v.nextError ?? null);
          setError('');
        },
        setError,
      ),
    [client, id],
  );
  return { state, skew, nextId, nextError, error };
}

/**
 * Every game a tournament deals (see tournamentGames), for laying out its tables, and whether they're all played Limit
 * (see tournamentAllLimit); no games until it loads, or with no tournament. Only a change to those re-renders.
 */
export function useTournamentGames(id: string | null): { games: string[]; allLimit: boolean } {
  const [key, setKey] = useState('');
  useEffect(() => {
    setKey('');
    if (!id) return;
    return tournamentClient().subscribe(id, (v) => setKey(`${tournamentGames(v.state.settings).join(',')}|${tournamentAllLimit(v.state.settings) ? 'limit' : ''}`), () => {});
  }, [id]);
  return useMemo(() => {
    const [games, limit] = key.split('|');
    return { games: games ? games.split(',') : [], allLimit: limit === 'limit' };
  }, [key]);
}

/** Changes page without reloading; App follows popstate. */
export function navigate(to: string) {
  // Two signals can send a tab to the same seat; keep one history entry.
  if (location.pathname === to) return;
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
export function useFollowSeat(currentTable: string | null, seatedHere = false, holding = false): string | null {
  const [ready, setReady] = useState<string | null>(null);
  // A move that lands while an all-in runout is still being dealt here waits for it to finish.
  const [held, setHeld] = useState<string | null>(null);
  useEffect(() => {
    const onMoved = (move: { from: string; to: string }) => {
      const next = followMove(move, currentTable, seatedHere);
      if (next === 'go') setHeld(move.to);
      else if (next === 'offer') setReady(move.to);
      // Keep the link (or the held move) on the seat when the tournament moves it again.
      else {
        setReady((r) => (r === move.from ? move.to : r));
        setHeld((h) => (h === move.from ? move.to : h));
      }
    };
    socket.on('table:moved', onMoved);
    return () => {
      socket.off('table:moved', onMoved);
    };
  }, [currentTable, seatedHere]);
  useEffect(() => {
    if (!held || holding) return;
    setHeld(null);
    navigate(`/t/${held}`);
  }, [held, holding]);
  return ready;
}

/**
 * Whether the strip should take this tab to the player's seat (a table
 * address, or null when not seated) rather than only link to it: when the
 * tournament moved them off the table on screen and this table no longer
 * seats them, i.e. the tab missed table:moved. Someone who opened another
 * table to watch it stays there.
 */
export function followMissedMove(seat: string | null, here: string, wasHere: boolean, seatedHere: boolean): boolean {
  return seat !== null && seat !== here && wasHere && !seatedHere;
}

/** The tournament a table address (`abc-t3`) belongs to, or null for a cash table. */
export function tournamentOfTable(address: string): string | null {
  return address.match(/^([0-9a-f]+)-t\d+$/)?.[1] ?? null;
}

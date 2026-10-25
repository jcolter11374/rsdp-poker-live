import { useEffect, useState } from 'react';
import type { SeasonBoard } from '@rsdp/tournament';
import { call } from '../socket';
import { localTime, money, ordinal } from './format';
import { useSession } from './hooks';

type Sort = 'points' | 'ppg';

/** Fetches a season's leaderboard once; it changes only when an event finishes, so a reload is enough. */
function useSeason(id: string) {
  const [board, setBoard] = useState<SeasonBoard | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    call<{ board: SeasonBoard }>('season:get', { id })
      .then((r) => live && setBoard(r.board))
      .catch((e: Error) => live && setError(e.message === 'season not found' ? 'Season not found' : e.message));
    return () => {
      live = false;
    };
  }, [id]);
  return { board, error };
}

export function SeasonPage({ id }: { id: string }) {
  const { board, error } = useSeason(id);
  const session = useSession();
  const [sort, setSort] = useState<Sort>('points');
  const [minGames, setMinGames] = useState(1);
  if (error) return <main className="tn-page"><p className="error">{error}</p><a href="/">Home</a></main>;
  if (!board) return <main className="tn-page"><p className="muted">Loading…</p></main>;

  const ppg = (r: SeasonBoard['rows'][number]) => r.points / r.games;
  const rows = board.rows.filter((r) => r.games >= minGames);
  if (sort === 'ppg') rows.sort((a, b) => ppg(b) - ppg(a) || b.points - a.points);
  const money_ = board.rows.some((r) => r.net !== null);
  const bounties = board.rows.some((r) => r.knockouts > 0);
  const maxGames = Math.max(1, ...board.rows.map((r) => r.games));

  return (
    <main className="tn-page">
      <header className="tn-header">
        <a className="logo small" href="/">
          RSDP Poker <span>Live!</span>
        </a>
        <h1>{board.name}</h1>
        <p className="muted">
          Season leaderboard · {board.events.length} {board.events.length === 1 ? 'event' : 'events'} played · {board.rows.length} players
        </p>
      </header>

      <section className="tn-card">
        <div className="tn-request">
          <div className="tn-segment tn-segment-2" role="radiogroup" aria-label="Rank by">
            {(
              [
                ['points', 'Total points'],
                ['ppg', 'Points per game'],
              ] as const
            ).map(([k, label]) => (
              <button key={k} role="radio" aria-checked={sort === k} className={sort === k ? 'on' : ''} onClick={() => setSort(k)}>
                {label}
              </button>
            ))}
          </div>
          <label className="tn-inline">
            At least
            <input type="number" min={1} max={maxGames} value={minGames} onChange={(e) => setMinGames(Math.max(1, Math.floor(Number(e.target.value) || 1)))} />
            {minGames === 1 ? 'game' : 'games'}
          </label>
        </div>
        {rows.length === 0 ? (
          <p className="muted">{board.events.length ? 'Nobody has played that many games yet.' : 'No events have finished yet. Standings appear here after the first one.'}</p>
        ) : (
          <div className="tn-scroll">
            <table className="tn-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Player</th>
                  <th className="num">Points</th>
                  <th className="num">Games</th>
                  <th className="num">Per game</th>
                  <th className="num">Wins</th>
                  <th className="num">Cashes</th>
                  <th className="num">Best</th>
                  {bounties && <th className="num">KOs</th>}
                  {money_ && <th className="num">Net</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.playerId} className={r.playerId === session?.playerId ? 'tn-me-row' : ''}>
                    <td>{i + 1}</td>
                    <td>{r.displayName}</td>
                    <td className="num">{r.points}</td>
                    <td className="num">{r.games}</td>
                    <td className="num">{ppg(r).toFixed(1)}</td>
                    <td className="num">{r.wins || ''}</td>
                    <td className="num">{r.cashes || ''}</td>
                    <td className="num">{ordinal(r.bestPlace)}</td>
                    {bounties && <td className="num">{r.knockouts || ''}</td>}
                    {money_ && <td className={`num ${r.net! < 0 ? 'tn-neg' : ''}`}>{r.net! > 0 ? '+' : ''}{money(r.net!)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted">
          Points per event: players in the event minus your place, plus one. Winning a 12-player event scores 12; last place scores 1.{money_ ? ' Net is display-only: prizes and bounties won minus buy-ins, rebuys and add-ons.' : ''}
        </p>
      </section>

      {board.events.length > 0 && (
        <section className="tn-card">
          <h2>Events</h2>
          <ul className="tn-season-events">
            {[...board.events].reverse().map((e) => (
              <li key={e.id}>
                <a href={`/tn/${e.id}`}>{e.name}</a>
                <span className="muted">
                  {localTime(e.finishedAt)} · {e.entrants} players · won by {e.winners.join(', ') || '–'}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}

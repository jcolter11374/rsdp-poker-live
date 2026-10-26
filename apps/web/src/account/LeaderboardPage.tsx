import { useEffect, useState } from 'react';
import { chipFormat } from '../format';
import { Shell } from './AccountPages';
import { fetchLeaderboard, type LeaderPeriod, type LeaderRow } from './api';

/** Amounts come in cents (a chip counts as 100), so one format fits chip and cents tables alike. */
const fmt = chipFormat(true);
const signed = (n: number) => (n > 0 ? `+${fmt(n)}` : n < 0 ? `−${fmt(-n)}` : '0');

const PERIODS: { id: LeaderPeriod; label: string }[] = [
  { id: 'month', label: 'This month' },
  { id: 'year', label: 'This year' },
  { id: 'all', label: 'All time' },
];

type SortKey = 'profit' | 'hands' | 'biggestPot';
const SORTS: { id: SortKey; label: string }[] = [
  { id: 'profit', label: 'Profit' },
  { id: 'hands', label: 'Hands played' },
  { id: 'biggestPot', label: 'Biggest pot' },
];

/** /leaderboard: the group's cash game standings. Only real games count, never practice tables with bots. */
export function LeaderboardPage() {
  const params = new URLSearchParams(location.search);
  const [period, setPeriod] = useState<LeaderPeriod>((['month', 'year', 'all'] as const).find((p) => p === params.get('period')) ?? 'month');
  const [sort, setSort] = useState<SortKey>('profit');
  const [rows, setRows] = useState<LeaderRow[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setRows(null);
    fetchLeaderboard(period)
      .then((r) => (setRows(r.rows), setError('')))
      .catch((e: Error) => setError(e.message));
    history.replaceState(null, '', period === 'month' ? '/leaderboard' : `/leaderboard?period=${period}`);
  }, [period]);

  const sorted = rows && [...rows].sort((a, b) => b[sort] - a[sort] || b.hands - a.hands);

  return (
    <Shell title="Leaderboard">
      <div className="leaders">
        <div className="leader-controls">
          <div className="segmented" role="tablist" aria-label="Period">
            {PERIODS.map((p) => (
              <button key={p.id} role="tab" aria-selected={period === p.id} className={period === p.id ? 'on' : ''} onClick={() => setPeriod(p.id)}>
                {p.label}
              </button>
            ))}
          </div>
          <label>
            Rank by{' '}
            <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
              {SORTS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {error && <p className="error">{error}</p>}
        {!sorted ? (
          !error && <p className="muted">Loading…</p>
        ) : sorted.length === 0 ? (
          <p className="muted">No real games {period === 'month' ? 'this month' : period === 'year' ? 'this year' : 'yet'}. Practice tables with bots don't count.</p>
        ) : (
          <table className="leader-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Player</th>
                <th className={sort === 'profit' ? 'on' : ''}>Profit</th>
                <th>Games</th>
                <th className={sort === 'hands' ? 'on' : ''}>Hands</th>
                <th className={sort === 'biggestPot' ? 'on' : ''}>Biggest pot</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r, i) => (
                <tr key={r.key}>
                  <td className="muted">{i + 1}</td>
                  <td className="name">{r.name}</td>
                  <td className={r.profit > 0 ? 'up' : r.profit < 0 ? 'down' : ''}>{signed(r.profit)}</td>
                  <td>{r.sessions}</td>
                  <td>{r.hands.toLocaleString()}</td>
                  <td>{fmt(r.biggestPot)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="hint">
          Real cash games only: tables where two or more people played and no practice bot sat in. A game counts in the month it was last played. Chips count as whole units, so chip and
          cents tables add up. See your own <a href="/profile">profit graph</a>.
        </p>
      </div>
    </Shell>
  );
}

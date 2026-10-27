import { useEffect, useState } from 'react';
import { fetchGraph, fetchPracticeGraph, resetPracticeGraph, type PracticeGraphData, type ProfitSession } from './api';
import { signed, ticks, useWidth } from './chart';

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

const HEIGHT = 180;
const PAD = { top: 12, right: 12, bottom: 22, left: 52 };

/** My running total across every real cash game, with each night's result on hover. */
export function ProfitGraph({ refreshKey, practiceGames }: { refreshKey: unknown; practiceGames: number }) {
  const [sessions, setSessions] = useState<ProfitSession[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    fetchGraph()
      .then((g) => (setSessions(g.sessions), setError('')))
      .catch((e: Error) => setError(e.message));
  }, [refreshKey]);

  if (error) return <p className="error">{error}</p>;
  if (!sessions) return <p className="muted">Loading…</p>;
  if (sessions.length === 0) {
    return (
      <div className="profit-empty">
        <svg viewBox="0 0 200 60" aria-hidden="true">
          <polyline points="4,44 40,36 72,40 108,22 140,28 196,10" />
        </svg>
        <p>
          <strong>No real games yet.</strong> Your graph starts after your first cash game with at least one other person.
        </p>
        <p className="muted">
          {practiceGames > 0
            ? `Your ${practiceGames} practice ${practiceGames === 1 ? 'game' : 'games'} (with bots, or on your own) ${practiceGames === 1 ? "isn't" : "aren't"} counted here or on the leaderboard.`
            : "Practice games with bots never count here or on the leaderboard."}
        </p>
      </div>
    );
  }
  return (
    <ProfitChart
      sessions={sessions}
      totalLabel="All time"
      hint="Real games with friends only: practice games (with bots, or on your own) and tables you hid are left out. Chips count as whole units, so chip and cents tables add up."
    />
  );
}

/**
 * My running total at practice games (bots, or on my own) since I last reset
 * it. Kept apart from the real graph, and never on the leaderboard.
 */
export function PracticeGraph({ refreshKey }: { refreshKey: unknown }) {
  const [graph, setGraph] = useState<PracticeGraphData | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    fetchPracticeGraph()
      .then((g) => (setGraph(g), setError('')))
      .catch((e: Error) => setError(e.message));
  }, [refreshKey, reloads]);

  const reset = async () => {
    if (!confirm('Start your practice graph again from zero? Your practice games stay in your list; only this graph forgets them.')) return;
    setBusy(true);
    try {
      await resetPracticeGraph();
      setReloads((n) => n + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  };

  if (error) return <p className="error">{error}</p>;
  if (!graph) return <p className="muted">Loading…</p>;
  const since = graph.since ? `Since you reset it on ${day(graph.since)}.` : 'Since your first practice game.';
  const resetButton = (
    <button className="link" disabled={busy} onClick={reset} title="Start the practice graph again from zero">
      Reset
    </button>
  );
  if (graph.sessions.length === 0) {
    return (
      <p className="muted">
        {graph.since
          ? `Nothing yet since you reset it on ${day(graph.since)}. Play a practice game and it starts here.`
          : 'No practice games yet. Try "Practice with bots" on the home page and your results show up here.'}
      </p>
    );
  }
  return (
    <ProfitChart
      sessions={graph.sessions}
      totalLabel={graph.since ? 'Since reset' : 'All practice'}
      hint={`Practice games only (with bots, or on your own), counted hand by hand. ${since} Never on the leaderboard.`}
      extra={resetButton}
    />
  );
}

function ProfitChart({ sessions, totalLabel, hint, extra }: { sessions: ProfitSession[]; totalLabel: string; hint: string; extra?: React.ReactNode }) {
  const [hover, setHover] = useState<number | null>(null);
  const [listView, setListView] = useState(false);
  const [width, box] = useWidth();

  let run = 0;
  const points = sessions.map((s) => ({ ...s, total: (run += s.net) }));
  const total = run;
  const won = sessions.filter((s) => s.net > 0).length;
  const best = sessions.reduce((a, b) => (b.net > a.net ? b : a));

  // The line starts at 0 before the first game.
  const values = [0, ...points.map((p) => p.total)];
  const lo = Math.min(0, ...values);
  const hi = Math.max(0, ...values);
  const yTicks = ticks(lo, hi);
  const yMin = Math.min(lo, yTicks[0] ?? lo);
  const yMax = Math.max(hi, yTicks.at(-1) ?? hi, yMin + 1);
  const plotW = width - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (values.length === 1 ? 0 : (i / (values.length - 1)) * plotW);
  const y = (v: number) => PAD.top + (1 - (v - yMin) / (yMax - yMin)) * plotH;
  const path = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * width;
    const i = Math.round(((px - PAD.left) / plotW) * (values.length - 1));
    setHover(i >= 1 && i < values.length ? i : null);
  };
  const h = hover !== null ? points[hover - 1] : null;

  return (
    <div className="profit">
      <div className="profit-tiles">
        <div>
          <span className="muted">{totalLabel}</span>
          <strong className={total > 0 ? 'up' : total < 0 ? 'down' : ''}>{signed(total)}</strong>
        </div>
        <div>
          <span className="muted">Games</span>
          <strong>{sessions.length}</strong>
        </div>
        <div>
          <span className="muted">Winning games</span>
          <strong>
            {won} of {sessions.length}
          </strong>
        </div>
        <div>
          <span className="muted">Best game</span>
          <strong className={best.net > 0 ? 'up' : ''}>{signed(best.net)}</strong>
        </div>
      </div>
      {listView ? (
        <table className="profit-table">
          <thead>
            <tr>
              <th>Game</th>
              <th>Result</th>
              <th>Running total</th>
            </tr>
          </thead>
          <tbody>
            {[...points].reverse().map((p) => (
              <tr key={p.tableId}>
                <td>
                  <a href={`/t/${p.tableId}`}>{p.name || 'Table'}</a> <span className="muted">{day(p.at)}</span>
                </td>
                <td className={p.net > 0 ? 'up' : p.net < 0 ? 'down' : ''}>{signed(p.net)}</td>
                <td>{signed(p.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="profit-chart" ref={box}>
          <svg
            width={width}
            height={HEIGHT}
            role="img"
            aria-label={`Running total over ${sessions.length} games, now ${signed(total)}`}
            onPointerMove={onMove}
            onPointerLeave={() => setHover(null)}
          >
            {yTicks.map((t) => (
              <g key={t}>
                <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} className={t === 0 ? 'zero' : 'grid'} />
                <text x={PAD.left - 6} y={y(t)} dy="0.32em" textAnchor="end">
                  {signed(t)}
                </text>
              </g>
            ))}
            <text x={PAD.left} y={HEIGHT - 6}>
              {day(sessions[0].at)}
            </text>
            {sessions.length > 1 && (
              <text x={width - PAD.right} y={HEIGHT - 6} textAnchor="end">
                {day(sessions.at(-1)!.at)}
              </text>
            )}
            <path d={path} className="line" />
            {values.length <= 40 && values.slice(1).map((v, i) => <circle key={i} cx={x(i + 1)} cy={y(v)} r={3} className="dot" />)}
            {h && hover !== null && (
              <g>
                <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + plotH} className="cross" />
                <circle cx={x(hover)} cy={y(h.total)} r={5} className="dot on" />
              </g>
            )}
          </svg>
          {h && hover !== null && (
            <div className="profit-tip" style={{ left: Math.min(Math.max(x(hover), 80), width - 80) }}>
              <strong>{h.name || 'Table'}</strong>
              <span className="muted">
                {day(h.at)} · {h.hands} {h.hands === 1 ? 'hand' : 'hands'}
              </span>
              <span>
                This game <b className={h.net > 0 ? 'up' : h.net < 0 ? 'down' : ''}>{signed(h.net)}</b>
              </span>
              <span>
                Running total <b>{signed(h.total)}</b>
              </span>
            </div>
          )}
        </div>
      )}
      <p className="hint">
        {hint}{' '}
        <button className="link" onClick={() => setListView((v) => !v)}>
          {listView ? 'Show the graph' : 'Show as a list'}
        </button>
        {extra && <> · {extra}</>}
      </p>
    </div>
  );
}

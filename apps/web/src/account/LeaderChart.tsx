import { useState } from 'react';
import type { LeaderRow } from './api';
import { signed, ticks, useWidth } from './chart';

/** Three slots, validated together on the dark panel (dataviz palette, all pairs): blue, orange, aqua. */
export const SERIES = ['#3987e5', '#d95926', '#199e70'];

const HEIGHT = 220;
const PAD = { top: 14, right: 70, bottom: 24, left: 52 };
const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/**
 * Running profit over the period for up to three players, one line each,
 * stepping at each of their games. A crosshair shows everyone's total on hover.
 */
export function LeaderChart({ rows }: { rows: LeaderRow[] }) {
  const [width, box] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const lines = rows.map((r) => {
    let run = 0;
    return { row: r, points: r.games.map((g) => ({ at: g.at, total: (run += g.net), net: g.net })) };
  });
  const times = [...new Set(lines.flatMap((l) => l.points.map((p) => p.at)))].sort((a, b) => a - b);
  if (times.length === 0) return null;
  const t0 = times[0];
  const t1 = times.at(-1)!;
  const values = [0, ...lines.flatMap((l) => l.points.map((p) => p.total))];
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const yTicks = ticks(lo, hi);
  const yMin = Math.min(lo, yTicks[0] ?? lo);
  const yMax = Math.max(hi, yTicks.at(-1) ?? hi, yMin + 1);
  const plotW = width - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  // A short lead-in before the first game, where everyone starts at 0.
  const lead = Math.max((t1 - t0) * 0.04, 60_000);
  const x = (t: number) => PAD.left + ((t - (t0 - lead)) / (t1 - (t0 - lead))) * plotW;
  const y = (v: number) => PAD.top + (1 - (v - yMin) / (yMax - yMin)) * plotH;
  const totalAt = (points: { at: number; total: number }[], t: number) => {
    let v = 0;
    for (const p of points) if (p.at <= t) v = p.total;
    return v;
  };

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * width;
    let best = 0;
    for (let i = 1; i < times.length; i++) if (Math.abs(x(times[i]) - px) < Math.abs(x(times[best]) - px)) best = i;
    setHover(px >= PAD.left - 10 ? best : null);
  };
  const ht = hover !== null ? times[hover] : null;

  return (
    <div className="leader-chart" ref={box}>
      <svg width={width} height={HEIGHT} role="img" aria-label={`Running profit for ${rows.map((r) => r.name).join(', ')}`} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        {yTicks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} className={t === 0 ? 'zero' : 'grid'} />
            <text x={PAD.left - 6} y={y(t)} dy="0.32em" textAnchor="end">
              {signed(t)}
            </text>
          </g>
        ))}
        <text x={PAD.left} y={HEIGHT - 6}>
          {day(t0)}
        </text>
        {t1 !== t0 && (
          <text x={width - PAD.right} y={HEIGHT - 6} textAnchor="end">
            {day(t1)}
          </text>
        )}
        {lines.map((l, i) => {
          // Steps: a total holds until that player's next game.
          let d = `M${x(t0 - lead).toFixed(1)},${y(0).toFixed(1)}`;
          for (const p of l.points) d += ` H${x(p.at).toFixed(1)} V${y(p.total).toFixed(1)}`;
          d += ` H${x(t1).toFixed(1)}`;
          const end = l.points.at(-1)?.total ?? 0;
          return (
            <g key={l.row.key}>
              <path d={d} className="line" style={{ stroke: SERIES[i] }} />
              {l.points.map((p) => (
                <circle key={p.at} cx={x(p.at)} cy={y(p.total)} r={3} className="dot" style={{ fill: SERIES[i] }} />
              ))}
              <text x={x(t1) + 6} y={y(end)} dy="0.32em" className="end-label">
                {l.row.name.slice(0, 9)}
              </text>
            </g>
          );
        })}
        {ht !== null && <line x1={x(ht)} x2={x(ht)} y1={PAD.top} y2={PAD.top + plotH} className="cross" />}
      </svg>
      {ht !== null && (
        <div className="profit-tip" style={{ left: Math.min(Math.max(x(ht), 80), width - 80) }}>
          <span className="muted">{day(ht)}</span>
          {lines.map((l, i) => (
            <span key={l.row.key}>
              <i className="legend-swatch" style={{ background: SERIES[i] }} /> {l.row.name} <b>{signed(totalAt(l.points, ht))}</b>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

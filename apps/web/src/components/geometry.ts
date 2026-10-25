import type { CSSProperties } from 'react';

/** Where things sit on the felt, in pixels from its top-left corner. */
export interface Point {
  x: number;
  y: number;
}

/**
 * A point a fraction `t` (0..1) of the way round a stadium (a rectangle with
 * round ends) inside a w×h box, starting at the bottom centre and going
 * clockwise on screen (bottom, left, top, right). The round ends sit on the
 * short sides, so a tall box gives a tall table for phones.
 */
export function stadiumPoint(t: number, w: number, h: number): Point {
  const cx = w / 2;
  const cy = h / 2;
  const tall = h > w;
  const r = Math.min(w, h) / 2;
  const straight = Math.abs(h - w);
  const quarter = (Math.PI * r) / 2;
  const half = Math.PI * r;
  const arc = (c: Point, from: number, d: number): Point => {
    const a = from + d / r;
    return { x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) };
  };
  let d = (((t % 1) + 1) % 1) * (2 * straight + 2 * half);
  if (tall) {
    const low = { x: cx, y: cy + straight / 2 };
    const high = { x: cx, y: cy - straight / 2 };
    if (d < quarter) return arc(low, Math.PI / 2, d);
    d -= quarter;
    if (d < straight) return { x: cx - r, y: low.y - d };
    d -= straight;
    if (d < half) return arc(high, Math.PI, d);
    d -= half;
    if (d < straight) return { x: cx + r, y: high.y + d };
    d -= straight;
    return arc(low, 0, d);
  }
  const left = { x: cx - straight / 2, y: cy };
  const right = { x: cx + straight / 2, y: cy };
  if (d < straight / 2) return { x: cx - d, y: cy + r };
  d -= straight / 2;
  if (d < half) return arc(left, Math.PI / 2, d);
  d -= half;
  if (d < straight) return { x: left.x + d, y: cy - r };
  d -= straight;
  if (d < half) return arc(right, -Math.PI / 2, d);
  d -= half;
  return { x: right.x - d, y: cy + r };
}

/**
 * Where each seat sits round the table, as a fraction (0..1) from the bottom
 * centre. The anchor seat (yours, or seat 0 when watching) is at the bottom,
 * the players present are spaced evenly, and empty seats share the gaps
 * between them in seat order. So four players at a ten-seat table sit at the
 * four quarters instead of bunched on one side.
 *
 * `clear` is how far an empty seat must stay from a player's nameplate and
 * `minGap` how far empty seats stay from each other, both as fractions of
 * the way round. When some gap is too small for its empty seats (a nearly
 * full table), every seat goes back to even spacing.
 */
export function seatFractions(taken: readonly boolean[], anchor: number, { clear = 0, minGap = 0 } = {}): number[] {
  const n = taken.length;
  const even = Array.from({ length: n }, (_, seat) => ((seat - anchor + n) % n) / n);
  if (n === 0) return even;
  // Seat positions counted round from the anchor.
  const players: number[] = [];
  for (let k = 0; k < n; k++) if (taken[(anchor + k) % n]) players.push(k);
  if (players.length === 0) return even;
  if (players[0] !== 0) players.unshift(0);
  const m = players.length;
  const span = 1 / m;
  const out = new Array<number>(n).fill(0);
  for (let i = 0; i < m; i++) {
    const from = players[i];
    const empties = (i + 1 < m ? players[i + 1] : n) - from - 1;
    out[(anchor + from) % n] = i * span;
    if (empties === 0) continue;
    if (span < 2 * clear + (empties - 1) * minGap || span < (empties + 1) * minGap) return even;
    if (empties === 1) {
      out[(anchor + from + 1) % n] = i * span + span / 2;
      continue;
    }
    // Evenly split, unless that would put the end ones too close to the players.
    const edge = Math.max(span / (empties + 1), clear);
    const room = span - 2 * edge;
    for (let j = 1; j <= empties; j++) out[(anchor + from + j) % n] = i * span + edge + (room * (j - 1)) / (empties - 1);
  }
  return out;
}

/** Part of the way from `a` to `b`. */
export const lerp = (a: Point, b: Point, f: number): Point => ({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });

export const px = (p: Point) => ({ left: `${p.x}px`, top: `${p.y}px` });

/** CSS variables for an animation that starts at `from` and ends where the element is (`to`). */
export const fromVars = (from: Point, to: Point) =>
  ({ '--dx': `${from.x - to.x}px`, '--dy': `${from.y - to.y}px` }) as CSSProperties;

/**
 * On a tall (phone) table, keeps a band of `band` pixels clear of seats in the
 * middle of each long side, so the board and pot have the full width of the
 * felt. Fractions from `seatFractions` are spread over what is left of the way
 * round. Wide tables, and bands that don't fit, are returned unchanged.
 */
export function clearSideBands(fractions: readonly number[], w: number, h: number, band: number): number[] {
  const straight = h - w;
  const b = Math.min(band, straight * 0.9);
  if (straight <= 0 || b <= 0) return [...fractions];
  const r = w / 2;
  const total = 2 * straight + 2 * Math.PI * r;
  // Where the bands start, measured round from the bottom centre.
  const quarter = (Math.PI * r) / 2;
  const left = quarter + (straight - b) / 2;
  const right = quarter + straight + Math.PI * r + (straight - b) / 2;
  const usable = total - 2 * b;
  return fractions.map((f) => {
    let d = (((f % 1) + 1) % 1) * usable;
    if (d >= left) d += b;
    if (d >= right) d += b;
    return d / total;
  });
}

/** A box around a point: how far it reaches left, right, up and down. */
export interface Reach {
  l: number;
  r: number;
  u: number;
  d: number;
}

/**
 * Where something of half-size `half` sits just outside `box` (around `from`),
 * on the way towards `to`, with `gap` pixels to spare. It never goes more than
 * `most` of the way.
 */
export function pastBox(from: Point, to: Point, box: Reach, half: { w: number; h: number }, gap: number, most = 0.8): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) return from;
  const ux = dx / len;
  const uy = dy / len;
  const sideX = (ux >= 0 ? box.r : box.l) + half.w + gap;
  const sideY = (uy >= 0 ? box.d : box.u) + half.h + gap;
  const t = Math.min(Math.abs(ux) > 1e-6 ? sideX / Math.abs(ux) : Infinity, Math.abs(uy) > 1e-6 ? sideY / Math.abs(uy) : Infinity);
  return lerp(from, to, Math.min(t / len, most));
}

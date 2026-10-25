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

/** Part of the way from `a` to `b`. */
export const lerp = (a: Point, b: Point, f: number): Point => ({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });

export const px = (p: Point) => ({ left: `${p.x}px`, top: `${p.y}px` });

/** CSS variables for an animation that starts at `from` and ends where the element is (`to`). */
export const fromVars = (from: Point, to: Point) =>
  ({ '--dx': `${from.x - to.x}px`, '--dy': `${from.y - to.y}px` }) as CSSProperties;

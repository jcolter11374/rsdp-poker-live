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
 * the way round. When some gap is too small for its empty seats (five empty
 * seats in a row on a phone), that gap grows just enough and the others share
 * what is left equally, so players stay as evenly spread as they can. When
 * nothing fits (a nearly full table), every seat goes back to even spacing.
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
  const emptiesAfter = players.map((from, i) => (i + 1 < m ? players[i + 1] : n) - from - 1);
  // The least room each player's stretch (the player and the empty seats after it) needs.
  const least = emptiesAfter.map((e) => (e === 0 ? Math.max(2 * clear - minGap, minGap) : Math.max(2 * clear + (e - 1) * minGap, (e + 1) * minGap)));
  if (least.reduce((a, b) => a + b, 0) > 1 + 1e-9) return even;
  // Every stretch gets the same share, or the least it needs if that's more: the share is found by halving.
  let lo = least.every((b) => b <= 1 / m) ? 1 / m : 0;
  let hi = lo || 1;
  for (let k = 0; lo < hi && k < 50; k++) {
    const mid = (lo + hi) / 2;
    if (least.reduce((a, b) => a + Math.max(b, mid), 0) > 1) hi = mid;
    else lo = mid;
  }
  const spans = least.map((b) => Math.max(b, lo));
  const out = new Array<number>(n).fill(0);
  let at = 0;
  for (let i = 0; i < m; i++) {
    const from = players[i];
    const empties = emptiesAfter[i];
    const span = spans[i];
    out[(anchor + from) % n] = at;
    if (empties === 1) out[(anchor + from + 1) % n] = at + span / 2;
    else if (empties > 1) {
      // Evenly split, unless that would put the end ones too close to the players.
      const edge = Math.max(span / (empties + 1), clear);
      const room = span - 2 * edge;
      for (let j = 1; j <= empties; j++) out[(anchor + from + j) % n] = at + edge + (room * (j - 1)) / (empties - 1);
    }
    at += span;
  }
  return out;
}

/** How far a seat's box reaches from its spot: left, right, up and down, in pixels. */
export interface Extent {
  l: number;
  r: number;
  u: number;
  d: number;
}

/** Whether box `a` round `p` and box `b` round `q` are at least `gap` apart, side by side or one above the other. */
export function apart(p: Point, a: Extent, q: Point, b: Extent, gap = 0): boolean {
  return p.x + a.r + gap <= q.x - b.l || q.x + b.r + gap <= p.x - a.l || p.y + a.d + gap <= q.y - b.u || q.y + b.d + gap <= p.y - a.u;
}

/** The way round a stadium inside a w×h box, in pixels. */
export const stadiumLength = (w: number, h: number) => 2 * Math.abs(w - h) + Math.PI * Math.min(w, h);

/**
 * Whether no seat's box covers another's, with the seats at `fractions` round a w×h stadium. `box` gives each seat's box
 * (a player's nameplate and cards, or an empty seat's button); a seat it gives nothing for is left out of the check.
 * `gap` is the room wanted between two seats, or a function giving it for each pair (below 0 lets them overlap that much).
 */
export function seatsApart(
  fractions: readonly number[],
  w: number,
  h: number,
  box: (seat: number) => Extent | undefined,
  gap: number | ((a: number, b: number) => number) = 0,
): boolean {
  const spots = fractions.map((f) => stadiumPoint(f, w, h));
  const boxes = fractions.map((_, seat) => box(seat));
  for (let a = 0; a < spots.length; a++)
    for (let b = a + 1; b < spots.length; b++) {
      const ba = boxes[a];
      const bb = boxes[b];
      if (ba && bb && !apart(spots[a], ba, spots[b], bb, typeof gap === 'number' ? gap : gap(a, b))) return false;
    }
  return true;
}

/**
 * Seats spaced by how much room each one's box really needs, for when the even spacing of `seatFractions` would put one
 * nameplate on another (#363). That spacing counts the way round the table, so it asks a wide nameplate for its full
 * width everywhere, though at the round ends of the table seats sit one above the other and need only their height.
 * With four-card Omaha's wide nameplates on a laptop, or six or more players, the room it asked for ran out, and every
 * seat went back to even spacing, closer than the nameplates are wide.
 *
 * Here each player is placed round from the anchor (at the bottom) at the first spot where its box clears the seats
 * before it, with the empty seats between them placed the same way. Players are then spread as evenly as that allows:
 * each gap is the same share of the way round, or the least its seats need when that's more. Fractions as from
 * `seatFractions`, or null when the boxes can't all fit round the table. With `players`, only players' boxes are kept
 * apart: empty seats share what's left between them.
 */
export function spreadByBoxes(
  taken: readonly boolean[],
  anchor: number,
  w: number,
  h: number,
  box: (seat: number) => Extent,
  { gap = 0, players = false } = {},
): number[] | null {
  const n = taken.length;
  if (n === 0 || w <= 0 || h <= 0) return null;
  // Spots round the table every few pixels: plenty for seats that are 40px tall or more.
  const steps = Math.max(360, Math.min(1440, Math.round(stadiumLength(w, h) / 3)));
  const spot = Array.from({ length: steps }, (_, i) => stadiumPoint(i / steps, w, h));
  const at = (i: number) => spot[((i % steps) + steps) % steps];
  const seatOf = (k: number) => (anchor + k) % n;
  // The anchor and the players, counted round from the anchor. The anchor stays at the bottom even when it's empty.
  const stops = [0];
  for (let k = 1; k < n; k++) if (taken[seatOf(k)]) stops.push(k);
  const m = stops.length;
  const boxes = Array.from({ length: n }, (_, k) => box(seatOf(k)));
  const counts = (k: number) => !players || k === 0 || taken[seatOf(k)];
  /** The first spot after `from` where seat k's box is clear of every placed one by `space` (or Infinity when there is none). */
  const firstClear = (from: number, k: number, placed: { i: number; k: number }[], space: number) => {
    if (!Number.isFinite(from)) return Infinity;
    if (!counts(k)) return from + 1;
    const near = placed.filter((p) => counts(p.k));
    for (let i = from + 1; i <= from + steps; i++) if (near.every((p) => apart(at(i), boxes[k], at(p.i), boxes[p.k], space))) return i;
    return Infinity;
  };
  /**
   * The j-th player's stretch, from them (at `from`) to the next player: its empty seats each placed at the first spot
   * clear of the seats before them by `space`, and the first spot where the next player would be clear of them all.
   */
  const stretch = (j: number, from: number, space: number) => {
    const next = j + 1 < m ? stops[j + 1] : n;
    const placed = [{ i: from, k: stops[j] }];
    let cur = from;
    for (let k = stops[j] + 1; k < next; k++) {
      cur = firstClear(cur, k, placed, space);
      // No room for this empty seat: the stretch can't fit, and nothing after it can be placed.
      if (!Number.isFinite(cur)) return { placed, end: Infinity };
      placed.push({ i: cur, k });
    }
    return { placed, end: firstClear(cur, next % n, placed, space) };
  };
  /** Players placed round the table, each gap at least `share` spots: where they go, and where the anchor would come round. */
  const chain = (share: number) => {
    const where = [0];
    let s = 0;
    for (let j = 0; j < m; j++) {
      s = Math.max(stretch(j, s, gap).end, s + share);
      if (!Number.isFinite(s) || s > steps) return { where, end: Infinity };
      if (j + 1 < m) where.push(s);
    }
    return { where, end: s };
  };
  if (chain(0).end > steps) return null;
  // The biggest even share that still fits, found by halving.
  let lo = 0;
  let hi = Math.floor(steps / m);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (chain(mid).end <= steps) lo = mid;
    else hi = mid - 1;
  }
  const where = chain(lo).where;
  const out = new Array<number>(n).fill(0);
  for (let j = 0; j < m; j++) {
    const from = where[j];
    const to = j + 1 < m ? where[j + 1] : steps;
    const k0 = stops[j];
    const empties = (j + 1 < m ? stops[j + 1] : n) - k0 - 1;
    out[seatOf(k0)] = from / steps;
    if (empties === 0) continue;
    if (players) {
      // Only the players count: the empty seats split the gap between them evenly.
      for (let e = 1; e <= empties; e++) out[seatOf(k0 + e)] = (from + ((to - from) * e) / (empties + 1)) / steps;
      continue;
    }
    // The empty seats spread out as far as the gap allows: the same extra room between each of them and the seats either
    // side, found by halving. (Even steps round the table would crowd the ones where it curves into the long sides.)
    let best = stretch(j, from, gap).placed;
    let low = 0;
    let high = to - from;
    for (let t = 0; t < 12 && high - low > 0.5; t++) {
      const extra = (low + high) / 2;
      const tried = stretch(j, from, gap + extra);
      if (tried.end <= to) {
        best = tried.placed;
        low = extra;
      } else high = extra;
    }
    for (const p of best.slice(1)) out[seatOf(p.k)] = p.i / steps;
  }
  return out;
}

/**
 * How far two empty seats may overlap and still count as clear of each other. Their buttons are pills with rounded ends,
 * and on some windows today's spacing has two of them meet by a pixel or two, which covers nothing; moving every seat
 * for that would change tables that look right.
 */
export const EMPTY_SEATS_MAY_TOUCH = 6;

/**
 * Where each seat sits round a w×h desktop table. The spacing of `seatFractions` is kept wherever no box covers another,
 * so tables that look right stay as they are. Otherwise seats are spaced by their boxes (`spreadByBoxes`): with `gap`
 * between them if there's room, touching if not, and if even that can't fit, with players kept apart and empty seats
 * squeezed in between. A table that full falls back to even spacing. Until every seat has a box (before the first
 * measure), the spacing of `seatFractions` is kept.
 *
 * `keep` is where the seats are now. While no box covers another there, they stay: boxes only grow while the seats are
 * worked out from the same measure (a stud hand's row of cards gets longer each street, a badge appears under a
 * nameplate), and a seat shouldn't shift a few pixels every time that happens when it has room where it is.
 */
export function placeSeats(
  taken: readonly boolean[],
  anchor: number,
  w: number,
  h: number,
  {
    clear = 0,
    minGap = 0,
    box,
    gap = 0,
    keep,
  }: { clear?: number; minGap?: number; box: (seat: number) => Extent | undefined; gap?: number; keep?: readonly number[] },
): readonly number[] {
  const even = seatFractions(taken, anchor, { clear, minGap });
  const boxes = taken.map((_, seat) => box(seat));
  if (boxes.some((b) => !b)) return even;
  const sized = (seat: number) => boxes[seat]!;
  const fine = (fractions: readonly number[]) =>
    seatsApart(fractions, w, h, sized, (a, b) => (!taken[a] && !taken[b] ? -EMPTY_SEATS_MAY_TOUCH : 0));
  if (keep?.length === taken.length && fine(keep)) return keep;
  if (fine(even)) return even;
  for (const g of gap > 0 ? [gap, 0] : [0]) {
    const spread = spreadByBoxes(taken, anchor, w, h, sized, { gap: g });
    if (spread && seatsApart(spread, w, h, sized)) return spread;
  }
  const players = spreadByBoxes(taken, anchor, w, h, sized, { players: true });
  return players && seatsApart(players, w, h, (seat) => (taken[seat] ? boxes[seat] : undefined)) ? players : even;
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
  /** Half the nameplate's width, without cards, so layout doesn't shift as cards come and go. */
  pod?: number;
}

/**
 * Where a seat's bet goes: just in front of its nameplate and cards (`box`,
 * around `from`), towards the middle (`to`). Seats above or below the middle
 * get it straight below or above them, seats at the ends straight beside
 * them, leaning a little towards the middle, the way chips sit on a real
 * table. `half` is the bet's half-size; it never goes more than `most` of
 * the way.
 */
export function inFront(from: Point, to: Point, box: Reach, half: { w: number; h: number }, gap: number, lean = 0.12, most = 0.8): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  // `to` is the middle, so it is also half the felt's width and height.
  const vertical = Math.abs(dy) / Math.max(1, to.y) >= Math.abs(dx) / Math.max(1, to.x);
  if (vertical) {
    const reach = Math.min((dy >= 0 ? box.d : box.u) + half.h + gap, Math.abs(dy) * most);
    return { x: from.x + dx * lean, y: from.y + Math.sign(dy || 1) * reach };
  }
  const reach = Math.min((dx >= 0 ? box.r : box.l) + half.w + gap, Math.abs(dx) * most);
  return { x: from.x + Math.sign(dx) * reach, y: from.y + dy * lean };
}

/** The dealer button: beside the seat's bet spot, on the side away from the middle. */
export function besideBet(bet: Point, from: Point, to: Point, half: { w: number; h: number }, gap: number): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const vertical = Math.abs(dy) / Math.max(1, to.y) >= Math.abs(dx) / Math.max(1, to.x);
  if (vertical) return { x: bet.x - Math.sign(dx || 1) * (half.w + gap), y: bet.y };
  return { x: bet.x, y: bet.y - Math.sign(dy || -1) * (half.h + gap) };
}

/** A box on screen, as getBoundingClientRect gives it. */
export interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * On a phone on its side, how wide your own hand may be before it covers a neighbour's nameplate
 * (#304). Your cards sit just left of your nameplate, centred on it from top to bottom, so the room
 * is the gap to the nearest plate on the left among those level with the cards. Infinity when
 * nothing is in the way.
 */
export function handRoom(mine: Box, others: readonly Box[], cardHeight: number, margin = 6): number {
  const middle = (mine.top + mine.bottom) / 2;
  const top = Math.min(mine.top, middle - cardHeight / 2);
  const bottom = Math.max(mine.bottom, middle + cardHeight / 2);
  const edge = Math.max(-Infinity, ...others.filter((o) => o.bottom > top && o.top < bottom && o.right <= mine.left + margin).map((o) => o.right));
  return mine.left - margin - edge - margin;
}

/**
 * On a phone standing up, the stretch your own hand may take above your nameplate (`mine`) without
 * covering anyone (#304, #318): from the nearest nameplate on the left to the nearest on the right,
 * among those level with your cards (`cardHeight` tall), and never past the screen's `edges`.
 */
export function handSpan(mine: Box, others: readonly Box[], cardHeight: number, edges: { left: number; right: number }, margin = 6): { left: number; right: number } {
  const level = others.filter((o) => o.bottom > mine.top - cardHeight && o.top < mine.top + 8);
  const cx = (mine.left + mine.right) / 2;
  return {
    left: Math.max(edges.left + 3, ...level.filter((o) => o.right <= cx).map((o) => o.right + margin)),
    right: Math.min(edges.right - 3, ...level.filter((o) => o.left >= cx).map((o) => o.left - margin)),
  };
}

/**
 * On a phone standing up, the part of your hand's `span` (from handSpan) that also keeps clear of other players'
 * rows of cards level with it (#318). Each row in `rows` is where it would go without your cards, with the
 * middle of its player's nameplate (`from`): a row counts on its player's side, even one that has moved
 * over your nameplate. A row is level with your cards when it reaches more than 4px into their height, as
 * placeRow counts it. Your cards hang down to 8px into your nameplate (styles.css), `cardHeight` tall, and
 * count `lift` pixels higher, as the rows count them (a line on your nameplate lifts them).
 */
export function clearOfRows(
  mine: Box,
  rows: readonly { box: Box; from: number }[],
  cardHeight: number,
  span: { left: number; right: number },
  lift = 0,
  margin = 6,
): { left: number; right: number } {
  const bottom = mine.top + 8;
  const level = rows.filter(({ box }) => box.bottom > bottom - cardHeight - lift + 4 && box.top < bottom - 4);
  const cx = (mine.left + mine.right) / 2;
  return {
    left: Math.max(span.left, ...level.filter((r) => r.from < cx).map((r) => r.box.right + margin)),
    right: Math.min(span.right, ...level.filter((r) => r.from >= cx).map((r) => r.box.left - margin)),
  };
}

/**
 * Where your hand's left edge goes on a phone standing up, `w` wide: centred over your nameplate (at `cx`),
 * moved only as far as it must into `span`, the room clear of nameplates. When it can, it also keeps inside
 * `clear` (from clearOfRows), so the rows beside it keep their usual look. When it can't, it sits where it
 * leaves the rows on either side equally short of that, still inside `span`; when there's a row on only
 * one side, that's as far from it as `span` allows. A hand wider than `span` sits in the middle of it.
 */
export function placeHand(cx: number, w: number, span: { left: number; right: number }, clear: { left: number; right: number } = span): number {
  if (w > span.right - span.left) return (span.left + span.right - w) / 2;
  const left = Math.max(span.left, clear.left);
  const right = Math.min(span.right, clear.right);
  if (w <= right - left) return Math.min(Math.max(cx - w / 2, left), right - w);
  return Math.min(Math.max((left + right - w) / 2, span.left), span.right - w);
}

/** A card width and how much each card covers the one before it, in pixels. */
export interface HandFit {
  cw: number;
  overlap: number;
}

/**
 * Your hand made to fit the room beside your nameplate: first the cards bunch up, still showing
 * at least `minShow` of each card (enough for its rank and suit), then they get smaller, down to
 * `minCw`. Null when the hand fits as it is, so the usual look is kept.
 */
export function fitHand(cards: number, room: number, natural: HandFit, minShow = 0.45, minCw = 30): HandFit | null {
  const width = (f: HandFit) => f.cw + (cards - 1) * (f.cw - f.overlap);
  if (cards < 2 || !(room < width(natural))) return null;
  const show = Math.min(minShow, (natural.cw - natural.overlap) / natural.cw);
  const bunched = (room - natural.cw) / (cards - 1);
  if (bunched >= show * natural.cw) return { cw: natural.cw, overlap: Math.round(natural.cw - bunched) };
  const cw = Math.max(minCw, Math.min(natural.cw, Math.floor(room / (1 + (cards - 1) * show))));
  return { cw, overlap: Math.round(cw * (1 - show)) };
}

/** Another player's row of cards on a phone, as `placeRow` sets it out. */
export interface RowPlace {
  /** How far the row moves sideways from centred over the nameplate, in pixels (left is negative). */
  shift: number;
  /** The card's width: less than usual only when even bunched up the row can't fit. */
  cw: number;
  /** From one card's left edge to the next one's: less than usual when the row is bunched up. */
  step: number;
}

/**
 * On a phone, where another player's row of cards goes so it covers nobody else (#318). The row sits
 * above the player's nameplate (`plate`), from `row.top` to `row.bottom`. Anything in `blocks` that
 * reaches more than a few pixels into that height (another nameplate, your own cards, the line between
 * this row and a neighbour's) closes it in on the side where its middle lies, and so do the screen's
 * edges (`edges`). The row keeps its usual look and moves sideways into the room it has. Only when the
 * room is narrower than the row do its cards bunch up, still showing `minShow` of each card (its rank
 * and suit, for when it's turned up), and then get smaller, down to `minCw`. A row that still can't
 * fit sits in the middle of its room, but never off the screen. Null when the row fits centred over
 * the nameplate as it is.
 */
export function placeRow(
  plate: Box,
  row: { top: number; bottom: number },
  blocks: readonly Box[],
  edges: { left: number; right: number },
  natural: { cards: number; cw: number; step: number },
  { minShow = 0.5, minCw = 24, margin = 3 } = {},
): RowPlace | null {
  const { cards } = natural;
  if (cards < 1) return null;
  const cx = (plate.left + plate.right) / 2;
  let left = edges.left + margin;
  let right = edges.right - margin;
  for (const b of blocks) {
    // Only what reaches more than a sliver into the row: touching the rounded edge of a nameplate above is better than
    // bunching up. Not more, though: a seat drawn later covers an earlier one, so on one side of the table the nameplate
    // above would hide the top of the cards, where their rank and suit are.
    if (!(b.bottom > row.top + 4 && b.top < row.bottom - 4)) continue;
    if ((b.left + b.right) / 2 < cx) left = Math.max(left, b.right + margin);
    else right = Math.min(right, b.left - margin);
  }
  const room = right - left;
  const width = (f: { cw: number; step: number }) => f.cw + (cards - 1) * f.step;
  let fit = { cw: natural.cw, step: natural.step };
  if (cards > 1 && width(fit) > room) {
    const bunched = Math.floor((room - natural.cw) / (cards - 1));
    if (bunched >= Math.ceil(natural.cw * minShow)) fit = { cw: natural.cw, step: Math.min(natural.step, bunched) };
    else {
      const floor = Math.min(minCw, natural.cw);
      let cw = Math.max(floor, Math.min(natural.cw, Math.floor(room / (1 + (cards - 1) * minShow))));
      while (cw > floor && width({ cw, step: Math.ceil(cw * minShow) }) > room) cw--;
      fit = { cw, step: Math.min(natural.step, Math.ceil(cw * minShow)) };
    }
  }
  const w = width(fit);
  // Centred over the nameplate, then moved into the room; one that can't fit sits in the middle of it, on the screen.
  const from =
    w <= room ? Math.min(Math.max(cx - w / 2, left), right - w) : Math.min(Math.max((left + right - w) / 2, edges.left + margin), edges.right - margin - w);
  const shift = Math.round(from - (cx - w / 2));
  return shift === 0 && fit.step === natural.step && fit.cw === natural.cw ? null : { shift, ...fit };
}

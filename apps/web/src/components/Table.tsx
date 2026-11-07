import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';
import { runoutSteps } from '@rsdp/engine/core';
import type { SeatView, TableView } from '@rsdp/engine/wire';
import { betUnit, clock, type Fmt } from '../format';
import { handStrength } from '../strength';
import { PlayingCard } from './PlayingCard';
import { besideBet, clearOfRows, clearSideBands, fitHand, fitMiddle, fromVars, handRoom, handSpan, inFront, keepPlaced, lerp, placeHand, placeRow, placeSeats, px, seatFractions, seatsFine, stadiumPoint, type Box, type Extent, type HandFit, type Point, type Reach, type RowPlace } from './geometry';
import { BoardExtras, FeltExtras, SeatExtras } from './table/slots';
import { ChoiceLine, PickTag } from './table/Choice';
import { reportError } from '../reportError';
import { dealtSizes, splitsPot } from '../handSizes';
import { dealableGames } from '../tableGames';
import { baseChip, CHIP_SET, ChipStacks, DOLLAR_CHIPS } from './table/Chips';
import { feltStyle, usePrefs } from '../prefs';
import { CountUp, FeltEmblem, useLanded } from './table/Feel';
import { botOwnerLabel, botPlateLabel } from './table/BotLevels';
import { sharedWithFirstRun } from '../runout';

/** What a player who showed down made, when every card of theirs is face up to us. */
const shownHand = (gameId: string, seat: SeatView, board: string[]) =>
  seat.cards.length && seat.cards.every((c) => c.card !== '??') ? handStrength(gameId, seat.cards.map((c) => c.card), board) : null;

/** Re-renders on an interval while something on screen is counting down. */
export function useNow(active: boolean, ms = 200) {
  const [now, setNow] = useState(Date.now());
  // Catch up before painting when it starts again, so a countdown doesn't open on a stale time.
  useLayoutEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [active, ms]);
  return now;
}

/**
 * The acting seat's clock: a line that drains to empty at the deadline. Keyed on the turn, so where it
 * starts and how long it runs are fixed when it appears; changing them on every tick would make it jump.
 */
function TurnLine({ turn, paused, serverNow, skew, bank, low }: { turn: { startedAt: number; deadline: number }; paused: boolean; serverNow: number; skew: number; bank: boolean; low: boolean }) {
  // Read the clock here rather than taking the table's \`now\`, which stands still while nothing ticks (a pause, a fresh turn).
  const [start] = useState(() => {
    const ms = Math.max(0, turn.deadline - (paused ? serverNow : Date.now() + skew));
    return { fraction: Math.min(1, ms / (turn.deadline - turn.startedAt)), ms };
  });
  return (
    <div className={`timer ${bank ? 'bank' : ''}`}>
      <div
        className={`timer-fill ${low ? 'low' : ''}`}
        style={{ '--from': start.fraction, animationDuration: `${start.ms}ms`, animationPlayState: paused ? 'paused' : 'running' } as CSSProperties}
      />
    </div>
  );
}

/**
 * The room the felt has in its column: the column's width, and the felt's height plus its top and bottom margins.
 * The felt stretches to fill the column, so this stays the same whatever its margins are.
 */
function useRoom(ref: RefObject<HTMLElement>, on: boolean) {
  const [room, setRoom] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    const parent = el?.parentElement;
    if (!on || !el || !parent) return;
    const measure = () => {
      const css = getComputedStyle(el);
      const w = parent.clientWidth;
      // The exact height, not offsetHeight: that one is rounded while the margins (which grow with the table) are not, so
      // the sum moved by a pixel each time the scale changed, which changed the scale back: the table twitched (#350).
      const h = Math.round(el.getBoundingClientRect().height + parseFloat(css.marginTop) + parseFloat(css.marginBottom));
      setRoom((r) => (r.w === w && r.h === h ? r : { w, h }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    ro.observe(parent);
    return () => ro.disconnect();
  }, [ref, on]);
  return room;
}

/** The element's size, kept up to date as it changes. */
function useSize(ref: RefObject<HTMLElement>) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

/**
 * Your own hand's size on a phone as styles.css draws it, standing up and on its side, for two or
 * three cards, four, and five to seven: the card's width, and how much each card covers the one
 * before it, net of the 2px gap between them. Keep in step with those rules.
 */
const PHONE_HAND = {
  upright: { few: { cw: 60, overlap: 8 }, four: { cw: 60, overlap: 22 }, more: { cw: 38, overlap: 13 } },
  sideways: { few: { cw: 40, overlap: 8 }, four: { cw: 40, overlap: 22 }, more: { cw: 34, overlap: 13 } },
};

/**
 * Other players' cards on a phone as styles.css draws them, standing up and on its side: the card's width
 * and height, and the step from one card's left edge to the next (the card and the 2px gap, less the
 * overlap) for two or three cards, four, and five to seven. Keep in step with those rules.
 */
const PHONE_ROW = {
  upright: { cw: 30, height: 42, steps: [32, 22, 19], minCw: 24 },
  sideways: { cw: 24, height: 34, steps: [26, 16, 13], minCw: 20 },
};
type RowSize = (typeof PHONE_ROW)['upright'];

/**
 * A phone nameplate as the layout counts it: its measured width, and the height of a plain one (name and stack)
 * around its middle. A plate grows taller, evenly up and down, while it shows a line such as "Call 0.50"; counting
 * that would move cards about each time someone acts, so it isn't.
 */
const PLATE_HALF_HEIGHT = 25;
/**
 * How much taller a phone nameplate is while it shows a betting line under its stack ("Call 0.50"): 5.5px, half of it up
 * and half down, rounded up. (A hand's name at showdown adds about 10px.)
 */
const LINE_GROWTH = 6;
/** Other players' cards on a phone don't follow a nameplate's width by this many pixels or fewer (see useRowSpots). */
const JIGGLE = 2;
/**
 * Nor does your own hand, by this many: it moves when someone in the next seats acts and their nameplate widens, and a
 * move this small, which still leaves it clear of their nameplates and cards, is left out.
 */
const HAND_JIGGLE = 4;
const plateBox = (r: DOMRect, from: DOMRect = r): Box => {
  const middle = (r.top + r.bottom) / 2;
  return { left: from.left, right: from.right, top: middle - PLATE_HALF_HEIGHT, bottom: middle + PLATE_HALF_HEIGHT };
};

/**
 * Phone nameplates held at the widest each has been since `key` last changed (a new hand, a new window width, or someone
 * sitting down or leaving). A nameplate gets wider and narrower during a hand as lines such as "Call 0.50" come and go;
 * cards placed beside it would otherwise follow it back and forth. A nameplate is centred on its seat, so it's the
 * half-width that's held, around wherever the seat is now. Returns a function from a seat and its measured nameplate to
 * the box to count.
 */
function useHeldPlates(key: string): (seat: number, box: Box) => Box {
  const held = useRef({ key, halves: new Map<number, number>() });
  return (seat, box) => {
    if (held.current.key !== key) held.current = { key, halves: new Map() };
    const middle = (box.left + box.right) / 2;
    const half = Math.max(held.current.halves.get(seat) ?? 0, (box.right - box.left) / 2);
    held.current.halves.set(seat, half);
    return { ...box, left: middle - half, right: middle + half };
  };
}

/** A seat on a phone as the layout counts it: its nameplate (plain, and held at its widest: useHeldPlates) and its cards. */
interface PhoneSeat {
  seat: number;
  me: boolean;
  plate: Box;
  /** Cards on the table there, not counting a folded hand. */
  cards: number;
  /** A folded hand on its way to the middle. */
  mucked: boolean;
}

function phoneSeats(el: HTMLElement, hold: (seat: number, box: Box) => Box): PhoneSeat[] {
  return [...el.querySelectorAll<HTMLElement>('.seat[data-seat]')].map((s) => ({
    seat: Number(s.dataset.seat),
    me: s.classList.contains('me'),
    plate: hold(Number(s.dataset.seat), plateBox(s.querySelector<HTMLElement>('.nameplate')!.getBoundingClientRect())),
    cards: s.querySelectorAll('.hole:not(.mucked) .playing-card').length,
    mucked: !!s.querySelector('.hole.mucked .playing-card'),
  }));
}

/** How much further than placeRow's 4px another player's cards may reach into the empty bottom of a nameplate they're drawn over. */
const PADDING_UNDER_STACK = 6;

/** Another player's row of cards on a phone as placeRows sets it out: its place (null when centred as usual), its usual step, and the box it takes. */
interface RowPlan {
  place: RowPlace | null;
  step: number;
  box: Box;
}

/**
 * On a phone, another player's row of cards is wider than their nameplate, so at a crowded table it
 * could cover the next player's nameplate or cards (#318). This moves each row aside into the room it
 * has, and bunches it up only when there isn't enough (placeRow). A row depends only on the nameplates
 * and your own cards (`mine`, when they're on the table), never on another row: two rows level with each
 * other each keep to their side of the line halfway between their nameplates. Your own hand is placed
 * beside these rows as they'd be without it (useHandFit), then the rows are set out round it (useRowSpots).
 */
function placeRows(seats: readonly PhoneSeat[], size: RowSize, mine?: Box): Map<number, RowPlan> {
  const edges = { left: 0, right: document.documentElement.clientWidth };
  // The row's bottom edge sits 3px down the nameplate (styles.css: bottom: calc(100% - 3px)), counted from a plain plate's top.
  const band = (plate: Box) => ({ top: plate.top + 3 - size.height, bottom: plate.top + 3 });
  const rows = seats.filter((s) => !s.me && s.cards > 0);
  const plans = new Map<number, RowPlan>();
  for (const r of rows) {
    const at = band(r.plate);
    // A seat drawn later covers an earlier one, and yours covers them all. So these cards may reach a little further into
    // the bottom of an earlier seat's nameplate above them (10px in all), and keep their size instead of bunching up: a
    // plain nameplate has nothing written there (its stack ends 12px above its bottom). While that nameplate also shows a
    // line under the stack ("Call 0.50", a hand's name), the cards can cover the bottom of that line. The other way round,
    // a nameplate drawn over the cards would hide their rank and suit, so there the usual 4px holds. Both count plain
    // nameplates: while both show a line, one drawn over the cards can come a few pixels further down over them (#380 is
    // about the room between those seats). Counting the lines instead moved rows aside and back as lines came and went.
    const blocks: Box[] = seats
      .filter((s) => s !== r)
      .map((s) => (s.me || s.seat > r.seat ? s.plate : { ...s.plate, bottom: s.plate.bottom - PADDING_UNDER_STACK }));
    if (mine) blocks.push(mine);
    for (const o of rows) {
      const ob = band(o.plate);
      if (o === r || !(ob.bottom > at.top && ob.top < at.bottom)) continue;
      // Halfway between the two nameplates (between their middles, if they overlap).
      const [a, b] = r.plate.left <= o.plate.left ? [r.plate, o.plate] : [o.plate, r.plate];
      const x = a.right <= b.left ? (a.right + b.left) / 2 : (a.left + a.right + b.left + b.right) / 4;
      blocks.push({ left: x, right: x, top: at.top, bottom: at.bottom });
    }
    const step = size.steps[r.cards <= 3 ? 0 : r.cards === 4 ? 1 : 2];
    // Bunched up, half of each card still shows: its rank and suit, for when it's turned up.
    const place = placeRow(r.plate, at, blocks, edges, { cards: r.cards, cw: size.cw, step }, { minCw: size.minCw });
    const f = place ?? { shift: 0, cw: size.cw, step };
    const from = (r.plate.left + r.plate.right) / 2 - (f.cw + (r.cards - 1) * f.step) / 2 + f.shift;
    plans.set(r.seat, { place, step, box: { left: from, right: from + f.cw + (r.cards - 1) * f.step, ...at } });
  }
  return plans;
}

/**
 * How far each other player's row of cards on a phone has reached either side of the middle of their nameplate since `key`
 * last changed (as for useHeldPlates). Your own cards make room for those rows (useHandFit), and shouldn't move back each time
 * someone folds. Returns a function from the rows set out now to the rows to count: the reach held, around each nameplate's
 * middle now, from the top to the bottom of the row's place now (or, for a folded hand, where its row was last).
 */
function useHeldRows(key: string): (seats: readonly PhoneSeat[], plans: Map<number, RowPlan>) => { box: Box; from: number }[] {
  const held = useRef({ key, reach: new Map<number, { l: number; r: number; top: number; bottom: number }>() });
  return (seats, plans) => {
    if (held.current.key !== key) held.current = { key, reach: new Map() };
    const out: { box: Box; from: number }[] = [];
    for (const s of seats) {
      const middle = (s.plate.left + s.plate.right) / 2;
      const was = held.current.reach.get(s.seat);
      const box = plans.get(s.seat)?.box;
      if (!box && !was) continue;
      const now = box ? { l: box.left - middle, r: box.right - middle, top: box.top - s.plate.top, bottom: box.bottom - s.plate.top } : was!;
      const reach = was ? { ...now, l: Math.min(was.l, now.l), r: Math.max(was.r, now.r) } : now;
      held.current.reach.set(s.seat, reach);
      out.push({ box: { left: middle + reach.l, right: middle + reach.r, top: s.plate.top + reach.top, bottom: s.plate.top + reach.bottom }, from: middle });
    }
    return out;
  };
}

/** Your own hand on a phone: a smaller size when it has to fit (`cw`, `overlap`), and how far it moves aside (`shift`). */
interface MyHandFit extends HandFit {
  shift: number;
}

/**
 * On a phone, your hand can be wider than the gap between the players either side of you, and then
 * covers their nameplates (#304). Measured after each render, this moves your cards aside into the
 * room there is (standing up), and when there still isn't enough, bunches them up and makes them
 * smaller. Where there's room to spare, they also make room for the rows of cards beside them, which
 * are wider than their nameplates (#318). Null when they fit as they are. Desktop seats tuck the cards
 * into the nameplate, so they're left alone.
 */
function useHandFit(felt: RefObject<HTMLElement>, compact: boolean, plateKey: string): MyHandFit | null {
  const [fit, setFit] = useState<MyHandFit | null>(null);
  const hold = useHeldPlates(plateKey);
  // Seats glide to new places when someone sits down or leaves; measure again once they've arrived, and from then on hold
  // the rows where they are now, not where they were on the way.
  const [glides, setGlides] = useState(0);
  const holdRows = useHeldRows(`${plateKey}|${glides}`);
  useEffect(() => {
    const el = felt.current;
    if (!el || !compact) return;
    const arrived = (e: TransitionEvent) =>
      (e.target as HTMLElement).classList?.contains('seat') && (e.propertyName === 'left' || e.propertyName === 'top') && setGlides((g) => g + 1);
    el.addEventListener('transitionend', arrived);
    return () => el.removeEventListener('transitionend', arrived);
  }, [felt, compact]);
  useLayoutEffect(() => {
    const el = felt.current;
    const me = el?.querySelector<HTMLElement>('.seat.me');
    const plate = me?.querySelector<HTMLElement>('.nameplate');
    const cards = me?.querySelectorAll('.hole:not(.mucked) .playing-card').length ?? 0;
    let next: MyHandFit | null = null;
    let natural: HandFit | undefined;
    if (el && compact && plate && cards >= 2) {
      const sideways = window.matchMedia('(max-height: 500px)').matches;
      natural = PHONE_HAND[sideways ? 'sideways' : 'upright'][cards <= 3 ? 'few' : cards === 4 ? 'four' : 'more'];
      const seats = phoneSeats(el, hold);
      const others = seats.filter((s) => !s.me).map((s) => s.plate);
      if (sideways) {
        // On its side the cards hang off the seat's left edge, which can be wider than its nameplate.
        const size = cards >= 4 ? fitHand(cards, handRoom(plateBox(plate.getBoundingClientRect(), me!.getBoundingClientRect()), others, natural.cw * 1.4), natural) : null;
        next = size && { ...size, shift: 0 };
      } else {
        const mine = seats.find((s) => s.me)!.plate;
        const span = handSpan(mine, others, natural.cw * 1.4, { left: 0, right: document.documentElement.clientWidth });
        const size = fitHand(cards, span.right - span.left, natural);
        const f = size ?? natural;
        const w = f.cw + (cards - 1) * (f.cw - f.overlap);
        const cx = (mine.left + mine.right) / 2;
        // Centred over your nameplate, then moved into the room, and further when it can, so the rows beside it keep their
        // usual look as they'd be set out without your cards. A hand that still can't fit sits in the middle of the room.
        const rows = holdRows(seats, placeRows(seats, PHONE_ROW.upright));
        const from = placeHand(cx, w, span, clearOfRows(mine, rows, natural.cw * 1.4, span, LINE_GROWTH / 2));
        const shift = Math.round(from - (cx - w / 2));
        next = size || shift ? { ...f, shift } : null;
      }
    }
    // A nameplate gets a little wider or narrower as its stack or the line under it changes. Following that by a few pixels
    // would only make the cards jiggle, so a move that small is left out (HAND_JIGGLE).
    // (No fit and the usual size moved aside a little count as the same size.)
    const sized = (f: MyHandFit | null) => (!f || (f.cw === natural?.cw && f.overlap === natural.overlap) ? '' : `${f.cw}/${f.overlap}`);
    if (sized(next) !== sized(fit) || Math.abs((next?.shift ?? 0) - (fit?.shift ?? 0)) > HAND_JIGGLE) setFit(next);
  });
  return fit;
}

/** Where another player's cards go on a phone: moved aside by `shift` pixels, and bunched up when `margin` is set. */
interface RowSpot {
  shift: number;
  /** Each card's margin after the first, in pixels, when the row is bunched up (net of the 2px gap). */
  margin?: number;
  /** The card's width, when bunched up. */
  cw?: number;
}

/**
 * Other players' rows of cards on a phone, set out round your own (placeRows), measured after each
 * render. Seats gliding to new places are measured again when they arrive, through useHandFit's re-render.
 */
function useRowSpots(felt: RefObject<HTMLElement>, compact: boolean, plateKey: string): Record<number, RowSpot> {
  const [spots, setSpots] = useState<Record<number, RowSpot>>({});
  const hold = useHeldPlates(plateKey);
  useLayoutEffect(() => {
    const el = felt.current;
    const next: Record<number, RowSpot> = {};
    // Seats with a row of cards on the table now.
    const live = new Set<number>();
    if (el && compact) {
      const sideways = window.matchMedia('(max-height: 500px)').matches;
      const size = PHONE_ROW[sideways ? 'sideways' : 'upright'];
      const seats = phoneSeats(el, hold);
      // Your cards. Standing up, they hang from your nameplate's top, so a line on it lifts them, and taking it away drops
      // them again: they count from as high as a line lifts them over a plain nameplate, or higher if they are now, down to
      // where a plain nameplate puts them, so the rows round them don't move each time you act.
      const hole = el.querySelector<HTMLElement>('.seat.me .hole')?.getBoundingClientRect();
      const myPlate = el.querySelector<HTMLElement>('.seat.me .nameplate')?.getBoundingClientRect();
      const lift = myPlate && !sideways ? plateBox(myPlate).top - myPlate.top : 0;
      const mine = hole?.width
        ? { left: hole.left, right: hole.right, top: Math.min(hole.top, hole.top + lift - (sideways ? 0 : LINE_GROWTH / 2)), bottom: Math.max(hole.bottom, hole.bottom + lift) }
        : undefined;
      for (const [seat, { place, step }] of placeRows(seats, size, mine)) {
        live.add(seat);
        if (place) next[seat] = { shift: place.shift, ...(place.step < step || place.cw < size.cw ? { margin: place.step - place.cw - 2, cw: place.cw } : {}) };
      }
      // A folded hand slides to the middle from where it was, as it was, instead of jumping back over its nameplate first.
      for (const s of seats) {
        if (!s.mucked || !spots[s.seat]) continue;
        live.add(s.seat);
        next[s.seat] = spots[s.seat];
      }
    }
    // As for your own hand, a row that would move by only a pixel or two stays where it is (no spot is a shift of 0).
    const centred: RowSpot = { shift: 0 };
    const near = (a: RowSpot, b: RowSpot) => a.margin === b.margin && a.cw === b.cw && Math.abs(a.shift - b.shift) <= JIGGLE;
    const kept: Record<number, RowSpot> = {};
    for (const k of new Set([...Object.keys(next), ...Object.keys(spots)].map(Number))) {
      const was = spots[k];
      const now = next[k];
      const keep = live.has(k) && near(was ?? centred, now ?? centred);
      const v = keep ? was : now;
      if (v) kept[k] = v;
    }
    const same = Object.keys(kept).length === Object.keys(spots).length && Object.entries(kept).every(([k, v]) => spots[+k] === v);
    if (!same) setSpots(kept);
  });
  return spots;
}

/**
 * How far a seat's nameplate and cards reach from its centre, and half the nameplate's width. With `still`, cards on their
 * way to or back from the muck (they slide off towards the middle and back in when the next hand is dealt) are left out.
 */
function seatReach(seatEl: HTMLElement, still = false): Reach {
  const box = seatEl.getBoundingClientRect();
  const cx = box.left + box.width / 2;
  const cy = box.top + box.height / 2;
  const pod = box.width / 2;
  let { left, right, top, bottom } = box;
  const hole = seatEl.querySelector<HTMLElement>('.hole:not(.mucked)');
  if (hole && hole.childElementCount && !(still && getComputedStyle(hole).transform !== 'none')) {
    const r = hole.getBoundingClientRect();
    left = Math.min(left, r.left);
    right = Math.max(right, r.right);
    top = Math.min(top, r.top);
    bottom = Math.max(bottom, r.bottom);
  }
  return { l: cx - left, r: right - cx, u: cy - top, d: bottom - cy, pod };
}

/**
 * How far each seat's nameplate and cards reach from its centre, measured after
 * each render, so bets can sit just clear of them.
 */
function useSeatReach(felt: RefObject<HTMLElement>) {
  const [reach, setReach] = useState<Record<number, Reach>>({});
  useLayoutEffect(() => {
    const el = felt.current;
    if (!el) return;
    const next: Record<number, Reach> = {};
    let changed = false;
    el.querySelectorAll<HTMLElement>('.seat[data-seat]').forEach((seatEl) => {
      const seat = Number(seatEl.dataset.seat);
      const now = seatReach(seatEl);
      const pod = now.pod!;
      const was = reach[seat];
      if (!was || Math.abs(was.pod! - pod) > 4 || Math.abs(was.l - now.l) + Math.abs(was.r - now.r) + Math.abs(was.u - now.u) + Math.abs(was.d - now.d) > 4) changed = true;
      next[seat] = now;
    });
    if (changed || Object.keys(next).length !== Object.keys(reach).length) setReach(next);
  });
  return reach;
}

/** Whether a card is where it will stay: not being dealt, carried down or turned over. A winning card's short lift counts. */
const settled = (card: Element) => !card.getAnimations?.().some((a) => a instanceof CSSAnimation && a.playState === 'running');

/**
 * Where an element will be once it has grown in (a winner's line pops in from 40% and overshoots a little): its box,
 * less a scale and a move in its own `transform` about its centre. `zoom` is how much what holds it is drawn scaled.
 */
function grownIn(el: Element, zoom: number): Box {
  const r = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  const m = !style.transform || style.transform === 'none' || typeof DOMMatrixReadOnly === 'undefined' ? null : new DOMMatrixReadOnly(style.transform);
  if (!m || !m.is2D || m.b || m.c || m.a <= 0 || m.d <= 0 || style.scale !== 'none' || style.translate !== 'none') return r;
  const x = (r.left + r.right) / 2 - m.e * zoom;
  const y = (r.top + r.bottom) / 2 - m.f * zoom;
  const w = r.width / m.a / 2;
  const h = r.height / m.d / 2;
  return { left: x - w, right: x + w, top: y - h, bottom: y + h };
}

/**
 * The scale the middle of the table (`stack`, drawn scaled about its centre) needs so it covers no player's nameplate or
 * cards (#417): see fitMiddle.
 */
function boardScale(felt: HTMLElement, stack: HTMLElement): number {
  const now = parseFloat(getComputedStyle(stack).scale) || 1;
  const s = stack.getBoundingClientRect();
  const centre = { x: s.left + s.width / 2, y: s.top + s.height / 2 };
  const full = (b: Box) => ({ left: centre.x + (b.left - centre.x) / now, right: centre.x + (b.right - centre.x) / now, top: centre.y + (b.top - centre.y) / now, bottom: centre.y + (b.bottom - centre.y) / now });
  // What it holds, as it would be at full size: each row, with its cards where they are (a winning card lifted), and each
  // winner's line.
  const items: (Box & { line: boolean })[] = [];
  for (const child of stack.children) {
    for (const part of child.classList.contains('results') ? [...child.children] : [child]) {
      if (part.classList.contains('unseen')) continue;
      let b = grownIn(part, now);
      if (!b.right && !b.bottom) continue;
      for (const card of part.querySelectorAll('.playing-card')) {
        if (!settled(card)) continue;
        const r = card.getBoundingClientRect();
        b = { left: Math.min(b.left, r.left), right: Math.max(b.right, r.right), top: Math.min(b.top, r.top), bottom: Math.max(b.bottom, r.bottom) };
      }
      items.push({ ...full(b), line: !part.matches('.board-row, .pots') });
    }
  }
  if (!items.length) return 1;
  // Seats and the button glide to a new spot (when the table is first measured, on opening or reloading it, or when the
  // seats are spaced again), and a hand's fit is only ever made smaller. So each is measured where it is headed, not where
  // it is on the way: halfway in from the first guess at the table's size, they'd make the middle shrink for the hand (#462).
  const zoom = felt.offsetWidth ? felt.getBoundingClientRect().width / felt.offsetWidth : 1;
  const seats: Box[] = [];
  felt.querySelectorAll<HTMLElement>('.seat[data-seat]:not(.empty)').forEach((seat) => {
    const to = headedFor(seat, zoom);
    const plate = seat.querySelector('.nameplate');
    if (plate) seats.push(to(plate.getBoundingClientRect()));
    // The cards' own spots, and where they are once dealt or turned over (a winning card lifted). Cards on their way to
    // or from the muck are left out, as for the seats' reach.
    const hole = seat.querySelector<HTMLElement>('.hole:not(.mucked)');
    if (hole?.childElementCount && getComputedStyle(hole).transform === 'none') {
      seats.push(to(hole.getBoundingClientRect()));
      for (const card of hole.querySelectorAll('.playing-card')) if (settled(card)) seats.push(to(card.getBoundingClientRect()));
    }
  });
  const dealer = felt.querySelector<HTMLElement>('.dealer');
  return fitMiddle(items, seats, dealer ? headedFor(dealer, zoom)(dealer.getBoundingClientRect()) : null, centre);
}

/** Moves a box inside a seat (or the button) by what that seat has left to glide: its spot is set in its style, and while
 * its left and top are moving there, the drawn ones lag behind. */
function headedFor(el: HTMLElement, zoom: number): (b: Box) => Box {
  const now = getComputedStyle(el);
  const gap = (to: string, at: string) => {
    const d = (parseFloat(to) - parseFloat(at)) * zoom;
    return Number.isFinite(d) ? d : 0;
  };
  const x = gap(el.style.left, now.left);
  const y = gap(el.style.top, now.top);
  return (b) => ({ left: b.left + x, right: b.right + x, top: b.top + y, bottom: b.bottom + y });
}

/** The smallest box holding both. */
const grow = <T extends Extent>(a: T | undefined, b: T): T => {
  if (!a) return { ...b };
  const out: Record<string, number> = { ...(a as unknown as Record<string, number>) };
  for (const [side, v] of Object.entries(b)) if (typeof v === 'number') out[side] = typeof out[side] === 'number' ? Math.max(out[side], v) : v;
  return out as unknown as T;
};

/** The boxes seats are spaced by on a computer: yours, the biggest of everyone else's, and the biggest empty seat's. */
interface SeatBoxes {
  key: string;
  me?: Reach;
  others?: Reach;
  empty?: Extent;
}

/**
 * The lines a nameplate can gain during a hand: the last action, and one status line. That's the clock's last seconds or
 * the time bank, or once the hand is over the hand a player shows, which can widen the nameplate. The widest hand's name
 * stands for all of them (#427): of every name a hand can have, this one is the widest in the table's font (measured).
 * A game that splits the pot names both halves.
 */
const linesGained = (hiLo: boolean): readonly [string, string][] => [
  ['last-action a-call', 'Call'],
  ['status', hiLo ? 'Full House, Queens full of Sevens · Eight-Seven low' : 'Full House, Queens full of Sevens'],
];

/**
 * How far each player's seat will reach once the cards are out (#363), before they are: a copy of the seat is given the
 * game's cards at the sizes a hand reaches, with and without the lines a nameplate gains mid-hand, measured, and taken
 * away again before anything is drawn. Spacing the seats by these from the start means they don't move when the cards
 * are dealt, a line appears or a stud hand grows. It runs only when the game's shape, the seat size or the seating
 * changes: a full stud table makes about 60 copies, a few milliseconds.
 */
function dealtReach(felt: HTMLElement, seats: readonly HTMLElement[], sizes: readonly number[], hiLo: boolean): Map<HTMLElement, Reach> {
  const gained = linesGained(hiLo);
  // Up to four cards tuck into the nameplate, each size a little differently. A longer hand is a row over the nameplate,
  // and the longest row reaches furthest, so it alone stands for the others. Lined up with either end of the seat (as at
  // the table's left and right ends), it reaches at least as far as when centred.
  const long = sizes.filter((n) => n > 4);
  const shapes = [...sizes.filter((n) => n <= 4), ...(long.length ? [Math.max(...long)] : [])];
  const copies: [HTMLElement, HTMLElement][] = [];
  for (const seatEl of seats)
    for (const n of shapes)
      for (const edge of n > 4 && !seatEl.classList.contains('me') ? ['edge-left', 'edge-right'] : [null])
        for (const lines of [0, gained.length]) {
          const copy = seatEl.cloneNode(true) as HTMLElement;
          copy.removeAttribute('data-seat');
          copy.setAttribute('aria-hidden', 'true');
          copy.style.visibility = 'hidden';
          copy.style.transition = 'none';
          copy.classList.remove('folded', 'acting', 'winner', 'departed', 'fading', 'long-hand');
          copy.classList.add('has-cards');
          if (n > 4) copy.classList.add('long-hand');
          if (edge !== null) copy.classList.remove('edge-left', 'edge-right');
          if (edge) copy.classList.add(edge);
          const hole = copy.querySelector<HTMLElement>('.hole');
          const plate = copy.querySelector<HTMLElement>('.nameplate');
          if (!hole || !plate) continue;
          hole.className = `hole n${n}`;
          hole.replaceChildren(
            ...Array.from({ length: n }, () => {
              const card = document.createElement('div');
              card.className = 'playing-card small back';
              return card;
            }),
          );
          // Lines that come and go (and an Away pill: an away player isn't dealt in) give way to the ones a hand brings.
          plate.querySelectorAll(':scope > :is(.last-action, .status, .pill)').forEach((line) => line.remove());
          for (const [className, text] of gained.slice(0, lines)) {
            const line = document.createElement('div');
            line.className = className;
            line.textContent = text;
            plate.appendChild(line);
          }
          copies.push([seatEl, copy]);
        }
  for (const [, copy] of copies) felt.appendChild(copy);
  const out = new Map<HTMLElement, Reach>();
  for (const [seatEl, copy] of copies) out.set(seatEl, grow(out.get(seatEl), seatReach(copy)));
  for (const [, copy] of copies) copy.remove();
  return out;
}

/**
 * The boxes seats are spaced by on a computer (#363), each the biggest it has been since `key` (the shape of the game's
 * hands and the seats' size) last changed. They start from each player's dealt size (dealtReach), measured again when
 * someone sits down, and then grow with what's on screen: a player's nameplate and cards shrink when they fold and
 * between hands, and spacing by the biggest keeps the seats still then. Within a key they only grow, so the seats can't
 * flip back and forth.
 */
function useSeatBoxes(felt: RefObject<HTMLElement>, key: string, sizes: readonly number[], hiLo: boolean, seating: string, me: number | null, on: boolean): SeatBoxes {
  const [boxes, setBoxes] = useState<SeatBoxes>({ key: '' });
  const probed = useRef('');
  useLayoutEffect(() => {
    const el = felt.current;
    if (!el || !on) return;
    const fresh = boxes.key !== key;
    let { me: mine, others, empty }: SeatBoxes = fresh ? { key } : boxes;
    const probe = `${key}|${seating}|${me}`;
    if (fresh || probed.current !== probe) {
      probed.current = probe;
      const players = [...el.querySelectorAll<HTMLElement>('.seat[data-seat]:not(.departed)')];
      for (const [seatEl, r] of dealtReach(el, players, sizes, hiLo)) {
        if (Number(seatEl.dataset.seat) === me) mine = grow(mine, r);
        else others = grow(others, r);
      }
    }
    el.querySelectorAll<HTMLElement>('.seat').forEach((seatEl) => {
      if (seatEl.classList.contains('empty')) {
        const b = seatEl.getBoundingClientRect();
        empty = grow(empty, { l: b.width / 2, r: b.width / 2, u: b.height / 2, d: b.height / 2 });
      } else if (seatEl.dataset.seat !== undefined) {
        const r = seatReach(seatEl, true);
        if (Number(seatEl.dataset.seat) === me) mine = grow(mine, r);
        else others = grow(others, r);
      }
    });
    const moved = (a?: Extent, b?: Extent) => !a !== !b || (!!a && !!b && Math.abs(a.l - b.l) + Math.abs(a.r - b.r) + Math.abs(a.u - b.u) + Math.abs(a.d - b.d) > 2);
    if (fresh || moved(boxes.me, mine) || moved(boxes.others, others) || moved(boxes.empty, empty)) setBoxes({ key, me: mine, others, empty });
  });
  return boxes;
}

/** The last card of a single all-in run: it waited face down on the board before turning over (#308). */
function heldCards(hand: TableView['hand']): string[] {
  if (!hand || !hand.events.some((e) => e.t === 'run-it' && e.times === 1)) return [];
  return runoutSteps(hand.events).at(-1)?.flatMap((e) => e.cards) ?? [];
}

/** A short badge for a seat that is not playing, or null when it is. */
function seatBadge(s: SeatView, tournament: boolean): { text: string; kind: 'offline' | 'away' | 'info' } | null {
  if (s.departed) return { text: 'Knocked out', kind: 'info' };
  if (!s.online) return { text: s.sittingOut ? 'Away · offline' : 'Offline', kind: 'offline' };
  if (s.sittingOut) {
    if (s.sitOutReason === 'busted') return { text: 'Busted', kind: 'away' };
    if (s.sitOutReason === 'host') return { text: 'Sat out by host', kind: 'away' };
    if (s.sitOutReason === 'timeouts') return { text: 'Away · timed out', kind: 'away' };
    return { text: 'Away', kind: 'away' };
  }
  if (s.leaving) return { text: 'Leaving', kind: 'info' };
  // A newcomer to a tournament table may sit out one more hand on the button or small blind, so don't promise the next.
  if (s.waiting && !s.inHand) return { text: s.waitForBigBlind ? 'Waits for big blind' : tournament ? 'Joining' : 'Plays next hand', kind: 'info' };
  return null;
}

export interface DiscardPick {
  selected: number[];
  toggle: (index: number) => void;
}

/** Chips flying across the felt: bets swept into the pot, the pot pushed to a winner. */
interface Flight {
  id: number;
  from: Point;
  to: Point;
  delay: number;
  kind: 'sweep' | 'award';
}

let flightId = 0;

export function Table({
  view,
  skew,
  fmt,
  compact = false,
  onPickSeat,
  onAddBot,
  onSeatClick,
  discard,
  fill = false,
  wide = false,
  notice = null,
  noticeHidden = false,
  onNoticeRoom,
  games,
}: {
  view: TableView;
  /** Server clock minus ours. */
  skew: number;
  fmt: Fmt;
  /** Phone layout: a tall table and smaller seats. */
  compact?: boolean;
  onPickSeat?: (seat: number) => void;
  /** Put a practice bot in this empty seat. */
  onAddBot?: (seat: number) => void;
  onSeatClick?: (seat: SeatView) => void;
  discard?: DiscardPick | null;
  /** The table page's own table: on a big window it grows to fill its column. */
  fill?: boolean;
  /** The wide desktop layout (no side column): cards grow a little more than the nameplates. */
  wide?: boolean;
  /**
   * What happens next, in the middle of the table, before a cash game starts or after it stops (#383). There it takes
   * no room from the felt, so the seats don't move when it goes. With `onClick` it opens what it points to.
   */
  notice?: { text: string; onClick?: () => void } | null;
  /** `notice` is shown elsewhere: it is laid out in the middle, unseen, only to tell whether it would fit there. */
  noticeHidden?: boolean;
  /** Whether `notice` fits in the middle of the table without covering a seat (phones: see below). */
  onNoticeRoom?: (room: boolean) => void;
  /**
   * Every game the table deals (a rotation, a Dealer's choice menu, a tournament's games): it is laid out for all of
   * them, so the seats don't move when the game changes (#409). Left out, the game on now.
   */
  games?: readonly string[];
}) {
  const felt = useRef<HTMLDivElement>(null);
  const prefs = usePrefs();
  const size = useSize(felt);
  const reach = useSeatReach(felt);
  // Cards on a phone are placed by the nameplates around them, each held at its widest through a hand (useHeldPlates),
  // until the felt changes size or someone sits down or leaves.
  const plateKey = `${view.hand?.handNumber ?? 0}|${size.w}x${size.h}|${view.seats.map((s) => (s ? 1 : 0)).join('')}`;
  const handFit = useHandFit(felt, compact, plateKey);
  const rowSpots = useRowSpots(felt, compact, plateKey);
  const room = useRoom(felt, fill && !compact);
  // On a small phone table (a narrow phone, an iPhone SE in Safari standing up or on its side) the note in the middle is
  // squeezed between the seats at the sides until it runs onto the nameplates above or below it: there the page shows
  // it under the table instead (#383). The note stays laid out in the middle, unseen (noticeHidden), so this measures
  // where it would be. Showing it under the table doesn't make the felt bigger, so the answer can't flip back and forth.
  useLayoutEffect(() => {
    if (!onNoticeRoom) return;
    const el = felt.current;
    const note = el?.querySelector('.board-notice');
    if (!compact || !el || !note || !size.w) {
      onNoticeRoom(true);
      return;
    }
    const n = note.getBoundingClientRect();
    const covers = [...el.querySelectorAll<HTMLElement>('.seat')].some((s) => {
      const b = (s.classList.contains('empty') ? s : (s.querySelector('.nameplate') ?? s)).getBoundingClientRect();
      return Math.min(n.right, b.right) - Math.max(n.left, b.left) > 2 && Math.min(n.bottom, b.bottom) - Math.max(n.top, b.top) > 2;
    });
    onNoticeRoom(!covers);
  });
  const n = view.seats.length;
  // Rotate so your own seat is at the bottom.
  const offset = view.me.seat ?? 0;
  const hand = view.hand;
  const done = hand?.phase === 'complete';
  const live = !!hand && !done;
  const ticking = !view.paused && (!!view.turn || view.nextHandAt !== null || !!hand?.runItTwice.deadline);
  // While paused the server sends each clock as the time left at the view's own moment, so it stands still.
  const clientNow = useNow(ticking) + skew;
  const now = view.paused ? view.serverNow : clientNow;
  const myTurn = !!view.legal || !!view.canDraw || view.canVoteRunItTwice;
  const seatsClosed = !!view.choice?.closed;

  // Geometry. Before the first measure, assume a typical box so nothing jumps far.
  const w = size.w || (compact ? 320 : 800);
  const h = size.h || (compact ? 520 : 500);
  const center: Point = { x: w / 2, y: h / 2 };
  const perimeter = 2 * Math.abs(w - h) + Math.PI * Math.min(w, h);
  // Desktop seats shrink a little when the players and empty seats round the table leave them less room than a
  // nameplate (about 290px a player and 130px an empty seat at full size), and grow a little on a big window. A short
  // felt keeps them smaller too, so seats at the top and bottom leave the board (two boards, the result) room between them.
  const players = view.seats.filter(Boolean).length;
  const roomy = Math.min(1.1, h / 460, (perimeter * 0.92) / (players * 290 + (n - players) * 130));
  // On a big window the whole table grows with it (#317): k is the table's scale, from the room the felt has. Below k = 1
  // (laptops, and the replayer) the sizes above stay as they were, except in the wide layout (below).
  // A short, very wide window (an ultrawide screen, or a big one with tall browser bars) has the width but not the height:
  // there the wide layout packs the table tighter from top to bottom, so it still grows a little instead of shrinking (#347).
  const kTall = Math.min(1.9, room.h / 560, room.w / 1180);
  const kShort = wide ? Math.min(1.25, room.h / 470, room.w / 1180) : 0;
  // A window just too short for k = 1 keeps that packed table, a little smaller, down to the smallest seats' size (0.72),
  // rather than dropping to the laptop layout and its smallest seats: a few pixels of height (a tournament's strip, a
  // banner over the table) took a 2300x824 window from full-size seats and cards to the smallest (#385).
  const packed = wide && fill && !compact && !!room.w;
  const k = !fill || compact || !room.w ? 1 : Math.round(Math.max(kTall, kShort, packed ? 0.72 : 0) * 100) / 100;
  const grown = k > 1 || packed;
  // The wide layout's bigger cards (styles.css), except on a window so short (under about 620px, or a little taller with
  // a row above the table) that the table is held at that smallest size in less room than it needs: there your own big
  // cards would cover the board, so the seats keep their usual cards.
  const bigCards = grown && wide && Math.max(kTall, kShort) >= 0.72;
  // On such a window the board gives up some height too, so bets in front of the seats above and below don't reach it.
  const short = kShort > kTall && grown;
  // Seats grow with k unless the players round the felt need them smaller. The felt's size is estimated from the room
  // and k, not measured, because its margins grow with the seats and a measured size would feed back.
  // A player's nameplate with its tucked cards, at scale 1: wider with four cards, and with the wide layout's bigger cards.
  // A mixed table is laid out for every game it deals, the game on now included (a bomb pot can deal one that isn't on
  // the list), so neither the felt nor the seats move when the game changes (#409). Games too small for the players
  // seated can't be dealt now, so they're left out.
  const gameId = (hand ?? view.upcoming)?.gameId ?? '';
  const dealtKey = [...new Set([...dealableGames(games ?? [], players), gameId].filter(Boolean))].sort().join(',');
  const dealt = useMemo(() => (dealtKey ? dealtKey.split(',') : []), [dealtKey]);
  // The stud games tuck their cards in the same way on third and fourth street, before the row goes over the nameplate:
  // counted with them, so a side seat's three or four cards don't run off the window's edge (#385).
  const fourCard = dealt.some((g) => ['plo4', 'plo8', 'badugi', 'stud', 'razz', 'stud8'].includes(g));
  // Stud, triple draw and five- and six-card Omaha show a row of cards over the nameplate. In the wide layout those
  // cards are bigger too (#331), so the row stands taller and the felt leaves more room above the top seats.
  const longGame = wide && dealt.some((g) => ['plo5', 'plo6', 'plo5-8', 'plo6-8', 'stud', 'razz', 'stud8', 'td27'].includes(g));
  const topMargin = longGame ? 106 : 84;
  const podWidth = (wide ? 320 : 290) + (fourCard ? 50 : 0);
  // The felt's side margins hold half a side seat's nameplate.
  const sideMargin = 140 + (fourCard ? 30 : 0);
  const estW = room.w - 2 * sideMargin * k;
  const estH = room.h - (topMargin + 46) * k;
  const estPerimeter = 2 * Math.abs(estW - estH) + Math.PI * Math.min(estW, estH);
  const grownScale = Math.round(Math.max(0.72, Math.min(k, (estPerimeter * 0.92) / (players * podWidth + (n - players) * 130))) * 100) / 100;
  const seatScale = compact ? 1 : grown ? grownScale : Math.round(Math.max(0.72, roomy) * 100) / 100;
  // Each player's nameplate and cards, and an empty seat's button, at the biggest they've been (starting from their size once
  // dealt in, in every game the table deals) since the table's games or the seats' size last changed: they shrink when a
  // player folds and between hands, and the seats mustn't move then, when the cards come (#363) or when a mixed game
  // moves on to the next game (#409).
  // Everyone but you shares the biggest of their boxes, so a long name or a folded hand doesn't move anyone either.
  // Before a tournament table's first hand the view has no game yet (its settings say Hold'em whatever the event plays),
  // so there's nothing to size for until the deal, unless the page knows the tournament's games.
  const sizes = useMemo(() => dealtSizes(dealt), [dealt]);
  // Hi-lo games name two hands at a showdown ("… · Eight-Six low"), a longer line to make room for (#427).
  const hiLo = useMemo(() => dealt.some((g) => splitsPot(g)), [dealt]);
  const seating = view.seats.map((s) => s?.playerId ?? '').join(',');
  // The hand sizes, the seats' scale, then the layout (the placement below leaves the scale out of its key).
  const boxKey = (of: readonly number[], split: boolean) => `${of.join('-')}|${seatScale}|${split ? 'hi-lo' : ''}|${bigCards ? 'big-cards' : ''}|${short ? 'short' : ''}`;
  const sizedKey = boxKey(sizes, hiLo);
  const sized = useSeatBoxes(felt, sizedKey, sizes, hiLo, seating, view.me.seat, !compact);
  // A table too full to give every game's hands their room at once is spaced for the game on now instead, as before #409:
  // its seats move when the game changes, but nobody's nameplate covers another's.
  const nowSizes = useMemo(() => dealtSizes(gameId ? [gameId] : []), [gameId]);
  const nowHiLo = useMemo(() => splitsPot(gameId), [gameId]);
  const nowKey = boxKey(nowSizes, nowHiLo);
  // Games with the same hand sizes can still differ in their boxes: one hi-lo, one not (Omaha 5 and Omaha 5 hi-lo).
  const mixed = nowKey !== sizedKey;
  // What the table deals, for the fallback's mark below.
  const allGames = `${sizes.join('-')}${hiLo ? ' hi-lo' : ''}`;
  const sizedNow = useSeatBoxes(felt, nowKey, nowSizes, nowHiLo, seating, view.me.seat, !compact && mixed);
  // Empty seats keep half the widest nameplate (with its cards, so nothing moves on the deal) plus half an empty seat clear of
  // players, and some room between each other, so they never land on someone's nameplate.
  const emptyHalf = compact ? 34 : 58;
  const clearOf = (b: SeatBoxes) =>
    ((compact ? Math.max(60, ...view.seats.map((s, seat) => (s && reach[seat]?.pod ? reach[seat].pod! : 0))) : Math.max(120, b.me?.pod ?? 0, b.others?.pod ?? 0)) + emptyHalf + 6) /
    perimeter;
  const clear = clearOf(sized);
  const clearNow = clearOf(sizedNow);
  const minGap = (compact ? 72 : 120) / perimeter;
  // On a computer that spacing is kept unless it puts one seat on another; then seats are spaced by their real size (#363).
  // Worked out again only when something it depends on changes: the box spacing takes a moment, and the clocks re-render often.
  // Seats already placed from the same measure stay where they are while they have room (see placeSeats).
  const takenKey = view.seats.map((s) => (s ? 1 : 0)).join('');
  const mine = view.me.seat;
  const placed = useRef<{ key: string; w: number; h: number; at: readonly number[] } | null>(null);
  const measured = size.w > 0;
  const spread = useMemo(() => {
    const taken = [...takenKey].map((c) => c === '1');
    if (compact) return seatFractions(taken, offset, { clear, minGap });
    const was = placed.current;
    // They stay through a small change to the felt's size too (the dock or the top bar a few pixels taller mid-hand),
    // since placed afresh, a few pixels could send seats a long way. A bigger change (a banner coming or going, a new
    // window size) or the felt's first measure places them afresh: seats kept from the size before would depend on what
    // happened before, and two players with the same window could see different tables.
    // The seats' scale isn't part of it: a small change to the felt's size can step the scale too, and kept seats still
    // have to fit the boxes at the new scale (placeSeats checks).
    // `fallback` marks the spacing for the game on now that a mixed table falls back to (below), with the games' hand
    // sizes and whether any is hi-lo, so it's never taken for a spacing made before the table dealt those games.
    const place = (b: SeatBoxes, clearing: number, current: string, fallback = '') => {
      const boxOf = (seat: number): Extent | undefined => (!taken[seat] ? b.empty : seat === mine ? b.me : b.others);
      const key = `${b.key.split('|').filter((_, i) => i !== 1).join('|')}|${takenKey}|${offset}${fallback && `|for ${fallback}`}`;
      const near = keepPlaced(was, key, size.w, size.h);
      const at = placeSeats(taken, offset, w, h, { clear: clearing, minGap, box: boxOf, gap: 6, keep: near ? was.at : undefined });
      // Kept seats keep the size they were placed for, so a run of small changes can't carry them across a big one.
      const kept = near && at === was.at;
      const record = kept ? was : { key, w, h, at };
      return { at, record, kept, current: b.key === current, fine: [...taken.keys()].some((seat) => !boxOf(seat)) || seatsFine(at, taken, w, h, boxOf) };
    };
    let at: readonly number[];
    try {
      // A mixed table spaced for the game on now (below) stays that way while its seats are kept: trying every game's
      // boxes first would swap it between the two spacings whenever a few pixels tipped those in or out of fitting.
      const stay = mixed ? place(sizedNow, clearNow, nowKey, allGames) : null;
      let done = stay?.kept && stay.fine ? stay : place(sized, clear, sizedKey);
      if (mixed && !done.fine) done = stay!;
      at = done.at;
      // Seats placed with boxes from before this size and scale (the render before they're measured again) aren't
      // kept: the first measure of the felt would otherwise keep a spacing worked out for boxes at another scale.
      if (!measured) placed.current = null;
      else if (done.current) placed.current = done.record;
    } catch (error) {
      // A slip here mustn't take the table down: report it and fall back to the old spacing.
      reportError(error, 'error');
      at = seatFractions(taken, offset, { clear, minGap });
      placed.current = null;
    }
    return at;
  }, [takenKey, offset, mine, compact, clear, clearNow, minGap, w, h, measured, sized, sizedNow, mixed, allGames, sizedKey, nowKey]);
  // On a phone, no seat sits level with the middle, so the board gets the felt's full width.
  // The band fits the pot, the board rows and a result line, plus the seats either side of it.
  const boardRows = !hand || hand.family === 'flop' ? Math.max(1, (hand?.boards.length ?? 1) * (hand?.boards[0]?.length ?? 1)) : 0;
  const band = 30 + (boardRows > 1 ? boardRows * 52 : boardRows * 68) + 30 + 100;
  const fractions = compact ? clearSideBands(spread, w, h, Math.max(0, Math.min(band, (perimeter - n * 100) / 2))) : spread;
  const seatPoint = (seat: number) => stadiumPoint(fractions[seat], w, h);
  // Board cards grow with the felt, so a big window doesn't leave a small board in a sea of green.
  const boardCard = compact
    ? null
    : grown
      ? // With a row of big cards above and below it (#331), the board gives up a little height so bets don't reach it,
        // and a little more on a window too short for the big cards, so your own cards stay off it.
        Math.round(Math.max(short ? (bigCards ? 44 : 38) : 60, Math.min((wide ? 80 : 68) * k, w * 0.085, h * (longGame ? 0.19 : 0.21) * (short ? 0.82 : 1))))
      : Math.round(Math.max(60, Math.min(88, w * 0.062, h * 0.17)));
  // Bets sit just inside each seat's nameplate and cards, on the way to the middle.
  const guess: Reach = compact ? { l: 50, r: 50, u: 55, d: 25 } : { l: 100, r: 100, u: 70, d: 32 };
  // The board sits midway between the seats above it and below it (your own cards are bigger),
  // so on a short window it doesn't run into either.
  let boardShift = 0;
  if (!compact || w > h) {
    let above = 0;
    let below = h;
    view.seats.forEach((s, seat) => {
      if (!s) return;
      const p = seatPoint(seat);
      const r = reach[seat] ?? guess;
      if (Math.abs(p.x - center.x) > w * 0.3) return;
      if (p.y < center.y) above = Math.max(above, p.y + r.d);
      else below = Math.min(below, p.y - r.u);
    });
    boardShift = Math.max(-h * 0.15, Math.min(h * 0.15, (above + below) / 2 - center.y));
  }
  // Where the middle would run onto a player's nameplate or cards (two runs of the board, several winners' lines, a short
  // wide window), it is drawn smaller until it doesn't (#417). The seats don't move for it, and a scale doesn't change the
  // layout this measures, so it can't feed back on itself. Within a hand (at one window size) it only ever gets smaller, as
  // the board and the results come, so it doesn't grow and shrink back and forth. Phones: see #380.
  const stack = useRef<HTMLDivElement>(null);
  const [boardFit, setBoardFit] = useState(1);
  const fitHeld = useRef({ key: '', fit: 1, failed: false });
  const fitKey = `${hand?.handNumber ?? ''}|${w}x${h}`;
  useLayoutEffect(() => {
    let fit = 1;
    try {
      if (!compact && felt.current && stack.current) fit = boardScale(felt.current, stack.current);
    } catch (error) {
      // As for the seats: a slip here mustn't take the table down. The middle keeps its full size, as before #417.
      if (!fitHeld.current.failed) reportError(error, 'error');
      fitHeld.current.failed = true;
    }
    if (fitHeld.current.key === fitKey) fit = Math.min(fit, fitHeld.current.fit);
    fitHeld.current = { key: fitKey, fit, failed: fitHeld.current.failed };
    setBoardFit((f) => (f === fit ? f : fit));
  });
  const boardMiddle: Point = { x: center.x, y: center.y + boardShift };
  const betHalf = compact ? { w: 22, h: 10 } : { w: 30, h: 13 };
  const betPoint = (seat: number) => inFront(seatPoint(seat), boardMiddle, reach[seat] ?? guess, betHalf, compact ? 4 : 8);
  // The dealer button sits beside where that seat's bet goes, so the two never cover each other.
  const buttonPoint = (seat: number) => besideBet(betPoint(seat), seatPoint(seat), boardMiddle, betHalf, compact ? 18 : 24);

  // Winning cards, per board, and every card any winner used.
  const boardWinners = new Map<string, Set<string>>();
  const winningHole = new Set<string>();
  if (done)
    for (const a of hand!.awards) {
      const key = `${a.run}-${a.board}`;
      if (!boardWinners.has(key)) boardWinners.set(key, new Set());
      a.cards?.forEach((c) => {
        boardWinners.get(key)!.add(c);
        winningHole.add(c);
      });
    }
  const highlight = (card: string, set: Set<string> | undefined) => (!set || set.size === 0 || card === '??' ? '' : set.has(card) ? 'win' : 'dim');

  // One line per winner: total won and each different hand they won with. With two runs or two boards,
  // each hand says which run or board it won, so run 2's full house isn't shown as run 1's two pair.
  const results = new Map<number, { amount: number; handName?: string }>();
  if (done) {
    const twoRuns = hand!.boards.length > 1;
    const twoBoards = (hand!.boards[0]?.length ?? 0) > 1;
    const slots = hand!.boards.length * (hand!.boards[0]?.length ?? 1);
    const names = new Map<number, Map<string, string[]>>();
    for (const a of hand!.awards) {
      const prev = results.get(a.seat);
      results.set(a.seat, { amount: (prev?.amount ?? 0) + a.amount });
      if (!a.handName) continue;
      const where = [twoRuns && `Run ${a.run + 1}`, twoBoards && `Board ${a.board + 1}`].filter(Boolean).join(', ');
      const byName = names.get(a.seat) ?? new Map<string, string[]>();
      names.set(a.seat, byName);
      // A hi-lo scoop is named "Flush and 8-6 low": its halves group with high-only or low-only wins elsewhere.
      for (const name of a.half === 'scoop' ? a.handName.split(' and ') : [a.handName]) {
        const places = byName.get(name) ?? [];
        if (where && !places.includes(where)) places.push(where);
        byName.set(name, places);
      }
    }
    for (const [seat, byName] of names) {
      const list = [...byName.entries()];
      // Places are named unless every hand was won everywhere (or there's only one run and board).
      const everywhere = list.every(([, places]) => places.length === 0 || places.length === slots);
      results.get(seat)!.handName = everywhere
        ? list.map(([name]) => name).join(' and ')
        : list.map(([name, places]) => (places.length ? `${places.join(' & ')}: ${name}` : name)).join(' · ');
    }
  }

  // Chip flights: bets swept in when a betting round ends, the pot pushed to the winners.
  const [flights, setFlights] = useState<Flight[]>([]);
  const lastRound = useRef<{ key: string; hand: number } | null>(null);
  const lastBets = useRef<number[]>([]);
  const flightTimers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => () => flightTimers.current.forEach(clearTimeout), []);
  // Chips fly to the pot pill itself, not the middle of the board, so they land on it rather than on the cards.
  // The pill is gone once the hand is over, so its spot is kept from the last time it was on screen.
  const potSpot = useRef<Point | null>(null);
  useLayoutEffect(() => {
    const el = felt.current;
    const pot = el?.querySelector<HTMLElement>('.board .pot-row .pot');
    if (!el || !pot) return;
    const f = el.getBoundingClientRect();
    const r = pot.getBoundingClientRect();
    potSpot.current = { x: r.left + r.width / 2 - f.left - el.clientLeft, y: r.top + r.height / 2 - f.top - el.clientTop };
  }, [view, w, h, boardFit]);
  const potPoint = (): Point => potSpot.current ?? boardMiddle;
  const geometry = useRef({ betPoint, seatPoint, center, potPoint });
  geometry.current = { betPoint, seatPoint, center: boardMiddle, potPoint };
  const roundKey = hand ? `${hand.handNumber}:${hand.street}:${done ? 'done' : 'live'}` : '';
  // Runs before the effect below stores this view's bets, so lastBets holds the round that just ended.
  useEffect(() => {
    const before = lastRound.current;
    lastRound.current = hand ? { key: roundKey, hand: hand.handNumber } : null;
    if (!hand || !before || before.key === roundKey || before.hand !== hand.handNumber || document.hidden) return;
    const g = geometry.current;
    const pot = g.potPoint();
    const next: Flight[] = [];
    lastBets.current.forEach((amount, seat) => {
      if (amount > 0) next.push({ id: ++flightId, from: g.betPoint(seat), to: pot, delay: 0, kind: 'sweep' });
    });
    if (done) {
      const winners = [...new Set(hand.awards.map((a) => a.seat))];
      for (const seat of winners) next.push({ id: ++flightId, from: pot, to: g.seatPoint(seat), delay: next.length ? 350 : 100, kind: 'award' });
    }
    if (!next.length) return;
    setFlights((f) => [...f, ...next]);
    const ids = new Set(next.map((f) => f.id));
    const t = setTimeout(() => {
      flightTimers.current.delete(t);
      setFlights((f) => f.filter((x) => !ids.has(x.id)));
    }, 1400);
    flightTimers.current.add(t);
  }, [roundKey]);
  useEffect(() => {
    lastBets.current = view.seats.map((s) => s?.bet ?? 0);
  }, [view]);

  // The pile in the pot pill grows when the swept bets land on it, not as they leave the seats.
  const potPile = useLanded(hand?.pots[0]?.amount ?? 0, 550);
  const bets = view.seats.reduce((s, x) => s + (x?.bet ?? 0), 0);
  const runs = hand?.boards ?? [];
  const multiRun = runs.length > 1;
  const multiBoard = (runs[0]?.length ?? 0) > 1;
  const stud = hand?.family === 'stud';
  // A single all-in run's last card waits face down on its board, then turns over where it lies (#308).
  const coming = new Set((hand?.comingNext ?? []).map((c) => `${c.run}-${c.board}`));
  const held = new Set(heldCards(hand));
  // Cash games use casino chips, a cent upwards. In chips, colours follow the stakes: the smallest forced bet sets the white chip.
  const stakes = hand?.stakes ?? view.settings.stakes;
  const dollars = view.settings.stakes.centsMode;
  const chipSet = dollars ? DOLLAR_CHIPS : CHIP_SET;
  // With no forced bet at all (a hold'em bomb pot at a 1-chip stud table, say), the bet step sets it instead of every bet
  // turning into one white chip.
  const forced = [stakes.smallBlind, stakes.ante, stud ? stakes.bringIn : 0].filter((x): x is number => !!x && x > 0);
  const chipBase = dollars ? 1 : baseChip(forced.length ? Math.min(...forced) : betUnit(stakes));
  // Order of seats from the button, so the deal goes round the table.
  const dealOrder = (seat: number) => (hand ? (seat - hand.button - 1 + n) % n : 0);

  return (
    <div
      ref={felt}
      className={['felt', compact && 'compact', grown && 'grown', bigCards && 'big-cards', short && 'short', handFit && 'hand-fit', done && hand!.awards.length > 0 && 'showdown', view.me.seat !== null && 'seated-view', myTurn && 'my-turn', view.cardsWatched && 'cards-watched'].filter(Boolean).join(' ')}
      style={{ ...feltStyle(prefs, view.settings.table.felt), '--seat-scale': seatScale, ...(grown ? { '--k': k, '--sk': seatScale, '--side-margin': `${sideMargin}px`, '--top-margin': `${topMargin}px` } : {}), ...(boardCard ? { '--board-cw': `${boardCard}px` } : {}), ...(handFit ? { '--fit-cw': `${handFit.cw}px`, '--fit-overlap': `${-handFit.overlap}px`, '--fit-shift': `${handFit.shift}px` } : {}) } as CSSProperties}
    >
      <FeltEmblem />
      <div className={`board${multiRun || multiBoard ? ' multi' : ''}`} style={boardShift ? { translate: `0 ${Math.round(boardShift)}px` } : undefined}>
        <div className="board-stack" ref={stack} style={boardFit < 1 ? { scale: String(boardFit) } : undefined}>
        {runs.map((run, r) =>
          run.map((cards, b) => {
            // Run it twice: the second run's first cards are the first run's, carried down as the board splits, not dealt again (#372).
            const shared = sharedWithFirstRun(runs, r, b);
            return (
              cards.length > 0 && (
                <div className="cards board-row" key={`${r}-${b}`}>
                  {(multiRun || multiBoard) && <span className="board-label">{multiRun ? `Run ${r + 1}` : `Board ${b + 1}`}</span>}
                  {cards.map((c, i) =>
                    held.has(c) ? (
                      // Takes the face-down card's place and turns over there.
                      <PlayingCard key={`${hand!.handNumber}-${r}-${b}-${c}`} card={c} className={`turn-held ${highlight(c, boardWinners.get(`${r}-${b}`))}`} />
                    ) : i < shared ? (
                      <PlayingCard key={`${hand!.handNumber}-${r}-${b}-${c}`} card={c} className={`copy-board ${highlight(c, boardWinners.get(`${r}-${b}`))}`} />
                    ) : (
                      <PlayingCard
                        key={`${hand!.handNumber}-${r}-${b}-${c}`}
                        card={c}
                        className={`deal-board ${highlight(c, boardWinners.get(`${r}-${b}`))}`}
                        style={{ animationDelay: `${cards.length <= 3 ? i * 160 : 0}ms` }}
                      />
                    ),
                  )}
                  {coming.has(`${r}-${b}`) && (
                    <span className="held-slot" key={`${hand!.handNumber}-${r}-${b}-held`}>
                      <PlayingCard card={null} className="deal-board" />
                    </span>
                  )}
                </div>
              )
            );
          }),
        )}
        {live && (
          <div className="pots">
            <div className="pot-row">
              {hand!.pots.length > 1 ? (
                hand!.pots.map((p, i) => (
                  <div className="pot" key={i}>
                    <ChipStacks amount={p.amount} base={chipBase} set={chipSet} />
                    {i === 0 ? 'Pot' : `Side pot ${i}`} {fmt(p.amount)}
                  </div>
                ))
              ) : (
                // One pot: show everything in play, bets in front of the seats included, so it never reads "Pot 0" with chips out.
                <div className="pot">
                  <ChipStacks amount={potPile} base={chipBase} set={chipSet} />
                  {/* The pot counts as fast as a bet is tossed, so it reads right when the chips land. */}
                  Pot <CountUp value={Math.max(hand!.potTotal, hand!.pots[0]?.amount ?? 0)} fmt={fmt} upMs={380} />
                </div>
              )}
            </div>
            {hand!.pots.length > 1 && bets > 0 && <div className="pot total">Total {fmt(hand!.potTotal)}</div>}
          </div>
        )}
        {/* One line per winner. Several (a split pot, side pots) sit side by side where the felt has the width, so the middle
            doesn't grow taller than the room between the seats above and below it (#417). */}
        {done && results.size > 0 && (
          <div className={`results${results.size > 1 ? ' several' : ''}`}>
            {[...results.entries()].map(([seat, w]) => (
              <div className="pot result" key={seat}>
                {view.hand?.names?.[seat] ?? view.seats[seat]?.name ?? 'Player'} wins {fmt(w.amount)}
                {w.handName ? ` · ${w.handName}` : ''}
              </div>
            ))}
          </div>
        )}
        {/* The pot's spot above the board says what happens next between hands. */}
        {!live && view.nextHandAt !== null && view.started && !view.paused && view.choice?.deadline == null && (
          <div className="next-hand">Next hand in {Math.max(0, Math.ceil((view.nextHandAt - now) / 1000))}</div>
        )}
        {/* Dealer's choice: who is picking the next game, in the same spot. */}
        <ChoiceLine view={view} now={now} />
        {view.paused && <div className="next-hand">Paused</div>}
        {!hand && view.upcoming && !(view.choice && !view.choice.current) && <div className="next-hand muted">{view.upcoming.gameName}</div>}
        {notice && (
          <div
            className={['board-notice', hand && 'after-hand', notice.onClick && 'clickable', noticeHidden && 'unseen'].filter(Boolean).join(' ')}
            {...(noticeHidden
              ? { 'aria-hidden': true }
              : notice.onClick
              ? {
                  role: 'button',
                  tabIndex: 0,
                  onClick: notice.onClick,
                  onKeyDown: (e: ReactKeyboardEvent) => {
                    if (e.key !== 'Enter' && e.key !== ' ') return;
                    e.preventDefault();
                    notice.onClick!();
                  },
                }
              : { role: 'status' })}
          >
            {notice.text}
          </div>
        )}
        <BoardExtras view={view} />
        </div>
      </div>

      {view.seats.map((s, seat) => {
        const pos = seatPoint(seat);
        if (!s) {
          return (
            <div className="seat empty" style={px(pos)} key={seat}>
              {seatsClosed ? (
                // Dealer's choice: a smaller game has every seat it can deal (D33).
                <span className="closed" title="This game seats no more players. The seat opens after this game.">
                  Closed
                </span>
              ) : onPickSeat ? (
                <button onClick={() => onPickSeat(seat)}>Sit</button>
              ) : (
                !onAddBot && <span>{seat + 1}</span>
              )}
              {onAddBot && !seatsClosed && (
                <button className="add-bot" onClick={() => onAddBot(seat)} title="Add a practice bot to this seat">
                  + Bot
                </button>
              )}
            </div>
          );
        }
        const isMe = seat === view.me.seat;
        const acting = live && hand!.toAct === seat;
        const won = results.get(seat);
        let timeFraction: number | null = null;
        let secondsLeft: number | null = null;
        if (acting && view.turn?.seat === seat && view.turn.deadline) {
          const total = view.turn.deadline - view.turn.startedAt;
          timeFraction = Math.max(0, Math.min(1, (view.turn.deadline - now) / total));
          secondsLeft = Math.max(0, Math.ceil((view.turn.deadline - now) / 1000));
        }
        const badge = seatBadge(s, view.mode === 'tournament');
        const classes = [
          'seat',
          pos.x < w * 0.18 ? 'edge-left' : pos.x > w * 0.82 ? 'edge-right' : '',
          acting && 'acting',
          s.folded && 'folded',
          s.allIn && live && 'all-in',
          (s.sittingOut || !s.online) && 'away',
          won && 'winner',
          isMe && 'me',
          s.cards.length > 0 && (isMe || !s.folded) && 'has-cards',
          // Stud and five-card draw hands are too long to tuck beside the nameplate.
          s.cards.length > 4 && 'long-hand',
          s.departed && 'departed',
          s.departed === 'fading' && 'fading',
          onSeatClick && !s.departed && 'host-click',
        ]
          .filter(Boolean)
          .join(' ');
        const pickable = isMe && !!discard;
        const shown = done && !won && s.inHand && !s.folded ? shownHand(hand!.gameId, s, hand!.boards[0]?.[0] ?? []) : null;
        // Cards come off the dealer button (stud has none, so the middle of the table).
        const toMiddle = fromVars(hand && !stud ? buttonPoint(hand.button) : center, pos);
        const muck = fromVars(lerp(pos, center, 0.5), pos);
        const spot = isMe ? undefined : rowSpots[seat];
        return (
          <div key={seat}>
            <div className={classes} style={px(pos)} data-seat={seat}>
              <div
                className={`hole n${s.cards.length} ${s.folded && !isMe ? 'mucked' : ''} ${spot?.margin !== undefined ? 'bunched' : ''}`}
                style={spot ? ({ ...muck, '--row-shift': `${spot.shift}px`, ...(spot.margin !== undefined ? { '--row-margin': `${spot.margin}px`, '--row-cw': `${spot.cw}px` } : {}) } as CSSProperties) : muck}
              >
                {s.cards.map((c, i) => {
                  const face = c.card !== '??';
                  // Cards turned over at showdown flip; everything else is dealt in from the middle.
                  const flip = face && !isMe && !c.up;
                  return (
                    <PlayingCard
                      key={`${hand?.handNumber}-${i}-${isMe ? c.card : face ? 'f' : 'b'}`}
                      card={c.card}
                      small={!(compact && isMe)}
                      className={[
                        flip ? 'flip-in' : 'deal-hole',
                        highlight(c.card, winningHole),
                        stud && !c.up && 'facedown',
                        pickable && discard!.selected.includes(i) && 'discard',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      style={{ ...toMiddle, animationDelay: flip ? `${i * 80}ms` : hand?.street === 0 ? `${(i * n + dealOrder(seat)) * 45}ms` : '0ms' }}
                      onClick={pickable ? () => discard!.toggle(i) : undefined}
                      title={pickable ? 'Tap to throw this card away' : undefined}
                    />
                  );
                })}
              </div>
              <div
                className="nameplate"
                onClick={onSeatClick && !s.departed ? () => onSeatClick(s) : undefined}
              >
                {badge && badge.kind !== 'info' && <div className={`pill ${badge.kind}`}>{badge.text}</div>}
                <div className="name" title={s.bot ? `${s.name}, ${botOwnerLabel(s.bot, 'practice bot')}` : undefined}>
                  {s.name}
                  {s.playerId === view.hostId && <span className="tag">host</span>}
                  {/* Dealer's choice: the Pick chip, on whoever picks the next game. */}
                  <PickTag view={view} seat={s} />
                  {/* The bot's own short name comes first, so a long owner name is what gets cut short. */}
                  {s.bot && <span className="bot-owner">· {botPlateLabel(s.bot)}</span>}
                </div>
                <div className="stack">{s.allIn ? 'ALL IN' : <CountUp value={s.stack} fmt={fmt} />}</div>
                {badge?.kind === 'info' && <div className="status">{badge.text}</div>}
                {s.lastAction && live && <div className={`last-action a-${s.lastAction.split(' ')[0].toLowerCase()}`}>{s.lastAction}</div>}
                {shown && <div className="status">{shown}</div>}
                {timeFraction !== null && (
                  <TurnLine
                    key={`${view.turn!.startedAt}:${view.turn!.deadline}:${view.paused}:${skew}`}
                    turn={view.turn as { startedAt: number; deadline: number }}
                    paused={view.paused}
                    serverNow={view.serverNow}
                    skew={skew}
                    bank={!!view.turn?.usingBank}
                    low={secondsLeft! <= 5}
                  />
                )}
                {timeFraction !== null && (secondsLeft! <= 10 || view.turn?.usingBank) && (
                  <div className={`status ${view.turn?.usingBank ? 'bank-text' : 'low-text'}`}>
                    {view.turn?.usingBank ? 'time bank ' : ''}
                    {clock(secondsLeft! * 1000)}
                  </div>
                )}
                <SeatExtras view={view} seat={s} />
              </div>
              {won && <div className="win-float">+{fmt(won.amount)}</div>}
            </div>
            {s.bet > 0 && (
              <div className="bet" style={{ ...px(betPoint(seat)), ...fromVars(pos, betPoint(seat)) }}>
                <ChipStacks amount={s.bet} base={chipBase} set={chipSet} max={2} />
                {fmt(s.bet)}
              </div>
            )}
          </div>
        );
      })}

      {/* Not once the game is stopped: the last hand stays on the felt, but its button means nothing, and it would sit on the note (#383). */}
      {hand && !stud && !notice && <div className={`dealer ${hand.buttonDead ? 'dead' : ''}`} style={px(buttonPoint(hand.button))}>D</div>}

      <FeltExtras view={view} seatPoint={seatPoint} railPoint={{ x: w / 2, y: h }} />

      {flights.map((f) => (
        <div key={f.id} className={`chip-flight ${f.kind}`} style={{ ...px(f.to), ...fromVars(f.from, f.to), animationDelay: `${f.delay}ms` }}>
          <span className="chip" />
          <span className="chip" />
          <span className="chip" />
        </div>
      ))}
    </div>
  );
}

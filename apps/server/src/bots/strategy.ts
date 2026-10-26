import { freshDeck, suitOf, type Card } from '@rsdp/engine';
import { engine, type Action, type HandSeat, type HandState, type LegalActions, type PlayerId, type SeatIndex } from '@rsdp/engine/core';
import { getVariant, HIGH_EVALUATORS, LOW_EVALUATORS, type VariantSpec } from '@rsdp/engine/variants';
import type { BotLevel } from '@rsdp/engine/wire';

/**
 * Practice bots: a simple, rule-based player for every game. It estimates
 * its chance of winning by dealing the unseen cards out at random many times
 * (vs random hands), then bets, calls or folds against the pot odds. It only
 * looks at what a player in its seat could see: its own cards, up cards, the
 * boards and how everyone has bet.
 *
 * Levels: Normal is the player above. Easy calls more, bets only good hands
 * and bets small. Hard thinks longer, follows how many cards each opponent
 * draws in draw games, plays an opponent who bets and
 * raises as holding a better hand than a random one (less so for a player
 * who bets everything), bets thinner for value against players who call a
 * lot, bluffs players who fold a lot, and uses position.
 */

/** What a bot does when it is its turn. */
export type BotMove = { kind: 'act'; action: Action } | { kind: 'draw'; discard: number[] };

/** A float in [0, 1). */
export type Rand = () => number;

/** Small, fast seeded generator; the bots use it for their deals and their coin flips. */
export function seededRand(seed: number): Rand {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * How hard the bots think. A decision runs on the server's event loop, so it
 * is kept to a few milliseconds; tests turn it down further.
 */
export const botTuning = {
  /** Stop dealing out new finishes after this long... */
  thinkMs: 10,
  /** ...once at least this many are done. */
  minSims: 20,
  maxSims: 400,
  /** Deals tried for each way of drawing... */
  drawSims: 10,
  /** ...and for the best few of them, to pick one. */
  drawFinalSims: 60,
  /** The same two when it only sizes up the hand for a bet. */
  drawBetSims: 6,
  drawBetFinalSims: 24,
};

/**
 * How much longer than Normal each level thinks about its chances, and about
 * how to draw. Hard in lowball draw games weighs only a few ways to draw
 * (keepOptions), so twice the deals for each still keeps a decision within a
 * few tens of milliseconds.
 */
const EFFORT: Record<BotLevel, number> = { easy: 0.5, normal: 1, hard: 1.5 };
const DRAW_EFFORT: Record<BotLevel, number> = { easy: 0.5, normal: 1, hard: 2 };

export interface BotContext {
  /** Normal if missing. */
  level?: BotLevel;
  /** How the players at the table have played lately (readPlayers); Hard uses it. */
  players?: Record<PlayerId, PlayerRead>;
}

export function chooseMove(hand: HandState, seat: SeatIndex, rand: Rand, ctx: BotContext = {}): BotMove {
  const level = ctx.level ?? 'normal';
  const effort = EFFORT[level] ?? 1;
  const drawEffort = DRAW_EFFORT[level] ?? 1;
  const view = situation(hand, seat);
  if (level === 'hard') {
    view.reads = handReads(hand, seat, ctx.players ?? {});
    if (view.spec.family === 'draw' && lowDrawRule(view.spec)) view.draws = opponentDraws(hand, seat, view.drawsInGame);
  }
  const sims = (screen: number, final: number) => ({ screen: Math.max(1, Math.round(screen * drawEffort)), final: Math.max(1, Math.round(final * drawEffort)) });
  if (hand.phase === 'drawing') {
    const max = hand.input.game.streets[hand.street].drawMaxDiscard ?? 0;
    return { kind: 'draw', discard: bestDraw(view, max, rand, sims(botTuning.drawSims, botTuning.drawFinalSims)).discard };
  }
  const legal = engine.legalActions(hand, seat);
  if (!legal) throw new Error('not the bot’s turn');
  // With draws to come, Normal sizes up its chances against two opponents and stretches that to the rest; Hard plays it out against everyone.
  const field = level === 'hard' ? drawFieldSize(view) : DRAW_OPPONENTS;
  const equity =
    view.drawsLeft > 0
      ? scaleToField(bestDraw(view, view.cardsPerPlayer, rand, sims(botTuning.drawBetSims, botTuning.drawBetFinalSims), field).equity, field, view.opponents.length)
      : estimateEquity(view, rand, effort);
  const opponents = view.opponents.length;
  if (level === 'easy') return { kind: 'act', action: decideEasy(hand, seat, legal, equity, opponents, rand) };
  if (level === 'hard') return { kind: 'act', action: decideHard(hand, seat, legal, equity, ctx.players ?? {}, rand) };
  return { kind: 'act', action: decide(hand, seat, legal, equity, opponents, rand) };
}

// ---------------------------------------------------------------- what the bot can see

interface Situation {
  spec: VariantSpec;
  mine: Card[];
  /** Community cards so far, one list per board. */
  boards: Card[][];
  /** Each live opponent's face-up cards. */
  opponents: Card[][];
  /** Cards nobody can hold any more that the bot has seen (folded up cards). */
  dead: Card[];
  /** Cards each player ends with. */
  cardsPerPlayer: number;
  /** Community cards each board ends with. */
  boardCards: number;
  /** Draws still to come (draw games), counting one in progress. */
  drawsLeft: number;
  /** Draws in the whole game, for how strong a finished hand should be. */
  drawsInGame: number;
  /** Hard: for each live opponent, how many more random hands to deal them and keep the best of (see handReads). */
  reads?: number[];
  /** Hard, lowball draw games: each live opponent's discards so far (one count per draw, null when the table stood pat for them) and draws still to come. */
  draws?: OpponentDraws[];
}

function situation(hand: HandState, seat: SeatIndex): Situation {
  const game = hand.input.game;
  const spec = getVariant(game.id);
  const me = hand.seats.find((x) => x.seat === seat)!;
  const others = hand.seats.filter((x) => x.seat !== seat);
  const streets = game.streets;
  const drawStreets = streets.map((st, i) => (st.drawMaxDiscard ? i : -1)).filter((i) => i >= 0);
  // In the betting after a draw that draw is done; while drawing, it is still to come.
  const drawsLeft = drawStreets.filter((i) => i > hand.street || (i === hand.street && hand.phase === 'drawing')).length;
  const boards = (hand.runs[0] ?? [[]]).map((b) => [...b]);
  // Stud with too many players for the deck deals the last card once, face up in the middle: it is everyone's.
  const shared = game.family === 'stud' ? boards[0].length : 0;
  return {
    spec,
    mine: me.cards.map((c) => c.card),
    boards,
    opponents: others.filter((x) => !x.folded).map((x) => x.cards.filter((c) => c.up).map((c) => c.card)),
    dead: others.filter((x) => x.folded).flatMap((x) => x.cards.filter((c) => c.up).map((c) => c.card)),
    cardsPerPlayer: streets.reduce((n, st) => n + st.dealDown + st.dealUp, 0) - shared,
    boardCards: streets.reduce((n, st) => n + st.dealBoard, 0) + shared,
    drawsLeft,
    drawsInGame: drawStreets.length,
  };
}

// ---------------------------------------------------------------- equity

/** The share of the pot `hands[0]` takes on this board (ties split, hi-lo halves). */
export function potShare(spec: VariantSpec, hands: Card[][], board: Card[]): number {
  const { high, low } = spec.showdown;
  const hi = high ? hands.map((h) => HIGH_EVALUATORS[high](h, board)?.score ?? -1) : null;
  const lo = low ? hands.map((h) => LOW_EVALUATORS[low](h, board)?.score ?? -1) : null;
  if (hi && lo) return Math.max(...lo) < 0 ? part(hi) : part(hi) / 2 + part(lo) / 2;
  return part((hi ?? lo)!);
}

function part(scores: number[]): number {
  const top = Math.max(...scores);
  if (top < 0 || scores[0] !== top) return 0;
  return 1 / scores.filter((s) => s === top).length;
}

/** The cards the bot has not seen, in a fresh random order on each call to `deal`. */
class Pool {
  private readonly cards: Card[];
  private n = 0;
  constructor(seen: Card[], readonly rand: Rand) {
    const known = new Set(seen);
    this.cards = freshDeck().filter((c) => !known.has(c));
  }
  get size() {
    return this.cards.length;
  }
  reset() {
    this.n = 0;
  }
  /** `count` more cards, none dealt since the last reset. */
  deal(count: number): Card[] {
    const out: Card[] = [];
    for (let i = 0; i < count && this.n < this.cards.length; i++, this.n++) {
      const j = this.n + Math.floor(this.rand() * (this.cards.length - this.n));
      [this.cards[this.n], this.cards[j]] = [this.cards[j], this.cards[this.n]];
      out.push(this.cards[this.n]);
    }
    return out;
  }
  /** `count` random cards from those not dealt yet (and not in `except`), without dealing them: later deals may repeat them. */
  sample(count: number, except: Card[] = []): Card[] {
    const out: Card[] = [];
    const left = markCards(except);
    for (let i = this.n; out.length < count && i < this.cards.length; i++) {
      const j = i + Math.floor(this.rand() * (this.cards.length - i));
      [this.cards[i], this.cards[j]] = [this.cards[j], this.cards[i]];
      if (!left(this.cards[i])) out.push(this.cards[i]);
    }
    return out;
  }
  /** Up to `count` random cards of `cards`. */
  pick(cards: Card[], count: number): Card[] {
    const out = cards.slice();
    for (let i = 0; i < count && i < out.length; i++) {
      const j = i + Math.floor(this.rand() * (out.length - i));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out.slice(0, count);
  }
}

/** A number for each card, from its two letters (quicker than looking the text up, and these run thousands of times a decision). */
const CODE: number[] = [];
'23456789TJQKA'.split('').forEach((r, i) => (CODE[r.charCodeAt(0)] = i + 2));
'cdhs'.split('').forEach((x, i) => (CODE[x.charCodeAt(0)] = i));
const cardNo = (card: Card) => CODE[card.charCodeAt(0)] * 4 + CODE[card.charCodeAt(1)];

/** Marks for markCards: a card is marked when its stamp is the current one. */
const stamps = new Uint32Array(64);
let stamp = 0;

/** Marks these cards, and returns a test for whether a card is one of them (until the next call). */
function markCards(cards: Card[]): (card: Card) => boolean {
  const mine = ++stamp;
  for (const card of cards) stamps[cardNo(card)] = mine;
  return (card) => stamps[cardNo(card)] === mine;
}

/**
 * Opponents in a draw game have had the chance to improve: model each one as
 * the best of a few random hands, one more per draw in the game. The extra
 * hands are sampled from the cards left once everyone has a hand, without
 * using them up, so a big field doesn't run the deck dry.
 */
function improve(view: Situation, pool: Pool, hand: Card[]): Card[] {
  if (view.spec.family !== 'draw') return hand;
  let best = hand;
  for (let i = 0; i < view.drawsInGame; i++) {
    const other = pool.sample(view.cardsPerPlayer);
    if (other.length < view.cardsPerPlayer) break;
    if (potShare(view.spec, [other, best], []) > 0.5) best = other;
  }
  return best;
}

/** How many opponents the deck can deal out in full. */
function opponentsThatFit(view: Situation, poolSize: number, myMissing: number): number {
  const boardMissing = view.boards.reduce((n, b) => n + Math.max(0, view.boardCards - b.length), 0);
  let room = poolSize - myMissing - boardMissing;
  let k = 0;
  for (const up of view.opponents) {
    const need = view.cardsPerPlayer - up.length;
    if (room < need) break;
    room -= need;
    k++;
  }
  return Math.max(1, k);
}

function seenCards(view: Situation) {
  return [...view.mine, ...view.boards.flat(), ...view.opponents.flat(), ...view.dead];
}

/** One random finish of the hand: the bot's share of the pot, averaged over the boards. */
function simulate(view: Situation, pool: Pool, myHand: Card[], opponents: Card[][]): number {
  const dealt = opponents.map((up) => [...up, ...pool.deal(view.cardsPerPlayer - up.length)]);
  const hands = [myHand];
  // Hard keeps opponents' redrawn cards apart (Normal's improve() lets them overlap, which hardly matters for a rough read).
  dealt.forEach((h, i) => hands.push(view.draws ? replayDraws(view, pool, h, view.draws[i], hands.flat()) : improve(view, pool, h)));
  const boards = view.boards.map((board) => [...board, ...pool.deal(view.boardCards - board.length)]);
  if (view.reads) readHands(view, pool, opponents, hands, boards);
  return boards.reduce((n, board) => n + potShare(view.spec, hands, board), 0) / boards.length;
}

/**
 * Hard: an opponent who has shown strength gets more random hands, and plays
 * the best of them on the boards as they finish. A fraction of a read is a
 * chance of one more.
 */
function readHands(view: Situation, pool: Pool, opponents: Card[][], hands: Card[][], boards: Card[][]) {
  opponents.forEach((up, i) => {
    const read = view.reads![i] ?? 0;
    const tries = Math.floor(read) + (pool.rand() < read % 1 ? 1 : 0);
    for (let t = 0; t < tries; t++) {
      // None of the cards anyone else holds in this deal.
      const taken = hands.flat();
      const need = view.cardsPerPlayer - up.length;
      const fill = pool.sample(need, taken);
      // A crowded deck may not have enough cards left: the hidden cards this opponent was dealt could be theirs too.
      if (fill.length < need) fill.push(...pool.pick(hands[i + 1].filter((c) => !up.includes(c)), need - fill.length));
      let other = [...up, ...fill];
      if (other.length < view.cardsPerPlayer) break;
      if (view.draws) other = replayDraws(view, pool, other, view.draws[i], taken);
      const share = boards.reduce((n, board) => n + potShare(view.spec, [other, hands[i + 1]], board), 0) / boards.length;
      if (share > 0.5) hands[i + 1] = other;
    }
  });
}

// ---------------------------------------------------------------- Hard: what opponents' draws say

type LowRule = 'deuce-to-seven' | 'badugi';

/** How low a card is in a lowball draw game (aces are high in 2-7, low in Badugi). */
function lowRank(rule: LowRule, card: Card) {
  const rank = CODE[card.charCodeAt(0)];
  return rank === 14 && rule === 'badugi' ? 1 : rank;
}

/** A few cards, lowest first (an insertion sort: these hands have four or five cards). */
function lowestFirst(rule: LowRule, cards: Card[]): Card[] {
  const out = cards.slice();
  for (let i = 1; i < out.length; i++) {
    const card = out[i];
    const rank = lowRank(rule, card);
    let j = i - 1;
    for (; j >= 0 && lowRank(rule, out[j]) > rank; j--) out[j + 1] = out[j];
    out[j + 1] = card;
  }
  return out;
}

/** The lowball rule of a draw game whose draws Hard can follow, or null. */
function lowDrawRule(spec: VariantSpec): LowRule | null {
  const low = spec.showdown.low;
  return low === 'deuce-to-seven' || low === 'badugi' ? low : null;
}

/**
 * The `k` cards a player keeps: the lowest cards of different ranks (and, in
 * Badugi, different suits) first, then the lowest of the rest.
 */
function keepBest(rule: LowRule, cards: Card[], k: number): Card[] {
  const sorted = lowestFirst(rule, cards);
  const ranks = new Set<string>();
  const suits = new Set<string>();
  const first: Card[] = [];
  const rest: Card[] = [];
  for (const card of sorted) {
    const fits = !ranks.has(card[0]) && (rule !== 'badugi' || !suits.has(suitOf(card)));
    if (fits) {
      ranks.add(card[0]);
      suits.add(suitOf(card));
      first.push(card);
    } else rest.push(card);
  }
  return [...first, ...rest].slice(0, Math.max(0, k));
}

/** The cards a player keeps when they draw again: a 10-low or better 2-7 hand, or a four-card badugi, stands pat. */
function keepOnDraw(rule: LowRule, cards: Card[]): Card[] {
  const sorted = lowestFirst(rule, cards);
  const kept: Card[] = [];
  if (rule === 'badugi') {
    // The lowest cards that are all different ranks and suits.
    for (const card of sorted) if (kept.every((c) => c[0] !== card[0] && suitOf(c) !== suitOf(card))) kept.push(card);
    return kept;
  }
  // Sorted, so a pair sits side by side.
  const paired = sorted.some((c, i) => i > 0 && c[0] === sorted[i - 1][0]);
  if (!paired && lowRank(rule, sorted[sorted.length - 1]) <= 10) return cards;
  // Different ranks of 10 or lower.
  for (const card of sorted) if (lowRank(rule, card) <= 10 && kept.every((c) => c[0] !== card[0])) kept.push(card);
  return kept;
}

/**
 * Ways to draw that keep the best few cards: standing pat first, then throwing
 * one more card at a time. Keeping the lowest cards can miss the bigger badugi
 * round a blocked low card, or keep four 2-7 cards that a straight or flush
 * spoils, so a better set of that size is weighed too (soundestKeep).
 */
function keepOptions(rule: LowRule, mine: Card[], maxDiscard: number): number[][] {
  const seen = new Set<string>();
  const out: number[][] = [];
  const add = (kept: Card[]) => {
    const discard = mine.flatMap((c, i) => (kept.includes(c) ? [] : [i]));
    const key = discard.join();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(discard);
    }
  };
  for (let keep = mine.length; keep >= Math.max(0, mine.length - maxDiscard); keep--) {
    const kept = keepBest(rule, mine, keep);
    add(kept);
    if (keep > 0 && keep < mine.length) {
      const sound = soundestKeep(rule, mine, kept);
      if (sound) add(sound);
    }
  }
  return out;
}

/**
 * Badugi: when the lowest cards clash, the lowest set as big that doesn't.
 * 2-7, keeping four: the lowest set of four different ranks, none above the
 * higher of 8 and the top kept card, that fewer draws spoil (by a flush, or
 * each rank that makes a straight) than the lowest four. Null if none is better.
 */
function soundestKeep(rule: LowRule, mine: Card[], kept: Card[]): Card[] | null {
  const k = kept.length;
  if (rule === 'deuce-to-seven' && k !== 4) return null;
  const flaws = (cards: Card[]) => {
    if (rule === 'badugi') return cards.every((c, i) => cards.every((d, j) => j <= i || (c[0] !== d[0] && suitOf(c) !== suitOf(d)))) ? 0 : 1;
    const ranks = cards.map((c) => lowRank(rule, c));
    let spoilers = cards.every((c) => suitOf(c) === suitOf(cards[0])) ? 1 : 0;
    for (let r = 2; r <= 14; r++) {
      if (ranks.includes(r)) continue;
      const all = [...ranks, r];
      if (Math.max(...all) - Math.min(...all) === 4) spoilers++;
    }
    return spoilers;
  };
  const own = flaws(kept);
  if (own === 0) return null;
  const top = Math.max(8, ...kept.map((c) => lowRank(rule, c)));
  let best: { cards: Card[]; flaws: number; ranks: number[] } | null = null;
  for (let mask = 0; mask < 1 << mine.length; mask++) {
    const cards = mine.filter((_, i) => mask & (1 << i));
    if (cards.length !== k) continue;
    const ranks = cards.map((c) => lowRank(rule, c)).sort((a, b) => b - a);
    if (new Set(ranks).size < k || (rule === 'deuce-to-seven' && ranks[0] > top)) continue;
    const f = flaws(cards);
    if (f < own && (!best || f < best.flaws || (f === best.flaws && lower(ranks, best.ranks)))) best = { cards, flaws: f, ranks };
  }
  return best?.cards ?? null;
}

/** Whether one set of ranks, highest first, is a lower hand than another. */
function lower(a: number[], b: number[]) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

/** How many cards an opponent threw at each draw so far (null when the table stood pat for them while away), and how many draws they have left. */
interface OpponentDraws {
  done: (number | null)[];
  left: number;
}

/** Hard: each live opponent's draws so far. */
function opponentDraws(hand: HandState, seat: SeatIndex, drawsInGame: number): OpponentDraws[] {
  return hand.seats
    .filter((x) => x.seat !== seat && !x.folded)
    .map((x) => {
      const done = hand.events.flatMap((ev) => (ev.t === 'draw' && ev.seat === x.seat ? [ev.auto ? null : ev.discarded] : []));
      return { done, left: Math.max(0, drawsInGame - done.length) };
    });
}

/**
 * Hard, lowball draw games: plays out an opponent's hand the way they drew it.
 * At each draw they made, they kept their good cards (keepOnDraw) and threw
 * the rest; when they kept more than that hand has, the extra cards they kept
 * are dealt as good ones too (low, and a rank, or in Badugi a suit, they don't
 * have yet). A stand-pat the table made for them says nothing, so their cards
 * stay as dealt. Draws still to come follow keepOnDraw.
 */
function replayDraws(view: Situation, pool: Pool, start: Card[], draws: OpponentDraws, taken: Card[]): Card[] {
  const rule = lowDrawRule(view.spec)!;
  const n = start.length;
  let hand = start;
  for (const thrown of draws.done) {
    if (thrown === null) continue;
    const keep = Math.max(0, n - thrown);
    const kept = keepBest(rule, keepOnDraw(rule, hand), keep);
    if (kept.length < keep) kept.push(...goodCards(rule, pool, kept, keep - kept.length, taken));
    const next = [...kept, ...pool.sample(n - kept.length, [...kept, ...taken])];
    if (next.length < n) break;
    hand = next;
  }
  for (let i = 0; i < draws.left; i++) {
    const kept = keepOnDraw(rule, hand);
    if (kept.length >= n) break;
    const next = [...kept, ...pool.sample(n - kept.length, [...kept, ...taken])];
    if (next.length < n) break;
    hand = next;
  }
  return hand;
}

/** Up to `count` unseen cards of 10 or lower (Jack or lower in Badugi) that go with `kept`: new ranks, and in Badugi new suits. */
function goodCards(rule: LowRule, pool: Pool, kept: Card[], count: number, taken: Card[]): Card[] {
  const out: Card[] = [];
  for (const card of pool.sample(16, [...kept, ...taken])) {
    if (out.length >= count) break;
    const have = [...kept, ...out];
    if (lowRank(rule, card) <= (rule === 'badugi' ? 11 : 10) && have.every((c) => c[0] !== card[0] && (rule !== 'badugi' || suitOf(c) !== suitOf(card)))) out.push(card);
  }
  return out;
}

/** Chance of winning (share of the pot) against random hands for every live opponent (stronger ones, with reads). */
export function estimateEquity(view: Situation, rand: Rand, effort = 1): number {
  const pool = new Pool(seenCards(view), rand);
  const myMissing = Math.max(0, view.cardsPerPlayer - view.mine.length);
  const opponents = view.opponents.slice(0, opponentsThatFit(view, pool.size, myMissing));
  const thinkMs = botTuning.thinkMs * effort;
  const minSims = botTuning.minSims * effort;
  const start = performance.now();
  let sum = 0;
  let n = 0;
  while (n < botTuning.maxSims * effort) {
    // Think for thinkMs once minSims are done; an expensive game (big hi-lo Omaha fields) stops at three times that regardless.
    const spent = performance.now() - start;
    if (n >= 1 && spent >= thinkMs * 3) break;
    if (n >= minSims && spent >= thinkMs) break;
    pool.reset();
    sum += simulate(view, pool, [...view.mine, ...pool.deal(myMissing)], opponents);
    n++;
  }
  return sum / n;
}

/** Drawing is tried against at most this many opponents (and so is Normal's betting with draws to come), to keep it quick. */
const DRAW_OPPONENTS = 2;
/** Ways of drawing looked at again more closely. */
const DRAW_FINALISTS = 4;

/** Every live opponent, if the deck can deal them all out along with every draw the bot has left. */
function drawFieldSize(view: Situation): number {
  return opponentsThatFit(view, freshDeck().length - seenCards(view).length, view.drawsLeft * view.mine.length);
}

/**
 * The `count` opponents drawing is tried against: the first few, or for Hard
 * the most dangerous few (the strongest reads, and the fewest cards drawn), so
 * it doesn't matter where they sit.
 */
function drawField(view: Situation, count: number): Situation {
  if (!view.reads) return { ...view, opponents: view.opponents.slice(0, count) };
  const threat = (i: number) => {
    const drawn = (view.draws?.[i]?.done ?? []).filter((n): n is number => n !== null);
    const thrown = drawn.length ? drawn.reduce((a, b) => a + b, 0) / drawn.length : 0;
    return (view.reads![i] ?? 0) - thrown;
  };
  // In that order even when all of them are tried, so the same spot plays out the same wherever they sit. A stable
  // sort keeps seat order on ties.
  const picked = view.opponents
    .map((_, i) => i)
    .sort((a, b) => threat(b) - threat(a))
    .slice(0, count);
  return {
    ...view,
    opponents: picked.map((i) => view.opponents[i]),
    reads: picked.map((i) => view.reads![i]),
    draws: view.draws && picked.map((i) => view.draws![i]),
  };
}

/** Equity against `from` opponents, as if each were beaten independently, stretched to `to` of them. */
function scaleToField(equity: number, from: number, to: number) {
  const used = Math.min(from, to);
  if (used === to || equity <= 0) return equity;
  return Math.pow(equity, to / used);
}

/**
 * Draw games: tries every allowed set of cards to throw away with a few
 * deals (the same ones for each, so they compare fairly), then looks harder
 * at the best few with more deals and keeps the best.
 */
export function bestDraw(
  view: Situation,
  maxDiscard: number,
  rand: Rand,
  sims: { screen: number; final: number } = { screen: botTuning.drawSims, final: botTuning.drawFinalSims },
  opponents = DRAW_OPPONENTS,
): { discard: number[]; equity: number } {
  const cards = view.mine.length;
  const field = drawField(view, opponents);
  const seeds = (n: number) => Array.from({ length: n }, () => Math.floor(rand() * 2 ** 31));
  const equityOf = (discard: number[], deals: number[]) => {
    const kept = view.mine.filter((_, i) => !discard.includes(i));
    let sum = 0;
    for (const seed of deals) {
      const pool = new Pool(seenCards(view), seededRand(seed));
      // Later draws are a few more tries at the same cards.
      let mine = [...kept, ...pool.deal(discard.length)];
      for (let i = 1; i < view.drawsLeft && discard.length; i++) {
        const other = [...kept, ...pool.deal(discard.length)];
        if (other.length === mine.length && potShare(view.spec, [other, mine], []) > 0.5) mine = other;
      }
      sum += simulate(field, pool, mine, field.opponents);
    }
    return sum / deals.length;
  };
  // Hard in lowball games only weighs keeping its best few cards (keepOptions). That is quicker, and played better than
  // weighing every way to draw: the more ways it compares on a few deals each, the likelier a lucky-looking bad one wins.
  const rule = view.draws ? lowDrawRule(view.spec) : null;
  const options: number[][] = rule ? keepOptions(rule, view.mine, maxDiscard) : [];
  for (let mask = 0; !rule && mask < 1 << cards; mask++) {
    const discard = [...Array(cards).keys()].filter((i) => mask & (1 << i));
    if (discard.length <= maxDiscard) options.push(discard);
  }
  const screen = seeds(sims.screen);
  // A stable sort keeps the smaller draw (standing pat comes first) on ties.
  const ranked = options.map((discard) => ({ discard, equity: equityOf(discard, screen) })).sort((a, b) => b.equity - a.equity);
  const final = seeds(sims.final);
  let best = { discard: [] as number[], equity: -1 };
  for (const { discard } of ranked.slice(0, DRAW_FINALISTS)) {
    const equity = equityOf(discard, final);
    if (equity > best.equity + 1e-9) best = { discard, equity };
  }
  return best;
}

// ---------------------------------------------------------------- betting

function decide(hand: HandState, seat: SeatIndex, legal: LegalActions, equity: number, opponents: number, rand: Rand): Action {
  const me = hand.seats.find((x) => x.seat === seat)!;
  const pot = hand.seats.reduce((n, x) => n + x.total, 0);
  const fair = 1 / (opponents + 1);
  const strength = equity / fair;
  const firstRound = hand.street === 0;
  const raise = (fraction: number): Action => {
    const target = hand.currentBet + fraction * (pot + legal.callAmount);
    const to = sizeTo(legal, target);
    return legal.raiseKind === 'bet' ? { type: 'bet', to } : { type: 'raise', to };
  };

  if (legal.canBringIn) {
    // Stud: complete with a strong start, otherwise bring it in for the minimum.
    return legal.canRaise && strength >= 1.5 ? raise(0) : { type: 'bring-in' };
  }
  // Keep re-raising wars short: each raise past the third needs a stronger hand, and past the seventh none is strong enough
  // (heads-up fixed limit has no cap, and two strong hands would otherwise raise each other all in a bet at a time).
  const raiseBar = hand.raisesThisRound < 3 ? 0 : 0.85 + 0.04 * (hand.raisesThisRound - 3);
  const mayRaise = legal.canRaise && equity >= raiseBar;

  if (legal.canCheck) {
    const value = strength >= 1.45 || equity >= 0.62;
    const bluff = !firstRound && opponents === 1 && rand() < 0.07;
    if (mayRaise && (value || bluff)) return raise(0.5 + 0.25 * rand());
    return { type: 'check' };
  }

  const odds = legal.callAmount / (pot + legal.callAmount);
  const margin = legal.callAmount >= me.stack * 0.5 ? 0.08 : 0.03;
  if (mayRaise && (equity >= 0.8 || ((equity >= 0.7 || strength >= 2.2) && rand() < 0.8))) return raise(0.75);
  if (equity >= odds + margin) return { type: 'call' };
  return { type: 'fold' };
}

/** Easy: calls small bets with almost anything, bets only good hands and small, raises only the best, and never bluffs. */
function decideEasy(hand: HandState, seat: SeatIndex, legal: LegalActions, equity: number, opponents: number, rand: Rand): Action {
  const me = hand.seats.find((x) => x.seat === seat)!;
  const pot = hand.seats.reduce((n, x) => n + x.total, 0);
  const strength = equity * (opponents + 1);
  const raise = (fraction: number): Action => {
    const to = sizeTo(legal, hand.currentBet + fraction * (pot + legal.callAmount));
    return legal.raiseKind === 'bet' ? { type: 'bet', to } : { type: 'raise', to };
  };
  if (legal.canBringIn) return legal.canRaise && strength >= 2 ? raise(0) : { type: 'bring-in' };
  const mayRaise = legal.canRaise && hand.raisesThisRound < 3;
  if (legal.canCheck) {
    if (mayRaise && (strength >= 1.7 || equity >= 0.72) && rand() < 0.75) return raise(0.3 + 0.2 * rand());
    return { type: 'check' };
  }
  if (mayRaise && equity >= 0.85 && rand() < 0.6) return raise(0.5);
  const odds = legal.callAmount / (pot + legal.callAmount);
  // Curious about small bets; careful with its stack.
  const slack = legal.callAmount >= me.stack * 0.5 ? 0 : legal.callAmount <= pot * 0.6 ? 0.1 : 0.04;
  if (equity >= odds - slack) return { type: 'call' };
  return { type: 'fold' };
}

/** How a player has played in recent hands: betting actions they chose, and what they did facing a bet. */
export interface PlayerRead {
  /** Folds, checks, calls, bets and raises they chose (not ones made for them). */
  acts: number;
  /** Bets, raises and completes. */
  aggressive: number;
  /** Times they acted facing a bet or raise someone chose to make (not just the blinds)... */
  faced: number;
  /** ...and folded. */
  folds: number;
}

/** What each player did in these hands, for Hard bots to learn how they play. */
export function readPlayers(hands: HandState[]): Record<PlayerId, PlayerRead> {
  const out: Record<PlayerId, PlayerRead> = {};
  for (const hand of hands) {
    const ids = new Map(hand.seats.map((x) => [x.seat, x.playerId]));
    const bets = new Map<SeatIndex, number>();
    let top = 0;
    // Folding to the blinds or a bring-in alone says nothing about folding to a bet.
    let raised = false;
    for (const ev of hand.events) {
      if (ev.t === 'street') {
        bets.clear();
        top = 0;
        raised = false;
      } else if (ev.t === 'post' && ev.live) {
        const bet = (bets.get(ev.seat) ?? 0) + ev.amount;
        bets.set(ev.seat, bet);
        top = Math.max(top, bet);
      } else if (ev.t === 'action') {
        const facing = raised && top > (bets.get(ev.seat) ?? 0);
        bets.set(ev.seat, ev.to);
        top = Math.max(top, ev.to);
        if (ev.action === 'bet' || ev.action === 'raise' || ev.action === 'complete') raised = true;
        const id = ids.get(ev.seat);
        if (ev.auto || ev.action === 'bring-in' || !id) continue;
        const read = (out[id] ??= { acts: 0, aggressive: 0, faced: 0, folds: 0 });
        read.acts++;
        if (ev.action === 'bet' || ev.action === 'raise' || ev.action === 'complete') read.aggressive++;
        if (facing) {
          read.faced++;
          if (ev.action === 'fold') read.folds++;
        }
      }
    }
  }
  return out;
}

/** A player's style, with what most players do filling in until there's enough to go on. */
function styleOf(read: PlayerRead | undefined) {
  const r = read ?? { acts: 0, aggressive: 0, faced: 0, folds: 0 };
  return { aggression: (r.aggressive + 1.6) / (r.acts + 8), foldRate: (r.folds + 2.1) / (r.faced + 6) };
}

/**
 * Hard: how much stronger than a random hand each live opponent has shown
 * (in the order of Situation.opponents). Bets and raises count most, calls
 * after the first round a little. A player who bets and raises most of the
 * time says less. (How many cards they draw is followed by replayDraws.)
 */
function handReads(hand: HandState, seat: SeatIndex, players: Record<PlayerId, PlayerRead>): number[] {
  const live = hand.seats.filter((x) => x.seat !== seat && !x.folded);
  return live.map((x) => {
    let shown = 0;
    let street = 0;
    for (const ev of hand.events) {
      if (ev.t === 'street') street = ev.street;
      else if (ev.t === 'action' && ev.seat === x.seat && !ev.auto) {
        if (ev.action === 'bet' || ev.action === 'raise' || ev.action === 'complete') shown += 1;
        else if (ev.action === 'call' && street > 0) shown += 0.35;
      }
    }
    const { aggression } = styleOf(players[x.playerId]);
    const believed = Math.max(0, Math.min(1, (0.55 - aggression) / 0.3));
    return Math.min(3, shown * believed);
  });
}

/** Acts after every opponent still to act for the rest of the hand (flop and draw games, where the button sets the order). */
function actsLast(hand: HandState, seat: SeatIndex): boolean {
  if (hand.input.game.family === 'stud') return false;
  const { maxSeats, button } = hand.input;
  const order = (s: SeatIndex) => (s - button - 1 + maxSeats) % maxSeats;
  return hand.seats.every((x) => x.seat === seat || x.folded || x.allIn || order(x.seat) < order(seat));
}

/** Hard: the odds as Normal plays them, against what opponents have shown, adjusted to position and to how they play. */
function decideHard(hand: HandState, seat: SeatIndex, legal: LegalActions, equity: number, players: Record<PlayerId, PlayerRead>, rand: Rand): Action {
  const me = hand.seats.find((x) => x.seat === seat)!;
  const live: HandSeat[] = hand.seats.filter((x) => x.seat !== seat && !x.folded);
  const opponents = live.length;
  const pot = hand.seats.reduce((n, x) => n + x.total, 0);
  const strength = equity * (opponents + 1);
  const lastRound = hand.street === hand.input.game.streets.length - 1;
  const inPosition = actsLast(hand, seat);
  // How often these opponents fold to a bet: the most stubborn one decides.
  const foldRate = Math.min(1, ...live.map((x) => styleOf(players[x.playerId]).foldRate));
  const raise = (fraction: number): Action => {
    const to = sizeTo(legal, hand.currentBet + fraction * (pot + legal.callAmount));
    return legal.raiseKind === 'bet' ? { type: 'bet', to } : { type: 'raise', to };
  };

  if (legal.canBringIn) {
    const steal = opponents <= 2 && rand() < Math.max(0, foldRate - 0.35);
    return legal.canRaise && (strength >= 1.35 || steal) ? raise(0) : { type: 'bring-in' };
  }
  const raiseBar = hand.raisesThisRound < 3 ? 0 : 0.85 + 0.04 * (hand.raisesThisRound - 3);
  const mayRaise = legal.canRaise && equity >= raiseBar;

  if (legal.canCheck) {
    // Bets thinner against players who call, and bigger with the best hands.
    const value = opponents === 1 ? equity >= Math.max(0.54, Math.min(0.64, 0.6 - 0.15 * (0.35 - foldRate))) : strength >= 1.35 || equity >= 0.6;
    if (mayRaise && value) return raise(equity >= 0.8 ? 0.75 + 0.25 * rand() : 0.5 + 0.25 * rand());
    // Bluffs (and bets its draws) when folds pay for it: more in position, rarely into two players, never more.
    let bluff = Math.max(0, Math.min(0.35, (foldRate - 0.33) * 1.5)) * (inPosition ? 1.3 : 0.7) * (opponents === 1 ? 1 : opponents === 2 ? 0.35 : 0);
    if (!lastRound) bluff *= 1 + equity;
    if (mayRaise && rand() < Math.min(0.4, bluff)) return raise(0.55 + 0.2 * rand());
    return { type: 'check' };
  }

  const odds = legal.callAmount / (pot + legal.callAmount);
  // Calls a little wider in position with cards to come, a little tighter out of it.
  let margin = legal.callAmount >= me.stack * 0.5 ? 0.05 : 0.015;
  if (!lastRound) margin += inPosition ? -0.02 : 0.01;
  if (mayRaise && (equity >= 0.78 || ((equity >= 0.66 || strength >= 2) && rand() < 0.7))) return raise(equity >= 0.85 ? 0.9 : 0.7);
  if (mayRaise && !lastRound && opponents === 1 && equity >= 0.35 && rand() < Math.max(0, foldRate - 0.4) * 0.5) return raise(0.7);
  if (equity >= odds + margin) return { type: 'call' };
  return { type: 'fold' };
}

/** A legal total for this round near `target`: at least the minimum, at most the maximum, all in when nearly there. */
function sizeTo(legal: LegalActions, target: number): number {
  if (legal.maxTo <= legal.minTo) return legal.maxTo;
  const to = Math.max(legal.minTo, Math.min(legal.maxTo, Math.round(target)));
  return to > legal.maxTo * 0.85 ? legal.maxTo : to;
}

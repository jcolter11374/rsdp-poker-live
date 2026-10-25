import { freshDeck, type Card } from '@rsdp/engine';
import { engine, type Action, type HandState, type LegalActions, type SeatIndex } from '@rsdp/engine/core';
import { getVariant, HIGH_EVALUATORS, LOW_EVALUATORS, type VariantSpec } from '@rsdp/engine/variants';

/**
 * Practice bots: a simple, rule-based player for every game. It estimates
 * its chance of winning by dealing the unseen cards out at random many times
 * (vs random hands), then bets, calls or folds against the pot odds. It only
 * looks at what a player in its seat could see: its own cards, up cards and
 * the boards.
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
  drawSims: 16,
  /** ...and when it only sizes up the hand for a bet. */
  drawBetSims: 8,
};

export function chooseMove(hand: HandState, seat: SeatIndex, rand: Rand): BotMove {
  const view = situation(hand, seat);
  if (hand.phase === 'drawing') {
    const max = hand.input.game.streets[hand.street].drawMaxDiscard ?? 0;
    return { kind: 'draw', discard: bestDraw(view, max, rand).discard };
  }
  const legal = engine.legalActions(hand, seat);
  if (!legal) throw new Error('not the bot’s turn');
  const equity = view.drawsLeft > 0 ? scaleToField(bestDraw(view, view.cardsPerPlayer, rand, botTuning.drawBetSims).equity, DRAW_OPPONENTS, view.opponents.length) : estimateEquity(view, rand);
  return { kind: 'act', action: decide(hand, seat, legal, equity, view.opponents.length, rand) };
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
  return {
    spec,
    mine: me.cards.map((c) => c.card),
    boards: (hand.runs[0] ?? [[]]).map((b) => [...b]),
    opponents: others.filter((x) => !x.folded).map((x) => x.cards.filter((c) => c.up).map((c) => c.card)),
    dead: others.filter((x) => x.folded).flatMap((x) => x.cards.filter((c) => c.up).map((c) => c.card)),
    cardsPerPlayer: streets.reduce((n, st) => n + st.dealDown + st.dealUp, 0),
    boardCards: streets.reduce((n, st) => n + st.dealBoard, 0),
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
  constructor(seen: Card[], private readonly rand: Rand) {
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
}

/**
 * Opponents in a draw game have had the chance to improve: model each one as
 * the best of a few random hands, one more per draw in the game, from the
 * cards left once everyone has a hand.
 */
function improve(view: Situation, pool: Pool, hand: Card[]): Card[] {
  if (view.spec.family !== 'draw') return hand;
  let best = hand;
  for (let i = 0; i < view.drawsInGame; i++) {
    const other = pool.deal(view.cardsPerPlayer);
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
  const hands = [myHand, ...dealt.map((h) => improve(view, pool, h))];
  let total = 0;
  for (const board of view.boards) {
    const full = [...board, ...pool.deal(view.boardCards - board.length)];
    total += potShare(view.spec, hands, full);
  }
  return total / view.boards.length;
}

/** Chance of winning (share of the pot) against random hands for every live opponent. */
export function estimateEquity(view: Situation, rand: Rand): number {
  const pool = new Pool(seenCards(view), rand);
  const myMissing = Math.max(0, view.cardsPerPlayer - view.mine.length);
  const opponents = view.opponents.slice(0, opponentsThatFit(view, pool.size, myMissing));
  const start = performance.now();
  let sum = 0;
  let n = 0;
  while (n < botTuning.maxSims && (n < botTuning.minSims || performance.now() - start < botTuning.thinkMs)) {
    pool.reset();
    sum += simulate(view, pool, [...view.mine, ...pool.deal(myMissing)], opponents);
    n++;
  }
  return sum / n;
}

/** Drawing is tried against at most this many opponents, to keep it quick. */
const DRAW_OPPONENTS = 2;

/** Equity against `from` opponents, as if each were beaten independently, stretched to `to` of them. */
function scaleToField(equity: number, from: number, to: number) {
  const used = Math.min(from, to);
  if (used === to || equity <= 0) return equity;
  return Math.pow(equity, to / used);
}

/**
 * Draw games: tries every allowed set of cards to throw away (with the same
 * random deals for each, so they compare fairly) and keeps the best.
 */
export function bestDraw(view: Situation, maxDiscard: number, rand: Rand, sims = botTuning.drawSims): { discard: number[]; equity: number } {
  const cards = view.mine.length;
  const opponents = view.opponents.slice(0, DRAW_OPPONENTS);
  const seeds = Array.from({ length: sims }, () => Math.floor(rand() * 2 ** 31));
  let best = { discard: [] as number[], equity: -1 };
  for (let mask = 0; mask < 1 << cards; mask++) {
    const discard = [...Array(cards).keys()].filter((i) => mask & (1 << i));
    if (discard.length > maxDiscard) continue;
    const kept = view.mine.filter((_, i) => !(mask & (1 << i)));
    let sum = 0;
    for (const seed of seeds) {
      const deals = new Pool(seenCards(view), seededRand(seed));
      // Later draws are a few more tries at the same cards.
      let mine = [...kept, ...deals.deal(discard.length)];
      for (let i = 1; i < view.drawsLeft && discard.length; i++) {
        const other = [...kept, ...deals.deal(discard.length)];
        if (other.length === mine.length && potShare(view.spec, [other, mine], []) > 0.5) mine = other;
      }
      sum += simulate(view, deals, mine, opponents);
    }
    const equity = sum / seeds.length;
    // Ties keep the earlier, smaller draw (standing pat comes first).
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
  // Keep re-raising wars short unless the hand is very strong.
  const mayRaise = legal.canRaise && (hand.raisesThisRound < 3 || equity >= 0.85);

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

/** A legal total for this round near `target`: at least the minimum, at most the maximum, all in when nearly there. */
function sizeTo(legal: LegalActions, target: number): number {
  if (legal.maxTo <= legal.minTo) return legal.maxTo;
  const to = Math.max(legal.minTo, Math.min(legal.maxTo, Math.round(target)));
  return to > legal.maxTo * 0.85 ? legal.maxTo : to;
}

import { freshDeck, suitOf, type Card } from '@rsdp/engine';
import {
  engine,
  HIDDEN_CARD,
  type Action,
  type HandEvent,
  type HandSeat,
  type HandState,
  type LegalActions,
  type PlayerId,
  type SeatIndex,
} from '@rsdp/engine/core';
import { getVariant, HIGH_EVALUATORS, LOW_EVALUATORS, type VariantSpec } from '@rsdp/engine/variants';
import type { BotLevel, BotNoteRule } from '@rsdp/engine/wire';

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
 *
 * Every coin flip goes through Dice, and each decision fills in a MoveWhy, so
 * a bot can say why it played as it did (explainMove), and a coach tip can
 * run Normal's rules with dice that never bluff (tipDice).
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
  return explainMove(hand, seat, rand, ctx).move;
}

/** Why a bot made a move: the rule that picked it (the table adds the rest of BotNoteRule). */
export type MoveRule = Exclude<BotNoteRule, 'rit-yes' | 'fallback'>;

/** The numbers behind a move, as the bot worked them out (only what it could see). */
export interface MoveWhy {
  rule: MoveRule;
  /** Its chance of winning: its share of the pot, ties and halves included. */
  equity?: number;
  /** Live opponents. */
  opponents?: number;
  /** Draws still to come (draw games), counting one in progress. */
  drawsLeft?: number;
  /** The pot is split: a hi-lo game, or two boards. */
  split?: boolean;
  /** Facing a bet: the call as a share of the pot once called... */
  cost?: number;
  /** ...and the chance of winning the bot wanted before calling. */
  need?: number;
  /** The call is half its chips or more, so it wanted a margin. */
  big?: boolean;
  /** It may raise, but not with this hand after this many raises. */
  capped?: boolean;
  /** The chance of the coin flip that picked this play (a bluff, a raise it makes some of the time). */
  often?: number;
  /** Hard: acts last for the rest of the hand... */
  inPosition?: boolean;
  /** ...is on the last betting round... */
  lastRound?: boolean;
  /** ...and how often the most stubborn opponent folds to a bet, and who that is. */
  foldRate?: number;
  foldFrom?: PlayerId;
  /** Draws: how many cards it threw, and the next best way to draw it weighed. */
  thrown?: number;
  alt?: { thrown: number; equity: number };
}

/** What a coin flip decides. */
export type RollLabel = 'bluff' | 'size' | 'raise-band' | 'value' | 'steal' | 'semi-bluff';
interface Roll {
  label: RollLabel;
  p: number;
  hit: boolean;
}

/** The bots' coin flips. */
export interface Dice {
  /** True with chance p. */
  roll(label: RollLabel, p: number): boolean;
  /** A number from base up to base + span. */
  between(label: RollLabel, base: number, span: number): number;
}

/** A bot's dice: exactly one rand() per call, so it plays the same as when it called rand() itself. */
const botDice = (rand: Rand, rolls: Roll[]): Dice => ({
  roll: (label, p) => {
    const v = rand();
    rolls.push({ label, p, hit: v < p });
    return v < p;
  },
  between: (_label, base, span) => base + span * rand(),
});

/** A tip's dice: it never bluffs, steals or semi-bluffs, always takes a raise it makes some of the time, and bets the smallest size. */
export const tipDice: Dice = { roll: (label) => label === 'raise-band', between: (_label, base) => base };

/** A bot's move, and the numbers and rule behind it. */
export function explainMove(hand: HandState, seat: SeatIndex, rand: Rand, ctx: BotContext = {}): { move: BotMove; why: MoveWhy } {
  const level = ctx.level ?? 'normal';
  const drawEffort = DRAW_EFFORT[level] ?? 1;
  const view = situation(hand, seat);
  if (level === 'hard') {
    view.reads = handReads(hand, seat, ctx.players ?? {});
    if (view.spec.family === 'draw' && lowDrawRule(view.spec)) view.draws = opponentDraws(hand, seat, view.drawsInGame);
  }
  const sims = (screen: number, final: number) => ({ screen: Math.max(1, Math.round(screen * drawEffort)), final: Math.max(1, Math.round(final * drawEffort)) });
  const opponents = view.opponents.length;
  const split = (!!view.spec.showdown.high && !!view.spec.showdown.low) || view.boards.length > 1;
  const why: MoveWhy = { rule: 'check', opponents, drawsLeft: view.drawsLeft, split };
  if (hand.phase === 'drawing') {
    const max = hand.input.game.streets[hand.street].drawMaxDiscard ?? 0;
    const best = bestDraw(view, max, rand, sims(botTuning.drawSims, botTuning.drawFinalSims));
    const alt = best.finalists[1];
    why.rule = best.discard.length ? 'draw' : 'pat';
    why.equity = best.equity;
    why.thrown = best.discard.length;
    if (alt) why.alt = { thrown: alt.discard.length, equity: alt.equity };
    return { move: { kind: 'draw', discard: best.discard }, why };
  }
  const legal = engine.legalActions(hand, seat);
  if (!legal) throw new Error('not the bot’s turn');
  const equity = sizeUp(view, rand, level, sims);
  why.equity = equity;
  const rolls: Roll[] = [];
  const dice = botDice(rand, rolls);
  let action: Action;
  if (level === 'easy') action = decideEasy(hand, seat, legal, equity, opponents, dice, why);
  else if (level === 'hard') action = decideHard(hand, seat, legal, equity, ctx.players ?? {}, dice, why);
  else action = decide(hand, seat, legal, equity, opponents, dice, why);
  // The flip that picked the play, if one did: a raise some of the time is the raise band, the rest go by their own name.
  const picked = rolls.find((r) => r.hit && r.label === (why.rule === 'raise' ? 'raise-band' : why.rule));
  if (picked) why.often = picked.p;
  return { move: { kind: 'act', action }, why };
}

/** The bot's chance of winning, to bet on. */
function sizeUp(view: Situation, rand: Rand, level: BotLevel, sims: (screen: number, final: number) => DrawSims): number {
  // With draws to come, Normal sizes up its chances against two opponents and stretches that to the rest; Hard plays it out against everyone.
  const field = level === 'hard' ? drawFieldSize(view) : DRAW_OPPONENTS;
  return view.drawsLeft > 0
    ? scaleToField(bestDraw(view, view.cardsPerPlayer, rand, sims(botTuning.drawBetSims, botTuning.drawBetFinalSims), field).equity, field, view.opponents.length)
    : estimateEquity(view, rand, EFFORT[level] ?? 1);
}

// ---------------------------------------------------------------- what the bot can see

export interface Situation {
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

export function situation(hand: HandState, seat: SeatIndex): Situation {
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

/** A hand as one seat sees it (seenBy); a coach tip takes nothing else. */
declare const SEEN: unique symbol;
export type Seen = HandState & { readonly [SEEN]: true };

/**
 * A copy of the hand holding only what the player in `seat` can see: their own
 * cards, everyone's up cards, the boards and the betting. No deck, muck or
 * seeds, and no other player's face-down card. It is built field by field,
 * never spread, so a field added to HandState later stays out until someone
 * adds it here on purpose.
 */
export function seenBy(hand: HandState, seat: SeatIndex): Seen {
  const input = hand.input;
  const out: HandState = {
    input: {
      handId: input.handId,
      handNumber: input.handNumber,
      game: input.game,
      betting: input.betting,
      stakes: { ...input.stakes },
      maxSeats: input.maxSeats,
      seats: input.seats.map((x) => ({ seat: x.seat, playerId: x.playerId, stack: x.stack, away: x.away })),
      button: input.button,
      buttonDead: input.buttonDead,
      posts: input.posts.map((x) => ({ seat: x.seat, kind: x.kind, amount: x.amount, live: x.live })),
      deck: [],
      reshuffleSeed: 0,
      options: { ...input.options },
      modifiers: [],
    },
    phase: hand.phase,
    street: hand.street,
    seats: hand.seats.map((x) => ({
      seat: x.seat,
      playerId: x.playerId,
      startStack: x.startStack,
      stack: x.stack,
      cards: x.cards.map((c) => (x.seat === seat || c.up ? { card: c.card, up: c.up } : { card: HIDDEN_CARD, up: false })),
      away: x.away,
      folded: x.folded,
      allIn: x.allIn,
      bet: x.bet,
      total: x.total,
      hasActed: x.hasActed,
      canRaise: x.canRaise,
      lastAction: x.lastAction,
      shown: x.seat === seat ? [...x.shown] : [],
      ritVote: x.ritVote,
    })),
    deckPos: 0,
    runs: hand.runs.map((run) => run.map((board) => [...board])),
    muck: [],
    toAct: hand.toAct,
    currentBet: hand.currentBet,
    lastFullRaise: hand.lastFullRaise,
    raisesThisRound: hand.raisesThisRound,
    runout: hand.runout,
    showdown: hand.showdown,
    awards: [],
    // Where each card sat in the deck is for checking a revealed hand, not for playing one.
    events: engine.visibleEvents(hand, { seat, seeAll: false }).map((e) => ('pos' in e ? withoutPos(e) : e)),
  };
  return out as Seen;
}

function withoutPos(e: HandEvent): HandEvent {
  const { pos: _pos, ...rest } = e as HandEvent & { pos?: number[] };
  return rest as HandEvent;
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

/** Marks for markCards: a card is marked when its stamp is the current one. Doubles, so the count never wraps (whole numbers are exact up to 2^53). */
const stamps = new Float64Array(64);
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

export type LowRule = 'deuce-to-seven' | 'badugi';

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
export function lowDrawRule(spec: VariantSpec): LowRule | null {
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
export interface OpponentDraws {
  done: (number | null)[];
  left: number;
}

/** Hard: each live opponent's draws so far. */
export function opponentDraws(hand: HandState, seat: SeatIndex, drawsInGame: number): OpponentDraws[] {
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

/** How long and how hard estimateDetail deals out finishes. */
export interface EquityTuning {
  thinkMs: number;
  minSims: number;
  maxSims: number;
}

/**
 * For coach tips: estimateEquity's loop at the tuning given, which also says
 * how many finishes it dealt (n), against how many opponents (vs: a crowded
 * deck can't deal everyone in), and how often it took the whole pot (scoop).
 */
export function estimateDetail(view: Situation, rand: Rand, tuning: EquityTuning): { equity: number; n: number; vs: number; scoop: number } {
  const pool = new Pool(seenCards(view), rand);
  const myMissing = Math.max(0, view.cardsPerPlayer - view.mine.length);
  const opponents = view.opponents.slice(0, opponentsThatFit(view, pool.size, myMissing));
  const start = performance.now();
  let sum = 0;
  let scoops = 0;
  let n = 0;
  while (n < tuning.maxSims) {
    const spent = performance.now() - start;
    if (n >= 1 && spent >= tuning.thinkMs * 3) break;
    if (n >= tuning.minSims && spent >= tuning.thinkMs) break;
    pool.reset();
    const share = simulate(view, pool, [...view.mine, ...pool.deal(myMissing)], opponents);
    sum += share;
    if (share === 1) scoops++;
    n++;
  }
  return { equity: sum / n, n, vs: opponents.length, scoop: scoops / n };
}

/**
 * How hard a coach tip thinks. Apart from botTuning (which tests turn down):
 * a tip is worked out once for a decision, when asked, so it deals out more.
 * Equity stops by 120 ms, the random-hands comparison by 45 ms.
 */
export const coachTuning = {
  equity: { thinkMs: 40, minSims: 80, maxSims: 1600 },
  vsRandom: { thinkMs: 15, minSims: 40, maxSims: 600 },
  /** Deals for each way to draw, then for the best few. */
  draw: { screen: 40, final: 240 },
  /** The same, sizing up the hand for a bet with draws to come. */
  drawBet: { screen: 24, final: 96 },
  /** The comparison against hands given no credit for their betting only runs when the main one took less than this. */
  vsRandomUnderMs: 60,
};

/** Deals for each way to draw (screen), and for the best few (final). */
export interface DrawSims {
  screen: number;
  final: number;
}

/** Drawing is tried against at most this many opponents (and so is Normal's betting with draws to come), to keep it quick. */
const DRAW_OPPONENTS = 2;
/** Ways of drawing looked at again more closely. */
const DRAW_FINALISTS = 4;

/** Every live opponent, if the deck can deal them all out along with every draw the bot has left. */
export function drawFieldSize(view: Situation): number {
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
  sims: DrawSims = { screen: botTuning.drawSims, final: botTuning.drawFinalSims },
  opponents = DRAW_OPPONENTS,
): { discard: number[]; equity: number; finalists: { discard: number[]; equity: number }[] } {
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
  const finalists = ranked.slice(0, DRAW_FINALISTS).map(({ discard }) => ({ discard, equity: equityOf(discard, final) }));
  let best = { discard: [] as number[], equity: -1 };
  for (const f of finalists) if (f.equity > best.equity + 1e-9) best = f;
  // The one it picked first, then the others it looked at closely, best first.
  return { ...best, finalists: [best, ...finalists.filter((f) => f !== best).sort((a, b) => b.equity - a.equity)] };
}

// ---------------------------------------------------------------- betting

/**
 * Normal: bets good hands, bluffs now and then heads-up after the first round,
 * and calls when its chance beats the pot odds by a margin. Coach tips use it
 * too (normalDecide), with dice that never bluff.
 */
function decide(hand: HandState, seat: SeatIndex, legal: LegalActions, equity: number, opponents: number, dice: Dice, why: MoveWhy): Action {
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
    const complete = legal.canRaise && strength >= 1.5;
    why.rule = complete ? 'complete' : 'bring-in';
    return complete ? raise(0) : { type: 'bring-in' };
  }
  // Keep re-raising wars short: each raise past the third needs a stronger hand, and past the seventh none is strong enough
  // (heads-up fixed limit has no cap, and two strong hands would otherwise raise each other all in a bet at a time).
  const raiseBar = hand.raisesThisRound < 3 ? 0 : 0.85 + 0.04 * (hand.raisesThisRound - 3);
  const mayRaise = legal.canRaise && equity >= raiseBar;
  why.capped = legal.canRaise && !mayRaise;

  if (legal.canCheck) {
    const value = strength >= 1.45 || equity >= 0.62;
    const bluff = !firstRound && opponents === 1 && dice.roll('bluff', 0.07);
    if (mayRaise && (value || bluff)) {
      why.rule = value ? 'value' : 'bluff';
      return raise(dice.between('size', 0.5, 0.25));
    }
    why.rule = 'check';
    return { type: 'check' };
  }

  const odds = legal.callAmount / (pot + legal.callAmount);
  const margin = legal.callAmount >= me.stack * 0.5 ? 0.08 : 0.03;
  why.cost = odds;
  why.need = odds + margin;
  why.big = legal.callAmount >= me.stack * 0.5;
  if (mayRaise && (equity >= 0.8 || ((equity >= 0.7 || strength >= 2.2) && dice.roll('raise-band', 0.8)))) {
    why.rule = 'raise';
    return raise(0.75);
  }
  why.rule = equity >= odds + margin ? 'call' : 'fold';
  if (equity >= odds + margin) return { type: 'call' };
  return { type: 'fold' };
}
export { decide as normalDecide };

/** Easy: calls small bets with almost anything, bets only good hands and small, raises only the best, and never bluffs. */
function decideEasy(hand: HandState, seat: SeatIndex, legal: LegalActions, equity: number, opponents: number, dice: Dice, why: MoveWhy): Action {
  const me = hand.seats.find((x) => x.seat === seat)!;
  const pot = hand.seats.reduce((n, x) => n + x.total, 0);
  const strength = equity * (opponents + 1);
  const raise = (fraction: number): Action => {
    const to = sizeTo(legal, hand.currentBet + fraction * (pot + legal.callAmount));
    return legal.raiseKind === 'bet' ? { type: 'bet', to } : { type: 'raise', to };
  };
  if (legal.canBringIn) {
    const complete = legal.canRaise && strength >= 2;
    why.rule = complete ? 'complete' : 'bring-in';
    return complete ? raise(0) : { type: 'bring-in' };
  }
  const mayRaise = legal.canRaise && hand.raisesThisRound < 3;
  why.capped = legal.canRaise && !mayRaise;
  if (legal.canCheck) {
    if (mayRaise && (strength >= 1.7 || equity >= 0.72) && dice.roll('value', 0.75)) {
      why.rule = 'value';
      return raise(dice.between('size', 0.3, 0.2));
    }
    why.rule = 'check';
    return { type: 'check' };
  }
  const odds = legal.callAmount / (pot + legal.callAmount);
  why.cost = odds;
  if (mayRaise && equity >= 0.85 && dice.roll('raise-band', 0.6)) {
    why.rule = 'raise';
    return raise(0.5);
  }
  // Curious about small bets; careful with its stack.
  const slack = legal.callAmount >= me.stack * 0.5 ? 0 : legal.callAmount <= pot * 0.6 ? 0.1 : 0.04;
  why.need = odds - slack;
  why.big = legal.callAmount >= me.stack * 0.5;
  // A call it makes only thanks to the slack is a loose one.
  why.rule = equity >= odds - slack ? (equity >= odds ? 'call' : 'call-loose') : 'fold';
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
export function handReads(hand: HandState, seat: SeatIndex, players: Record<PlayerId, PlayerRead>): number[] {
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
function decideHard(hand: HandState, seat: SeatIndex, legal: LegalActions, equity: number, players: Record<PlayerId, PlayerRead>, dice: Dice, why: MoveWhy): Action {
  const me = hand.seats.find((x) => x.seat === seat)!;
  const live: HandSeat[] = hand.seats.filter((x) => x.seat !== seat && !x.folded);
  const opponents = live.length;
  const pot = hand.seats.reduce((n, x) => n + x.total, 0);
  const strength = equity * (opponents + 1);
  const lastRound = hand.street === hand.input.game.streets.length - 1;
  const inPosition = actsLast(hand, seat);
  // How often these opponents fold to a bet: the most stubborn one decides.
  const foldRates = live.map((x) => styleOf(players[x.playerId]).foldRate);
  const foldRate = Math.min(1, ...foldRates);
  why.inPosition = inPosition;
  why.lastRound = lastRound;
  why.foldRate = foldRate;
  why.foldFrom = live[foldRates.indexOf(foldRate)]?.playerId;
  const raise = (fraction: number): Action => {
    const to = sizeTo(legal, hand.currentBet + fraction * (pot + legal.callAmount));
    return legal.raiseKind === 'bet' ? { type: 'bet', to } : { type: 'raise', to };
  };

  if (legal.canBringIn) {
    const steal = opponents <= 2 && dice.roll('steal', Math.max(0, foldRate - 0.35));
    why.rule = legal.canRaise && strength >= 1.35 ? 'complete' : legal.canRaise && steal ? 'steal' : 'bring-in';
    return legal.canRaise && (strength >= 1.35 || steal) ? raise(0) : { type: 'bring-in' };
  }
  const raiseBar = hand.raisesThisRound < 3 ? 0 : 0.85 + 0.04 * (hand.raisesThisRound - 3);
  const mayRaise = legal.canRaise && equity >= raiseBar;
  why.capped = legal.canRaise && !mayRaise;

  if (legal.canCheck) {
    // Bets thinner against players who call, and bigger with the best hands.
    const value = opponents === 1 ? equity >= Math.max(0.54, Math.min(0.64, 0.6 - 0.15 * (0.35 - foldRate))) : strength >= 1.35 || equity >= 0.6;
    if (mayRaise && value) {
      why.rule = 'value';
      return raise(equity >= 0.8 ? dice.between('size', 0.75, 0.25) : dice.between('size', 0.5, 0.25));
    }
    // Bluffs (and bets its draws) when folds pay for it: more in position, rarely into two players, never more.
    let bluff = Math.max(0, Math.min(0.35, (foldRate - 0.33) * 1.5)) * (inPosition ? 1.3 : 0.7) * (opponents === 1 ? 1 : opponents === 2 ? 0.35 : 0);
    if (!lastRound) bluff *= 1 + equity;
    if (mayRaise && dice.roll('bluff', Math.min(0.4, bluff))) {
      why.rule = 'bluff';
      return raise(dice.between('size', 0.55, 0.2));
    }
    why.rule = 'check';
    return { type: 'check' };
  }

  const odds = legal.callAmount / (pot + legal.callAmount);
  // Calls a little wider in position with cards to come, a little tighter out of it.
  let margin = legal.callAmount >= me.stack * 0.5 ? 0.05 : 0.015;
  if (!lastRound) margin += inPosition ? -0.02 : 0.01;
  why.cost = odds;
  why.need = odds + margin;
  why.big = legal.callAmount >= me.stack * 0.5;
  if (mayRaise && (equity >= 0.78 || ((equity >= 0.66 || strength >= 2) && dice.roll('raise-band', 0.7)))) {
    why.rule = 'raise';
    return raise(equity >= 0.85 ? 0.9 : 0.7);
  }
  if (mayRaise && !lastRound && opponents === 1 && equity >= 0.35 && dice.roll('semi-bluff', Math.max(0, foldRate - 0.4) * 0.5)) {
    why.rule = 'semi-bluff';
    return raise(0.7);
  }
  why.rule = equity >= odds + margin ? 'call' : 'fold';
  if (equity >= odds + margin) return { type: 'call' };
  return { type: 'fold' };
}

/** A legal total for this round near `target`: at least the minimum, at most the maximum, all in when nearly there. */
export function sizeTo(legal: LegalActions, target: number): number {
  if (legal.maxTo <= legal.minTo) return legal.maxTo;
  const to = Math.max(legal.minTo, Math.min(legal.maxTo, Math.round(target)));
  return to > legal.maxTo * 0.85 ? legal.maxTo : to;
}

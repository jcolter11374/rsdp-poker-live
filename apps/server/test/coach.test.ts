import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FAIR_VERSION, freshDeck, type Card } from '@rsdp/engine';
import { engine, variants, type BettingKind, type HandState, type PlannedPost } from '@rsdp/engine/core';
import { getVariant, registerAllVariants, VARIANT_LIST, type VariantSpec } from '@rsdp/engine/variants';
import { BOT_LEVELS, BOT_NOTE_RULES, type BotNote } from '@rsdp/engine/wire';
import { coachTip } from '../src/bots/coach';
import { botNote, plainNote } from '../src/bots/reasons';
import { botTuning, coachTuning, explainMove, seededRand, seenBy, type PlayerRead, type MoveWhy } from '../src/bots/strategy';

beforeAll(() => registerAllVariants(variants));

const FULL = 'AKQJT98765432'.split('').flatMap((r) => 'cdhs'.split('').map((s) => r + s));

/** Deals one hand from a stacked deck: stud games ante and bring in, the rest post blinds. */
function dealt(gameId: string, cards: string[], players = 2, stacks: number[] = []) {
  const spec = getVariant(gameId);
  const stud = spec.family === 'stud';
  const posts: PlannedPost[] = stud
    ? Array.from({ length: players }, (_, seat) => ({ seat, kind: 'ante' as const, amount: 1, live: false }))
    : [
        { seat: 0, kind: 'small-blind', amount: 1, live: true },
        { seat: 1, kind: 'big-blind', amount: 2, live: true },
      ];
  return engine.startHand({
    handId: 'h',
    handNumber: 1,
    game: spec,
    betting: spec.defaultBetting,
    stakes: { smallBlind: stud ? 0 : 1, bigBlind: 2, ante: stud ? 1 : 0, anteType: stud ? 'per-player' : 'none', bringIn: 1, smallBet: 2, bigBet: 4 },
    maxSeats: players,
    seats: Array.from({ length: players }, (_, i) => ({ seat: i, playerId: `p${i}`, stack: stacks[i] ?? 200, away: false })),
    button: players === 2 ? 1 : 0,
    buttonDead: false,
    posts,
    deck: [...cards, ...FULL.filter((c) => !cards.includes(c))],
    reshuffleSeed: 1,
    options: { boards: 1, bombPot: false, runItTwice: 'off', fixedLimitCap: 4, uncappedHeadsUp: false },
    modifiers: [],
  });
}

/** The tip this seat would get now, as TableRuntime.coachTip builds it. */
function tipAt(hand: HandState, seat: number, seed = 5) {
  const drawing = hand.phase === 'drawing';
  return coachTip(seenBy(hand, seat), seat, {
    legal: drawing ? null : engine.legalActions(hand, seat),
    drawMax: drawing ? (hand.input.game.streets[hand.street].drawMaxDiscard ?? 0) : 0,
    rand: seededRand(seed),
    handNumber: hand.input.handNumber,
    at: hand.events.length,
  });
}

/** Checks and calls to the given street, then checks round to `from`, who bets to `to`. */
function betInto(hand: HandState, street: number, from: number, to: number) {
  for (let i = 0; i < 40 && hand.street < street; i++) {
    const legal = engine.legalActions(hand, hand.toAct!)!;
    engine.act(hand, hand.toAct!, legal.canCheck ? { type: 'check' } : legal.canBringIn ? { type: 'bring-in' } : { type: 'call' });
  }
  for (let i = 0; i < 10 && hand.toAct !== from; i++) engine.act(hand, hand.toAct!, { type: 'check' });
  engine.act(hand, from, { type: hand.currentBet > 0 ? 'raise' : 'bet', to });
  return hand;
}

/** Deals enough finishes for the numbers to settle, and never stops on the clock, so every answer here is the same on every machine. */
const SETTLED = {
  equity: { thinkMs: 1e9, minSims: 200, maxSims: 200 },
  vsRandom: { thinkMs: 1e9, minSims: 100, maxSims: 100 },
  draw: { screen: 12, final: 48 },
  drawBet: { screen: 6, final: 24 },
  vsRandomUnderMs: 1e9,
};
/** The same, turned right down: enough for "is it the same answer?", too few for "is it the right answer?". */
const QUICK = {
  equity: { thinkMs: 1e9, minSims: 16, maxSims: 16 },
  vsRandom: { thinkMs: 1e9, minSims: 8, maxSims: 8 },
  draw: { screen: 3, final: 6 },
  drawBet: { screen: 2, final: 4 },
  vsRandomUnderMs: 1e9,
};

function fixTuning(tip: typeof SETTLED) {
  const coach = structuredClone(coachTuning);
  const bots = { ...botTuning };
  beforeAll(() => {
    Object.assign(coachTuning, tip);
    Object.assign(botTuning, { thinkMs: 1e9, minSims: 8, maxSims: 8, drawSims: 2, drawFinalSims: 4, drawBetSims: 2, drawBetFinalSims: 2 });
  });
  afterAll(() => {
    Object.assign(coachTuning, coach);
    Object.assign(botTuning, bots);
  });
}

describe('what a coach tip says', () => {
  fixTuning(SETTLED);

  it('raises the nuts facing a bet, and folds a hand that cannot pay for the call', () => {
    // A royal flush on the river, with a bet to raise.
    const nuts = betInto(dealt('nlhe', ['Ah', '2c', 'Kh', '7d', 'Qh', 'Jh', 'Th', '2d', '3d']), 3, 1, 10);
    const raise = tipAt(nuts, 0);
    expect(raise).toMatchObject({ kind: 'bet', rule: 'raise', share: 1, close: false, move: { type: 'raise', to: 28, fraction: 0.75, allIn: false } });
    // Three quarters of the pot once called: 10 + 4 in the middle, 10 to call.
    expect(raise.cost).toBeCloseTo(10 / 24);

    // Seven-deuce facing a raise to 40.
    const junk = dealt('nlhe', ['7c', 'As', '2d', 'Ah']);
    engine.act(junk, 0, { type: 'call' });
    engine.act(junk, 1, { type: 'raise', to: 40 });
    const fold = tipAt(junk, 0);
    expect(fold).toMatchObject({ rule: 'fold', move: { type: 'fold' }, close: false });
    expect(fold.need).toBeGreaterThan(fold.share);
    // The betting counted against it, so the browser can show what a hand that had not bet would be worth.
    expect(fold.vsRandom).toBeGreaterThan(fold.share);
    expect(fold.reads).toEqual([{ seat: 1, bets: 1 }]);
  });

  it('brings in a weak hand and completes a strong one', () => {
    // Four queens showing: the queen of clubs brings in. Nine-jack-trey has nothing to complete with.
    const weak = dealt('stud', ['9d', 'Kc', 'Kd', 'Ks', 'Jh', 'Qc', 'Qd', 'Qs', '3c', 'Ah', 'Ad', 'As'], 4);
    expect(weak.toAct).toBe(1);
    expect(tipAt(weak, 1)).toMatchObject({ rule: 'bring-in', move: { type: 'bring-in' }, cost: null, need: null, close: false, opponents: 3 });
    // Ace-deuce-trey of clubs, three to a straight flush, does.
    const strong = dealt('stud', ['Ac', 'Kd', 'Qd', 'Jd', '2c', 'Kh', 'Qh', 'Jh', '3c', 'Ks', 'Qs', 'Js'], 4);
    expect(tipAt(strong, strong.toAct!)).toMatchObject({ rule: 'complete', move: { type: 'complete', to: 2, fraction: null, allIn: false } });
  });

  it('throws the card that spoils a draw, and shows the other ways to draw', () => {
    // 2-7: a king is far too high.
    const td = dealt('td27', ['2c', 'Ah', '3d', 'Ad', '4s', 'As', '8c', 'Qh', 'Kd', 'Qd']);
    engine.act(td, 0, { type: 'call' });
    engine.act(td, 1, { type: 'check' });
    expect(td.seats[0].cards.map((c) => c.card)).toEqual(['2c', '3d', '4s', '8c', 'Kd']);
    const draw = tipAt(td, 0);
    expect(draw).toMatchObject({ kind: 'draw', rule: 'draw', move: { type: 'draw', discard: [4] }, drawsLeft: 3, call: 0, cost: null, big: false });
    expect(draw.options[0]).toEqual({ discard: [4], share: draw.share });
    expect(draw.options.length).toBeGreaterThan(1);
    expect(draw.options.at(-1)!.share).toBeLessThanOrEqual(draw.share);
    expect(draw.draws).toEqual([{ seat: 1, done: [] }]);

    // Badugi: the five of hearts shares a suit with the three.
    const bd = dealt('badugi', ['Ac', 'Kh', '2d', 'Kd', '5h', 'Ks', '3h', 'Qs']);
    engine.act(bd, 0, { type: 'call' });
    engine.act(bd, 1, { type: 'check' });
    expect(bd.seats[0].cards.map((c) => c.card)).toEqual(['Ac', '2d', '5h', '3h']);
    expect(tipAt(bd, 0).move).toEqual({ type: 'draw', discard: [2] });

    // Standing pat is a pat tip, not a draw of nothing.
    const pat = dealt('badugi', ['Ac', 'Kh', '2d', 'Kd', '3h', 'Ks', '4s', 'Qs']);
    engine.act(pat, 0, { type: 'call' });
    engine.act(pat, 1, { type: 'check' });
    expect(tipAt(pat, 0)).toMatchObject({ rule: 'pat', move: { type: 'draw', discard: [] } });
  });

  it('counts only the chips it can win when the call is against a short stack', () => {
    // 30 behind against a raise to 100: the big blind's 2 and 30 of the raise are all this hand can win.
    const side = dealt('nlhe', ['Ac', 'Ks', 'Ad', 'Kd', 'Qc', 'Qd'], 3, [30, 200, 200]);
    engine.act(side, 2, { type: 'raise', to: 100 });
    const tip = tipAt(side, 0);
    const middle = side.seats.reduce((n, x) => n + x.total, 0);
    expect([tip.call, tip.pot, middle]).toEqual([29, 33, 103]);
    expect(tip.cost).toBeCloseTo(29 / 62);
  });

  it('wants a bigger margin when the call is half the stack, which turns a call into a fold', () => {
    // A raise, a call, then a bet on the flop. The chance is the same whatever the bet is, so the first run sizes it.
    const spot = (bet: number, stack: number) => {
      const hand = dealt('nlhe', ['Th', '2c', '9d', '7d', 'Jh', '4c', '2s', 'Kd', '5h'], 2, [stack, 400]);
      engine.act(hand, 0, { type: 'raise', to: 20 });
      engine.act(hand, 1, { type: 'call' });
      for (let i = 0; i < 4 && hand.toAct !== 1; i++) engine.act(hand, hand.toAct!, { type: 'check' });
      engine.act(hand, 1, { type: 'bet', to: bet });
      return hand;
    };
    // Sized so the chance is five points above the pot odds: enough to call, not enough with half the stack at risk.
    const share = tipAt(spot(10, 400), 0).share;
    const target = share - 0.05;
    const bet = Math.round((40 * target) / (1 - 2 * target));
    const deep = tipAt(spot(bet, 400), 0);
    expect(deep).toMatchObject({ rule: 'call', big: false, move: { type: 'call' } });
    expect(deep.share).toBe(share);
    const short = tipAt(spot(bet, 20 + 2 * bet), 0);
    expect(short).toMatchObject({ rule: 'fold-big', big: true, move: { type: 'fold' } });
    expect(short.need! - short.cost!).toBeCloseTo(0.08);
    // Either way the chance is within the noise of what the call needs, so the browser offers both.
    expect([deep.close, short.close]).toEqual([true, true]);
  });

  it('takes the whole pot less often than it wins a share of it', () => {
    const hiLo = dealt('plo8', ['As', 'Kc', '2h', 'Kd', '3c', 'Qs', '4d', 'Qh', '4s', '7d', '2d']);
    engine.act(hiLo, 0, { type: 'call' });
    engine.act(hiLo, 1, { type: 'check' });
    const tip = tipAt(hiLo, hiLo.toAct!);
    expect(tip.split).toBe(true);
    expect(tip.scoop).toBeLessThanOrEqual(tip.share);
    expect(tip.scoop).toBeGreaterThan(0);
    // Nothing to call, a strong hand: half the pot.
    expect(tip).toMatchObject({ rule: 'bet', move: { type: 'bet', fraction: 0.5, allIn: false } });
  });

  it('sizes a bet with draws to come from the best way to draw, against the whole field', () => {
    const td = dealt('td27', ['2c', 'Ah', '3d', 'Ad', '4s', 'As', '8c', 'Qh', 'Kd', 'Qd'], 2);
    engine.act(td, 0, { type: 'call' });
    engine.act(td, 1, { type: 'check' });
    engine.draw(td, 0, [4]);
    engine.draw(td, 1, [0, 1, 2]);
    expect(td.phase).toBe('betting');
    const tip = tipAt(td, td.toAct!);
    expect(tip).toMatchObject({ kind: 'bet', drawsLeft: 2, vs: 1, scoop: null, vsRandom: null });
    expect(tip.share).toBeGreaterThan(0);
    expect(tip.draws).toEqual([{ seat: td.toAct === 0 ? 1 : 0, done: [td.toAct === 0 ? 3 : 1] }]);
  });
});

// ---------------------------------------------------------------- it can only use what that seat sees

/** Every card the player in `seat` has been shown: their own (thrown ones too), up cards, boards and cards shown. */
function visibleTo(hand: HandState, seat: number): Set<Card> {
  const out = new Set<Card>();
  for (const e of hand.events) {
    if (e.t === 'deal') for (const c of e.cards) if (c.up || e.seat === seat) out.add(c.card);
    if (e.t === 'draw' && e.seat === seat) for (const c of e.cards) out.add(c);
    if (e.t === 'board' || e.t === 'show') for (const c of e.cards) out.add(c);
  }
  return out;
}

/**
 * The same hand with every card that seat has not been shown swapped for
 * another they have not been shown, and with new seeds. Anything built from
 * what they can see must come out the same.
 */
function permuted(hand: HandState, seat: number, seed: number): HandState {
  const visible = visibleTo(hand, seat);
  const hidden = freshDeck().filter((c) => !visible.has(c));
  const shuffled = [...hidden];
  const rand = seededRand(seed);
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const swap = new Map(hidden.map((c, i) => [c, shuffled[i]]));
  // Every card not on that list is one they have seen, so swapping the rest wherever they appear (other players' hole
  // cards, the deck, the muck, the deal and draw events) leaves a hand that looks the same from their seat.
  const out = JSON.parse(JSON.stringify(hand, (_key, value) => (typeof value === 'string' && swap.has(value) ? swap.get(value) : value))) as HandState;
  if (out.input.fair) out.input.fair = { ...out.input.fair, serverSeed: 'f'.repeat(32), handSeed: 'e'.repeat(64) };
  return out;
}

/** How players have played lately, for Hard: one who folds a lot, one who raises everything, one who calls. */
const READS: Record<string, PlayerRead> = {
  p0: { acts: 30, aggressive: 3, faced: 14, folds: 10 },
  p1: { acts: 40, aggressive: 34, faced: 8, folds: 0 },
  p2: { acts: 25, aggressive: 4, faced: 12, folds: 1 },
};

/**
 * A hand from a seeded deck, played with simple moves (bring in, one bet a
 * street, calls and small draws) and stopped at a decision on one street,
 * after someone has already acted there. Between them the seeds cover two to
 * four players, every street and both phases.
 */
function spot(spec: VariantSpec, betting: BettingKind, seed: number): HandState {
  const players = 2 + (seed % 3);
  const rand = seededRand(seed * 7919);
  const deck = [...FULL];
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  const stud = spec.family === 'stud';
  const posts: PlannedPost[] = stud
    ? Array.from({ length: players }, (_, seat) => ({ seat, kind: 'ante' as const, amount: 1, live: false }))
    : [
        { seat: 0, kind: 'small-blind', amount: 1, live: true },
        { seat: 1 % players, kind: 'big-blind', amount: 2, live: true },
      ];
  const hand = engine.startHand({
    handId: `s${seed}`,
    handNumber: seed,
    game: spec,
    betting,
    stakes: { smallBlind: stud ? 0 : 1, bigBlind: 2, ante: stud ? 1 : 0, anteType: stud ? 'per-player' : 'none', bringIn: 1, smallBet: 2, bigBet: 4 },
    maxSeats: players,
    seats: Array.from({ length: players }, (_, i) => ({ seat: i, playerId: `p${i}`, stack: 200, away: false })),
    button: 0,
    buttonDead: false,
    posts,
    deck,
    reshuffleSeed: seed,
    fair: { version: FAIR_VERSION, commit: 'c'.repeat(64), serverSeed: 'a'.repeat(32), clientSeeds: [{ playerId: 'p0', seed: 'b'.repeat(16) }], handSeed: 'd'.repeat(64) },
    options: { boards: 1, bombPot: false, runItTwice: 'off', fixedLimitCap: 4, uncappedHeadsUp: false },
    modifiers: [],
  });
  const target = seed % spec.streets.length;
  let acted = 0;
  for (let step = 0; step < 300 && hand.phase !== 'complete' && hand.toAct !== null; step++) {
    const seat = hand.toAct;
    if (hand.street === target && acted >= 1) return hand;
    if (hand.street !== target) acted = 0;
    if (hand.phase === 'drawing') {
      if (hand.street === target) return hand;
      engine.draw(hand, seat, [...Array((seed + seat) % 3).keys()]);
      continue;
    }
    const legal = engine.legalActions(hand, seat)!;
    if (legal.canBringIn) engine.act(hand, seat, { type: 'bring-in' });
    else if (legal.canRaise && hand.raisesThisRound === 0 && hand.street === target) engine.act(hand, seat, legal.raiseKind === 'bet' ? { type: 'bet', to: legal.minTo } : { type: 'raise', to: legal.minTo });
    else engine.act(hand, seat, legal.canCheck ? { type: 'check' } : { type: 'call' });
    acted++;
  }
  throw new Error(`no decision to tip in ${spec.id} on street ${target} (seed ${seed})`);
}

const SEEDS = 8;

describe('a tip only uses what that seat can see', () => {
  fixTuning(QUICK);

  it('never reaches for a card the player cannot see', () => {
    const source = readFileSync(path.resolve(__dirname, '../src/bots/coach.ts'), 'utf8');
    for (const banned of ['.deck', '.muck', '.fair', 'serverSeed', 'deckPos', 'chooseMove', 'explainMove']) expect(source, banned).not.toContain(banned);
  });

  for (const spec of VARIANT_LIST) {
    it(`gives the same tip and the same bot move whatever the hidden cards are in ${spec.name}`, () => {
      for (let seed = 1; seed <= SEEDS; seed++) {
        const hand = spot(spec, spec.defaultBetting, seed);
        const seat = hand.toAct!;
        const other = permuted(hand, seat, seed + 100);
        // The swap really did change the cards, and the seeds.
        expect(JSON.stringify(other)).not.toBe(JSON.stringify(hand));
        expect(seenBy(other, seat)).toEqual(seenBy(hand, seat));
        expect(tipAt(other, seat)).toEqual(tipAt(hand, seat));
        // And from a bot's seat, the same move for the same reasons: a bot sees no more than a tip does.
        for (const level of BOT_LEVELS) {
          const was = explainMove(hand, seat, seededRand(seed), { level, players: READS });
          expect(explainMove(other, seat, seededRand(seed), { level, players: READS })).toEqual(was);
        }
      }
    });
  }
});

// ---------------------------------------------------------------- the bots' reasons

const NOTE_KEYS = ['seq', 'seat', 'level', 'rule', 'share', 'split', 'vs', 'drawsLeft', 'cost', 'need', 'big', 'capped', 'often', 'thrown', 'alt', 'last', 'you', 'yourBets'];
const NOTE_WORDS = [...NOTE_KEYS, ...BOT_NOTE_RULES, ...BOT_LEVELS, 'folds-often', 'calls-often'];

describe('what a bot says about its move (botNote)', () => {
  fixTuning(QUICK);

  it('keeps nothing but whitelisted numbers and words', () => {
    const notes: BotNote[] = [plainNote(0, 1, 'normal', 'rit-yes'), plainNote(4, 2, 'easy', 'fallback')];
    for (const spec of VARIANT_LIST) {
      for (const level of BOT_LEVELS) {
        for (let seed = 1; seed <= 3; seed++) {
          const hand = spot(spec, spec.defaultBetting, seed);
          const seat = hand.toAct!;
          const { why } = explainMove(hand, seat, seededRand(seed), { level, players: READS });
          notes.push(botNote(hand.events.length, seat, level, why, hand, 'p0'));
        }
      }
    }
    expect(notes.length).toBeGreaterThan(50);
    for (const note of notes) {
      expect(Object.keys(note).filter((k) => !NOTE_KEYS.includes(k))).toEqual([]);
      expect(BOT_NOTE_RULES).toContain(note.rule);
      expect(Number.isInteger(note.seq) && note.seq >= 0).toBe(true);
      expect(Number.isInteger(note.seat) && note.seat >= 0).toBe(true);
      for (const x of [note.share, note.cost, note.need, note.often, note.alt?.share]) if (x !== undefined) expect(x).toBeGreaterThanOrEqual(0), expect(x).toBeLessThanOrEqual(1);
      for (const x of [note.vs, note.drawsLeft, note.thrown, note.alt?.thrown, note.yourBets]) if (x !== undefined) expect(Number.isInteger(x) && x >= 0).toBe(true);
      // Chances are rough on purpose, so they are given in fives.
      if (note.share !== undefined) expect(Math.round(note.share * 20)).toBeCloseTo(note.share * 20);
    }
    // No card, and no word that isn't one of ours.
    const json = JSON.stringify(notes);
    expect(json).not.toMatch(/"[2-9TJQKA][cdhs]"/);
    expect(json).not.toContain('??');
    for (const [, word] of json.matchAll(/"([^"]*)"/g)) expect(NOTE_WORDS).toContain(word);
  });

  it('says what Hard made of how you play only when it was about you, and counts your bets', () => {
    const hand = dealt('nlhe', ['Kc', 'Qs', '9d', 'Jh']);
    engine.act(hand, 0, { type: 'raise', to: 8 });
    engine.act(hand, 1, { type: 'raise', to: 20 });
    engine.act(hand, 0, { type: 'raise', to: 60 });
    const why: MoveWhy = { rule: 'bluff', foldFrom: 'p0', foldRate: 0.5 };
    expect(botNote(1, 1, 'hard', why, hand, 'p0')).toMatchObject({ you: 'folds-often', yourBets: 2 });
    // Another player's folding is never anyone's business.
    expect(botNote(1, 1, 'hard', why, hand, 'p1').you).toBeUndefined();
    // Only Hard reads players, and only where the read chose the play.
    expect(botNote(1, 1, 'normal', why, hand, 'p0').you).toBeUndefined();
    expect(botNote(1, 1, 'hard', { ...why, rule: 'fold' }, hand, 'p0').you).toBeUndefined();
    expect(botNote(1, 1, 'hard', { ...why, foldRate: 0.2 }, hand, 'p0').you).toBe('calls-often');
    expect(botNote(1, 1, 'hard', { ...why, foldRate: 0.35 }, hand, 'p0').you).toBeUndefined();
    expect(botNote(1, 1, 'normal', why, hand, 'p0').yourBets).toBeUndefined();
  });

  it("doesn't count your bets once you have folded: Hard reads only the players still in", () => {
    const hand = dealt('nlhe', ['Kc', 'Qs', '9d', 'Jh', '2c', '3d'], 3);
    // p0 raises, p1 and p2 call, then p0 folds to a bet on the flop.
    engine.act(hand, 2, { type: 'call' });
    engine.act(hand, 0, { type: 'raise', to: 6 });
    while (hand.street === 0) engine.act(hand, hand.toAct!, { type: 'call' });
    while (hand.toAct !== 0) engine.act(hand, hand.toAct!, hand.currentBet ? { type: 'call' } : { type: 'bet', to: 6 });
    const why: MoveWhy = { rule: 'fold', equity: 0.05, cost: 0.3 };
    expect(botNote(1, 1, 'hard', why, hand, 'p0').yourBets).toBe(1);
    engine.act(hand, 0, { type: 'fold' });
    expect(botNote(1, 1, 'hard', why, hand, 'p0').yourBets).toBeUndefined();
  });

  it('rounds its guesses and keeps the rest of the numbers', () => {
    const hand = dealt('nlhe', ['Kc', 'Qs', '9d', 'Jh']);
    const why: MoveWhy = { rule: 'call', equity: 0.4231, opponents: 2, cost: 0.2567, need: 0.2867, big: true, capped: true, often: 0.8, split: true, drawsLeft: 2, thrown: 2, alt: { thrown: 1, equity: 0.3812 }, inPosition: true };
    expect(botNote(7, 3, 'hard', why, hand, 'p0')).toEqual({
      seq: 7,
      seat: 3,
      level: 'hard',
      rule: 'call',
      share: 0.4,
      split: true,
      vs: 2,
      drawsLeft: 2,
      cost: 0.26,
      need: 0.29,
      big: true,
      capped: true,
      often: 0.8,
      thrown: 2,
      alt: { thrown: 1, share: 0.4 },
      last: true,
    });
  });
});

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { engine, variants, type Action, type BettingKind, type HandState, type PlannedPost } from '@rsdp/engine/core';
import { defaultSettings } from '@rsdp/engine/settings';
import { registerAllVariants, VARIANT_LIST, type VariantSpec } from '@rsdp/engine/variants';
import { BOT_LEVELS, type BotLevel } from '@rsdp/engine/wire';
import { TableRuntime } from '../src/runtime/table';
import { botTuning, chooseMove, seededRand, type BotMove, type PlayerRead } from '../src/bots/strategy';
import { FakeClock, seeded } from './fake-clock';

/**
 * Golden bot moves: every decision the bots make in a fixed set of hands, with
 * how many random numbers each one drew, as the code played them when the
 * file was made. A change to the bots' code that is meant to leave their play
 * alone (a refactor, explaining their moves) must keep every line. A change
 * meant to change how they play makes the file again:
 *
 *   BOT_MOVES_UPDATE=1 npx vitest run test/bot-golden.test.ts
 *
 * Each line is `<hand or seed>.<street>:<seat>:<move>:<random numbers drawn>`.
 */
const GOLDEN = path.resolve(__dirname, '__snapshots__/bot-moves.json');
const UPDATE = !!process.env.BOT_MOVES_UPDATE;

/** Hands each table plays, and hands dealt from a seeded deck, for each game, betting and level. */
const TABLE_HANDS = 6;
const SEEDS = 6;

/**
 * The table's own bots, recorded as they move: whichever of the strategy's
 * entry points the table calls, its rand is counted and its move written down
 * while `recording.out` is set. Nothing is worked out twice.
 */
const recording = vi.hoisted(() => ({ out: null as string[] | null }));
vi.mock('../src/bots/strategy', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  type Entry = (hand: HandState, seat: number, rand: () => number, ctx?: unknown) => BotMove | { move: BotMove };
  const counted = (fn: Entry): Entry => (hand, seat, rand, ctx) => {
    if (!recording.out) return fn(hand, seat, rand, ctx);
    let n = 0;
    const res = fn(hand, seat, () => (n++, rand()), ctx);
    recording.out.push(line(String(hand.input.handNumber), hand, seat, 'move' in res ? res.move : res, n));
    return res;
  };
  const out = { ...real };
  for (const name of ['chooseMove', 'explainMove']) if (typeof real[name] === 'function') out[name] = counted(real[name] as Entry);
  return out;
});

type Golden = Record<string, { table: string[]; spots: string[] }>;
const golden: Golden = existsSync(GOLDEN) ? JSON.parse(readFileSync(GOLDEN, 'utf8')) : {};
const made: Golden = {};

beforeAll(() => registerAllVariants(variants));

// A fixed number of deals for every decision, so nothing depends on how fast the machine is (and few, so the test is quick).
const tuning = { ...botTuning };
beforeAll(() => Object.assign(botTuning, { thinkMs: 1e9, minSims: 4, maxSims: 4, drawSims: 3, drawFinalSims: 6, drawBetSims: 2, drawBetFinalSims: 4 }));
afterAll(() => {
  Object.assign(botTuning, tuning);
  if (!UPDATE) return;
  mkdirSync(path.dirname(GOLDEN), { recursive: true });
  // Only the cases that ran are replaced, so a run filtered with -t keeps the rest.
  const all = { ...golden, ...made };
  const sorted = Object.fromEntries(Object.keys(all).sort().map((k) => [k, all[k]]));
  writeFileSync(GOLDEN, JSON.stringify(sorted, null, 1) + '\n');
});

function line(where: string, hand: HandState, seat: number, move: BotMove, randCalls: number): string {
  const text = move.kind === 'draw' ? ['draw', ...move.discard].join(' ') : 'to' in move.action ? `${move.action.type} ${move.action.to}` : move.action.type;
  return `${where}.${hand.street}:${seat}:${text}:${randCalls}`;
}

/** A few hands at a cash table: the host checks and calls, and two bots at this level play. */
function tableRun(spec: VariantSpec, betting: BettingKind, level: BotLevel): string[] {
  const clock = new FakeClock();
  const errors: unknown[] = [];
  const settings = defaultSettings('cash');
  settings.seating.requireApproval = false;
  settings.game.gameId = spec.id;
  settings.game.betting = betting;
  settings.table.maxSeats = 3;
  settings.timing.decisionSeconds = 0;
  if (spec.family === 'stud') Object.assign(settings.stakes, { smallBlind: 0, bigBlind: 2, ante: 1, anteType: 'per-player', bringIn: 0 });
  const rt = TableRuntime.create({ id: 'g', hostId: 'host', settings }, { clock, rng: seeded(), log: (m, e) => errors.push([m, e]) });
  rt.connect('host');
  rt.requestSeat('host', { seat: 0, name: 'Host', stack: 300 });
  for (let i = 0; i < 2; i++) rt.addBot('host', { ownerName: 'Host', level });
  const out: string[] = [];
  recording.out = out;
  try {
    rt.start('host');
    for (let i = 0; i < 20_000 && rt.state.handNumber <= TABLE_HANDS; i++) {
      const h = rt.state.hand;
      const me = rt.seatOf('host');
      if (me && me.stack === 0 && me.pendingChips === 0) rt.rebuy('host', 300);
      if (h && (h.phase === 'betting' || h.phase === 'drawing') && h.toAct !== null && rt.state.seats[h.toAct]?.playerId === 'host') {
        if (h.phase === 'drawing') rt.draw('host', []);
        else {
          const legal = engine.legalActions(h, h.toAct)!;
          rt.act('host', legal.canCheck ? { type: 'check' } : legal.canBringIn ? { type: 'bring-in' } : { type: 'call' });
        }
        continue;
      }
      clock.advance(500);
    }
  } finally {
    recording.out = null;
    rt.dispose();
  }
  expect(rt.state.handNumber).toBeGreaterThan(TABLE_HANDS);
  expect(errors).toEqual([]);
  // The next hand may have started; its moves aren't part of the run.
  return out.filter((x) => Number(x.split('.')[0]) <= TABLE_HANDS);
}

/** How players have played lately, for Hard: one who folds a lot, one who raises everything, one who calls, and the rest unknown. */
const READS: Record<string, PlayerRead> = {
  p0: { acts: 30, aggressive: 3, faced: 14, folds: 10 },
  p1: { acts: 40, aggressive: 34, faced: 8, folds: 0 },
  p2: { acts: 25, aggressive: 4, faced: 12, folds: 1 },
};

const studStakes = { smallBlind: 0, bigBlind: 2, ante: 1, anteType: 'per-player' as const, bringIn: 1, smallBet: 2, bigBet: 4 };
const blindStakes = { smallBlind: 1, bigBlind: 2, ante: 0, anteType: 'none' as const, bringIn: 1, smallBet: 2, bigBet: 4 };

/**
 * A hand dealt from a seeded deck, played along with checks, calls, one small
 * bet a round and small draws up to one street, where every move is the bots'
 * own until the street ends. Between them, the seeds cover two to four players,
 * every street, a short stack and two boards.
 */
function spotRun(spec: VariantSpec, betting: BettingKind, level: BotLevel, seed: number): string[] {
  const players = 2 + ((seed - 1) % 3);
  const r = seededRand(seed * 7919);
  const deck = 'AKQJT98765432'.split('').flatMap((x) => 'cdhs'.split('').map((s) => x + s));
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  const stud = spec.family === 'stud';
  const button = seed % players;
  const sb = players === 2 ? button : (button + 1) % players;
  const posts: PlannedPost[] = stud
    ? Array.from({ length: players }, (_, seat) => ({ seat, kind: 'ante' as const, amount: 1, live: false }))
    : [
        { seat: sb, kind: 'small-blind', amount: 1, live: true },
        { seat: (sb + 1) % players, kind: 'big-blind', amount: 2, live: true },
      ];
  const hand = engine.startHand({
    handId: `s${seed}`,
    handNumber: seed,
    game: spec,
    betting,
    stakes: stud ? studStakes : blindStakes,
    maxSeats: players,
    // One seed in four, seat 2 is short and goes all in early.
    seats: Array.from({ length: players }, (_, i) => ({ seat: i, playerId: `p${i}`, stack: seed % 4 === 0 && i === 1 ? 9 : 200, away: false })),
    button,
    buttonDead: false,
    posts,
    deck,
    reshuffleSeed: seed,
    options: { boards: spec.family === 'flop' && seed % 5 === 0 ? 2 : 1, bombPot: false, runItTwice: 'off', fixedLimitCap: 4, uncappedHeadsUp: false },
    modifiers: [],
  });
  const target = seed % spec.streets.length;
  const out: string[] = [];
  for (let step = 0; step < 200 && hand.phase !== 'complete' && hand.toAct !== null; step++) {
    const seat = hand.toAct;
    if (hand.street > target || hand.phase === 'rit-vote') break;
    if (hand.street === target) {
      let n = 0;
      const rand = seededRand(seed * 1000 + step);
      const move = chooseMove(hand, seat, () => (n++, rand()), { level, players: READS });
      out.push(line(String(seed), hand, seat, move, n));
      if (move.kind === 'draw') engine.draw(hand, seat, move.discard);
      else engine.act(hand, seat, move.action);
      continue;
    }
    if (hand.phase === 'drawing') {
      engine.draw(hand, seat, [...Array((seed + seat + hand.street) % 3).keys()]);
      continue;
    }
    const legal = engine.legalActions(hand, seat)!;
    let action: Action = legal.canCheck ? { type: 'check' } : { type: 'call' };
    if (legal.canBringIn) action = { type: 'bring-in' };
    else if (legal.canRaise && hand.raisesThisRound === 0 && seat === (seed + hand.street) % players)
      action = legal.raiseKind === 'bet' ? { type: 'bet', to: legal.minTo } : { type: 'raise', to: legal.minTo };
    engine.act(hand, seat, action);
  }
  return out;
}

describe('bot moves stay the same', () => {
  for (const spec of VARIANT_LIST) {
    for (const betting of ['no-limit', 'pot-limit', 'fixed-limit'] as BettingKind[]) {
      if (spec.defaultBetting !== betting && betting !== 'fixed-limit' && spec.family !== 'flop') continue;
      it(`${spec.name} (${betting})`, () => {
        for (const level of BOT_LEVELS) {
          const key = `${spec.id}/${betting}/${level}`;
          made[key] = { table: tableRun(spec, betting, level), spots: Array.from({ length: SEEDS }, (_, i) => spotRun(spec, betting, level, i + 1)).flat() };
          if (UPDATE) continue;
          expect(golden[key], `${key} is missing from ${GOLDEN}: run with BOT_MOVES_UPDATE=1 to make it`).toBeDefined();
          expect(made[key].table, `${key} table`).toEqual(golden[key].table);
          expect(made[key].spots, `${key} spots`).toEqual(golden[key].spots);
        }
      });
    }
  }
});

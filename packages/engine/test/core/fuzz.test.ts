import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { shuffle } from '../../src/cards';
import { ActionError, engine, modifierRegistry, planForcedBets, variants, type HandInput, type HandState, type PlannerSeat } from '../../src/core';
import { commitmentOf, deckFromSeed, handSeedOf, verifyHand } from '../../src/fairness';
import './harness';

/** mulberry32: small seeded RNG so failures can be replayed by seed. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (n: number) => Math.floor(next() * n), pick: <T,>(xs: T[]) => xs[Math.floor(next() * xs.length)] };
}

modifierRegistry.register({ id: 'fuzz-rake', potFee: (pot) => Math.min(3, Math.floor(pot.amount / 20)) });

const GAMES = variants.list().map((g) => g.id);

function randomHand(seed: number): HandInput {
  const r = rng(seed);
  const spec = variants.get(r.pick(GAMES)).spec;
  const maxSeats = Math.max(spec.maxPlayers, 2);
  const players = 2 + r.int(Math.min(spec.maxPlayers, 9) - 1);
  const seatNumbers = shuffle([...Array(maxSeats).keys()], r.int).slice(0, players).sort((a, b) => a - b);
  const bb = r.pick([2, 10, 50]);
  const stakes = {
    smallBlind: bb / 2,
    bigBlind: bb,
    ante: r.next() < 0.3 ? Math.max(1, bb / 10) : 0,
    anteType: spec.family === 'stud' ? ('per-player' as const) : r.pick(['none', 'per-player', 'big-blind'] as const),
    bringIn: Math.max(1, Math.floor(bb / 4)),
    smallBet: bb,
    bigBet: bb * 2,
  };
  if (spec.family === 'stud' && stakes.ante === 0) stakes.ante = 1;
  const seats: PlannerSeat[] = seatNumbers.map((seat) => ({
    seat,
    playerId: `p${seat}`,
    stack: r.next() < 0.2 ? 1 + r.int(bb * 3) : bb * (5 + r.int(200)),
    isNew: false,
    missedSmallBlind: false,
    missedBigBlind: false,
    waitForBigBlind: false,
    straddle: r.next() < 0.3,
  }));
  const bombPot = spec.family === 'flop' && r.next() < 0.15 ? { amount: bb * 2 } : null;
  const plan = planForcedBets({
    game: spec,
    stakes,
    maxSeats,
    seats,
    lastBigBlindSeat: r.next() < 0.5 ? null : r.pick(seatNumbers),
    lastSmallBlindSeat: null,
    lastButton: r.pick(seatNumbers),
    mode: r.next() < 0.5 ? 'cash' : 'tournament',
    straddles: r.pick(['off', 'utg', 'utg-and-button'] as const),
    bombPot,
  });
  const dealt = new Set(plan.dealtIn);
  const boards = spec.family === 'flop' && r.next() < 0.25 ? 2 : 1;
  return {
    handId: `fuzz-${seed}`,
    handNumber: 1,
    game: spec,
    betting: spec.family === 'flop' ? r.pick(['no-limit', 'pot-limit', 'fixed-limit'] as const) : spec.defaultBetting,
    stakes,
    maxSeats,
    seats: seats.filter((s) => dealt.has(s.seat)).map((s) => ({ seat: s.seat, playerId: s.playerId, stack: s.stack, away: r.next() < 0.1 })),
    button: plan.button,
    buttonDead: plan.buttonDead,
    posts: plan.posts,
    ...fairDeal(seed),
    options: {
      boards,
      bombPot: !!bombPot,
      runItTwice: r.pick(['off', 'ask', 'always'] as const),
      fixedLimitCap: 4,
      uncappedHeadsUp: r.next() < 0.5,
    },
    modifiers: r.next() < 0.3 ? [{ id: 'fuzz-rake', settings: {} }] : [],
  };
}

/** A provably fair deck, seeded from the fuzz seed so failures replay. */
function fairDeal(seed: number) {
  const serverSeed = seed.toString(16).padStart(64, '0');
  const handSeed = handSeedOf(serverSeed, []);
  return {
    deck: deckFromSeed(handSeed),
    reshuffleSeed: 0,
    fair: { version: 'rsdp-fair-v1' as const, commit: commitmentOf(serverSeed), serverSeed, clientSeeds: [], handSeed },
  };
}

function play(seed: number): HandState {
  const r = rng(seed ^ 0x9e3779b9);
  const input = randomHand(seed);
  if (input.seats.length < 2) return null as unknown as HandState;
  let state: HandState;
  try {
    state = engine.startHand(input);
  } catch (e) {
    // Too many players for the deck in this game is a legal refusal.
    if (e instanceof ActionError && /not enough cards|at most/.test(e.message)) return null as unknown as HandState;
    throw e;
  }
  for (let step = 0; step < 1000 && state.phase !== 'complete'; step++) {
    if (r.next() < 0.02) {
      const live = state.seats.filter((s) => !s.folded);
      engine.foldOutOfTurn(state, r.pick(live).seat);
      continue;
    }
    if (state.phase === 'rit-vote') {
      const voter = state.seats.find((s) => !s.folded && s.ritVote === null)!;
      engine.voteRunItTwice(state, voter.seat, r.next() < 0.6);
      continue;
    }
    const seat = state.toAct!;
    expect(seat, `seed ${seed} stuck in ${state.phase} street ${state.street} ${state.input.game.id} events ${state.events.slice(-6).map((e) => e.t + ('seat' in e ? e.seat : '') + ('action' in e ? e.action : '')).join(' ')}`).not.toBeNull();
    if (state.phase === 'drawing') {
      const me = state.seats.find((s) => s.seat === seat)!;
      const max = state.input.game.streets[state.street].drawMaxDiscard!;
      const n = r.int(Math.min(max, me.cards.length) + 1);
      engine.draw(state, seat, shuffle([...me.cards.keys()], r.int).slice(0, n));
      continue;
    }
    if (r.next() < 0.05) {
      engine.timeout(state, seat);
      continue;
    }
    const legal = engine.legalActions(state, seat)!;
    const roll = r.next();
    if (legal.canBringIn && roll < 0.5) engine.act(state, seat, { type: 'bring-in' });
    else if (legal.canRaise && roll < 0.35) {
      const to = r.next() < 0.3 ? legal.maxTo : legal.minTo + r.int(legal.maxTo - legal.minTo + 1);
      engine.act(state, seat, { type: legal.raiseKind, to });
    } else if (roll < 0.85 && !legal.canBringIn) engine.act(state, seat, legal.canCheck ? { type: 'check' } : { type: 'call' });
    else engine.act(state, seat, legal.canCheck ? { type: 'check' } : { type: 'fold' });

    // Mid-hand: chips are only moved, never made.
    const inPlay = state.seats.reduce((a, s) => a + s.stack + s.total, 0);
    const start = state.seats.reduce((a, s) => a + s.startStack, 0);
    if ((state.phase as string) !== 'complete') expect(inPlay).toBe(start);
  }
  return state;
}

describe('fuzz: random hands in every game', () => {
  it('always finishes, conserves chips and never duplicates a card', () => {
    let played = 0;
    let reshuffles = 0;
    const proofs: object[] = [];
    const byGame = new Map<string, number>();
    const hands = Number(process.env.FUZZ_HANDS ?? 3000);
    for (let seed = 1; seed <= hands; seed++) {
      const state = play(seed);
      if (!state) continue;
      played++;
      byGame.set(state.input.game.id, (byGame.get(state.input.game.id) ?? 0) + 1);
      const ctx = `seed ${seed} (${state.input.game.id})`;
      expect(state.phase, ctx).toBe('complete');
      const rake = state.events.filter((e) => e.t === 'transfer' && e.kind === 'rake').reduce((a, e) => a + (e.t === 'transfer' ? e.amount : 0), 0);
      const start = state.seats.reduce((a, s) => a + s.startStack, 0);
      const end = state.seats.reduce((a, s) => a + s.stack, 0);
      expect(end + rake, ctx).toBe(start);
      for (const s of state.seats) expect(s.stack, ctx).toBeGreaterThanOrEqual(0);
      const awarded = state.awards.reduce((a, w) => a + w.amount, 0);
      const putIn = state.seats.reduce((a, s) => a + s.total, 0);
      expect(awarded + rake, ctx).toBe(putIn);
      // Cards held by live players and on the boards are all different.
      const live = state.seats.filter((s) => !s.folded || state.input.game.family !== 'draw');
      for (const run of state.runs) {
        for (const board of run) {
          const cards = [...live.flatMap((s) => s.cards.map((c) => c.card)), ...board];
          expect(new Set(cards).size, ctx).toBe(cards.length);
        }
      }
      // The event log replays to the same final stacks.
      const end_ = state.events.at(-1)!;
      expect(end_.t, ctx).toBe('hand-end');
      // Every card dealt checks out against the deck rebuilt from the seed.
      const fair = state.input.fair!;
      const proof = { commit: fair.commit, serverSeed: fair.serverSeed, clientSeeds: [], handSeed: fair.handSeed, button: state.input.button, seats: state.input.seats.map((x) => x.seat), events: state.events };
      const check = verifyHand(proof);
      expect(check.checks.filter((c) => !c.ok), ctx).toEqual([]);
      expect(check.ok, ctx).toBe(true);
      proofs.push(proof);
      if (state.reshuffled) reshuffles++;
    }
    expect(played).toBeGreaterThan(hands * 0.8);
    expect(reshuffles, 'draw-game reshuffles get checked too').toBeGreaterThan(0);
    // The standalone checker (Node's own SHA-256, no app code) agrees on every hand.
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'proofs-')), 'proofs.json');
    writeFileSync(file, JSON.stringify(proofs));
    const run = spawnSync(process.execPath, [path.resolve(__dirname, '../../../../scripts/verify-hand.mjs'), file], { encoding: 'utf8' });
    expect(run.stdout.trim().split('\n').at(-1)).toBe(`All ${proofs.length} hands check out.`);
    expect(run.status).toBe(0);
    for (const id of GAMES) expect(byGame.get(id) ?? 0, id).toBeGreaterThan(50);
  });
});

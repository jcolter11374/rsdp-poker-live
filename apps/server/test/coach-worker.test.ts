import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { engine, variants, type HandState, type PlannedPost } from '@rsdp/engine/core';
import { defaultSettings } from '@rsdp/engine/settings';
import { getVariant, registerAllVariants } from '@rsdp/engine/variants';
import type { CoachTip } from '@rsdp/engine/wire';
import { workTip, type TipJob } from '../src/bots/coach';
import { COACH_BUSY, coachWorker, type TipWorker } from '../src/bots/coachWorker';
import { botTuning, coachTuning, seededRand, seenBy } from '../src/bots/strategy';
import { BOT_THINK_MS, BOT_THINK_SPREAD_MS, hashKey, TableRuntime } from '../src/runtime/table';
import { FakeClock, seeded } from './fake-clock';

beforeAll(() => registerAllVariants(variants));

/**
 * Tips that never stop on the clock, so every answer here is the same on every machine: few deals for a bet, and
 * plenty for a draw, so a draw tip keeps a thread busy for a good while.
 */
const TUNING = {
  equity: { thinkMs: 1e9, minSims: 24, maxSims: 24 },
  vsRandom: { thinkMs: 1e9, minSims: 12, maxSims: 12 },
  draw: { screen: 400, final: 2000 },
  drawBet: { screen: 4, final: 12 },
  vsRandomUnderMs: 1e9,
};
const server = structuredClone(coachTuning);
const bots = { ...botTuning };
beforeAll(() => {
  // The same on this thread, for tips worked out here to compare with.
  Object.assign(coachTuning, TUNING);
  Object.assign(botTuning, { thinkMs: 0, minSims: 4, drawSims: 2, drawFinalSims: 3, drawBetSims: 2, drawBetFinalSims: 2 });
});
afterAll(() => {
  Object.assign(coachTuning, server);
  Object.assign(botTuning, bots);
});

const FULL = 'AKQJT98765432'.split('').flatMap((r) => 'cdhs'.split('').map((s) => r + s));

/** A hand dealt from a deck shuffled by `seed`, with the blinds in. */
function dealt(gameId: string, players: number, seed: number): HandState {
  const spec = getVariant(gameId);
  const rand = seededRand(seed);
  const deck = [...FULL];
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  const headsUp = players === 2;
  const posts: PlannedPost[] = [
    { seat: headsUp ? 0 : 1, kind: 'small-blind', amount: 1, live: true },
    { seat: headsUp ? 1 : 2, kind: 'big-blind', amount: 2, live: true },
  ];
  return engine.startHand({
    handId: `h${seed}`,
    handNumber: 1,
    game: spec,
    betting: spec.defaultBetting,
    stakes: { smallBlind: 1, bigBlind: 2, ante: 0, anteType: 'none', bringIn: 1, smallBet: 2, bigBet: 4 },
    maxSeats: players,
    seats: Array.from({ length: players }, (_, i) => ({ seat: i, playerId: `p${i}`, stack: 200, away: false })),
    button: headsUp ? 1 : 0,
    buttonDead: false,
    posts,
    deck,
    reshuffleSeed: 1,
    options: { boards: 1, bombPot: false, runItTwice: 'off', fixedLimitCap: 4, uncappedHeadsUp: false },
    modifiers: [],
  });
}

/** Calls round to the first draw. */
function toDraw(hand: HandState): HandState {
  for (let i = 0; i < 20 && hand.phase === 'betting'; i++) {
    const legal = engine.legalActions(hand, hand.toAct!)!;
    engine.act(hand, hand.toAct!, legal.canCheck ? { type: 'check' } : { type: 'call' });
  }
  expect(hand.phase).toBe('drawing');
  return hand;
}

/** The job for the seat to act now, as TableRuntime.coachTip makes it. */
function jobFor(hand: HandState, seed = 1, handNumber = hand.input.handNumber): TipJob {
  const seat = hand.toAct!;
  const drawing = hand.phase === 'drawing';
  return {
    seen: seenBy(hand, seat),
    seat,
    legal: drawing ? null : engine.legalActions(hand, seat),
    drawMax: drawing ? (hand.input.game.streets[hand.street].drawMaxDiscard ?? 0) : 0,
    seed,
    handNumber,
    at: hand.events.length,
  };
}

/** A quick tip: Hold'em, before the flop. */
const quick = (handNumber?: number) => jobFor(dealt('nlhe', 2, 3), 1, handNumber);
/** A slow one: the first draw of six-handed 2-7 Triple Draw, every way to draw weighed on thousands of deals. */
const slow = (seed = 1) => jobFor(toDraw(dealt('td27', 6, 4)), seed);

const fixture = (name: string) => new URL(`./fixtures/${name}`, import.meta.url);

/** Waits for the thread to be up: a tip asked for while it is still loading may be told the coach is busy. */
async function warm(pool: TipWorker) {
  for (let i = 0; i < 200; i++) {
    if (await pool.work(quick()).then(() => true, () => false)) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("the coach's thread never started");
}

/** Runs `during` with a timer ticking every 5 ms, and says the longest it ever went without ticking. */
async function longestStall(during: () => Promise<unknown>): Promise<number> {
  let last = performance.now();
  let longest = 0;
  const tick = setInterval(() => {
    const t = performance.now();
    longest = Math.max(longest, t - last);
    last = t;
  }, 5);
  try {
    await during();
  } finally {
    clearInterval(tick);
  }
  return Math.max(longest, performance.now() - last);
}

describe("the coach's own thread", () => {
  it('works out the same tip as the table would itself, every time it is asked', async () => {
    // TUNING deals far more draws than the site does: on a busy machine one tip could pass the coach's own time limits,
    // which this doesn't test.
    const pool = coachWorker({ tuning: TUNING, runMs: 60_000, waitMs: 60_000 });
    try {
      const td = dealt('td27', 3, 2);
      const jobs = [quick(), jobFor(td, 7), jobFor(toDraw(dealt('badugi', 2, 5)), 9), jobFor(dealt('plo8', 4, 6), 11)];
      // A bet in Hold'em, a bet with draws to come, a draw, and a bet for half a split pot against three.
      expect(jobs.map((j) => [j.seen.input.game.id, j.legal ? 'bet' : 'draw'])).toEqual([
        ['nlhe', 'bet'],
        ['td27', 'bet'],
        ['badugi', 'draw'],
        ['plo8', 'bet'],
      ]);
      for (const job of jobs) {
        const here = workTip(job);
        expect(await pool.work(job)).toEqual(here);
        expect(await pool.work(job)).toEqual(here);
      }
    } finally {
      await pool.close();
    }
  });

  it('keeps every table on time while a burst of tips is worked out', async () => {
    // Worked out here, one slow tip holds this thread, and every table on it, for its whole length.
    const alone = await longestStall(async () => workTip(slow()));
    expect(alone).toBeGreaterThan(150);
    // Enough of them to keep the coach busy past the moment a bot at another table is due to act.
    const count = Math.min(16, Math.ceil(2_500 / alone) + 1);
    const pool = coachWorker({ tuning: TUNING, queue: 16, waitMs: 60_000, runMs: 60_000 });
    // Another table: a person and a bot, on the real clock. The bot acts a moment after its turn starts.
    const settings = defaultSettings('cash');
    settings.seating.requireApproval = false;
    settings.timing.decisionSeconds = 0;
    const other = TableRuntime.create({ id: 'other', hostId: 'host', settings }, { rng: seeded(), log: () => {} });
    try {
      await warm(pool);
      other.connect('host');
      other.requestSeat('host', { seat: 0, name: 'Host', stack: 200, consent: true });
      other.addBot('host', { ownerName: 'Host' });
      // The person checks or calls at once; the test waits for a bot's turn to start.
      const botTurn = () => {
        const s = other.state;
        const hand = s.hand;
        if (!hand || hand.phase !== 'betting' || hand.toAct === null || !s.turn) return null;
        const id = s.seats[hand.toAct]?.playerId ?? '';
        if (!other.isBot(id)) {
          const legal = engine.legalActions(hand, hand.toAct)!;
          other.act(id, legal.canCheck ? { type: 'check' } : { type: 'call' });
          return null;
        }
        return s.turn;
      };
      other.start('host');
      let turn = botTurn();
      for (let i = 0; i < 400 && !turn; i++) {
        await new Promise((r) => setTimeout(r, 10));
        turn = botTurn();
      }
      expect(turn).toBeTruthy();
      const due = turn!.startedAt + BOT_THINK_MS + (hashKey(turn!.key) % BOT_THINK_SPREAD_MS);
      let acted = 0;
      other.onChange = () => {
        if (!acted && other.state.turn?.key !== turn!.key) acted = Date.now();
      };

      let pending = count;
      let pendingWhenActed = -1;
      const tips: CoachTip[] = [];
      const stall = await longestStall(async () => {
        const burst = Array.from({ length: count }, (_, i) =>
          pool.work(slow(i + 1)).then((tip) => {
            tips.push(tip);
            pending--;
          }),
        );
        while (!acted) await new Promise((r) => setTimeout(r, 5));
        pendingWhenActed = pending;
        await Promise.all(burst);
      });
      expect(tips).toHaveLength(count);
      expect(tips.every((t) => t.kind === 'draw')).toBe(true);
      // The coach was still busy when the bot's moment came...
      expect(pendingWhenActed).toBeGreaterThan(0);
      // ...and the bot acted on time all the same, with this thread never held up for long.
      expect(acted - due).toBeLessThan(100);
      expect(stall).toBeLessThan(100);
    } finally {
      other.dispose();
      await pool.close();
    }
  });

  it('tells the tips past a full line that the coach is busy, and answers the rest', async () => {
    const logged: string[] = [];
    const pool = coachWorker({ tuning: TUNING, queue: 2, waitMs: 60_000, runMs: 60_000, busyLogMs: 300, log: (m) => logged.push(m) });
    const counts = () => logged.filter((m) => m.startsWith('the coach turned away'));
    try {
      await warm(pool);
      // One being worked out, two waiting, and the two after them turned away at once.
      const asked = Array.from({ length: 5 }, (_, i) => pool.work(slow(i + 1)));
      const turnedAway = await Promise.allSettled([asked[3], asked[4]]);
      expect(turnedAway.map((r) => r.status === 'rejected' && (r.reason as Error).message)).toEqual([COACH_BUSY, COACH_BUSY]);
      // Counted rather than logged one by one, so a busy evening is one line an hour (here, 300 ms).
      expect(counts()).toEqual([]);
      await vi.waitFor(() => expect(counts()).toEqual(['the coach turned away 2 tips in the last hour (its line was full, or they waited too long)']));
      const answered = await Promise.allSettled(asked.slice(0, 3));
      expect(answered.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
      // Once the line has cleared, a tip is answered again.
      expect((await pool.work(quick())).kind).toBe('bet');
    } finally {
      await pool.close();
    }
  });

  it('tells a tip that has waited too long that the coach is busy', async () => {
    const logged: string[] = [];
    const pool = coachWorker({ tuning: TUNING, waitMs: 50, runMs: 60_000, log: (m) => logged.push(m) });
    const counts = () => logged.filter((m) => m.startsWith('the coach turned away'));
    try {
      await warm(pool);
      const first = pool.work(slow());
      const second = pool.work(quick());
      await expect(second).rejects.toThrow(COACH_BUSY);
      expect((await first).kind).toBe('draw');
      expect(counts()).toEqual([]);
    } finally {
      await pool.close();
    }
    // The count so far is logged when the coach stops (warming up may have turned some away too, while the thread loaded).
    expect(counts()).toHaveLength(1);
    expect(counts()[0]).toMatch(/^the coach turned away \d+ tips? in the last hour \(its line was full, or they waited too long\)$/);
  });

  it('stops a tip that runs too long, and starts a fresh thread for the next one', async () => {
    const logged: string[] = [];
    const pool = coachWorker({ tuning: { ...TUNING, draw: { screen: 4_000, final: 20_000 } }, runMs: 200, log: (m) => logged.push(m) });
    try {
      await warm(pool);
      const started = performance.now();
      await expect(pool.work(slow())).rejects.toThrow(COACH_BUSY);
      // Told when the limit came, not when the tip would have been done.
      expect(performance.now() - started).toBeLessThan(2_000);
      expect(logged).toEqual(["a coach tip ran past 200 ms; a fresh thread is starting"]);
      expect((await pool.work(quick())).kind).toBe('bet');
    } finally {
      await pool.close();
    }
  });

  it('tells the player the coach is busy when its thread falls over, and starts a fresh one', async () => {
    const logged: string[] = [];
    const pool = coachWorker({ tuning: TUNING, entry: fixture('crashing-coach-thread.mjs'), log: (m) => logged.push(m) });
    try {
      const tip = await pool.work(quick());
      // It exits in the middle of a tip...
      await expect(pool.work(quick(666))).rejects.toThrow(COACH_BUSY);
      expect(logged).toEqual(["the coach's thread stopped (exit code 3); a fresh thread is starting"]);
      expect(await pool.work(quick())).toEqual(tip);
      // ...or throws.
      await expect(pool.work(quick(667))).rejects.toThrow(COACH_BUSY);
      expect(logged[1]).toBe("the coach's thread failed; a fresh thread is starting");
      expect(await pool.work(quick())).toEqual(tip);
      expect(logged).toHaveLength(2);
    } finally {
      await pool.close();
    }
  });

  it('turns tips away, without starting thread after thread, when a thread cannot start', async () => {
    const logged: string[] = [];
    const broken = coachWorker({ entry: fixture('broken-coach-thread.mjs'), log: (m) => logged.push(m) });
    try {
      // Everyone waiting for it is told, and only the next tip asked for tries again.
      const asked = await Promise.allSettled([broken.work(quick()), broken.work(quick())]);
      expect(asked.map((r) => r.status === 'rejected' && (r.reason as Error).message)).toEqual([COACH_BUSY, COACH_BUSY]);
      await expect(broken.work(quick())).rejects.toThrow(COACH_BUSY);
      await new Promise((r) => setTimeout(r, 200));
      expect(logged).toEqual(["the coach's thread failed; the next tip starts a fresh thread", "the coach's thread failed; the next tip starts a fresh thread"]);
    } finally {
      await broken.close();
    }

    const silent = coachWorker({ entry: fixture('silent-coach-thread.mjs'), startMs: 300, log: (m) => logged.push(m) });
    try {
      await expect(silent.work(quick())).rejects.toThrow(COACH_BUSY);
      expect(logged.at(-1)).toBe("the coach's thread did not start within 300 ms; the next tip starts a fresh thread");
    } finally {
      await silent.close();
    }
  });

  it('tells the tips still waiting that the coach is busy when the server stops', async () => {
    const pool = coachWorker({ tuning: TUNING, runMs: 60_000 });
    await warm(pool);
    const asked = Promise.allSettled([pool.work(slow()), pool.work(quick())]);
    await pool.close();
    // The one being worked out and the one waiting.
    expect((await asked).map((r) => r.status === 'rejected' && (r.reason as Error).message)).toEqual([COACH_BUSY, COACH_BUSY]);
    await expect(pool.work(quick())).rejects.toThrow(COACH_BUSY);
  });
});

describe('what a table sends the coach', () => {
  it('is the hand as the one player sees it, and its own random numbers from the turn', async () => {
    const pool = coachWorker({ tuning: TUNING, runMs: 60_000, waitMs: 60_000 });
    const sent: TipJob[] = [];
    const watched: TipWorker = { work: (job) => (sent.push(structuredClone(job)), pool.work(job)) };
    const clock = new FakeClock();
    const settings = defaultSettings('cash');
    settings.seating.requireApproval = false;
    settings.timing.decisionSeconds = 0;
    settings.game.gameId = 'td27';
    const rt = TableRuntime.create({ id: 't1', hostId: 'host', settings }, { clock, rng: seeded(), log: () => {}, tips: watched });
    try {
      rt.connect('host');
      rt.requestSeat('host', { seat: 0, name: 'Host', stack: 200, consent: true });
      for (let i = 0; i < 3; i++) rt.addBot('host', { ownerName: 'Host' });
      rt.start('host');
      for (let i = 0; i < 400; i++) {
        const hand = rt.state.hand;
        if (hand && hand.phase === 'betting' && rt.state.turn && hand.toAct !== null && rt.state.seats[hand.toAct]?.playerId === 'host') break;
        clock.advance(100);
      }
      const hand = rt.state.hand!;
      const turn = rt.state.turn!;
      const seat = hand.toAct!;
      expect(rt.state.seats[seat]?.playerId).toBe('host');
      const tip = await rt.coachTip('host', hand.input.handNumber, hand.events.length);
      // Asked again (another tab) while it is cached: nothing more is sent.
      expect(await rt.coachTip('host', hand.input.handNumber, hand.events.length)).toBe(tip);
      expect(sent).toHaveLength(1);
      const [job] = sent;

      // No deck, no muck, no seeds, and nobody else's face-down cards, anywhere in what crossed.
      const text = JSON.stringify(job);
      const hidden = hand.seats.filter((x) => x.seat !== seat).flatMap((x) => x.cards.filter((c) => !c.up).map((c) => c.card));
      expect(hidden.length).toBeGreaterThan(0);
      for (const card of hidden) expect(text).not.toContain(`"${card}"`);
      expect(job.seen.input.deck).toEqual([]);
      expect(job.seen.muck).toEqual([]);
      expect(text).not.toContain(hand.input.fair?.serverSeed ?? 'no seed');
      expect(job.seen.seats.find((x) => x.seat === seat)!.cards.map((c) => c.card)).toEqual(hand.seats.find((x) => x.seat === seat)!.cards.map((c) => c.card));

      // Its random numbers start from the turn and the player, never the table's, and the thread's answer is the
      // one this thread would give.
      expect(job.seed).toBe(hashKey(`${turn.key}|host`));
      expect(tip).toEqual(workTip(job));
    } finally {
      rt.dispose();
      await pool.close();
    }
  });

  it("is told the coach is busy, and asks afresh next time, when the coach can't answer", async () => {
    let busy = true;
    const coach: TipWorker = { work: async (job) => (busy ? Promise.reject(new Error(COACH_BUSY)) : workTip(job)) };
    const clock = new FakeClock();
    const settings = defaultSettings('cash');
    settings.seating.requireApproval = false;
    settings.timing.decisionSeconds = 0;
    const rt = TableRuntime.create({ id: 't2', hostId: 'host', settings }, { clock, rng: seeded(), log: () => {}, tips: coach });
    try {
      rt.connect('host');
      rt.requestSeat('host', { seat: 0, name: 'Host', stack: 200, consent: true });
      rt.addBot('host', { ownerName: 'Host' });
      rt.start('host');
      for (let i = 0; i < 400; i++) {
        const hand = rt.state.hand;
        if (hand && hand.phase === 'betting' && rt.state.turn && hand.toAct !== null && rt.state.seats[hand.toAct]?.playerId === 'host') break;
        clock.advance(100);
      }
      const hand = rt.state.hand!;
      await expect(rt.coachTip('host', hand.input.handNumber, hand.events.length)).rejects.toThrow(COACH_BUSY);
      busy = false;
      expect((await rt.coachTip('host', hand.input.handNumber, hand.events.length)).kind).toBe('bet');
    } finally {
      rt.dispose();
    }
  });
});

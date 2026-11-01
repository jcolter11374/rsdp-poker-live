import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { freshDeck } from '../src/cards';
import { engine, HOLDEM, type HandInput, type HandState } from '../src/core';
import { commitmentOf, deckFromSeed, handSeedOf, seededRng, sha256, toHex, verifyHand, type CardEvent } from '../src/fairness';
import { STAKES } from './core/harness';

describe('sha256', () => {
  it('matches node:crypto on every length from 0 to 300 bytes', () => {
    for (let n = 0; n <= 300; n++) {
      const data = randomBytes(n);
      expect(toHex(sha256(new Uint8Array(data)))).toBe(createHash('sha256').update(data).digest('hex'));
    }
  });
});

describe('seeded deck', () => {
  it('is a permutation of the 52 cards, and the same seed always gives the same deck', () => {
    for (let i = 0; i < 200; i++) {
      const seed = randomBytes(32).toString('hex');
      const deck = deckFromSeed(seed);
      expect([...deck].sort()).toEqual([...freshDeck()].sort());
      expect(deckFromSeed(seed)).toEqual(deck);
    }
  });

  // Hands already played must stay checkable: changing this deck is changing the scheme (bump FAIR_VERSION).
  it('is pinned for a known seed', () => {
    const seed = handSeedOf('00'.repeat(32), ['abcdefabcdefabcd']);
    expect(seed).toBe(createHash('sha256').update(`rsdp-fair-v1|${'00'.repeat(32)}|abcdefabcdefabcd`).digest('hex'));
    expect(deckFromSeed(seed).slice(0, 10)).toMatchInlineSnapshot(`
      [
        "Qd",
        "6h",
        "Qc",
        "Jh",
        "6d",
        "6s",
        "2h",
        "Js",
        "Jd",
        "7h",
      ]
    `);
  });

  it('client seed order does not matter, but every seed changes the deck', () => {
    const s = 'ab'.repeat(32);
    expect(handSeedOf(s, ['1111111111111111', '2222222222222222'])).toBe(handSeedOf(s, ['2222222222222222', '1111111111111111']));
    expect(handSeedOf(s, ['1111111111111111'])).not.toBe(handSeedOf(s, ['1111111111111112']));
    expect(handSeedOf(s, [])).not.toBe(handSeedOf('ac'.repeat(32), []));
  });

  it('draws are in range and every value turns up', () => {
    const rng = seededRng('cd'.repeat(32), 'test');
    const seen = new Set<number>();
    for (let i = 0; i < 5000; i++) {
      const x = rng(52);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(52);
      seen.add(x);
    }
    expect(seen.size).toBe(52);
    expect(() => rng(0)).toThrow();
  });

  it('commitment is the SHA-256 of the seed text, checkable with sha256sum', () => {
    const seed = randomBytes(32).toString('hex');
    expect(commitmentOf(seed)).toBe(createHash('sha256').update(seed).digest('hex'));
  });
});

function fairHand(serverSeed: string, clientSeeds: string[] = []): HandInput {
  const handSeed = handSeedOf(serverSeed, clientSeeds);
  return {
    handId: 'h1',
    handNumber: 1,
    game: HOLDEM,
    betting: 'no-limit',
    stakes: STAKES,
    maxSeats: 9,
    seats: [0, 1, 2].map((seat) => ({ seat, playerId: `p${seat}`, stack: 200, away: false })),
    button: 0,
    buttonDead: false,
    posts: [
      { seat: 1, kind: 'small-blind', amount: 1, live: true },
      { seat: 2, kind: 'big-blind', amount: 2, live: true },
    ],
    deck: deckFromSeed(handSeed),
    reshuffleSeed: 0,
    fair: { version: 'rsdp-fair-v1', commit: commitmentOf(serverSeed), serverSeed, clientSeeds: clientSeeds.map((seed, i) => ({ playerId: `p${i}`, seed })), handSeed },
    options: { boards: 1, bombPot: false, runItTwice: 'off', showdown: 'show-all', fixedLimitCap: 4, uncappedHeadsUp: false },
    modifiers: [],
  };
}

/** Everyone checks to the river. */
function playOut(input: HandInput): HandState {
  const state = engine.startHand(input);
  while (state.phase !== 'complete') {
    const seat = state.toAct!;
    const legal = engine.legalActions(state, seat)!;
    engine.act(state, seat, legal.canCheck ? { type: 'check' } : { type: 'call' });
  }
  return state;
}

describe('verifyHand', () => {
  const serverSeed = 'ef'.repeat(32);
  const clientSeeds = ['0123456789abcdef'];
  const args = (events: CardEvent[]) => ({ commit: commitmentOf(serverSeed), serverSeed, clientSeeds, handSeed: handSeedOf(serverSeed, clientSeeds), button: 0, events });
  const full = () => engine.visibleEvents(playOut(fairHand(serverSeed, clientSeeds)), { seat: null, seeAll: true }) as CardEvent[];
  const failing = (events: CardEvent[]) => verifyHand(args(events)).checks.filter((c) => !c.ok).map((c) => c.label);

  it('passes a real hand', () => {
    const check = verifyHand(args(full()));
    expect(check.checks.filter((c) => !c.ok)).toEqual([]);
    expect(check.ok).toBe(true);
    // 6 hole cards and 5 board cards dealt, then shown and awarded.
    expect(check.matched).toBeGreaterThanOrEqual(11 + 6);
  });

  it('as one player sees it, other hands that were never shown count as unchecked', () => {
    const state = playOut({ ...fairHand(serverSeed, clientSeeds), options: { ...fairHand(serverSeed).options, showdown: 'muck-losers' } });
    const check = verifyHand(args(engine.visibleEvents(state, { seat: 1, seeAll: false }) as CardEvent[]));
    expect(check.checks.filter((c) => !c.ok)).toEqual([]);
    expect(check.unchecked).toBeGreaterThan(0);
    expect(check.ok).toBe(false);
  });

  it('fails a swapped card, cards handed out of turn, a shown card never dealt, a wrong seed and a wrong commitment', () => {
    const events = full();
    const flop = events.find((e) => e.t === 'board')!;
    // A different card where the flop is.
    expect(failing(events.map((e) => (e === flop ? { ...e, cards: [...flop.cards!.slice(1), flop.cards![0]] } : e)))).toContain('Every card is the one at its place in the deck');
    // The flop given to seat 1 as hole cards and the hole cards put on the board: every place still used once.
    const deals = events.filter((e) => e.t === 'deal');
    const swappedSeats = events.map((e) => (e === deals[0] ? { ...e, seat: deals[1].seat } : e === deals[1] ? { ...e, seat: deals[0].seat } : e));
    expect(failing(swappedSeats)).toContain('Cards were dealt in turn from the top, none skipped');
    // A showdown with a card the seat never had.
    const show = events.find((e) => e.t === 'show')!;
    const other = flop.cards![0] as string;
    expect(failing(events.map((e) => (e === show ? { ...e, cards: [other, ...show.cards!.slice(1)] } : e)))).toContain('Every card is the one at its place in the deck');
    // A deal that leaves out a seat that was dealt in.
    expect(verifyHand({ ...args(events), seats: [0, 1, 2, 3] }).ok).toBe(false);
    expect(verifyHand({ ...args(events), seats: [0, 1, 2] }).ok).toBe(true);
    expect(verifyHand({ ...args(events), clientSeeds: [] }).ok).toBe(false);
    expect(verifyHand({ ...args(events), commit: commitmentOf('aa'.repeat(32)) }).ok).toBe(false);
  });

  it('fails a hand dealt honestly from a deck with a seed listed twice, or more seeds than seats dealt in', () => {
    // Every card matches, but each extra seed gives another deck to pick from, so nobody's seed vouches for this one.
    const twice = ['0123456789abcdef', '0123456789abcdef'];
    const events = engine.visibleEvents(playOut(fairHand(serverSeed, twice)), { seat: null, seeAll: true }) as CardEvent[];
    const dup = verifyHand({ commit: commitmentOf(serverSeed), serverSeed, clientSeeds: twice, handSeed: handSeedOf(serverSeed, twice), button: 0, events });
    expect(dup.ok).toBe(false);
    expect(dup.checks.filter((c) => !c.ok).map((c) => c.detail)).toEqual([expect.stringMatching(/0123456789abcdef.*listed 2 times/)]);
    const four = ['01'.repeat(8), '02'.repeat(8), '03'.repeat(8), '04'.repeat(8)];
    const more = engine.visibleEvents(playOut(fairHand(serverSeed, four)), { seat: null, seeAll: true }) as CardEvent[];
    const proof = { commit: commitmentOf(serverSeed), serverSeed, clientSeeds: four, handSeed: handSeedOf(serverSeed, four), button: 0, events: more };
    expect(verifyHand({ ...proof, seats: [0, 1, 2] }).checks.filter((c) => !c.ok).map((c) => c.detail)).toEqual([expect.stringMatching(/4 seeds.*3 seats/)]);
    // Without the seats dealt in, only copies can be told apart.
    expect(verifyHand(proof).ok).toBe(true);

    // The standalone checker (Node's own SHA-256, no app code) agrees.
    const dir = mkdtempSync(path.join(tmpdir(), 'proof-'));
    const run = (p: object) => {
      const file = path.join(dir, `${Math.random()}.json`);
      writeFileSync(file, JSON.stringify(p));
      return spawnSync(process.execPath, [path.resolve(__dirname, '../../../scripts/verify-hand.mjs'), file], { encoding: 'utf8' });
    };
    try {
      const copied = run({ commit: commitmentOf(serverSeed), serverSeed, clientSeeds: twice, handSeed: handSeedOf(serverSeed, twice), button: 0, seats: [0, 1, 2], events });
      expect(copied.stdout).toMatch(/FAIL .*0123456789abcdef.*listed 2 times/);
      expect(copied.status).toBe(1);
      const extraSeed = run({ ...proof, seats: [0, 1, 2] });
      expect(extraSeed.stdout).toMatch(/FAIL .*4 seeds.*3 seats/);
      expect(extraSeed.status).toBe(1);
      expect(run(proof).status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the standalone checker fails a seed listed for a practice bot, for someone not dealt in, or twice for one player', () => {
    // Every card matches in each of these: only whose the seeds are gives the extra one away.
    const dir = mkdtempSync(path.join(tmpdir(), 'proof-'));
    const run = (seeds: string[], more: object) => {
      const events = engine.visibleEvents(playOut(fairHand(serverSeed, seeds)), { seat: null, seeAll: true }) as CardEvent[];
      const file = path.join(dir, `${Math.random()}.json`);
      writeFileSync(file, JSON.stringify({ commit: commitmentOf(serverSeed), serverSeed, clientSeeds: seeds, handSeed: handSeedOf(serverSeed, seeds), button: 0, seats: [0, 1, 2], events, ...more }));
      return spawnSync(process.execPath, [path.resolve(__dirname, '../../../scripts/verify-hand.mjs'), file], { encoding: 'utf8' });
    };
    const players = [
      { seat: 0, playerId: 'p0' },
      { seat: 1, playerId: 'p1' },
      { seat: 2, playerId: 'bot-2', bot: true },
    ];
    const two = ['01'.repeat(8), '02'.repeat(8)];
    try {
      const honest = run(two, { players, seedOwners: ['p0', 'p1'] });
      expect(honest.stdout).toMatch(/This hand checks out/);
      expect(honest.stdout).not.toMatch(/doesn't say whose/);
      expect(honest.status).toBe(0);
      const bot = run(two, { players, seedOwners: ['p0', 'bot-2'] });
      expect(bot.stdout).toMatch(/FAIL .*0202020202020202.*practice bot in seat 3/);
      expect(bot.status).toBe(1);
      const ghost = run(two, { players, seedOwners: ['p0', 'ghost'] });
      expect(ghost.stdout).toMatch(/FAIL .*0202020202020202.*ghost, who wasn't dealt in/);
      expect(ghost.status).toBe(1);
      const doubled = run(two, { players, seedOwners: ['p1', 'p1'] });
      expect(doubled.stdout).toMatch(/FAIL +more than one seed is listed for p1/);
      expect(doubled.status).toBe(1);
      expect(run(two, { players, seedOwners: ['p0'] }).stdout).toMatch(/FAIL +2 seeds are listed but 1 owners/);
      expect(run(two, { players: players.slice(0, 2), seedOwners: ['p0', 'p1'] }).stdout).toMatch(/FAIL +the players listed are not in the seats dealt in/);
      // A file saved before it said whose each seed is still checks, and says what it can't check.
      const old = run(two, {});
      expect(old.stdout).toMatch(/doesn't say whose each seed is/);
      expect(old.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

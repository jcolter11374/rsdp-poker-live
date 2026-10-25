import { createHash, randomBytes } from 'node:crypto';
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
    const seed = handSeedOf('00'.repeat(32), 'table-1', ['abcdefabcdefabcd']);
    expect(seed).toBe(createHash('sha256').update(`rsdp-fair-v1|${'00'.repeat(32)}|table-1|abcdefabcdefabcd`).digest('hex'));
    expect(deckFromSeed(seed).slice(0, 10)).toMatchInlineSnapshot(`
      [
        "9h",
        "3d",
        "Ad",
        "Jc",
        "Jd",
        "3s",
        "Kh",
        "As",
        "5s",
        "2h",
      ]
    `);
  });

  it('client seed order does not matter, but every seed changes the deck', () => {
    const s = 'ab'.repeat(32);
    expect(handSeedOf(s, 'h', ['1111111111111111', '2222222222222222'])).toBe(handSeedOf(s, 'h', ['2222222222222222', '1111111111111111']));
    expect(handSeedOf(s, 'h', ['1111111111111111'])).not.toBe(handSeedOf(s, 'h', ['1111111111111112']));
    expect(handSeedOf(s, 'h', [])).not.toBe(handSeedOf(s, 'h2', []));
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
  const handSeed = handSeedOf(serverSeed, 'h1', clientSeeds);
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
  const args = (events: CardEvent[]) => ({ handId: 'h1', commit: commitmentOf(serverSeed), serverSeed, clientSeeds, handSeed: handSeedOf(serverSeed, 'h1', clientSeeds), events });

  it('passes a real hand, as a player who saw only their own cards', () => {
    const state = playOut(fairHand(serverSeed, clientSeeds));
    const seen = engine.visibleEvents(state, { seat: 1, seeAll: false });
    const check = verifyHand(args(seen));
    expect(check.checks.filter((c) => !c.ok)).toEqual([]);
    expect(check.ok).toBe(true);
    // Showdown shows everyone's cards here: 6 hole cards and 5 on the board.
    expect(check.matched).toBe(11);
  });

  it('fails a swapped card, a skipped card, a wrong seed and a wrong commitment', () => {
    const state = playOut(fairHand(serverSeed, clientSeeds));
    const events = engine.visibleEvents(state, { seat: null, seeAll: true });
    const board = events.find((e) => e.t === 'board' && e.cards.length === 1)! as Extract<CardEvent, { t: string }>;
    const swapped = events.map((e) => (e === board ? { ...board, cards: [board.cards![0] === 'As' ? 'Ks' : 'As'] } : e));
    expect(verifyHand(args(swapped)).ok).toBe(false);
    const skipped = events.map((e) => (e === board ? { ...board, pos: [board.pos![0] + 1] } : e));
    expect(verifyHand(args(skipped)).ok).toBe(false);
    expect(verifyHand({ ...args(events), clientSeeds: [] }).ok).toBe(false);
    expect(verifyHand({ ...args(events), commit: commitmentOf('aa'.repeat(32)) }).ok).toBe(false);
  });
});

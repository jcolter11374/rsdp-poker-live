import { freshDeck, type Card } from '@rsdp/engine';
import { engine, planForcedBets, settle, variants, type HandInput, type HandState, type Pot } from '@rsdp/engine/core';
import { bounty72Schema, rakeFor, rakeSchema } from '@rsdp/engine/modifiers';
import { defaultSettings } from '@rsdp/engine/settings';
import { registerAllVariants } from '@rsdp/engine/variants';
import { describe, expect, it } from 'vitest';
import { BOMB_EX, BOUNTY_EX, DOUBLE_EX, EXTRAS, RAKE_EX, RIT_EX, STRADDLE_EX, extraFor, extrasOn } from './extras';
import { GUIDES, cardsOf, guideFor } from './guides';

registerAllVariants(variants);

const CARD = /^[2-9TJQKA][cdhs]$/;
const STAKES = { smallBlind: 1, bigBlind: 2, ante: 0, anteType: 'none' as const, bringIn: 0, smallBet: 2, bigBet: 4 };

/** A 1/2 Hold'em hand with the button on seat 0, dealt from `top` and then a fixed order. */
function deal(opts: { stacks: number[]; straddlers?: number[]; straddles?: 'utg' | 'utg-and-button'; bombPot?: number; top?: Card[]; modifiers?: HandInput['modifiers'] }): HandState {
  const spec = variants.get('nlhe').spec;
  const seats = opts.stacks.map((stack, seat) => ({
    seat,
    playerId: `p${seat}`,
    stack,
    isNew: false,
    missedSmallBlind: false,
    missedBigBlind: false,
    waitForBigBlind: false,
    straddle: !!opts.straddlers?.includes(seat),
  }));
  const plan = planForcedBets({
    game: spec,
    stakes: STAKES,
    maxSeats: 10,
    seats,
    lastBigBlindSeat: null,
    lastButton: 0,
    mode: 'cash',
    straddles: opts.straddles ?? 'off',
    bombPot: opts.bombPot ? { amount: opts.bombPot } : null,
  });
  const top = opts.top ?? [];
  return engine.startHand({
    handId: 'h1',
    handNumber: 1,
    game: spec,
    betting: 'no-limit',
    stakes: STAKES,
    maxSeats: 10,
    seats: seats.map((s) => ({ seat: s.seat, playerId: s.playerId, stack: s.stack, away: false })),
    button: plan.button,
    buttonDead: plan.buttonDead,
    posts: plan.posts,
    deck: [...top, ...freshDeck().filter((c) => !top.includes(c))],
    reshuffleSeed: 1,
    options: { boards: 1, bombPot: !!opts.bombPot, runItTwice: 'off', fixedLimitCap: 4, uncappedHeadsUp: true },
    modifiers: opts.modifiers ?? [],
  });
}

const posts = (s: HandState) => s.events.flatMap((e) => (e.t === 'post' ? [[e.seat, e.kind, e.amount] as const] : []));

describe('side game guides', () => {
  it('have unique ids that never clash with a game guide', () => {
    const ids = EXTRAS.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(guideFor(id), id).toBeNull();
      expect(extraFor(id)?.id).toBe(id);
      expect(id).toMatch(/^[\w-]+$/); // the /rules/:id route
    }
    for (const g of GUIDES) expect(extraFor(g.id)).toBeNull();
  });

  it('are filled in, with real distinct cards in every example', () => {
    for (const g of EXTRAS) {
      expect(g.steps.length, g.id).toBeGreaterThan(0);
      expect(g.examples.length, g.id).toBeGreaterThan(0);
      expect(g.settings.length, g.id).toBeGreaterThan(0);
      for (const ex of g.examples) {
        const all = (ex.cards ?? []).flatMap((c) => cardsOf(c.cards));
        for (const c of all) expect(c, `${g.id}: ${c}`).toMatch(CARD);
        expect(new Set(all).size, `${g.id}: repeated card`).toBe(all.length);
        // Template slips like "undefined" or "NaN" would show up in the text.
        for (const line of [...ex.lines, ex.title]) expect(line, g.id).not.toMatch(/undefined|NaN|\[object/);
      }
    }
  });

  it('list the side games switched on at a table', () => {
    const cash = defaultSettings('cash');
    // A new cash table: run it twice by vote, straddles, rabbit hunting and a time bank are on.
    expect(extrasOn(cash)).toEqual(['run-it-twice', 'straddles', 'rabbit-hunt', 'time-bank', 'showdown', 'missed-blinds']);
    cash.modifiers.nit = { ...(cash.modifiers.nit as object), enabled: true };
    cash.modifiers.rake = { ...rakeSchema.defaults(), enabled: true };
    expect(extrasOn(cash)).toContain('nit-game');
    expect(extrasOn(cash)).toContain('house-fee');
    const tourney = defaultSettings('tournament');
    expect(extrasOn(tourney)).toEqual(['rabbit-hunt', 'time-bank', 'showdown']);
  });
});

describe('the numbers in the side game examples', () => {
  it('straddles: what each one posts and the smallest raise over it', () => {
    // Button 0, blinds 1 and 2, under the gun 3, then 4 and 5.
    const utg = deal({ stacks: [200, 200, 200, 200, 200, 200], straddles: 'utg', straddlers: [3] });
    expect(posts(utg)).toContainEqual([3, 'straddle', STRADDLE_EX.utg]);
    expect(utg.toAct).toBe(4);
    expect(engine.legalActions(utg, 4)!.minTo).toBe(STRADDLE_EX.minRaiseOverUtg);
    // Everyone calls round to the straddler, who can check or raise.
    for (const seat of [4, 5, 0, 1, 2]) engine.act(utg, seat, { type: 'call' });
    expect(utg.toAct).toBe(3);
    const last = engine.legalActions(utg, 3)!;
    expect(last.canCheck).toBe(true);
    expect(last.canRaise).toBe(true);

    const both = deal({ stacks: [200, 200, 200, 200, 200, 200], straddles: 'utg-and-button', straddlers: [3, 0] });
    expect(posts(both)).toContainEqual([0, 'straddle', STRADDLE_EX.button]);
    expect(both.toAct).toBe(1); // the small blind
    expect(engine.legalActions(both, 1)!.minTo).toBe(STRADDLE_EX.minRaiseOverButton);

    const buttonOnly = deal({ stacks: [200, 200, 200, 200, 200, 200], straddles: 'utg-and-button', straddlers: [0] });
    expect(posts(buttonOnly)).toContainEqual([0, 'straddle', STRADDLE_EX.buttonAlone]);
  });

  it('bomb pots: the posts, the pot and the side pot for a short stack', () => {
    const post = BOMB_EX.bigBlinds * STAKES.bigBlind;
    const full = deal({ stacks: Array(BOMB_EX.players).fill(200), bombPot: post });
    expect(engine.pots(full).reduce((n, p) => n + p.amount, 0)).toBe(post * BOMB_EX.players);
    expect(posts(full).every(([, kind]) => kind === 'bomb-pot')).toBe(true);
    expect(full.runs[0][0]).toHaveLength(3); // the flop is out
    expect(full.toAct).toBe(1); // left of the button

    const stacks = Array(BOMB_EX.players).fill(200);
    stacks[3] = BOMB_EX.shortStack;
    const short = deal({ stacks, bombPot: post });
    const [main, side] = engine.pots(short);
    expect(main.amount).toBe(BOMB_EX.shortStack * BOMB_EX.players);
    expect(side.amount).toBe((post - BOMB_EX.shortStack) * (BOMB_EX.players - 1));
    expect(side.eligible).not.toContain(3);
  });

  it('7-2 bounty: what the winner collects, with and without a short payer', () => {
    // Seat 3 (under the gun) holds 7-2 and raises; everyone folds, then seat 3 shows.
    const holes: Record<number, [Card, Card]> = { 1: ['Kd', 'Qc'], 2: ['9h', '8h'], 3: ['7s', '2d'], 4: ['Ac', 'Jd'], 5: ['Td', '6c'], 0: ['5s', '4s'] };
    const order = [1, 2, 3, 4, 5, 0];
    const top = [0, 1].flatMap((r) => order.map((s) => holes[s][r]));
    const cfg = { ...bounty72Schema.defaults(), enabled: true, amount: BOUNTY_EX.amount, autoShow: false };
    const collected = (stacks: number[]) => {
      const s = deal({ stacks, top, modifiers: [{ id: 'bounty-72', settings: cfg }] });
      engine.act(s, 3, { type: 'raise', to: 6 });
      for (const seat of [4, 5, 0, 1, 2]) engine.act(s, seat, { type: 'fold' });
      engine.show(s, 3, [0, 1]);
      return s.events.reduce((n, e) => n + (e.t === 'transfer' && e.kind === 'bounty-72' && e.to === 3 ? e.amount : 0), 0);
    };
    expect(collected(Array(BOUNTY_EX.players).fill(100))).toBe(BOUNTY_EX.amount * (BOUNTY_EX.players - 1));
    const stacks = Array(BOUNTY_EX.players).fill(100);
    stacks[4] = BOUNTY_EX.shortStack; // folds without putting anything in
    expect(collected(stacks)).toBe(BOUNTY_EX.amount * (BOUNTY_EX.players - 2) + BOUNTY_EX.shortStack);
  });

  it('run it twice and double board: how an odd pot is cut', () => {
    const { spec, rules } = variants.get('nlhe');
    const pot: Pot = { amount: RIT_EX.pot, eligible: [0, 1] };
    const holeBySeat = { 0: cardsOf('As Ad'), 1: cardsOf('Kh Kd') };
    // Run 1 gives Ana (seat 0) the best hand, run 2 gives Ben a set of kings.
    const runs = [[cardsOf('2c 7d 9s Jh 3c')], [cardsOf('Kc 7d 9s Jh 3c')]];
    const rit = settle({ pots: [pot], runs, button: 1, maxSeats: 2, holeBySeat, spec, rules });
    expect(rit.map((a) => [a.run, a.seat, a.amount])).toEqual([
      [0, 0, RIT_EX.run1],
      [1, 1, RIT_EX.run2],
    ]);

    const boards = [[cardsOf(DOUBLE_EX.boards[0]), cardsOf(DOUBLE_EX.boards[1])]];
    const db = settle({
      pots: [{ amount: DOUBLE_EX.pot, eligible: [0, 1] }],
      runs: boards,
      button: 1,
      maxSeats: 2,
      holeBySeat: { 0: cardsOf(DOUBLE_EX.ana), 1: cardsOf(DOUBLE_EX.ben) },
      spec,
      rules,
    });
    expect(db.map((a) => [a.board, a.seat, a.amount])).toEqual([
      [0, 0, DOUBLE_EX.top],
      [1, 1, DOUBLE_EX.bottom],
    ]);
  });

  it('house fee: each example pot pays the fee the guide says', () => {
    const cfg = { ...rakeSchema.defaults(), enabled: true, percent: RAKE_EX.percent, cap: RAKE_EX.cap, shortHanded: { players: RAKE_EX.short.players, percent: RAKE_EX.short.percent, cap: 0 } };
    for (const ex of RAKE_EX.pots) {
      const state = {
        input: { game: { family: 'flop' } },
        runs: [[ex.flop ? ['2c', '3d', '4h'] : []]],
        street: 0,
        seats: Array.from({ length: ex.players }, (_, i) => ({ total: i === 0 ? ex.pot : 0 })),
      } as unknown as HandState;
      expect(rakeFor({ amount: ex.pot, eligible: [0, 1] }, state, cfg), `${ex.pot} pot`).toBe(ex.fee);
    }
  });
});

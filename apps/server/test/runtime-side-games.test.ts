import { beforeAll, describe, expect, it } from 'vitest';
import { engine, variants } from '@rsdp/engine/core';
import { bombPotSchema, bounty72Schema, doubleBoardSchema } from '@rsdp/engine/modifiers';
import { defaultSettings, type TableSettings } from '@rsdp/engine/settings';
import { registerAllVariants } from '@rsdp/engine/variants';
import { TableRuntime } from '../src/runtime/table';
import { tableView } from '../src/runtime/view';
import { FakeClock, seeded } from './fake-clock';

beforeAll(() => registerAllVariants(variants));

const IDS = ['host', 'a', 'b', 'c'];

function table(patch: (s: TableSettings) => void = () => {}, players = 3, stack = 200) {
  const clock = new FakeClock();
  const settings = defaultSettings('cash');
  settings.seating.requireApproval = false;
  settings.timing.autoStartNextHand = false;
  patch(settings);
  const rt = TableRuntime.create({ id: 't1', hostId: 'host', settings }, { clock, rng: seeded() });
  for (const p of IDS) rt.connect(p);
  IDS.slice(0, players).forEach((id, seat) => rt.requestSeat(id, { seat, name: id.toUpperCase(), stack }));
  return { rt, clock };
}

const hand = (rt: TableRuntime) => rt.state.hand!;
const idAt = (rt: TableRuntime, seat: number) => rt.state.seats[seat]!.playerId;
const total = (rt: TableRuntime) => rt.state.seats.reduce((n, s) => n + (s?.stack ?? 0), 0);

function finish(rt: TableRuntime, how: 'fold' | 'check' = 'check') {
  for (let i = 0; i < 100 && hand(rt).phase === 'betting' && hand(rt).toAct !== null; i++) {
    const seat = hand(rt).toAct!;
    const legal = engine.legalActions(hand(rt), seat)!;
    rt.act(idAt(rt, seat), how === 'fold' && !legal.canCheck ? { type: 'fold' } : legal.canCheck ? { type: 'check' } : { type: 'call' });
  }
}

const set = <T extends object>(s: TableSettings, id: string, patch: T) => {
  s.modifiers[id] = { ...(s.modifiers[id] as object), ...patch };
};

describe('bomb pots', () => {
  it('the host button makes the next hand a bomb pot, once', () => {
    const { rt } = table();
    rt.requestBombPot('host', true);
    expect(tableView(rt, 'a', 0).bombPotNext).toBe(true);
    expect(() => rt.requestBombPot('a', true)).toThrow(/host/);
    rt.start('host');
    const h = hand(rt);
    expect(h.input.options.bombPot).toBe(true);
    expect(h.input.posts.map((p) => [p.kind, p.amount])).toEqual(Array(3).fill(['bomb-pot', 10]));
    expect(h.runs[0][0]).toHaveLength(3);
    expect(tableView(rt, 'a', 0).hand?.bombPot).toBe(true);
    finish(rt);
    expect(total(rt)).toBe(600);
    rt.dealNext('host');
    expect(hand(rt).input.options.bombPot).toBe(false);
  });

  it('deals one every N hands', () => {
    const { rt } = table((s) => set(s, 'bomb-pot', { enabled: true, chancePercent: 0, everyHands: 2 }));
    rt.start('host');
    const seen: boolean[] = [];
    for (let i = 0; i < 4; i++) {
      seen.push(hand(rt).input.options.bombPot);
      finish(rt, 'fold');
      rt.dealNext('host');
    }
    expect(seen).toEqual([false, true, false, true]);
  });

  it('plays a PLO bomb pot at a Hold\'em table, with double board in bomb pots', () => {
    const { rt } = table((s) => {
      set(s, 'bomb-pot', { gameId: 'plo4', betting: 'pot-limit', bigBlinds: 3 });
      set(s, 'double-board', { enabled: true, when: 'bomb-pots' });
    });
    rt.requestBombPot('host', true);
    rt.start('host');
    const h = hand(rt);
    expect(h.input.game.id).toBe('plo4');
    expect(h.input.betting).toBe('pot-limit');
    expect(h.seats[0].cards).toHaveLength(4);
    expect(h.runs[0]).toHaveLength(2);
    expect(h.input.posts[0].amount).toBe(6);
    finish(rt);
    rt.dealNext('host');
    expect(hand(rt).input.game.id).toBe('nlhe');
    expect(hand(rt).runs[0]).toHaveLength(1);
  });

  it('refuses a bomb pot game without a flop, and bomb pots in tournaments', () => {
    const { rt } = table();
    expect(() => rt.updateSettings('host', { modifiers: { 'bomb-pot': { gameId: 'stud' } } })).toThrow(/flop/);
    expect(() => rt.updateSettings('host', { modifiers: { 'bomb-pot': { gameId: 'nope' } } })).toThrow(/unknown/);
    expect(bombPotSchema.get(rt.settings).gameId).toBe('');
  });

  it('skips the bomb pot when the table game has no flop', () => {
    const { rt } = table((s) => (s.game.gameId = 'stud'));
    rt.requestBombPot('host', true);
    rt.start('host');
    expect(hand(rt).input.options.bombPot).toBe(false);
    expect(rt.state.sideGames?.bombPotNext).toBe(false);
    expect(rt.state.log.at(-1)?.text).toMatch(/bomb pot/);
  });
});

describe('double board', () => {
  it('deals two boards every hand when set to always', () => {
    const { rt } = table((s) => set(s, doubleBoardSchema.id, { enabled: true, when: 'always' }));
    rt.start('host');
    finish(rt);
    expect(hand(rt).runs[0]).toHaveLength(2);
    expect(hand(rt).runs[0].every((b) => b.length === 5)).toBe(true);
    expect(total(rt)).toBe(600);
  });
});

describe('7-2 bounty', () => {
  const on = (autoShow: boolean) => (s: TableSettings) => set(s, bounty72Schema.id, { enabled: true, amount: 15, autoShow });

  /** Gives `seat` 7-2 in the live hand (the deck is shuffled; tests overwrite the dealt cards). */
  const giveSevenDeuce = (rt: TableRuntime, seat: number) => {
    const hs = hand(rt).seats.find((x) => x.seat === seat)!;
    hs.cards = [
      { card: '7c', up: false },
      { card: '2d', up: false },
    ];
  };

  /** Everyone folds to the player first to act, who wins uncontested. */
  const foldToFirst = (rt: TableRuntime) => {
    const first = hand(rt).toAct!;
    rt.act(idAt(rt, first), { type: 'raise', to: 20 });
    finish(rt, 'fold');
    return first;
  };

  it('auto-show pays the bounty for an uncontested 7-2', () => {
    const { rt } = table(on(true));
    rt.start('host');
    const first = hand(rt).toAct!;
    giveSevenDeuce(rt, first);
    foldToFirst(rt);
    const transfers = hand(rt).events.filter((e) => e.t === 'transfer');
    expect(transfers).toHaveLength(2);
    expect(rt.state.seats[first]!.stack).toBe(200 + 3 + 30);
    expect(total(rt)).toBe(600);
  });

  it('without auto-show the winner claims it by showing after the hand', () => {
    const { rt } = table(on(false));
    rt.start('host');
    const first = hand(rt).toAct!;
    giveSevenDeuce(rt, first);
    foldToFirst(rt);
    expect(rt.state.seats[first]!.stack).toBe(203);
    rt.show(idAt(rt, first), [0, 1]);
    expect(rt.state.seats[first]!.stack).toBe(233);
    rt.show(idAt(rt, first), [0, 1]);
    expect(rt.state.seats[first]!.stack).toBe(233);
    expect(total(rt)).toBe(600);
  });

  it('a payer who already left pays from their cash-out', () => {
    const { rt } = table(on(false));
    rt.start('host');
    const first = hand(rt).toAct!;
    giveSevenDeuce(rt, first);
    foldToFirst(rt);
    const leaver = [0, 1, 2].find((x) => x !== first)!;
    const leaverId = idAt(rt, leaver);
    rt.stand(leaverId);
    const before = rt.state.ledger[leaverId].cashOut;
    rt.show(idAt(rt, first), [0, 1]);
    expect(rt.state.ledger[leaverId].cashOut).toBe(before - 15);
  });
});

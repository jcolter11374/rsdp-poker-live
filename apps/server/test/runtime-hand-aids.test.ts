import { beforeAll, describe, expect, it } from 'vitest';
import { engine, variants } from '@rsdp/engine/core';
import { defaultSettings, type TableSettings } from '@rsdp/engine/settings';
import { registerAllVariants } from '@rsdp/engine/variants';
import { TableRuntime } from '../src/runtime/table';
import { tableView } from '../src/runtime/view';
import { FakeClock, seeded } from './fake-clock';

beforeAll(() => registerAllVariants(variants));

const IDS = ['host', 'a', 'b'];

function table(patch: (s: TableSettings) => void = () => {}) {
  const clock = new FakeClock();
  const settings = defaultSettings('cash');
  settings.seating.requireApproval = false;
  settings.timing.autoStartNextHand = false;
  patch(settings);
  const rt = TableRuntime.create({ id: 't1', hostId: 'host', settings }, { clock, rng: seeded() });
  for (const p of [...IDS, 'watcher']) rt.connect(p);
  IDS.forEach((id, seat) => rt.requestSeat(id, { seat, name: id.toUpperCase(), stack: 200 }));
  rt.start('host');
  return { rt, clock };
}

const hand = (rt: TableRuntime) => rt.state.hand!;
const toActId = (rt: TableRuntime) => rt.state.seats[hand(rt).toAct!]!.playerId;

describe('rabbit hunting', () => {
  it('shows the undealt board only to whoever asks, and they are the real next cards', () => {
    const { rt } = table();
    rt.act(toActId(rt), { type: 'raise', to: 20 });
    rt.act(toActId(rt), { type: 'fold' });
    rt.act(toActId(rt), { type: 'fold' });
    const h = hand(rt);
    expect(h.phase).toBe('complete');
    expect(tableView(rt, 'a', 0).rabbit).toEqual({ available: true, cards: null });
    rt.rabbitHunt('watcher');
    const seen = tableView(rt, 'watcher', 0).rabbit.cards!;
    expect(seen).toEqual([h.input.deck.slice(h.deckPos, h.deckPos + 5)]);
    expect(tableView(rt, 'a', 0).rabbit.cards).toBeNull();
    expect(JSON.stringify(tableView(rt, 'a', 0))).not.toContain(JSON.stringify(seen[0]));
  });

  it('is off when the setting is off, during a hand, and after a full board', () => {
    const off = table((s) => (s.play.rabbitHunt = false)).rt;
    off.act(toActId(off), { type: 'fold' });
    off.act(toActId(off), { type: 'fold' });
    expect(tableView(off, 'a', 0).rabbit.available).toBe(false);
    expect(() => off.rabbitHunt('a')).toThrow(/no cards/);

    const { rt } = table();
    expect(() => rt.rabbitHunt('a')).toThrow(/over/);
    for (let i = 0; i < 50 && hand(rt).phase !== 'complete'; i++) {
      const legal = engine.legalActions(hand(rt), hand(rt).toAct!)!;
      rt.act(toActId(rt), legal.canCheck ? { type: 'check' } : { type: 'call' });
    }
    expect(tableView(rt, 'a', 0).rabbit.available).toBe(false);
  });
});

describe('manual time bank', () => {
  it('adds the bank to the clock and charges only the time used past the normal clock', () => {
    const { rt, clock } = table((s) => {
      s.timing.decisionSeconds = 20;
      s.timing.timeBankSeconds = 30;
      s.timing.autoActivateTimeBank = false;
    });
    const id = toActId(rt);
    const seat = rt.seatOf(id)!;
    expect(() => rt.useTimeBank(IDS.find((x) => x !== id)!)).toThrow(/turn/);
    rt.useTimeBank(id);
    expect(rt.state.turn?.usingBank).toBe(true);
    clock.advance(25_000);
    expect(hand(rt).toAct).toBe(seat.seat);
    rt.act(id, { type: 'call' });
    expect(seat.timeBank).toBe(25);
  });

  it('acting before the normal clock runs out keeps the whole bank', () => {
    const { rt, clock } = table((s) => {
      s.timing.decisionSeconds = 20;
      s.timing.timeBankSeconds = 30;
    });
    const id = toActId(rt);
    rt.useTimeBank(id);
    clock.advance(5_000);
    rt.act(id, { type: 'call' });
    expect(rt.seatOf(id)!.timeBank).toBe(30);
  });
});

describe('showdown', () => {
  it('mucks losing hands by default and shows them all when the host turns that on', () => {
    for (const all of [false, true]) {
      const { rt } = table((s) => (s.play.revealAllAtShowdown = all));
      expect(hand(rt).input.options.showdown).toBe(all ? 'show-all' : 'muck-losers');
    }
  });
});

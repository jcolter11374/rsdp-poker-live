import { beforeAll, describe, expect, it } from 'vitest';
import { engine, variants } from '@rsdp/engine/core';
import { defaultSettings, type TableSettings } from '@rsdp/engine/settings';
import { registerAllVariants } from '@rsdp/engine/variants';
import { TableRuntime } from '../src/runtime/table';
import { tableView } from '../src/runtime/view';
import { FakeClock, seeded } from './fake-clock';

beforeAll(() => registerAllVariants(variants));

const IDS = ['host', 'a', 'b'];

function table(patch: (s: TableSettings) => void, ids = IDS) {
  const clock = new FakeClock();
  const settings = defaultSettings('cash');
  settings.seating.requireApproval = false;
  settings.timing.autoStartNextHand = false;
  patch(settings);
  const rt = TableRuntime.create({ id: 't1', hostId: 'host', settings }, { clock, rng: seeded() });
  for (const p of ids) rt.connect(p);
  ids.forEach((id, seat) => rt.requestSeat(id, { seat, name: id.toUpperCase(), stack: 200 }));
  return { rt, clock };
}

const hand = (rt: TableRuntime) => rt.state.hand!;
const toActId = (rt: TableRuntime) => rt.state.seats[hand(rt).toAct!]!.playerId;
const total = (rt: TableRuntime) => rt.state.seats.reduce((n, s) => n + (s?.stack ?? 0), 0);

/** The first player to act raises and everyone folds: they win outright. Returns their id. */
function winOutright(rt: TableRuntime) {
  const winner = toActId(rt);
  rt.act(winner, { type: 'raise', to: 10 });
  for (let i = 0; i < 10 && hand(rt).phase === 'betting'; i++) rt.act(toActId(rt), { type: 'fold' });
  return winner;
}

const nitOn = (s: TableSettings) => (s.modifiers.nit = { enabled: true, prizeBigBlinds: 10, minPlayers: 3 });

describe('Nit game', () => {
  it('starts when enough players opt in; the last holder pays each of the others', () => {
    const { rt } = table(nitOn);
    for (const id of IDS) rt.setPreferences(id, { nitGame: true });
    rt.start('host');
    expect(rt.state.sideGames?.nit).toMatchObject({ participants: IDS, prize: 20 });
    const first = winOutright(rt);
    expect(tableView(rt, 'a', 0).seats.find((s) => s?.playerId === first)?.nit).toBe('clear');
    // Keep dealing until a second, different holder wins outright.
    let guard = 0;
    while (rt.state.sideGames?.nit && guard++ < 20) {
      rt.dealNext('host');
      winOutright(rt);
    }
    expect(rt.state.sideGames?.nit).toBeNull();
    expect(total(rt)).toBe(600);
    expect(rt.state.log.some((l) => /last nit and pays 40/.test(l.text))).toBe(true);
  });

  it('does not start with too few opted in, and a holder who leaves pays at once', () => {
    const { rt } = table(nitOn);
    rt.setPreferences('host', { nitGame: true });
    rt.setPreferences('a', { nitGame: true });
    rt.start('host');
    expect(rt.state.sideGames?.nit ?? null).toBeNull();
    winOutright(rt);
    rt.setPreferences('b', { nitGame: true });
    rt.dealNext('host');
    expect(rt.state.sideGames?.nit?.participants).toHaveLength(3);
    winOutright(rt);
    const holder = rt.state.sideGames!.nit!.holders[0];
    const before = rt.seatOf(holder)!.stack;
    rt.stand(holder);
    expect(rt.state.ledger[holder].cashOut).toBe(before - 40);
    expect(rt.state.sideGames?.nit).toBeNull();
  });
});

describe('Nit game edge cases', () => {
  const FOUR = ['host', 'a', 'b', 'c'];
  const chips = (rt: TableRuntime) => total(rt) + FOUR.reduce((n, id) => n + (rt.state.ledger[id]?.cashOut ?? 0), 0);

  it('pays players in a live hand when that hand ends, so no chips are lost', () => {
    const { rt } = table(nitOn, FOUR);
    for (const id of FOUR) rt.setPreferences(id, { nitGame: true });
    rt.start('host');
    const winner = winOutright(rt);
    const holder = rt.state.sideGames!.nit!.holders.find((id) => id !== winner)!;
    rt.sitOut(holder, true);
    rt.dealNext('host');
    expect(hand(rt).seats.some((s) => s.playerId === holder)).toBe(false);
    rt.stand(holder);
    expect(rt.state.sideGames?.nit).toBeNull();
    for (let i = 0; i < 20 && hand(rt).phase === 'betting'; i++) rt.act(toActId(rt), { type: 'fold' });
    expect(hand(rt).phase).toBe('complete');
    expect(chips(rt)).toBe(800);
    expect(rt.state.ledger[holder].cashOut).toBe(200 - 60);
  });

  it('cancels the round as soon as the host turns the game off', () => {
    const { rt } = table(nitOn);
    for (const id of IDS) rt.setPreferences(id, { nitGame: true });
    rt.start('host');
    rt.updateSettings('host', { modifiers: { nit: { enabled: false } } } as never);
    expect(rt.state.sideGames?.nit ?? null).toBeNull();
    winOutright(rt);
    expect(rt.state.sideGames?.nit ?? null).toBeNull();
    expect(rt.state.log.some((l) => /pays .* \(Nit game\)/.test(l.text))).toBe(false);
  });
});

describe('house fee', () => {
  it('keeps a running total that only the host sees by default', () => {
    const { rt } = table((s) => (s.modifiers.rake = { ...(s.modifiers.rake as object), enabled: true, percent: 10, noFlopNoDrop: false }));
    rt.start('host');
    rt.act(toActId(rt), { type: 'raise', to: 20 });
    for (let i = 0; i < 50 && hand(rt).phase !== 'complete'; i++) {
      const legal = engine.legalActions(hand(rt), hand(rt).toAct!)!;
      rt.act(toActId(rt), legal.canCheck ? { type: 'check' } : { type: 'call' });
    }
    expect(rt.state.sideGames?.rakeTotal).toBe(6);
    expect(total(rt)).toBe(594);
    expect(tableView(rt, 'host', 0).rakeTotal).toBe(6);
    expect(tableView(rt, 'a', 0).rakeTotal).toBeNull();
  });
});

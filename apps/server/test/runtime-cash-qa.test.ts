import { beforeAll, describe, expect, it } from 'vitest';
import { variants } from '@rsdp/engine/core';
import { defaultSettings } from '@rsdp/engine/settings';
import { registerAllVariants } from '@rsdp/engine/variants';
import { TableRuntime } from '../src/runtime/table';
import { FakeClock, seeded } from './fake-clock';

beforeAll(() => registerAllVariants(variants));

function table() {
  const clock = new FakeClock();
  const s = defaultSettings('cash');
  s.seating.requireApproval = false;
  s.play.runItTwice = 'off';
  const rt = TableRuntime.create({ id: 't', hostId: 'host', settings: s }, { clock, rng: seeded() });
  for (const p of ['host', 'a', 'b', 'c']) rt.connect(p);
  rt.requestSeat('host', { seat: 0, name: 'H', stack: 100 });
  rt.requestSeat('a', { seat: 1, name: 'A', stack: 100 });
  rt.requestSeat('b', { seat: 2, name: 'B', stack: 100 });
  return { rt, clock };
}

const toAct = (rt: TableRuntime) => rt.state.seats[rt.state.hand!.toAct!]!.playerId;
const chipsAddUp = (rt: TableRuntime) => {
  const rows = Object.values(rt.state.ledger);
  const onTable = rt.state.seats.reduce((n, x) => n + (x ? x.stack + x.pendingChips : 0), 0);
  return rows.reduce((n, r) => n + r.buyIn, 0) === onTable + rows.reduce((n, r) => n + r.cashOut, 0);
};

describe('cash table edge cases', () => {
  it('nobody can sit in a seat a smaller table is about to drop', () => {
    const { rt, clock } = table();
    rt.start('host');
    rt.updateSettings('host', { table: { maxSeats: 6 } });
    expect(() => rt.requestSeat('c', { seat: 8, name: 'C', stack: 300 })).toThrow(/going down to 6 seats/);
    expect(() => rt.moveSeat('host', 'a', 7)).toThrow(/going down to 6 seats/);
    rt.requestSeat('c', { seat: 5, name: 'C', stack: 300 });
    while (rt.state.hand?.phase !== 'complete') rt.act(toAct(rt), { type: 'fold' });
    clock.advance(10_000);
    expect(rt.state.seats).toHaveLength(6);
    expect(rt.seatOf('c')?.seat).toBe(5);
    expect(chipsAddUp(rt)).toBe(true);
  });

  it('a seat request for a dropped seat is approved into an open one', () => {
    const { rt } = table();
    rt.updateSettings('host', { seating: { requireApproval: true } });
    rt.requestSeat('c', { seat: 9, name: 'C', stack: 300 });
    rt.start('host');
    rt.updateSettings('host', { table: { maxSeats: 6 } });
    rt.approve('host', rt.state.requests[0].id);
    expect(rt.seatOf('c')!.seat).toBeLessThan(6);
  });

  it('an all-in player who leaves keeps their hand and goes when it ends', () => {
    const { rt } = table();
    rt.start('host');
    const shover = toAct(rt);
    rt.act(shover, { type: 'raise', to: 100 });
    rt.act(toAct(rt), { type: 'call' });
    rt.stand(shover);
    const hs = rt.state.hand!.seats.find((x) => x.playerId === shover)!;
    expect(hs.folded).toBe(false);
    rt.act(toAct(rt), { type: 'fold' });
    expect(rt.state.hand!.phase).toBe('complete');
    expect(rt.seatOf(shover)).toBeNull();
    expect(chipsAddUp(rt)).toBe(true);
    // Whatever they won went out with them.
    const won = rt.state.hand!.seats.find((x) => x.playerId === shover)!.stack;
    expect(rt.state.ledger[shover].cashOut).toBe(won);
  });

  it('a player who leaves takes their rebuy request with them', () => {
    const { rt } = table();
    rt.updateSettings('host', { seating: { rebuyRequiresApproval: true } });
    rt.rebuy('a', 50);
    expect(rt.state.requests).toHaveLength(1);
    rt.stand('a');
    expect(rt.state.requests).toHaveLength(0);
  });
});

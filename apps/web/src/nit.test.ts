import { describe, expect, it } from 'vitest';
import type { SeatView, TableView } from '@rsdp/engine/wire';
import { nitStatus } from './nit';

const fmt = (n: number) => String(n);
const seat = (over: Partial<SeatView>) => ({ nitOptIn: false, nit: null, sittingOut: false, ...over }) as SeatView;
const view = (seats: SeatView[], nit: TableView['nit'] = null) =>
  ({ settings: { stakes: { bigBlind: 2 }, modifiers: { nit: { enabled: true, prizeBigBlinds: 10, minPlayers: 3 } } }, seats, nit }) as unknown as TableView;

describe('nitStatus', () => {
  it('counts ticked players before a round, leaving out anyone sitting out', () => {
    const seats = [seat({ nitOptIn: true }), seat({ nitOptIn: true, sittingOut: true }), seat({})];
    const s = nitStatus(view(seats), seats[0], fmt);
    expect(s.status).toBe('1 of 3 players ticked. A round starts once 2 more join. Prize: 20 to each player.');
    expect(s.locked).toBe(false);
  });

  it('says a round starts next hand once enough have ticked', () => {
    const seats = [0, 1, 2].map(() => seat({ nitOptIn: true }));
    expect(nitStatus(view(seats), seats[0], fmt).status).toMatch(/^3 players ticked: a round starts with the next hand/);
  });

  it('tells a player in the round they are locked in, on the nit or off it', () => {
    const round = { prize: 20, participants: 6, holders: 3 };
    const on = nitStatus(view([], round), seat({ nit: 'holder', nitOptIn: true }), fmt);
    expect(on.locked).toBe(true);
    expect(on.label).toBe('Play the next round too');
    expect(on.status).toContain("You're on the nit");
    expect(on.status).toContain('3 of 6 still on the nit');
    const off = nitStatus(view([], round), seat({ nit: 'clear' }), fmt);
    expect(off.locked).toBe(true);
    expect(off.status).toContain('the last one pays you 20');
  });

  it('tells someone outside a running round whether they are in the next one', () => {
    const round = { prize: 20, participants: 4, holders: 2 };
    expect(nitStatus(view([], round), seat({}), fmt)).toMatchObject({ locked: false, status: 'A Nit round is on without you (2 of 4 still on the nit). Tick to join the next one.' });
    expect(nitStatus(view([], round), seat({ nitOptIn: true }), fmt).status).toContain("You're in the next one.");
    expect(nitStatus(view([], round), null, fmt).status).toBe('A Nit round is on without you (2 of 4 still on the nit).');
  });
});

import { describe, expect, it } from 'vitest';
import { defaultSettings } from '@rsdp/engine/settings';
import { seatsThatFit, withPreset } from './withPreset';

describe('loading a preset', () => {
  it('keeps the table in dollars: a preset saved in chips counts each chip as a dollar', () => {
    const table = defaultSettings('cash');
    table.stakes = { ...table.stakes, smallBlind: 25, bigBlind: 50, centsMode: true };
    const preset = defaultSettings('cash');
    preset.table.name = 'Friday PLO';
    preset.seating.maxBuyIn = 300;
    const out = withPreset(table, preset);
    expect(out.stakes).toMatchObject({ smallBlind: 100, bigBlind: 200, centsMode: true });
    expect(out.seating.maxBuyIn).toBe(30_000);
    expect(out.table.name).toBe(table.table.name);
  });

  it('loads a preset in dollars as it is', () => {
    const table = defaultSettings('cash');
    table.stakes.centsMode = true;
    const preset = structuredClone(table);
    preset.stakes = { ...preset.stakes, smallBlind: 10, bigBlind: 25 };
    expect(withPreset(table, preset).stakes).toMatchObject({ smallBlind: 10, bigBlind: 25, centsMode: true });
  });

  it("won't put a preset in dollars on an older table in chips", () => {
    const table = defaultSettings('cash');
    const preset = structuredClone(table);
    preset.stakes = { ...preset.stakes, smallBlind: 25, bigBlind: 50, centsMode: true };
    expect(() => withPreset(table, preset)).toThrow(/plays in chips/);
  });
});

describe('seats that fit every game', () => {
  const step = (gameId: string, betting: 'no-limit' | 'fixed-limit') => ({ gameId, betting, length: 1, unit: 'orbits' as const });
  const preset = (maxSeats: number, steps = [step('nlhe', 'no-limit'), step('badugi', 'fixed-limit')], enabled = true) => {
    const s = defaultSettings('cash');
    return { ...s, table: { ...s.table, maxSeats }, game: { ...s.game, rotation: { enabled, steps } } };
  };

  it("brings a 10-seat preset rotating Hold'em and Badugi down to 6, the most Badugi deals", () => {
    expect(seatsThatFit(preset(10)).table.maxSeats).toBe(6);
    expect(seatsThatFit(preset(4)).table.maxSeats).toBe(4);
  });

  it("counts only the table's game when the rotation is off, and leaves a game it doesn't know to the server", () => {
    expect(seatsThatFit(preset(10, undefined, false)).table.maxSeats).toBe(10);
    expect(seatsThatFit(preset(10, [step('nlhe', 'no-limit'), step('no-such-game', 'no-limit')])).table.maxSeats).toBe(10);
  });

  it("at Dealer's choice, keeps the seats of the menu's biggest game, whatever the table's own game", () => {
    const dc = (maxSeats: number, gameId: string, games: { gameId: string; betting: 'no-limit' | 'fixed-limit' | 'pot-limit' }[]) => {
      const s = preset(maxSeats, [], false);
      return { ...s, game: { ...s.game, gameId, dealersChoice: { enabled: true, games, hands: 0, pickSeconds: 20 } } };
    };
    // Its own game (hidden while Dealer's choice is on) seats 6, but the menu's Hold'em seats 9.
    expect(seatsThatFit(dc(9, 'td27', [{ gameId: 'nlhe', betting: 'no-limit' }, { gameId: 'plo4', betting: 'pot-limit' }])).table.maxSeats).toBe(9);
    // A menu of Stud and Razz seats 8.
    expect(seatsThatFit(dc(9, 'nlhe', [{ gameId: 'stud', betting: 'fixed-limit' }, { gameId: 'razz', betting: 'fixed-limit' }])).table.maxSeats).toBe(8);
  });
});

import { describe, expect, it } from 'vitest';
import { defaultSettings } from '@rsdp/engine/settings';
import { withPreset } from './withPreset';

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

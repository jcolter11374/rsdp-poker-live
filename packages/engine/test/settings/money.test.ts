import { describe, expect, it } from 'vitest';
import { amountText, cashInDollars, defaultSettings, parseSettings, scaleChipAmounts, type SettingsPatch } from '../../src/settings';
import '../../src/modifiers';

describe('cash games in dollars and cents', () => {
  it('scales every chip amount, and only those', () => {
    const s = defaultSettings('cash');
    s.blindSchedule.levels = [{ smallBlind: 1, bigBlind: 2, ante: 0, minutes: 20, hands: 30 }];
    s.seating.minBuyIn = 40;
    s.modifiers = { ...s.modifiers, 'bounty-72': { enabled: true, amount: 10, suits: 'any', autoShow: true } };
    const out = scaleChipAmounts(s, 100);
    expect(out.stakes).toMatchObject({ smallBlind: 100, bigBlind: 200, centsMode: false });
    expect(out.blindSchedule.levels[0]).toEqual({ smallBlind: 100, bigBlind: 200, ante: 0, minutes: 20, hands: 30 });
    expect(out.seating).toMatchObject({ minBuyIn: 4000, maxBuyIn: 0, ratholeMinutes: s.seating.ratholeMinutes });
    expect(out.modifiers['bounty-72']).toMatchObject({ amount: 1000 });
    expect(out.timing).toEqual(s.timing);
    // The original is left alone.
    expect(s.stakes.bigBlind).toBe(2);
    expect(() => parseSettings(out)).not.toThrow();
  });

  it('leaves out what a patch leaves out', () => {
    expect(scaleChipAmounts({ stakes: { bigBlind: 2 }, table: { name: 'x' } } as SettingsPatch, 100)).toEqual({ stakes: { bigBlind: 200 }, table: { name: 'x' } });
  });

  it('counts each chip of an older setup as a dollar, and passes cents through', () => {
    expect(cashInDollars({ stakes: { smallBlind: 1, bigBlind: 2 } })).toEqual({ stakes: { smallBlind: 100, bigBlind: 200, centsMode: true } });
    expect(cashInDollars({ stakes: { smallBlind: 1, bigBlind: 2, centsMode: false } }).stakes).toMatchObject({ smallBlind: 100, centsMode: true });
    const cents: SettingsPatch = { stakes: { smallBlind: 25, bigBlind: 50, centsMode: true } };
    expect(cashInDollars(cents)).toBe(cents);
    expect(cashInDollars({}).stakes).toEqual({ centsMode: true });
  });

  it('writes amounts for the log', () => {
    expect(amountText(25, true)).toBe('0.25');
    expect(amountText(50, true)).toBe('0.50');
    expect(amountText(5000, true)).toBe('50');
    expect(amountText(123456, true)).toBe('1,234.56');
    expect(amountText(1500, false)).toBe('1,500');
  });
});

import { describe, expect, it } from 'vitest';
import { defaultSettings, delayText, settingsNotices, type TableSettings } from '../../src/settings';

const cash = (patch: (s: TableSettings) => void = () => {}) => {
  const s = defaultSettings('cash');
  patch(s);
  return s;
};

describe('settingsNotices', () => {
  it('warns loudly when spectators start seeing every card, with the delay', () => {
    const [n] = settingsNotices(cash(), cash((s) => (s.spectators.seeAllCards = true)), 'Ann', false);
    expect(n.loud).toBe(true);
    expect(n.text).toMatch(/^⚠️ Ann turned on spectators seeing hole cards\. .*live, with no delay\./);
  });

  it('counts allowing watching again as turning it on', () => {
    const before = cash((s) => {
      s.spectators.seeAllCards = true;
      s.spectators.allowed = false;
    });
    const after = cash((s) => (s.spectators.seeAllCards = true));
    expect(settingsNotices(before, after, 'Ann', false).map((n) => n.loud)).toEqual([true]);
  });

  it('says so when it goes off, and when only watching changes', () => {
    const on = cash((s) => (s.spectators.seeAllCards = true));
    expect(settingsNotices(on, cash(), 'Ann', true)[0]).toEqual({ text: 'Ann turned off spectators seeing hole cards. Spectators see only what players show.', loud: true });
    expect(settingsNotices(cash(), cash((s) => (s.spectators.allowed = false)), 'Ann', true)).toEqual([
      { text: 'Ann turned watching off: only seated players see the game.', loud: false },
    ]);
  });

  it('is loud about a shorter delay only while spectators see the cards', () => {
    const seeing = (d: number) => cash((s) => ((s.spectators.seeAllCards = true), (s.spectators.delaySeconds = d)));
    expect(settingsNotices(seeing(120), seeing(0), 'Ann', false)[0].loud).toBe(true);
    expect(settingsNotices(seeing(0), seeing(120), 'Ann', false)[0].loud).toBe(false);
    const plain = (d: number) => cash((s) => (s.spectators.delaySeconds = d));
    expect(settingsNotices(plain(120), plain(0), 'Ann', false)).toEqual([{ text: 'Ann set spectators to watch live, with no delay (it was 2 minutes behind).', loud: false }]);
  });

  it('never lets a change go by silently', () => {
    const notes = settingsNotices(cash(), cash((s) => ((s.stakes.bigBlind = 4), (s.timing.decisionSeconds = 45), (s.table.name = 'X'))), 'Ann', true);
    expect(notes).toEqual([{ text: 'Ann changed the table settings: table, stakes, clocks (from the next hand).', loud: false }]);
    expect(settingsNotices(cash(), cash(), 'Ann', true)).toEqual([]);
  });

  it('names delays plainly', () => {
    expect([delayText(1), delayText(45), delayText(60), delayText(90), delayText(600)]).toEqual(['1 second', '45 seconds', '1 minute', '1 min 30 s', '10 minutes']);
  });
});

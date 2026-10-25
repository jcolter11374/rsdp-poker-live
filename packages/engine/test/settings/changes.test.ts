import { describe, expect, it } from 'vitest';
import {
  IMMEDIATE_FIELDS,
  SettingsError,
  applyAtNextHand,
  applyImmediate,
  defaultSettings,
  diffSettings,
  isImmediateField,
  mergePatches,
  type SettingsPatch,
  type TableSettings,
} from '../../src/settings';
import { pathsOf, withField } from './helpers';

const cash = () => defaultSettings('cash');
const level = (smallBlind: number, bigBlind: number) => ({ smallBlind, bigBlind, ante: 0, minutes: 15, hands: 20 });

describe('diffSettings', () => {
  it('is empty for equal settings', () => {
    expect(diffSettings(cash(), cash())).toEqual([]);
  });

  it('lists each changed leaf with its path, in settings order', () => {
    const b = cash();
    b.timing.decisionSeconds = 45;
    b.stakes.smallBlind = 2;
    b.stakes.bigBlind = 5;
    b.chat.guestChat = false;
    expect(diffSettings(cash(), b)).toEqual([
      { path: 'stakes.smallBlind', from: 1, to: 2 },
      { path: 'stakes.bigBlind', from: 2, to: 5 },
      { path: 'timing.decisionSeconds', from: 30, to: 45 },
      { path: 'chat.guestChat', from: true, to: false },
    ]);
  });

  it('compares array items by index and reports added and removed items whole', () => {
    const a = withField(cash(), 'blindSchedule.levels', [level(1, 2), level(2, 4)]);
    const b = withField(cash(), 'blindSchedule.levels', [level(1, 2), level(3, 6), level(5, 10)]);
    expect(diffSettings(a, b)).toEqual([
      { path: 'blindSchedule.levels[1].smallBlind', from: 2, to: 3 },
      { path: 'blindSchedule.levels[1].bigBlind', from: 4, to: 6 },
      { path: 'blindSchedule.levels[2]', from: undefined, to: level(5, 10) },
    ]);
    expect(diffSettings(b, a).at(-1)).toEqual({ path: 'blindSchedule.levels[2]', from: level(5, 10), to: undefined });
  });

  it('reports a section that appears or disappears as one change', () => {
    const b = withField(cash(), 'modifiers', { 'bomb-pot': { enabled: true, every: 10 } });
    expect(diffSettings(cash(), b)).toEqual([
      { path: 'modifiers.bomb-pot', from: undefined, to: { enabled: true, every: 10 } },
    ]);
  });

  it('does not mutate its inputs', () => {
    const a = cash();
    const b = withField(cash(), 'table.maxSeats', 6);
    const before = structuredClone([a, b]);
    diffSettings(a, b);
    expect([a, b]).toEqual(before);
  });
});

describe('mergePatches', () => {
  it('lets the later edit win and merges the rest', () => {
    const merged = mergePatches(
      { stakes: { smallBlind: 5, bigBlind: 10 }, chat: { guestChat: false } },
      { stakes: { bigBlind: 20 }, timing: { decisionSeconds: 60 } },
    );
    expect(merged).toEqual({
      stakes: { smallBlind: 5, bigBlind: 20 },
      chat: { guestChat: false },
      timing: { decisionSeconds: 60 },
    });
  });

  it('replaces arrays whole', () => {
    const merged = mergePatches(
      { blindSchedule: { levels: [level(1, 2), level(2, 4)] } },
      { blindSchedule: { levels: [level(5, 10)] } },
    );
    expect(merged.blindSchedule?.levels).toEqual([level(5, 10)]);
  });
});

describe('applyAtNextHand', () => {
  it('merges the queued edit, validates it and returns the diff', () => {
    const current = cash();
    const { settings, diff } = applyAtNextHand(current, { stakes: { smallBlind: 5, bigBlind: 10 }, table: { maxSeats: 6 } });
    expect(settings.stakes).toMatchObject({ smallBlind: 5, bigBlind: 10, ante: 0 });
    expect(settings.table).toEqual({ ...current.table, maxSeats: 6 });
    expect(diff).toEqual([
      { path: 'table.maxSeats', from: 10, to: 6 },
      { path: 'stakes.smallBlind', from: 1, to: 5 },
      { path: 'stakes.bigBlind', from: 2, to: 10 },
    ]);
    expect(current).toEqual(cash());
  });

  it('is a no-op for a null or empty edit', () => {
    const current = cash();
    expect(applyAtNextHand(current, null)).toEqual({ settings: current, diff: [] });
    expect(applyAtNextHand(current, {})).toEqual({ settings: current, diff: [] });
  });

  it('replaces arrays in the edit whole', () => {
    const current = withFields({ 'blindSchedule.enabled': true, 'blindSchedule.levels': [level(1, 2), level(2, 4)] });
    const { settings } = applyAtNextHand(current, { blindSchedule: { levels: [level(10, 20)] } });
    expect(settings.blindSchedule.levels).toEqual([level(10, 20)]);
  });

  it('rejects an edit that makes the settings invalid, naming the fields', () => {
    const current = cash();
    expect(() => applyAtNextHand(current, { stakes: { smallBlind: 50 } })).toThrow(SettingsError);
    expect(pathsOf(() => applyAtNextHand(current, { stakes: { smallBlind: 50 }, timing: { showdownSeconds: 4 as 3 } }))).toEqual([
      'stakes.smallBlind',
      'timing.showdownSeconds',
    ]);
    expect(current).toEqual(cash());
  });

  it('rejects unknown keys in an edit, including __proto__, without touching any prototype', () => {
    const edit = JSON.parse('{"__proto__": {"polluted": true}, "stakes": {"__proto__": {"bigBlind": 1}}}') as SettingsPatch;
    expect(pathsOf(() => applyAtNextHand(cash(), edit))).toEqual(['stakes.__proto__', '__proto__']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('rejects an edit that is not an object', () => {
    expect(pathsOf(() => applyAtNextHand(cash(), 'stakes' as SettingsPatch))).toEqual(['(root)']);
  });
});

describe('immediate fields', () => {
  it('names real settings paths', () => {
    const s = cash() as unknown as Record<string, Record<string, unknown>>;
    for (const path of IMMEDIATE_FIELDS) {
      const [section, field] = path.split('.');
      expect(s[section], path).toBeDefined();
      if (field) expect(Object.hasOwn(s[section], field), path).toBe(true);
    }
  });

  it('matches whole fields and sections only', () => {
    expect(isImmediateField('chat')).toBe(true);
    expect(isImmediateField('chat.guestChat')).toBe(true);
    expect(isImmediateField('table.name')).toBe(true);
    expect(isImmediateField('spectators.allowed')).toBe(true);
    expect(isImmediateField('seating.requireApproval')).toBe(true);
    expect(isImmediateField('chatter')).toBe(false);
    expect(isImmediateField('table.maxSeats')).toBe(false);
    expect(isImmediateField('spectators.seeAllCards')).toBe(false);
    expect(isImmediateField('spectators.delaySeconds')).toBe(false);
    expect(isImmediateField('stakes.bigBlind')).toBe(false);
    expect(isImmediateField('timing.decisionSeconds')).toBe(false);
    expect(isImmediateField('seating.dealToAway')).toBe(false);
    expect(isImmediateField('play.runItTwice')).toBe(false);
    expect(isImmediateField('modifiers.bomb-pot.enabled')).toBe(false);
  });
});

describe('applyImmediate', () => {
  it('applies immediate fields now and queues the rest', () => {
    const current = cash();
    const edit: SettingsPatch = {
      table: { name: 'Late game', maxSeats: 6 },
      chat: { guestChat: false },
      spectators: { allowed: false, seeAllCards: true },
      stakes: { bigBlind: 4 },
    };
    const now = applyImmediate(current, edit);
    expect(now.settings.table).toEqual({ name: 'Late game', maxSeats: 10, mode: 'cash' });
    expect(now.settings.chat.guestChat).toBe(false);
    expect(now.settings.spectators).toEqual({ allowed: false, seeAllCards: false, delaySeconds: 0 });
    expect(now.settings.stakes.bigBlind).toBe(2);
    expect(now.diff.map((c) => c.path)).toEqual(['table.name', 'chat.guestChat', 'spectators.allowed']);
    expect(now.deferred).toEqual({ table: { maxSeats: 6 }, spectators: { seeAllCards: true }, stakes: { bigBlind: 4 } });

    const next = applyAtNextHand(now.settings, now.deferred);
    expect(next.settings).toEqual(applyAtNextHand(current, edit).settings);
    expect(next.diff.map((c) => c.path)).toEqual(['table.maxSeats', 'stakes.bigBlind', 'spectators.seeAllCards']);
  });

  it('queues nothing when the edit is all immediate', () => {
    const r = applyImmediate(cash(), { chat: { profanityFilter: true }, seating: { minBuyIn: 100, maxBuyIn: 400 } });
    expect(r.deferred).toBeNull();
    expect(r.settings.seating).toMatchObject({ minBuyIn: 100, maxBuyIn: 400 });
  });

  it('queues nothing when the next-hand part changes nothing', () => {
    const r = applyImmediate(cash(), { chat: { guestChat: false }, stakes: { bigBlind: 2 } });
    expect(r.deferred).toBeNull();
    expect(r.diff).toEqual([{ path: 'chat.guestChat', from: true, to: false }]);
  });

  it('applies nothing when any part of the edit is invalid', () => {
    const current = cash();
    expect(pathsOf(() => applyImmediate(current, { chat: { guestChat: false }, stakes: { smallBlind: 9 } }))).toEqual([
      'stakes.smallBlind',
    ]);
    expect(current).toEqual(cash());
  });

  it('validates a new edit together with the queued one', () => {
    const first = applyImmediate(cash(), { stakes: { smallBlind: 5, bigBlind: 10 } });
    expect(first.deferred).toEqual({ stakes: { smallBlind: 5, bigBlind: 10 } });

    const bad = mergePatches(first.deferred!, { stakes: { smallBlind: 20 } });
    expect(pathsOf(() => applyImmediate(first.settings, bad))).toEqual(['stakes.smallBlind']);

    const second = applyImmediate(first.settings, mergePatches(first.deferred!, { stakes: { bigBlind: 20 }, chat: { guestChat: false } }));
    expect(second.settings.chat.guestChat).toBe(false);
    expect(second.deferred).toEqual({ stakes: { smallBlind: 5, bigBlind: 20 } });
    expect(applyAtNextHand(second.settings, second.deferred).settings.stakes).toMatchObject({ smallBlind: 5, bigBlind: 20 });
  });

  it('is a no-op for null', () => {
    const current = cash();
    expect(applyImmediate(current, null)).toEqual({ settings: current, diff: [], deferred: null });
  });
});

function withFields(fields: Record<string, unknown>): TableSettings {
  return Object.entries(fields).reduce((s, [path, value]) => withField(s, path, value), cash());
}

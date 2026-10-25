import { describe, expect, it } from 'vitest';
import { SETTINGS_VERSION, defaultSettings, migrateSettings, type TableSettings } from '../../src/settings';
import { issuesOf, pathsOf } from './helpers';

const cash = () => defaultSettings('cash');

/** Runs migrateSettings and also returns what it reported as dropped. */
function migrate(raw: unknown): { settings: TableSettings; dropped: string[] } {
  const dropped: string[] = [];
  const settings = migrateSettings(raw, { onDropped: (paths) => dropped.push(...paths) });
  return { settings, dropped };
}

describe('migrateSettings', () => {
  it('gives cash defaults for nothing stored', () => {
    expect(migrateSettings(undefined)).toEqual(cash());
    expect(migrateSettings(null)).toEqual(cash());
    expect(migrateSettings({})).toEqual(cash());
  });

  it('leaves current settings unchanged and is idempotent', () => {
    const s = cash();
    s.stakes.bigBlind = 50;
    s.stakes.smallBlind = 25;
    s.blindSchedule.levels = [{ smallBlind: 1, bigBlind: 2, ante: 0, minutes: 10, hands: 12 }];
    const once = migrateSettings(JSON.parse(JSON.stringify(s)));
    expect(once).toEqual(s);
    expect(migrateSettings(once)).toEqual(once);
    expect(migrateSettings(defaultSettings('tournament'))).toEqual(defaultSettings('tournament'));
  });

  it('upgrades the MVP flat room config (version 0)', () => {
    const { settings, dropped } = migrate({ smallBlind: 5, bigBlind: 10, turnSeconds: 20, maxSeats: 9 });
    expect(settings.version).toBe(SETTINGS_VERSION);
    expect(settings.stakes).toMatchObject({ smallBlind: 5, bigBlind: 10 });
    expect(settings.timing.decisionSeconds).toBe(20);
    expect(settings.table.maxSeats).toBe(9);
    expect(settings.play).toEqual(cash().play);
    expect(dropped).toEqual([]);
  });

  it('moves MVP clocks into the new range', () => {
    const clock = (turnSeconds: number) => migrateSettings({ turnSeconds }).timing.decisionSeconds;
    expect(clock(0)).toBe(0);
    expect(clock(1)).toBe(5);
    expect(clock(4.9)).toBe(5);
    expect(clock(20.7)).toBe(20);
    expect(clock(600)).toBe(600);
    expect(clock(900)).toBe(600);
  });

  it('prefers a nested section over the MVP flat key', () => {
    const settings = migrateSettings({ bigBlind: 10, stakes: { smallBlind: 2, bigBlind: 4 } });
    expect(settings.stakes).toMatchObject({ smallBlind: 2, bigBlind: 4 });
  });

  it('fills missing sections and fields from defaults', () => {
    const settings = migrateSettings({ version: 1, stakes: { smallBlind: 5, bigBlind: 10 }, chat: {} });
    expect(settings).toEqual({ ...cash(), stakes: { ...cash().stakes, smallBlind: 5, bigBlind: 10 } });
  });

  it('fills with the defaults of the stored mode', () => {
    const settings = migrateSettings({ version: 1, table: { mode: 'tournament', name: 'Final table' } });
    expect(settings.table).toEqual({ name: 'Final table', maxSeats: 10, mode: 'tournament', felt: 'green' });
    expect(settings.play.runItTwice).toBe('off');
    expect(settings.seating.dealToAway).toBe(true);
  });

  it('fills missing fields inside blind levels and rotation steps', () => {
    const settings = migrateSettings({
      version: 1,
      blindSchedule: { enabled: true, levels: [{ smallBlind: 1, bigBlind: 2 }, { smallBlind: 2, bigBlind: 4, minutes: 30 }] },
      game: { rotation: { enabled: true, steps: [{ gameId: 'plo', betting: 'pot-limit', length: 2 }] } },
    });
    expect(settings.blindSchedule.levels).toEqual([
      { smallBlind: 1, bigBlind: 2, ante: 0, minutes: 15, hands: 20 },
      { smallBlind: 2, bigBlind: 4, ante: 0, minutes: 30, hands: 20 },
    ]);
    expect(settings.game.rotation.steps).toEqual([{ gameId: 'plo', betting: 'pot-limit', length: 2, unit: 'hands' }]);
  });

  it('does not guess the blinds of a level', () => {
    expect(issuesOf(() => migrateSettings({ version: 1, blindSchedule: { levels: [{ smallBlind: 1 }] } }))).toEqual([
      { path: 'blindSchedule.levels[0].bigBlind', message: 'required' },
    ]);
  });

  it('drops unknown fields everywhere and reports them', () => {
    const { settings, dropped } = migrate({
      version: 1,
      theme: 'dark',
      stakes: { smallBlind: 1, bigBlind: 2, straddleAmount: 4 },
      blindSchedule: { levels: [{ smallBlind: 1, bigBlind: 2, colour: 'red' }] },
      game: { rotation: { steps: [], shuffle: true } },
    });
    expect(settings.stakes).toEqual(cash().stakes);
    expect(dropped.sort()).toEqual(['blindSchedule.levels[0].colour', 'game.rotation.shuffle', 'stakes.straddleAmount', 'theme']);
    expect(JSON.stringify(settings)).not.toMatch(/theme|straddleAmount|colour|shuffle/);
  });

  it('drops the MVP flat keys from current-version data', () => {
    const { settings, dropped } = migrate({ version: 1, bigBlind: 10, turnSeconds: 3 });
    expect(settings.stakes.bigBlind).toBe(2);
    expect(dropped).toEqual(['bigBlind', 'turnSeconds']);
  });

  it('does not report anything when nothing was dropped', () => {
    let called = false;
    migrateSettings(cash(), { onDropped: () => (called = true) });
    expect(called).toBe(false);
  });

  it('throws for present but invalid values instead of guessing', () => {
    expect(pathsOf(() => migrateSettings({ version: 1, timing: { decisionSeconds: 2 } }))).toEqual(['timing.decisionSeconds']);
    expect(pathsOf(() => migrateSettings({ version: 1, stakes: 'cheap' }))).toEqual(['stakes']);
    expect(pathsOf(() => migrateSettings({ version: 1, table: { mode: 'ring' } }))).toEqual(['table.mode']);
    expect(pathsOf(() => migrateSettings({ version: 1, blindSchedule: { levels: 'many' } }))).toEqual(['blindSchedule.levels']);
    expect(pathsOf(() => migrateSettings({ version: 1, table: { mode: 'tournament' }, play: { runItTwice: 'ask' } }))).toEqual([
      'play.runItTwice',
    ]);
  });

  it('rejects versions it cannot read', () => {
    expect(issuesOf(() => migrateSettings({ version: SETTINGS_VERSION + 1 }))).toEqual([
      { path: 'version', message: `${SETTINGS_VERSION + 1} is newer than this build supports (${SETTINGS_VERSION})` },
    ]);
    for (const version of [-1, 1.5, '1', true]) {
      expect(pathsOf(() => migrateSettings({ version }))).toEqual(['version']);
    }
  });

  it('rejects stored data that is not an object', () => {
    for (const raw of ['{}', 42, [], true]) {
      expect(pathsOf(() => migrateSettings(raw))).toEqual(['(root)']);
    }
  });

  it('does not mutate what it was given', () => {
    const raw = { smallBlind: 5, bigBlind: 10, stakes: { ante: 0 }, blindSchedule: { levels: [{ smallBlind: 1, bigBlind: 2 }] } };
    const before = structuredClone(raw);
    migrateSettings(raw);
    expect(raw).toEqual(before);
  });

  it('ignores __proto__ keys in stored JSON', () => {
    const raw = JSON.parse('{"version": 1, "__proto__": {"polluted": true}, "stakes": {"__proto__": {"x": 1}}}');
    const { settings, dropped } = migrate(raw);
    expect(settings).toEqual(cash());
    expect(dropped.sort()).toEqual(['__proto__', 'stakes.__proto__']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

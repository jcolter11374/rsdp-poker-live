import { describe, expect, it } from 'vitest';
import {
  PRESET_FORMAT,
  PRESET_VERSION,
  SettingsError,
  defaultSettings,
  exportPreset,
  importPreset,
  type TableSettings,
} from '../../src/settings';
import { issuesOf, pathsOf } from './helpers';

function friday(): TableSettings {
  const s = defaultSettings('cash');
  s.table.name = 'Friday PLO';
  s.game.betting = 'pot-limit';
  s.game.gameId = 'plo';
  s.stakes = { ...s.stakes, smallBlind: 25, bigBlind: 50, centsMode: true };
  s.blindSchedule = {
    enabled: true,
    countdown: 'hands',
    levels: [
      { smallBlind: 25, bigBlind: 50, ante: 0, minutes: 20, hands: 30 },
      { smallBlind: 50, bigBlind: 100, ante: 0, minutes: 20, hands: 30 },
    ],
  };
  s.play.runItTwice = 'always';
  return s;
}

const wrap = (fields: Record<string, unknown>) =>
  JSON.stringify({ format: PRESET_FORMAT, version: PRESET_VERSION, name: 'P', settings: defaultSettings('cash'), ...fields });

describe('presets', () => {
  it('round trip settings and name', () => {
    const settings = friday();
    const json = exportPreset(settings, '  Friday night PLO  ');
    expect(importPreset(json)).toEqual({ name: 'Friday night PLO', settings });
  });

  it('round trip tournament settings', () => {
    const settings = defaultSettings('tournament');
    expect(importPreset(exportPreset(settings, 'MTT')).settings).toEqual(settings);
  });

  it('carry a format tag and version, and settings with their own version', () => {
    const data = JSON.parse(exportPreset(friday(), 'Friday'));
    expect(data).toMatchObject({ format: 'rsdp-table-preset', version: 1, name: 'Friday' });
    expect(data.settings.version).toBe(1);
    expect(exportPreset(friday(), 'Friday')).toContain('\n  "format"');
  });

  it('refuse to export invalid settings or names', () => {
    const bad = friday();
    bad.stakes.smallBlind = 500;
    expect(pathsOf(() => exportPreset(bad, 'Bad'))).toEqual(['stakes.smallBlind']);
    expect(pathsOf(() => exportPreset(friday(), '   '))).toEqual(['name']);
    expect(pathsOf(() => exportPreset(friday(), 'x'.repeat(61)))).toEqual(['name']);
    expect(() => exportPreset(friday(), 'x'.repeat(60))).not.toThrow();
  });

  it('reject files that are not presets', () => {
    expect(issuesOf(() => importPreset('{not json'))).toEqual([{ path: '(root)', message: 'not valid JSON' }]);
    expect(pathsOf(() => importPreset('[]'))).toEqual(['(root)']);
    expect(pathsOf(() => importPreset('null'))).toEqual(['(root)']);
    expect(pathsOf(() => importPreset(JSON.stringify(defaultSettings('cash'))))).toEqual(['format']);
    expect(pathsOf(() => importPreset(wrap({ format: 'other-app-preset' })))).toEqual(['format']);
    expect(pathsOf(() => importPreset(42 as unknown as string))).toEqual(['(root)']);
  });

  it('reject preset versions it cannot read', () => {
    expect(issuesOf(() => importPreset(wrap({ version: PRESET_VERSION + 1 })))).toEqual([
      { path: 'version', message: `${PRESET_VERSION + 1} is newer than this build supports (${PRESET_VERSION})` },
    ]);
    for (const version of [0, 1.5, '1', undefined]) expect(pathsOf(() => importPreset(wrap({ version })))).toEqual(['version']);
  });

  it('need a valid name and settings', () => {
    expect(issuesOf(() => importPreset(wrap({ name: undefined })))).toEqual([{ path: 'name', message: 'required' }]);
    expect(pathsOf(() => importPreset(wrap({ name: 'tab\there' })))).toEqual(['name']);
    expect(issuesOf(() => importPreset(wrap({ settings: undefined })))).toEqual([{ path: 'settings', message: 'required' }]);
    expect(pathsOf(() => importPreset(wrap({ settings: 'cash' })))).toEqual(['settings']);
  });

  it('name the bad settings field under settings', () => {
    const settings = { ...defaultSettings('cash'), stakes: { ...defaultSettings('cash').stakes, smallBlind: 9 } };
    let error: unknown;
    try {
      importPreset(wrap({ settings }));
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(SettingsError);
    expect((error as SettingsError).issues).toEqual([{ path: 'settings.stakes.smallBlind', message: 'must not exceed the big blind (2)' }]);
    expect((error as Error).message).toMatch(/^Invalid preset:\n- settings\.stakes\.smallBlind: /);
  });

  it('migrate settings saved by older builds and drop unknown fields', () => {
    const { settings } = importPreset(wrap({ settings: { smallBlind: 10, bigBlind: 20, turnSeconds: 2, sparkles: true } }));
    expect(settings.stakes).toMatchObject({ smallBlind: 10, bigBlind: 20 });
    expect(settings.timing.decisionSeconds).toBe(5);
    expect(JSON.stringify(settings)).not.toContain('sparkles');
  });

  it('reject oversized files', () => {
    const huge = wrap({ padding: 'x'.repeat(300 * 1024) });
    expect(pathsOf(() => importPreset(huge))).toEqual(['(root)']);
  });
});

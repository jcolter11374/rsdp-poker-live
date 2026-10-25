import { afterEach, describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import {
  applyAtNextHand,
  defaultSettings,
  diffSettings,
  enabledModifiers,
  exportPreset,
  getModifierSchema,
  importPreset,
  listModifierSchemas,
  migrateSettings,
  parseSettings,
  registerModifierSchema,
  unregisterModifierSchema,
} from '../../src/settings';
import { issuesOf, pathsOf, withField } from './helpers';

const BombPot = z
  .object({
    enabled: z.boolean(),
    /** A bomb pot every N hands. */
    everyHands: z.number().int().min(1).max(100),
    /** Big blinds each player posts. */
    anteBigBlinds: z.number().int().min(1).max(20),
  })
  .strict();

const Bounty = z.object({ enabled: z.boolean(), amount: z.number().int().min(1) });

function registerBombPot() {
  return registerModifierSchema('bomb-pot', BombPot, { enabled: false, everyHands: 10, anteBigBlinds: 2 });
}

function registerBounty() {
  return registerModifierSchema('bounty-72', Bounty, { enabled: false, amount: 5 }, { cashOnly: true });
}

afterEach(() => {
  for (const entry of listModifierSchemas()) unregisterModifierSchema(entry.id);
});

describe('registerModifierSchema', () => {
  it('adds the section to defaults and returns a typed handle', () => {
    const bombPot = registerBombPot();
    const s = defaultSettings('cash');
    expect(s.modifiers).toEqual({ 'bomb-pot': { enabled: false, everyHands: 10, anteBigBlinds: 2 } });
    expect(parseSettings(s)).toEqual(s);
    expect(bombPot.get(s)).toEqual({ enabled: false, everyHands: 10, anteBigBlinds: 2 });
    expectTypeOf(bombPot.get(s)).toEqualTypeOf<{ enabled: boolean; everyHands: number; anteBigBlinds: number }>();
    expect(bombPot.cashOnly).toBe(false);
    expect(getModifierSchema('bomb-pot')).toBe(bombPot);
  });

  it('hands out copies of the defaults', () => {
    const bombPot = registerBombPot();
    bombPot.defaults().everyHands = 99;
    defaultSettings('cash').modifiers['bomb-pot'] = null;
    expect(bombPot.defaults().everyHands).toBe(10);
    expect(defaultSettings('cash').modifiers['bomb-pot']).toEqual(bombPot.defaults());
  });

  it('reads defaults back for settings made before it registered', () => {
    const old = defaultSettings('cash');
    const bombPot = registerBombPot();
    expect(old.modifiers).toEqual({});
    expect(bombPot.get(old)).toEqual(bombPot.defaults());
  });

  it('rejects bad ids', () => {
    for (const id of ['', 'Bomb', 'bomb_pot', 'bomb.pot', '-bomb', 'x'.repeat(41), '__proto__']) {
      expect(() => registerModifierSchema(id, Bounty, { enabled: false, amount: 1 }), id).toThrow(/modifier id/);
    }
    expect(() => registerModifierSchema('x'.repeat(40), Bounty, { enabled: false, amount: 1 })).not.toThrow();
  });

  it('rejects defaults that do not parse, or that are switched on', () => {
    expect(() => registerModifierSchema('bounty-72', Bounty, { enabled: false, amount: 0 })).toThrow(
      /defaults do not match its schema: amount: must be at least 1/,
    );
    expect(() => registerModifierSchema('bounty-72', Bounty, { enabled: true, amount: 5 })).toThrow(/enabled: false/);
    expect(getModifierSchema('bounty-72')).toBeUndefined();
  });

  it('supports schemas that fill their own defaults', () => {
    const Nit = z.object({ enabled: z.boolean().default(false), escrow: z.number().int().min(0).default(10) });
    const nit = registerModifierSchema('nit', Nit, {});
    expect(nit.defaults()).toEqual({ enabled: false, escrow: 10 });
    const s = parseSettings(withField(defaultSettings('cash'), 'modifiers', { nit: { enabled: true } }));
    expect(nit.get(s)).toEqual({ enabled: true, escrow: 10 });
  });

  it('replaces an earlier registration of the same id (hot reload)', () => {
    registerBombPot();
    const v2 = registerModifierSchema('bomb-pot', z.object({ enabled: z.boolean(), doubleBoard: z.boolean() }), {
      enabled: false,
      doubleBoard: true,
    });
    expect(listModifierSchemas()).toEqual([v2]);
    expect(defaultSettings('cash').modifiers['bomb-pot']).toEqual({ enabled: false, doubleBoard: true });
  });

  it('can be unregistered', () => {
    registerBombPot();
    expect(unregisterModifierSchema('bomb-pot')).toBe(true);
    expect(unregisterModifierSchema('bomb-pot')).toBe(false);
    expect(defaultSettings('cash').modifiers).toEqual({});
  });

  it('lists registrations in order', () => {
    const a = registerBounty();
    const b = registerBombPot();
    expect(listModifierSchemas()).toEqual([a, b]);
  });
});

describe('modifier validation', () => {
  it('validates each registered section with its schema, at modifiers.<id> paths', () => {
    registerBombPot();
    const s = withField(defaultSettings('cash'), 'modifiers.bomb-pot', { enabled: true, everyHands: 0, anteBigBlinds: 2, x: 1 });
    expect(issuesOf(() => parseSettings(s))).toEqual([
      { path: 'modifiers.bomb-pot.everyHands', message: 'must be at least 1' },
      { path: 'modifiers.bomb-pot.x', message: 'unknown field' },
    ]);
    expect(pathsOf(() => parseSettings(withField(defaultSettings('cash'), 'modifiers.bomb-pot', 'on')))).toEqual(['modifiers.bomb-pot']);
  });

  it('rejects unregistered ids', () => {
    registerBombPot();
    const s = withField(defaultSettings('cash'), 'modifiers.bombpot', { enabled: true });
    expect(issuesOf(() => parseSettings(s))).toEqual([{ path: 'modifiers.bombpot', message: 'unknown modifier (not registered)' }]);
  });

  it('fills registered sections missing from the input', () => {
    registerBombPot();
    registerBounty();
    const s = withField(defaultSettings('cash'), 'modifiers', { 'bomb-pot': { enabled: true, everyHands: 5, anteBigBlinds: 1 } });
    expect(parseSettings(s).modifiers).toEqual({
      'bomb-pot': { enabled: true, everyHands: 5, anteBigBlinds: 1 },
      'bounty-72': { enabled: false, amount: 5 },
    });
  });

  it('reports modifier errors alongside core field errors', () => {
    registerBombPot();
    const s = withField(withField(defaultSettings('cash'), 'modifiers.bomb-pot.everyHands', 500), 'table.maxSeats', 1);
    expect(pathsOf(() => parseSettings(s))).toEqual(['table.maxSeats', 'modifiers.bomb-pot.everyHands']);
  });

  it('lists enabled modifiers in the HandInput shape', () => {
    registerBombPot();
    registerBounty();
    const s = parseSettings(withField(defaultSettings('cash'), 'modifiers.bounty-72', { enabled: true, amount: 3 }));
    expect(enabledModifiers(s)).toEqual([{ id: 'bounty-72', settings: { enabled: true, amount: 3 } }]);
    expect(enabledModifiers(defaultSettings('cash'))).toEqual([]);
  });
});

describe('tournament gate for cash-only modifiers', () => {
  it('rejects a cash-only modifier switched on in tournament mode', () => {
    registerBounty();
    const s = withField(defaultSettings('tournament'), 'modifiers.bounty-72.enabled', true);
    expect(issuesOf(() => parseSettings(s))).toEqual([
      { path: 'modifiers.bounty-72.enabled', message: 'cash games only: turn it off in tournament mode' },
    ]);
  });

  it('allows it in cash mode, or switched off in tournament mode', () => {
    registerBounty();
    expect(() => parseSettings(withField(defaultSettings('cash'), 'modifiers.bounty-72.enabled', true))).not.toThrow();
    expect(() => parseSettings(defaultSettings('tournament'))).not.toThrow();
  });

  it('does not gate modifiers that are not cash-only', () => {
    registerBombPot();
    expect(() => parseSettings(withField(defaultSettings('tournament'), 'modifiers.bomb-pot.enabled', true))).not.toThrow();
  });

  it('blocks switching to tournament mode while a cash-only modifier is on', () => {
    registerBounty();
    const current = parseSettings(withField(defaultSettings('cash'), 'modifiers.bounty-72.enabled', true));
    const edit = { table: { mode: 'tournament' as const }, play: { runItTwice: 'off' as const } };
    expect(pathsOf(() => applyAtNextHand(current, edit))).toEqual(['modifiers.bounty-72.enabled']);
    const ok = applyAtNextHand(current, { ...edit, modifiers: { 'bounty-72': { enabled: false } } });
    expect(ok.settings.table.mode).toBe('tournament');
  });
});

describe('modifiers through edits, migration and presets', () => {
  it('merges a partial section edit and diffs it', () => {
    const bombPot = registerBombPot();
    const current = defaultSettings('cash');
    const { settings, diff } = applyAtNextHand(current, { modifiers: { 'bomb-pot': { enabled: true } } });
    expect(bombPot.get(settings)).toEqual({ enabled: true, everyHands: 10, anteBigBlinds: 2 });
    expect(diff).toEqual([{ path: 'modifiers.bomb-pot.enabled', from: false, to: true }]);
    expect(diffSettings(settings, current)).toEqual([{ path: 'modifiers.bomb-pot.enabled', from: true, to: false }]);
  });

  it('migration fills registered sections, lays partial ones over defaults and drops unregistered ones', () => {
    registerBombPot();
    registerBounty();
    const dropped: string[] = [];
    const settings = migrateSettings(
      { version: 1, modifiers: { 'bomb-pot': { enabled: true, everyHands: 4 }, 'retired-feature': { enabled: true } } },
      { onDropped: (paths) => dropped.push(...paths) },
    );
    expect(settings.modifiers).toEqual({
      'bomb-pot': { enabled: true, everyHands: 4, anteBigBlinds: 2 },
      'bounty-72': { enabled: false, amount: 5 },
    });
    expect(dropped).toEqual(['modifiers.retired-feature']);
  });

  it('migration leaves unknown keys inside a section to the modifier schema', () => {
    registerBounty();
    const settings = migrateSettings({ version: 1, modifiers: { 'bounty-72': { enabled: true, amount: 2, legacy: 1 } } });
    expect(settings.modifiers['bounty-72']).toEqual({ enabled: true, amount: 2 });
    registerBombPot();
    expect(pathsOf(() => migrateSettings({ version: 1, modifiers: { 'bomb-pot': { legacy: 1 } } }))).toEqual([
      'modifiers.bomb-pot.legacy',
    ]);
  });

  it('presets round trip modifier sections', () => {
    registerBombPot();
    const settings = parseSettings(withField(defaultSettings('cash'), 'modifiers.bomb-pot.enabled', true));
    expect(importPreset(exportPreset(settings, 'Bombs away')).settings).toEqual(settings);
  });
});

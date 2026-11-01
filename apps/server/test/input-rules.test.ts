import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ActionError, variants } from '@rsdp/engine/core';
import '@rsdp/engine/modifiers';
import { defaultSettings, exportPreset, PRESET_FORMAT, SettingsError, type SettingsPatch, type TableSettings } from '@rsdp/engine/settings';
import { registerAllVariants } from '@rsdp/engine/variants';
import { closeDb, type Db } from '../src/db/client';
import { createTestDb, resetTestDb } from '../src/db/testing';
import { createAccount, IdentityError, resolveToken, setDisplayName, setPassword } from '../src/identity';
import { TableRuntime } from '../src/runtime/table';
import { cleanSetup, freeName } from '../src/savedSetups';
import { FakeClock, seeded } from './fake-clock';

/**
 * Pins what players and hosts are told when the server refuses what they
 * typed: settings edits, table presets and account details. A change here
 * is a change people will see.
 */

beforeAll(() => registerAllVariants(variants));

/** The message a call fails with, as the client would receive it, or "ok". */
function refusal(fn: () => unknown): string {
  try {
    fn();
    return 'ok';
  } catch (err) {
    if (err instanceof ActionError || err instanceof SettingsError) return `${err.constructor.name}: ${err.message}`;
    throw err;
  }
}

describe('settings the host sends', () => {
  const table = () => TableRuntime.create({ id: 't1', hostId: 'host', settings: defaultSettings('cash') }, { clock: new FakeClock(), rng: seeded() });
  const edit = (patch: unknown) => refusal(() => table().updateSettings('host', patch as SettingsPatch));

  it('refuses bad edits with the same wording', () => {
    expect(edit({ table: { maxSeats: 12 }, stakes: { ante: -1.5 } })).toBe(
      'ActionError: table.maxSeats: must be at most 10; stakes.ante: must be a whole number; must be at least 0',
    );
    expect(edit({ chat: { emoji: true } })).toBe('ActionError: chat.emoji: unknown field');
    expect(edit({ play: { straddle: 'mississippi' } })).toBe("ActionError: play.straddle: must be one of 'off', 'utg', 'utg-and-button'");
    expect(edit({ play: { straddle: 1 } })).toBe("ActionError: play.straddle: must be 'off' | 'utg' | 'utg-and-button', not number");
    expect(edit({ table: { name: '  ' } })).toBe('ActionError: table.name: must not be blank');
    expect(edit({ table: { name: null } })).toBe('ActionError: table.name: must be text, not null');
    expect(edit({ timing: { showdownSeconds: 5 } })).toBe('ActionError: timing.showdownSeconds: must be 3, 6 or 9');
    expect(edit({ timing: { decisionSeconds: 3 } })).toBe('ActionError: timing.decisionSeconds: must be 0 (no clock) or 5-600');
    expect(edit({ stakes: { smallBlind: 5 } })).toBe('ActionError: stakes.smallBlind: must not exceed the big blind (2)');
    expect(edit({ stakes: { bigBlind: 0, smallBlind: 0 } })).toBe('ActionError: stakes.bigBlind: must be at least 1 for no-limit and pot-limit games');
    expect(edit({ modifiers: { rake: { percent: 101 } } })).toBe('ActionError: modifiers.rake.percent: must be at most 100');
    expect(edit({ modifiers: { rake: { percent: 2.345 } } })).toBe('ActionError: modifiers.rake.percent: must have at most two decimals');
    expect(edit({ modifiers: { sparkles: { enabled: true } } })).toBe('ActionError: modifiers.sparkles: unknown modifier (not registered)');
    expect(edit({ blindSchedule: { enabled: true } })).toBe('ActionError: blindSchedule.levels: add at least one level');
    expect(edit({ seating: { minBuyIn: 500, maxBuyIn: 200 } })).toBe('ActionError: seating.minBuyIn: must not exceed the maximum buy-in (200)');
  });

  it('accepts good edits, filling nothing in', () => {
    const rt = table();
    rt.updateSettings('host', { table: { name: '  Friday  ' }, modifiers: { rake: { enabled: true, percent: 2.5 } } });
    expect(rt.state.settings.table.name).toBe('Friday');
    expect(rt.state.settings.modifiers.rake).toMatchObject({ enabled: true, percent: 2.5 });
  });

  it('refuses a new table with bad settings', () => {
    const settings = { ...defaultSettings('cash'), table: { ...defaultSettings('cash').table, maxSeats: 1 } } as TableSettings;
    expect(refusal(() => TableRuntime.create({ hostId: 'host', settings }))).toBe('SettingsError: Invalid table settings:\n- table.maxSeats: must be at least 2');
  });
});

describe('saved table presets', () => {
  const json = (fields: Record<string, unknown>) =>
    JSON.stringify({ format: PRESET_FORMAT, version: 1, name: 'Old', settings: defaultSettings('cash'), ...fields });
  const save = (name: string, text: string) => refusal(() => cleanSetup('table', { name, json: text }, 0));

  it('loads presets saved by older builds, under the new name', () => {
    const setup = cleanSetup('table', { name: 'Friday', json: json({ settings: { smallBlind: 5, bigBlind: 10, turnSeconds: 2, theme: 'dark' } }) }, 0);
    const saved = JSON.parse(setup.json) as { name: string; settings: TableSettings };
    expect(saved.name).toBe('Friday');
    expect(saved.settings.stakes).toMatchObject({ smallBlind: 5, bigBlind: 10 });
    expect(saved.settings.timing.decisionSeconds).toBe(5);
    expect(saved.settings.modifiers).toEqual(defaultSettings('cash').modifiers);
    expect(setup.json).toBe(exportPreset(saved.settings, 'Friday'));
  });

  it('refuses broken presets with the same wording', () => {
    expect(save('Friday', json({ settings: { version: 1, table: { maxSeats: 0 } } }))).toBe(
      'SettingsError: Invalid preset:\n- settings.table.maxSeats: must be at least 2',
    );
    expect(save('Friday', json({ settings: { version: 1, play: { straddle: 'button' } } }))).toBe(
      "SettingsError: Invalid preset:\n- settings.play.straddle: must be one of 'off', 'utg', 'utg-and-button'",
    );
    expect(save('Friday', json({ name: undefined }))).toBe('SettingsError: Invalid preset:\n- name: required');
    expect(save('Friday', json({ version: 2 }))).toBe('SettingsError: Invalid preset:\n- version: 2 is newer than this build supports (1)');
    expect(save('Friday', '{}')).toBe('SettingsError: Invalid preset:\n- format: must be "rsdp-table-preset"');
    expect(save('Bell\u0007', json({}))).toBe('ActionError: names cannot contain control characters');
  });

  it('counts a name the way the preset inside does, an emoji as two, so a name that passes is never refused as a preset', () => {
    expect(JSON.parse(cleanSetup('table', { name: '🂡'.repeat(30), json: json({}) }, 0).json).name).toBe('🂡'.repeat(30));
    expect(save('🂡'.repeat(31), json({}))).toBe('ActionError: names can be up to 60 characters');
    expect(save('🂡'.repeat(60), json({}))).toBe('ActionError: names can be up to 60 characters');
  });

  it('numbers a taken name within the limit, without splitting an emoji', () => {
    const name = '🂡'.repeat(30);
    const free = freeName(name, new Set([name]));
    expect(free).toBe(`${'🂡'.repeat(28)} (2)`);
    expect(JSON.parse(exportPreset(defaultSettings('cash'), free)).name).toBe(free);
    expect(freeName(`${'x'.repeat(59)}🂡`, new Set([`${'x'.repeat(59)}🂡`]))).toBe(`${'x'.repeat(56)} (2)`);
  });

  it('numbers a taken name without cutting a joined emoji (a family, a flag) apart', () => {
    const family = '👨\u200d👩\u200d👧';
    const name = `${'x'.repeat(50)}${family}`;
    expect(freeName(name, new Set([name]))).toBe(`${'x'.repeat(50)} (2)`);
    const flags = '🇳🇱'.repeat(15);
    expect(freeName(flags, new Set([flags]))).toBe(`${'🇳🇱'.repeat(14)} (2)`);
  });
});

describe('account details', () => {
  let db: Db;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await closeDb(db);
  });
  beforeEach(async () => {
    await resetTestDb(db);
  });

  /** The IdentityError code a call fails with, or what it returned. */
  async function result<T>(p: Promise<T>, pick: (value: T) => unknown = () => 'ok'): Promise<unknown> {
    try {
      return pick(await p);
    } catch (err) {
      if (err instanceof IdentityError) return `${err.code}: ${err.message}`;
      throw err;
    }
  }

  it('display names: trimmed and collapsed, 1 to 24 characters, no control characters', async () => {
    const player = await resolveToken(db, 'browser-secret-aaaaaaaaaaaaaaaa');
    const names: unknown[] = [
      'Ada',
      '  Ada   Lovelace ',
      'Ada\tLovelace',
      'Ada  Lovelace',
      'x'.repeat(24),
      'x'.repeat(25),
      ` ${'x'.repeat(24)} `,
      '🃏'.repeat(12),
      '🃏'.repeat(13),
      'Zoë',
      'zero​width',
      '',
      '   ',
      'bell\u0007',
      'next\u0085line',
      'del\u007f',
      42,
      null,
      undefined,
      ['Ada'],
    ];
    const outcomes: Record<string, unknown> = {};
    for (const name of names) {
      outcomes[JSON.stringify(name) ?? 'undefined'] = await result(setDisplayName(db, player.id, name as string), (p) => p.displayName);
    }
    const bad = 'invalid-name: names are 1 to 24 characters';
    expect(outcomes).toEqual({
      '"Ada"': 'Ada',
      '"  Ada   Lovelace "': 'Ada Lovelace',
      '"Ada\\tLovelace"': 'Ada Lovelace',
      [JSON.stringify('Ada\u00a0\u00a0Lovelace')]: 'Ada Lovelace',
      [JSON.stringify('x'.repeat(24))]: 'x'.repeat(24),
      [JSON.stringify('x'.repeat(25))]: bad,
      [JSON.stringify(` ${'x'.repeat(24)} `)]: 'x'.repeat(24),
      [JSON.stringify('🃏'.repeat(12))]: '🃏'.repeat(12),
      [JSON.stringify('🃏'.repeat(13))]: bad,
      '"Zoë"': 'Zoë',
      '"zero​width"': 'zero​width',
      '""': bad,
      '"   "': bad,
      '"bell\\u0007"': bad,
      '"next\u0085line"': bad,
      '"del\u007f"': bad,
      '42': bad,
      null: bad,
      undefined: bad,
      '["Ada"]': bad,
    });
  });

  it('usernames: 3 to 24 letters, digits, dots, dashes or underscores, not starting with a dot or dash', async () => {
    const outcomes: Record<string, unknown> = {};
    for (const username of ['abc', 'ab', 'x'.repeat(24), 'x'.repeat(25), '_ab', '.ab', '-ab', 'a.b-c_d', 'abc ', ' abc', 'ábc', 'ab\n', 42, null]) {
      // A valid username gets as far as looking up the player, which does not exist.
      outcomes[JSON.stringify(username)] = await result(createAccount(db, username as string, 'hunter2hunter2', 'missing'), () => 'created');
    }
    const bad = 'invalid-username: usernames are 3 to 24 letters, digits, dots, dashes or underscores';
    const fine = 'player-not-found: no such player';
    expect(outcomes).toEqual({
      '"abc"': fine,
      '"ab"': bad,
      [JSON.stringify('x'.repeat(24))]: fine,
      [JSON.stringify('x'.repeat(25))]: bad,
      '"_ab"': fine,
      '".ab"': bad,
      '"-ab"': bad,
      '"a.b-c_d"': fine,
      '"abc "': bad,
      '" abc"': bad,
      '"ábc"': bad,
      '"ab\\n"': bad,
      '42': bad,
      null: bad,
    });
  });

  it('passwords: 8 to 200 characters', async () => {
    const outcomes: Record<string, unknown> = {};
    for (const password of ['x'.repeat(7), 'x'.repeat(8), 'x'.repeat(200), 'x'.repeat(201), '🃏'.repeat(4), '🃏'.repeat(3) + 'x', ' '.repeat(8), 12345678, null]) {
      // A valid password gets as far as looking up the account, which does not exist.
      outcomes[JSON.stringify(password)] = await result(setPassword(db, 'missing', password as string));
    }
    const bad = 'weak-password: passwords are 8 to 200 characters';
    const fine = 'account-not-found: no such account';
    expect(outcomes).toEqual({
      [JSON.stringify('x'.repeat(7))]: bad,
      [JSON.stringify('x'.repeat(8))]: fine,
      [JSON.stringify('x'.repeat(200))]: fine,
      [JSON.stringify('x'.repeat(201))]: bad,
      [JSON.stringify('🃏'.repeat(4))]: fine,
      // Length counts UTF-16 code units, so an emoji is two.
      [JSON.stringify('🃏'.repeat(3) + 'x')]: bad,
      [JSON.stringify(' '.repeat(8))]: fine,
      '12345678': bad,
      null: bad,
    });
  });
});

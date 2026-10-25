import { describe, expect, it } from 'vitest';
import {
  apply,
  createTournament,
  defaultSettings,
  DirectorError,
  MAX_CHIPS,
  payoutPreset,
  presetStructure,
  validateStructure,
  type StructureRow,
  type TournamentSettings,
  type TournamentState,
} from '../src';

const MIN = 60_000;
const T0 = Date.parse('2026-10-30T00:00:00Z');

const levels: StructureRow[] = [
  { kind: 'level', sb: 50, bb: 100, ante: 0, anteType: 'none', minutes: 10, rebuy: true },
  { kind: 'break', minutes: 5, addOn: true },
  { kind: 'level', sb: 100, bb: 200, ante: 0, anteType: 'none', minutes: 10 },
];

/** Settings as a raw client could send them: any field may be missing or the wrong type. */
const settings = (overrides: Record<string, unknown> = {}) =>
  ({ ...defaultSettings({ structure: levels, startingStack: 1000 }), ...overrides }) as TournamentSettings;

const create = (overrides: Record<string, unknown> = {}) => createTournament({ id: 'T', hostId: 'host', settings: settings(overrides), now: T0, seed: 1 });

const update = (state: TournamentState, changes: Record<string, unknown>) =>
  apply(state, { type: 'updateSettings', by: 'host', settings: changes as Partial<TournamentSettings> }, T0).state;

/** The director's refusal, or null when it accepted. Anything other than a DirectorError fails the test. */
function refusal(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    expect(e).toBeInstanceOf(DirectorError);
    return (e as Error).message;
  }
}

/** What Postgres jsonb refuses: NUL and lone surrogates, which JSON.stringify writes as escapes. */
const storable = (value: unknown) => !/\\u0000|\\ud[89a-f][0-9a-f]{2}/i.test(JSON.stringify(value));

const scheduled = (extra: Record<string, unknown> = {}) => ({ kind: 'scheduled', startAt: T0 + 60 * MIN, ...extra });
const daily = { timeZone: 'America/New_York', startDate: '2026-10-29', time: '21:00', repeat: { freq: 'daily' } };

describe('numeric settings', () => {
  it.each([
    ['seatLeadSeconds', 'soon'],
    ['seatLeadSeconds', undefined],
    ['seatLeadSeconds', Number.NaN],
    ['seatLeadSeconds', 1.5],
    ['graceMinutes', 'x'],
    ['graceMinutes', undefined],
    ['graceMinutes', -1],
    ['seatsPerTable', '9'],
    ['maxEntrants', undefined],
    ['startingStack', MAX_CHIPS + 1],
    ['startingStack', 1e300],
    ['startingStack', 0.5],
  ])('refuses %s = %s', (key, value) => {
    expect(refusal(() => create({ start: scheduled(), [key]: value }))).not.toBeNull();
  });

  it('refuses a Sit & Go start delay that is not a whole number of seconds', () => {
    for (const startDelaySeconds of ['x', undefined, 2.5, -1])
      expect(refusal(() => create({ start: { kind: 'sng', playersNeeded: 2, startDelaySeconds, autoSpawn: false } }))).toMatch('Start delay');
  });

  it('refuses a start time a Date cannot hold, even through updateSettings', () => {
    expect(refusal(() => create({ start: scheduled({ startAt: 1e300 }) }))).toMatch('Pick a start time');
    const state = create({ start: scheduled({ schedule: daily }) });
    expect(refusal(() => update(state, { start: scheduled({ startAt: -1e300, schedule: daily }) }))).toMatch('Pick a start time');
  });

  it('accepts the largest stack and refuses more chips than that per entry', () => {
    const big = presetStructure('regular', { startingStack: MAX_CHIPS });
    expect(validateStructure(big).errors).toEqual([]);
    expect(big.at(-1)!.kind).toBe('level');
    expect(refusal(() => create({ startingStack: MAX_CHIPS, structure: big }))).toBeNull();
    const rebuys = big.map((r, i) => (i === 0 ? { ...r, rebuy: true } : r));
    expect(refusal(() => create({ startingStack: MAX_CHIPS, structure: rebuys, rebuy: { max: 1, chips: 1, approval: false, offerSeconds: 15 } }))).toMatch(
      'every rebuy and add-on',
    );
  });
});

describe('rebuy and add-on chips', () => {
  const rebuy = (chips: unknown, max: unknown = 3) => ({ rebuy: { max, chips, approval: false, offerSeconds: 15 } });
  const addOn = (chips: unknown, max: unknown = 1) => ({ addOn: { max, chips, approval: false } });

  it.each([0.5, 1e300, MAX_CHIPS + 1, 0, -100, '100', undefined])('refuses %s rebuy or add-on chips', (chips) => {
    expect(refusal(() => create(rebuy(chips)))).toMatch('Rebuy chips');
    expect(refusal(() => create(addOn(chips)))).toMatch('Add-on chips');
  });

  it('refuses counts that are not whole numbers', () => {
    for (const max of [1.5, -1, '2']) {
      expect(refusal(() => create(rebuy(100, max)))).not.toBeNull();
      expect(refusal(() => create(addOn(100, max)))).not.toBeNull();
    }
  });

  it('ignores the chip amount while rebuys and add-ons are off', () => {
    expect(refusal(() => create({ ...rebuy(0.5, 0), ...addOn(0.5, 0) }))).toBeNull();
  });

  it('refuses fractional chips through updateSettings too', () => {
    const state = create(rebuy(100));
    expect(refusal(() => update(state, rebuy(0.5)))).toMatch('Rebuy chips');
    expect(refusal(() => update(state, addOn(1e300)))).toMatch('Add-on chips');
  });
});

describe('late registration, re-entry, rotation and switches', () => {
  it('refuses missing late registration or re-entry settings', () => {
    expect(refusal(() => create({ lateRegistration: undefined }))).toMatch('lateRegistration');
    expect(refusal(() => create({ reEntry: undefined }))).toMatch('reEntry');
    expect(refusal(() => update(create(), { lateRegistration: null }))).toMatch('lateRegistration');
  });

  it.each([
    { lateRegistration: { enabled: 'yes', throughLevel: 2 } },
    { lateRegistration: { enabled: true, throughLevel: 0 } },
    { lateRegistration: { enabled: true, throughLevel: 1.5 } },
    { lateRegistration: { enabled: true, throughLevel: '3' } },
    { reEntry: { enabled: true, throughLevel: null, max: 0, approval: false } },
    { reEntry: { enabled: true, throughLevel: null, max: 2.5, approval: false } },
    { reEntry: { enabled: true, throughLevel: -1, max: null, approval: false } },
    { reEntry: { enabled: true, throughLevel: null, max: null, approval: 'no' } },
    { allowQuit: 'yes' },
    { registrationApproval: 1 },
  ])('refuses %o', (overrides) => {
    expect(refusal(() => create(overrides))).not.toBeNull();
  });

  it('accepts open-ended windows', () => {
    expect(refusal(() => create({ lateRegistration: { enabled: true, throughLevel: null } }))).toBeNull();
    expect(refusal(() => create({ reEntry: { enabled: true, throughLevel: 3, max: null, approval: true } }))).toBeNull();
  });

  it('accepts stopRotationAtLevel only when unset, null or a level number', () => {
    for (const ok of [undefined, null, 2]) expect(refusal(() => create({ games: ['nlhe', 'plo'], stopRotationAtLevel: ok }))).toBeNull();
    for (const bad of [0, 1.5, '2', -1]) expect(refusal(() => create({ games: ['nlhe', 'plo'], stopRotationAtLevel: bad }))).toMatch('Rotation');
  });

  it('refuses games that are not ids', () => {
    for (const games of [[''], ['nlhe', 5], 'nlhe', undefined]) expect(refusal(() => create({ games }))).toMatch('game');
  });
});

describe('schedules', () => {
  it('validates a schedule when one is set', () => {
    expect(refusal(() => create({ start: scheduled({ schedule: { ...daily, timeZone: 'Mars/Olympus' } }) }))).toMatch('Unknown time zone');
    expect(refusal(() => create({ start: scheduled({ schedule: { ...daily, startDate: '2026-02-30' } }) }))).toMatch('startDate');
    expect(refusal(() => create({ start: scheduled({ schedule: { ...daily, repeat: { freq: 'weekly' } } }) }))).toMatch('weekday');
    expect(refusal(() => create({ start: scheduled({ schedule: { ...daily, repeat: { freq: 'yearly' } } }) }))).toMatch('Repeat');
    expect(refusal(() => create({ start: scheduled({ schedule: { ...daily, repeat: { freq: 'monthly', nth: 2, weekday: 9 } } }) }))).toMatch('Weekdays');
    expect(refusal(() => create({ start: scheduled({ schedule: daily }) }))).toBeNull();
  });

  it('refuses an unknown start kind', () => {
    expect(refusal(() => create({ start: { kind: 'whenever' } }))).toMatch('starts');
  });
});

describe('free text', () => {
  it('strips NUL, control characters and lone surrogates from the name', () => {
    expect(create({ name: 'Cup\u0000' }).settings.name).toBe('Cup');
    expect(create({ name: ' Friday\u0007\u2028 Cup ' }).settings.name).toBe('Friday Cup');
    expect(create({ name: 'Abcdefghijklmnopqrs\ud83c' }).settings.name).toBe('Abcdefghijklmnopqrs');
    expect(create({ name: 'Club \u{1F0CF}' }).settings.name).toBe('Club \u{1F0CF}');
    expect(storable(create({ name: '\ud800Cup\udfff\u0000' }))).toBe(true);
  });

  it('counts the name in whole characters', () => {
    expect(create({ name: '\u{1F0CF}'.repeat(40) }).settings.name).toBe('\u{1F0CF}'.repeat(40));
    expect(refusal(() => create({ name: '\u{1F0CF}'.repeat(41) }))).toMatch('Name');
    expect(refusal(() => create({ name: '\u0000\u0007 \ud800' }))).toMatch('Name');
    expect(refusal(() => create({ name: 42 }))).toMatch('Name');
  });

  it('cleans the name in updateSettings', () => {
    expect(update(create(), { name: 'Cup\u0000\udc00' }).settings.name).toBe('Cup');
  });

  it('cleans the payout structure name and cuts it by whole characters', () => {
    const structure = { ...payoutPreset('winner-take-all', 600), name: `Top\u0000\ud800${'\u{1F0CF}'.repeat(45)}` };
    const state = create({ payouts: { structure, money: { buyIn: 100 } } });
    expect(state.settings.payouts!.structure.name).toBe(`Top${'\u{1F0CF}'.repeat(37)}`);
    expect(storable(state)).toBe(true);
  });

  it('refuses prize money that standings cannot use', () => {
    const structure = payoutPreset('winner-take-all', 600);
    expect(refusal(() => create({ payouts: { structure } }))).toMatch('Prize money');
    expect(refusal(() => create({ payouts: { structure, money: { buyIn: 'lots' } } }))).toMatch('Prize money');
    expect(refusal(() => create({ payouts: { structure, money: { buyIn: 100, feePercent: 101 } } }))).toMatch('fee');
  });

  it('refuses text that cannot be saved anywhere else in the settings', () => {
    expect(refusal(() => create({ rebuy: { max: 0, chips: 1000, approval: false, offerSeconds: 15, note: '\u0000' } }))).toMatch('cannot be saved');
    expect(refusal(() => update(create(), { addOn: { max: 0, chips: 1000, approval: false, ['\ud800']: 1 } }))).toMatch('cannot be saved');
  });
});

describe('unknown settings', () => {
  it('drops keys that are not tournament settings', () => {
    const created = create({ junk: '\u0000', name: 'Cup' });
    expect(created.settings).not.toHaveProperty('junk');
    const next = update(created, { name: 'New', alsoJunk: '\ud800' });
    expect(next.settings.name).toBe('New');
    expect(next.settings).not.toHaveProperty('alsoJunk');
    expect(storable(next)).toBe(true);
  });
});

describe('structure rows', () => {
  const lv = (extra: Record<string, unknown>) => ({ kind: 'level', sb: 50, bb: 100, ante: 0, anteType: 'none', minutes: 10, ...extra }) as StructureRow;

  it('needs a non-empty game id when a level names one', () => {
    for (const gameId of ['', 7, null]) expect(validateStructure([lv({ gameId })]).errors).toEqual(['Level 1: game must be a game id']);
    expect(validateStructure([lv({ gameId: 'plo' }), lv({ gameId: undefined })]).errors).toEqual([]);
    const state = create();
    expect(refusal(() => apply(state, { type: 'editStructure', by: 'host', structure: [lv({ gameId: '' })] }, T0))).toMatch('game');
  });

  it('refuses unknown row kinds and ante types', () => {
    expect(validateStructure([lv({}), { kind: 'pause', minutes: 5 } as unknown as StructureRow, lv({})]).errors).toEqual(['Row 2: must be a level or a break']);
    expect(validateStructure([lv({ anteType: 'sometimes', ante: 10 })]).errors).toEqual(['Level 1: unknown ante type']);
  });

  it('caps blinds at the engine chip limit', () => {
    expect(validateStructure([lv({ sb: MAX_CHIPS, bb: MAX_CHIPS + 2 })]).errors).toEqual(['Level 1: blinds and ante must be whole chip amounts']);
    expect(validateStructure([lv({ limit: { smallBet: 10, bigBet: MAX_CHIPS * 2 } })]).errors).toEqual(['Level 1: limit bets must be whole chip amounts above 0']);
  });

  it('reports a malformed structure instead of throwing', () => {
    for (const rows of [undefined, 'levels', [null]]) expect(validateStructure(rows as unknown as StructureRow[]).errors).toEqual(['The structure must be a list of levels and breaks']);
    expect(refusal(() => create({ structure: undefined }))).toMatch('structure');
    expect(validateStructure([lv({ note: '\u0000' })]).errors).toEqual(['The structure contains characters that cannot be saved']);
  });
});

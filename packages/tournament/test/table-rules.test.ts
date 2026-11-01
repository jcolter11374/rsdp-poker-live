import { describe, expect, it } from 'vitest';
import {
  apply,
  createTournament,
  defaultSettings,
  LEGACY_TABLE_RULES,
  RSDP_TABLE_RULES,
  tableRulesOf,
  validateTableRules,
  type Command,
  type TournamentSettings,
  type TournamentState,
} from '../src';

const T0 = Date.parse('2026-11-01T12:00:00Z');
const RSDP = { decisionSeconds: 10, timeBankSeconds: 20, timeBankRefillHands: 30, rabbitHunt: false };

const create = (overrides: Partial<TournamentSettings> = {}) =>
  createTournament({ id: 'T', hostId: 'host', settings: defaultSettings({ name: 'Wed', start: { kind: 'manual' }, startingStack: 1000, ...overrides }), now: T0, seed: 1 });
const run = (s: TournamentState, command: Command) => apply(s, command, T0).state;
const setRules = (s: TournamentState, tableRules: unknown) => run(s, { type: 'updateSettings', by: 'host', settings: { tableRules } as Partial<TournamentSettings> });

describe('tournament table rules', () => {
  it('RSDP rules are a 10-second clock, a 20-second bank every 30 hands and no rabbit hunting', () => {
    expect(RSDP_TABLE_RULES).toEqual(RSDP);
    expect(Object.isFrozen(RSDP_TABLE_RULES)).toBe(true);
  });

  it('an event saved before events had their own rules plays the way tournament tables used to', () => {
    expect(tableRulesOf(defaultSettings())).toEqual({ decisionSeconds: 30, timeBankSeconds: 30, timeBankRefillHands: 10, rabbitHunt: true });
    expect(tableRulesOf(defaultSettings({ tableRules: RSDP }))).toEqual(RSDP);
    // A copy, so a form editing it cannot change the shared rules.
    expect(tableRulesOf(defaultSettings())).not.toBe(LEGACY_TABLE_RULES);
  });

  it('checks each rule on its own', () => {
    expect(validateTableRules(RSDP)).toEqual([]);
    expect(validateTableRules({ ...RSDP, decisionSeconds: 0, timeBankSeconds: 0, timeBankRefillHands: 0 })).toEqual([]);
    expect(validateTableRules({ ...RSDP, decisionSeconds: 4 })).toEqual(['Decision clock must be 0 (no clock) or 5-600 seconds']);
    expect(validateTableRules({ ...RSDP, timeBankSeconds: 1.5 })).toEqual(['Time bank must be 0-300 seconds']);
    expect(validateTableRules({ ...RSDP, timeBankRefillHands: 201 })).toEqual(['Time bank refill must be 0-200 hands']);
    expect(validateTableRules({ ...RSDP, rabbitHunt: 'no' })).toEqual(['On/off settings must be true or false']);
    expect(validateTableRules(null)).toHaveLength(4);
    expect(validateTableRules([1, 2])).toHaveLength(4);
  });

  it('a host can switch an older event to the RSDP rules before the tables open', () => {
    const s = setRules(create(), { ...RSDP });
    expect(s.settings.tableRules).toEqual(RSDP);
    expect(tableRulesOf(s.settings)).toEqual(RSDP);
  });

  it('keeps only the four rules a host sends', () => {
    const s = setRules(create(), { ...RSDP, extra: 'x'.repeat(50), straddle: 'utg' });
    expect(s.settings.tableRules).toEqual(RSDP);
  });

  it('refuses rules that are out of range, and leaves the old ones in place', () => {
    const before = create({ tableRules: RSDP });
    expect(() => setRules(before, { ...RSDP, decisionSeconds: 2 })).toThrow(/Decision clock/);
    expect(() => setRules(before, 'fast')).toThrow(/Decision clock/);
    expect(before.settings.tableRules).toEqual(RSDP);
  });

  it('locks the rules once the tables exist', () => {
    const started = (overrides: Partial<TournamentSettings>) => {
      let s = create(overrides);
      for (const id of ['a', 'b', 'c']) s = run(s, { type: 'register', playerId: id, displayName: id.toUpperCase() });
      s = run(s, { type: 'startNow', by: 'host' });
      expect(s.tables.length).toBeGreaterThan(0);
      return s;
    };
    const rsdp = started({ tableRules: RSDP });
    expect(() => setRules(rsdp, { ...RSDP, rabbitHunt: true })).toThrow(/tableRules is locked/);
    // Sending the same rules back is not a change.
    expect(() => setRules(rsdp, { ...RSDP })).not.toThrow();
    // An older event cannot take on rules mid-tournament either.
    expect(() => setRules(started({}), RSDP)).toThrow(/tableRules is locked/);
  });
});

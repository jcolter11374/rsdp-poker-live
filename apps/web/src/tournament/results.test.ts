import { describe, expect, it } from 'vitest';
import { apply, createTournament, defaultSettings, type TournamentState } from '@rsdp/tournament';
import { resultsCsv, resultsFileName } from './results';

const T0 = Date.parse('2026-10-30T02:00:00Z');

function field(names: string[]): TournamentState {
  let s = createTournament({ id: 'R', hostId: 'host', settings: defaultSettings({ name: 'Friday/Night', lateRegistration: { enabled: false, throughLevel: null } }), now: T0, seed: 1 });
  names.forEach((n, i) => (s = apply(s, { type: 'register', playerId: `p${i}`, displayName: n }, T0).state));
  return apply(s, { type: 'startNow', by: 'host' }, T0).state;
}

describe('results CSV', () => {
  it('lists everyone with chips while running, quoting awkward names and defusing formulas', () => {
    const csv = resultsCsv(field(['Ana', 'Bo, Jr.', '=HYPERLINK("x")']));
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe('Place,Player,Entries,Rebuys,Add-ons,Knockouts,Chips');
    expect(lines).toHaveLength(4);
    expect(csv).toContain('"Bo, Jr."');
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(lines).toContain(',Ana,1,0,0,0,10000');
  });

  it('names the file after the tournament and its day', () => {
    expect(resultsFileName(field(['Ana', 'Bo']))).toBe('Friday Night 2026-10-30.csv');
  });
});

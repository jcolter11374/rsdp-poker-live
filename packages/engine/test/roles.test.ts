import { describe, expect, it } from 'vitest';
import { cleanPowers, handOver, hasPower, isStaff, MAX_CO_HOSTS, powersOf, RoleError, withCoHost, withoutCoHost, type Staff } from '../src/roles';

describe('co-hosts', () => {
  const staff: Staff = { hostId: 'h', coHosts: [{ playerId: 'a', name: 'Ann', powers: ['approve'] }] };

  it('gives the host every power and a co-host only theirs', () => {
    expect(hasPower(staff, 'h', 'settings')).toBe(true);
    expect(hasPower(staff, 'a', 'approve')).toBe(true);
    expect(hasPower(staff, 'a', 'chips')).toBe(false);
    expect(hasPower(staff, 'z', 'approve')).toBe(false);
    expect(isStaff(staff, 'a')).toBe(true);
    expect(isStaff(staff, null)).toBe(false);
    expect(powersOf(staff, 'h')).toHaveLength(5);
    // State saved before co-hosts existed.
    expect(hasPower({ hostId: 'h' }, 'a', 'approve')).toBe(false);
  });

  it('adds, updates and removes co-hosts', () => {
    const added = withCoHost(staff, { playerId: 'b', name: ' Bob ', powers: ['run'] });
    expect(added.at(-1)).toEqual({ playerId: 'b', name: 'Bob', powers: ['run'] });
    const changed = withCoHost({ ...staff, coHosts: added }, { playerId: 'a', name: 'Ann', powers: ['chips', 'approve'] });
    expect(changed[0].powers).toEqual(['approve', 'chips']);
    expect(withoutCoHost({ ...staff, coHosts: changed }, 'a').map((c) => c.playerId)).toEqual(['b']);
    expect(() => withoutCoHost(staff, 'b')).toThrow(RoleError);
    expect(() => withCoHost(staff, { playerId: 'h', name: '', powers: [] })).toThrow(RoleError);
    const full: Staff = { hostId: 'h', coHosts: Array.from({ length: MAX_CO_HOSTS }, (_, i) => ({ playerId: `c${i}`, name: 'C', powers: [] })) };
    expect(() => withCoHost(full, { playerId: 'new', name: 'N', powers: [] })).toThrow(/at most/);
  });

  it('checks powers', () => {
    expect(cleanPowers(['settings', 'approve', 'approve'])).toEqual(['approve', 'settings']);
    expect(() => cleanPowers(['root'])).toThrow(RoleError);
    expect(() => cleanPowers('approve')).toThrow(RoleError);
  });

  it('hands over the host role and keeps the old host as a full co-host', () => {
    const next = handOver(staff, 'a', 'Hal');
    expect(next.hostId).toBe('a');
    expect(next.coHosts).toEqual([{ playerId: 'h', name: 'Hal', powers: ['approve', 'chips', 'run', 'players', 'settings'] }]);
    expect(() => handOver(staff, 'h', 'Hal')).toThrow(RoleError);
  });
});

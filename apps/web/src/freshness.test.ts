import { describe, expect, it, vi } from 'vitest';

vi.mock('./socket', () => ({ socket: { on: () => {} } }));
const { isStale, quietNow } = await import('./freshness');

describe('reloading into a new build', () => {
  it('only when the server serves a different build from a built page', () => {
    expect(isStale('/assets/index-a.js', '/assets/index-b.js')).toBe(true);
    expect(isStale('/assets/index-a.js', '/assets/index-a.js')).toBe(false);
    // Development pages aren't hashed and never reload.
    expect(isStale(null, '/assets/index-b.js')).toBe(false);
  });

  it('never mid-hand, at a table between hands unless typing, elsewhere once hidden', () => {
    expect(quietNow('busy-table', false, false)).toBe(false);
    expect(quietNow('busy-table', false, true)).toBe(false);
    expect(quietNow('table', false, false)).toBe(true);
    expect(quietNow('table', true, false)).toBe(false);
    expect(quietNow('table', true, true)).toBe(true);
    expect(quietNow('page', false, false)).toBe(false);
    expect(quietNow('page', true, true)).toBe(true);
  });
});

// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useFollowSeat } from './hooks';

const handlers = vi.hoisted(() => new Map<string, Set<(arg: unknown) => void>>());
vi.mock('../socket', () => ({
  socket: {
    on: (ev: string, fn: (arg: unknown) => void) => void (handlers.get(ev) ?? handlers.set(ev, new Set()).get(ev)!).add(fn),
    off: (ev: string, fn: (arg: unknown) => void) => void handlers.get(ev)?.delete(fn),
  },
}));
vi.mock('./client', () => ({ tournamentClient: () => ({}) }));

const moved = (from: string, to: string) => act(() => handlers.get('table:moved')?.forEach((fn) => fn({ from, to })));

describe('following a move to another table', () => {
  afterEach(() => history.replaceState(null, '', '/'));

  it('waits while a runout is dealt here, then goes (#402)', () => {
    history.replaceState(null, '', '/t/a');
    const { rerender } = renderHook(({ holding }) => useFollowSeat('a', true, holding), { initialProps: { holding: true } });
    moved('a', 'b');
    expect(location.pathname).toBe('/t/a');
    rerender({ holding: false });
    expect(location.pathname).toBe('/t/b');
  });

  it('goes at once when nothing is being dealt', () => {
    history.replaceState(null, '', '/t/a');
    renderHook(() => useFollowSeat('a', true, false));
    moved('a', 'c');
    expect(location.pathname).toBe('/t/c');
  });
});

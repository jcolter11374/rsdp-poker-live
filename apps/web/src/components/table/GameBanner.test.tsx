// @vitest-environment jsdom
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BettingKind, Stakes } from '@rsdp/engine/core';
import { defaultSettings } from '@rsdp/engine/settings';
import type { HandView, TableView } from '@rsdp/engine/wire';
import { BANNER_MS, GameBanner } from './GameBanner';

vi.mock('../../socket', () => ({
  call: vi.fn(),
  socket: { on: () => {}, off: () => {}, emit: () => {}, connected: false },
  currentSession: () => null,
  onSession: () => () => {},
}));

const L: BettingKind = 'fixed-limit';
const STAKES: Stakes = { smallBlind: 1, bigBlind: 2, ante: 1, anteType: 'per-player', bringIn: 1, smallBet: 2, bigBet: 4 };

const hand = (handNumber: number, gameId: string, over: Partial<HandView> = {}) =>
  ({ handNumber, gameId, betting: L, family: gameId === 'nlhe' ? 'flop' : 'stud', stakes: STAKES, boards: [[[]]], bombPot: false, phase: 'betting', ...over }) as HandView;
const viewWith = (h: HandView | null, id = 't1') => ({ id, tournamentId: null, hand: h, settings: defaultSettings('cash') }) as unknown as TableView;

describe('the new-game banner (#373)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('shows for a few seconds when a hand is dealt in a new game, not for the first hand seen or the same game', () => {
    const { container, rerender } = render(<GameBanner view={viewWith(hand(1, 'razz'))} />);
    expect(container.textContent).toBe('');
    rerender(<GameBanner view={viewWith(hand(2, 'razz'))} />);
    expect(container.textContent).toBe('');
    rerender(<GameBanner view={viewWith(hand(3, 'stud'))} />);
    expect([...container.querySelectorAll('.game-banner > span')].map((x) => x.textContent)).toEqual(['New game', 'Seven Card Stud', '2/4 · ante 1 · bring-in 1']);
    act(() => void vi.advanceTimersByTime(BANNER_MS + 10));
    expect(container.textContent).toBe('');
  });

  it("isn't fooled by a bomb pot in another game, and gives way to the board", () => {
    const { container, rerender } = render(<GameBanner view={viewWith(hand(1, 'razz'))} />);
    rerender(<GameBanner view={viewWith(hand(2, 'nlhe', { bombPot: true }))} />);
    expect(container.textContent).toBe('');
    rerender(<GameBanner view={viewWith(hand(3, 'razz'))} />);
    expect(container.textContent).toBe('');
    rerender(<GameBanner view={viewWith(hand(4, 'nlhe'))} />);
    expect(container.querySelector('.game-banner')).not.toBeNull();
    rerender(<GameBanner view={viewWith(hand(4, 'nlhe', { boards: [[['Ah', 'Kd', '2c']]] }))} />);
    expect(container.textContent).toBe('');
  });

  it("at a cash table, new stakes alone aren't a new game", () => {
    const { container, rerender } = render(<GameBanner view={viewWith(hand(1, 'razz'))} />);
    rerender(<GameBanner view={viewWith(hand(2, 'razz', { stakes: { ...STAKES, ante: 2 } }))} />);
    expect(container.textContent).toBe('');
  });

  it('starts afresh at another table', () => {
    const { container, rerender } = render(<GameBanner view={viewWith(hand(1, 'razz'), 't1')} />);
    rerender(<GameBanner view={viewWith(hand(7, 'stud'), 't2')} />);
    expect(container.textContent).toBe('');
  });
});

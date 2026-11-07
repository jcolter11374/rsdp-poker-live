// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LevelRow, PlayerOptions, TournamentSummary } from '@rsdp/tournament';
import { TableStrip } from './TableStrip';

// The strip above a tournament table, and on a wide window (#385) the box in the bottom-right corner: what shows where.

const level: LevelRow = { kind: 'level', sb: 100, bb: 200, ante: 0, anteType: 'none', minutes: 8 };
let options: Partial<PlayerOptions>;
const send = vi.fn<(id: string, command: unknown) => Promise<void>>();

vi.mock('@rsdp/tournament', async (original) => ({
  ...(await original<typeof import('@rsdp/tournament')>()),
  summarize: (): Partial<TournamentSummary> => ({
    clock: { levelNumber: 3, onBreak: false, level, nextLevel: { ...level, sb: 150, bb: 300 }, msLeft: 300_000, msToBreak: null, rowIndex: 2, running: true },
    msToStart: null,
    playersLeft: 12,
    entrants: 18,
    averageStack: 94_500,
    handForHand: false,
  }),
  playerOptions: () => ({ entry: null, pending: [], canAddOn: false, canReEnter: false, canRebuy: false, canDeclineRebuy: false, ...options }),
  standings: () => [],
  tableAddress: (id: string) => id,
}));
vi.mock('./hooks', () => ({
  useTournament: () => ({ state: { settings: { name: 'Friday Cup', rebuy: { chips: 63_000 }, addOn: { chips: 63_000 } }, status: 'running', tables: [] }, skew: 0 }),
  useSession: () => ({ playerId: 'p1' }),
  useNow: () => 0,
  followMissedMove: () => false,
  useHeld: <T,>(value: T) => value,
  navigate: vi.fn(),
}));
vi.mock('./client', () => ({ tournamentClient: () => ({ send }) }));

beforeEach(() => {
  options = {};
  send.mockReset();
});
afterEach(cleanup);

const show = (corner: boolean) => render(<TableStrip tournamentId="tn1" tableId="tn1-t1" seatedHere corner={corner} />);
const seated = { status: 'seated', tableId: 'tn1-t1' } as PlayerOptions['entry'];

describe('the tournament strip', () => {
  it('keeps the level, clock and blinds above the table on a laptop', () => {
    const { container } = show(false);
    expect(container.querySelector('.tn-corner')).toBeNull();
    expect(container.querySelector('.tn-strip')?.textContent).toMatch(/Friday Cup.*Level 3 · 5:00.*100 \/ 200.*Next 150 \/ 300.*12 of 18 left/);
  });

  it('puts them in the corner box on a wide window, with nothing above the table', () => {
    const { container } = show(true);
    expect(container.querySelector('.tn-strip')).toBeNull();
    expect(container.querySelector('.tn-corner')?.textContent).toMatch(/Friday Cup.*Lobby.*Level 3.*5:00.*100 \/ 200.*Next 150 \/ 300.*12 of 18 left/);
  });

  it('shows a row above the table while it asks something of the player', () => {
    options = { entry: seated, canAddOn: true };
    const { container } = show(true);
    expect(container.querySelector('.tn-strip')?.textContent).toMatch(/Add-ons are open\./);
    expect(container.querySelector('.tn-corner')?.textContent).not.toMatch(/Add-ons/);
  });

  it('moves a refused request\'s error to the corner box once there is nothing left to ask', async () => {
    send.mockRejectedValue(new Error('add-ons are closed'));
    options = { entry: seated, canAddOn: true };
    const { container, rerender } = show(true);
    await act(async () => fireEvent.click(container.querySelector('.tn-strip button')!));
    expect(container.querySelector('.tn-strip')?.textContent).toMatch(/Add-ons are closed/);
    // The break ends: no add-on to offer, so no row above the table, and the error stays where the player can see it.
    options = { entry: seated, canAddOn: false };
    rerender(<TableStrip tournamentId="tn1" tableId="tn1-t1" seatedHere corner />);
    expect(container.querySelector('.tn-strip')).toBeNull();
    expect(container.querySelector('.tn-corner')?.textContent).toMatch(/Add-ons are closed/);
  });
});

// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LevelRow, PlayerOptions, TournamentSummary } from '@rsdp/tournament';
import { TableStrip } from './TableStrip';

// The strip above a tournament table, and on a wide window (#385) the box in the bottom-right corner and the asks under
// the table: what shows where.

const level: LevelRow = { kind: 'level', sb: 100, bb: 200, ante: 0, anteType: 'none', minutes: 8 };
let options: Partial<PlayerOptions>;
// The event's status and open tables, and its places (once it is over).
let event: { status: string; tables: { id: string }[] };
let places: { place: number; displayName: string; entryId: string }[];
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
  standings: () => places,
  tableAddress: (id: string) => id,
}));
vi.mock('./hooks', () => ({
  useTournament: () => ({ state: { settings: { name: 'Friday Cup', rebuy: { chips: 63_000 }, addOn: { chips: 63_000 } }, ...event }, skew: 0 }),
  useSession: () => ({ playerId: 'p1' }),
  useNow: () => 0,
  followMissedMove: () => false,
  useHeld: <T,>(value: T) => value,
  navigate: vi.fn(),
}));
vi.mock('./client', () => ({ tournamentClient: () => ({ send }) }));

// TablePage's spot for the asks, under the table (in the Dock).
let under: HTMLDivElement;
beforeEach(() => {
  options = {};
  event = { status: 'running', tables: [{ id: 'tn1-t1' }, { id: 'tn1-t2' }] };
  places = [];
  send.mockReset();
  under = document.body.appendChild(document.createElement('div'));
});
afterEach(() => {
  cleanup();
  under.remove();
});

const strip = (corner: boolean, emptyHere = false) => <TableStrip tournamentId="tn1" tableId="tn1-t1" seatedHere emptyHere={emptyHere} corner={corner} asksIn={corner ? under : null} />;
const show = (corner: boolean, emptyHere = false) => render(strip(corner, emptyHere));
const seated = { status: 'seated', tableId: 'tn1-t1' } as PlayerOptions['entry'];

describe('the tournament strip', () => {
  it('keeps the level, clock and blinds above the table on a laptop', () => {
    const { container } = show(false);
    expect(container.querySelector('.tn-corner')).toBeNull();
    expect(under.childElementCount).toBe(0);
    expect(container.querySelector('.tn-strip')?.textContent).toMatch(/Friday Cup.*Level 3 · 5:00.*100 \/ 200.*Next 150 \/ 300.*12 of 18 left/);
  });

  it('puts them in the corner box on a wide window, with nothing above or under the table', () => {
    const { container } = show(true);
    expect(container.querySelector('.tn-strip')).toBeNull();
    expect(under.childElementCount).toBe(0);
    expect(container.querySelector('.tn-corner')?.textContent).toMatch(/Friday Cup.*Lobby.*Level 3.*5:00.*100 \/ 200.*Next 150 \/ 300.*12 of 18 left/);
  });

  it('shows a row under the table, not above it, while it asks something of the player', () => {
    options = { entry: seated, canAddOn: true };
    const { container } = show(true);
    expect(under.querySelector('.tn-strip')?.textContent).toMatch(/Add-ons are open\./);
    expect(container.querySelector('.tn-strip')).toBeNull();
    expect(container.querySelector('.tn-corner')?.textContent).not.toMatch(/Add-ons/);
  });

  it('keeps the asks above the table on a laptop', () => {
    options = { entry: { status: 'rebuy-offer', rebuyOfferExpiresAt: 20_000 } as PlayerOptions['entry'], canRebuy: true, canDeclineRebuy: true };
    const { container } = show(false);
    expect(container.querySelector('.tn-strip')?.textContent).toMatch(/Friday Cup.*You're out of chips\. Rebuy for 63,000\?.*Rebuy.*No thanks/);
  });

  it('moves a refused request\'s error to the corner box once there is nothing left to ask', async () => {
    send.mockRejectedValue(new Error('add-ons are closed'));
    options = { entry: seated, canAddOn: true };
    const { container, rerender } = show(true);
    await act(async () => fireEvent.click(under.querySelector('.tn-strip button')!));
    expect(under.querySelector('.tn-strip')?.textContent).toMatch(/Add-ons are closed/);
    // The break ends: no add-on to offer, so no row under the table, and the error stays where the player can see it.
    options = { entry: seated, canAddOn: false };
    rerender(strip(true));
    expect(under.childElementCount).toBe(0);
    expect(container.querySelector('.tn-corner')?.textContent).toMatch(/Add-ons are closed/);
  });
  it("says where you finished only once your kept seat has gone, on a laptop, so the table doesn't move as the result shows (#445)", () => {
    options = { entry: { id: 'e5', status: 'busted' } as PlayerOptions['entry'] };
    places = [{ place: 5, displayName: 'Ana', entryId: 'e5' }];
    const kept = (k: boolean) => <TableStrip tournamentId="tn1" tableId="tn1-t1" seatedHere={false} keptHere={k} />;
    const { container, rerender } = render(kept(true));
    expect(container.textContent).not.toMatch(/You finished/);
    // The next deal: the seat goes, and the row with it.
    rerender(kept(false));
    expect(container.textContent).toMatch(/You finished 5th\./);
    cleanup();
    // In the corner box on a wide window it takes no room from the table, so it shows at once.
    const corner = render(<TableStrip tournamentId="tn1" tableId="tn1-t1" seatedHere={false} keptHere corner asksIn={under} />);
    expect(corner.container.querySelector('.tn-corner')?.textContent).toMatch(/You finished 5th\./);
  });

  it('shows a finished event with its winner, not a stopped clock and the next blinds (#446)', () => {
    event = { status: 'finished', tables: [{ id: 'tn1-t1' }] };
    places = [{ place: 1, displayName: 'Dot', entryId: 'e1' }];
    for (const corner of [false, true]) {
      const { container } = show(corner);
      const text = container.textContent ?? '';
      expect(text).toMatch(/🏆 Dot wins/);
      expect(text).not.toMatch(/Level|100 \/ 200|Next/);
      cleanup();
    }
  });

  it('tells someone watching a table that broke that it has closed (#446)', () => {
    // Its players were moved to the other table, and it is no longer one of the event's.
    event = { status: 'running', tables: [{ id: 'tn1-t2' }] };
    for (const corner of [false, true]) {
      const { container } = show(corner, true);
      expect(container.querySelector('[role="status"]')?.textContent).toBe('This table has closed. Play goes on at the other table.');
      cleanup();
    }
  });

  it("doesn't say a table closed while it has players, or while it is still one of the event's", () => {
    // A table opened a moment before this page's copy of the tournament heard of it.
    event = { status: 'running', tables: [{ id: 'tn1-t2' }] };
    expect(show(false).container.textContent).not.toMatch(/closed/);
    cleanup();
    // Everyone at it is out of chips between hands, but the table plays on.
    event = { status: 'running', tables: [{ id: 'tn1-t1' }, { id: 'tn1-t2' }] };
    expect(show(false, true).container.textContent).not.toMatch(/closed/);
  });
});

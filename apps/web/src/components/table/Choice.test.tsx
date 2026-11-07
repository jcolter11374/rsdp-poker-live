// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '@rsdp/engine/settings';
import type { ChoiceView, TableView } from '@rsdp/engine/wire';
import { canPickNow, GamePicker } from './Choice';

const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../../socket', () => ({
  call,
  socket: { on: () => {}, off: () => {}, emit: () => {}, connected: false },
  currentSession: () => null,
  onSession: () => () => {},
}));

/** The table waiting for my first pick, of Hold'em or Razz; it was dealing Razz. */
function waitingView(): TableView {
  const settings = defaultSettings('cash');
  settings.game.dealersChoice = {
    enabled: true,
    games: [
      { gameId: 'nlhe', betting: 'no-limit' },
      { gameId: 'razz', betting: 'fixed-limit' },
    ],
    hands: 0,
    pickSeconds: 20,
  };
  // No pick yet (current is null), but the table was dealing Razz, so the server can keep it.
  const choice: ChoiceView = {
    chip: 0,
    current: null,
    handsLeft: null,
    next: null,
    open: true,
    deadline: 20_000,
    count: 3,
    cap: null,
    closed: false,
    defaultIndex: 1,
    canKeep: true,
  };
  return {
    settings,
    choice,
    paused: false,
    serverNow: 0,
    hand: null,
  } as unknown as TableView;
}

describe('the Pick the next game panel', () => {
  it('offers to keep the game the table was dealing at its first pick', () => {
    render(<GamePicker view={waitingView()} skew={0} onClose={() => {}} onRules={() => {}} />);
    expect(screen.getByRole('button', { name: 'Keep playing Razz' })).toBeTruthy();
  });

  it('reads out why a pick was refused', async () => {
    call.mockRejectedValueOnce(new Error("it isn't your pick"));
    const onClose = vi.fn();
    render(<GamePicker view={waitingView()} skew={0} onClose={onClose} onRules={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Keep playing Razz' }));
    expect((await screen.findByRole('alert')).textContent).toBe("it isn't your pick");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("doesn't offer a pick once the host has switched the table to a game rotation from the next hand", () => {
    const choice = { chip: 0, current: null, handsLeft: null, next: null, open: true, deadline: null, count: 3, cap: null, closed: false, defaultIndex: 0, canKeep: false } as ChoiceView;
    const view = { choice, me: { playerId: 'a', seat: 0 }, rotation: null } as unknown as TableView;
    expect(canPickNow(view)).toBe(true);
    const horse = { gameId: 'lhe', betting: 'fixed-limit', gameName: "Limit Hold'em", dealt: 0, handsLeft: 3, next: { gameId: 'plo8', betting: 'fixed-limit', gameName: 'Limit Omaha Hi-Lo' } };
    expect(canPickNow({ ...view, rotation: horse } as TableView)).toBe(false);
  });
});

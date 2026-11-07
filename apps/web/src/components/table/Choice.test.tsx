// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { defaultSettings, type SettingsPatch } from '@rsdp/engine/settings';
import type { ChoiceView, TableView } from '@rsdp/engine/wire';
import { call } from '../../socket';
import { canPickNow, GamePicker } from './Choice';

vi.mock('../../socket', () => ({
  call: vi.fn(),
  socket: { on: () => {}, off: () => {}, emit: () => {}, connected: false },
  currentSession: () => null,
  onSession: () => () => {},
}));

describe('the Pick the next game panel', () => {
  it('offers to keep the game the table was dealing at its first pick', () => {
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
    const view = {
      settings,
      choice,
      paused: false,
      serverNow: 0,
      hand: null,
    } as unknown as TableView;
    render(<GamePicker view={view} skew={0} onClose={() => {}} onRules={() => {}} />);
    expect(screen.getByRole('button', { name: 'Keep playing Razz' })).toBeTruthy();
  });

  it("doesn't offer a pick once the host has switched the table to a game rotation from the next hand", () => {
    const choice = { chip: 0, current: null, handsLeft: null, next: null, open: true, deadline: null, count: 3, cap: null, closed: false, defaultIndex: 0, canKeep: false } as ChoiceView;
    const view = { choice, me: { playerId: 'a', seat: 0 }, rotation: null } as unknown as TableView;
    expect(canPickNow(view)).toBe(true);
    const horse = { gameId: 'lhe', betting: 'fixed-limit', gameName: "Limit Hold'em", dealt: 0, handsLeft: 3, next: { gameId: 'plo8', betting: 'fixed-limit', gameName: 'Limit Omaha Hi-Lo' } };
    expect(canPickNow({ ...view, rotation: horse } as TableView)).toBe(false);
  });

  describe('while the host is taking a game off the menu from the next hand (#441)', () => {
    const MENU = [
      { gameId: 'nlhe', betting: 'no-limit' as const },
      { gameId: 'razz', betting: 'fixed-limit' as const },
      { gameId: 'plo4', betting: 'pot-limit' as const },
    ];
    /** The chooser's view during the last hand of a pick, with the host's change waiting for the next hand. */
    const viewWith = (pendingSettings: SettingsPatch | null) => {
      const settings = defaultSettings('cash');
      settings.game.dealersChoice = { enabled: true, games: MENU, hands: 0, pickSeconds: 20 };
      const choice: ChoiceView = { chip: 0, current: null, handsLeft: 0, next: null, open: true, deadline: null, count: 3, cap: null, closed: false, defaultIndex: 0, canKeep: false };
      return { settings, pendingSettings, choice, paused: false, serverNow: 0, hand: { handNumber: 7 } } as unknown as TableView;
    };
    const pickButton = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;

    it("greys out the game coming off and says why, and the others can still be picked", () => {
      const pending: SettingsPatch = { game: { dealersChoice: { games: [MENU[0], MENU[2]] } } } as SettingsPatch;
      render(<GamePicker view={viewWith(pending)} skew={0} onClose={() => {}} onRules={() => {}} />);
      const razz = pickButton('Razz');
      expect(razz.disabled).toBe(true);
      expect(razz.closest('li')!.className).toContain('greyed');
      expect(screen.getByText('The host is taking it off the menu').id).toBe(razz.getAttribute('aria-describedby'));
      expect(pickButton("No-Limit Hold'em").disabled).toBe(false);
      expect(pickButton('Pot-Limit Omaha').disabled).toBe(false);
      // A tap on the greyed game sends nothing, so the server never has to refuse it.
      vi.mocked(call).mockClear();
      fireEvent.click(razz);
      expect(call).not.toHaveBeenCalled();
    });

    it('counts a game whose betting is changing as coming off: the server deals the game and betting picked', () => {
      const pending = { game: { dealersChoice: { games: [MENU[0], MENU[1], { gameId: 'plo4', betting: 'no-limit' }] } } } as SettingsPatch;
      render(<GamePicker view={viewWith(pending)} skew={0} onClose={() => {}} onRules={() => {}} />);
      expect(pickButton('Pot-Limit Omaha').disabled).toBe(true);
      expect(pickButton('Razz').disabled).toBe(false);
    });

    it("never offers to keep playing a game coming off the menu, even if told it can", () => {
      const pending = { game: { dealersChoice: { games: [MENU[0], MENU[2]] } } } as SettingsPatch;
      const view = viewWith(pending);
      view.choice = { ...view.choice!, current: { gameId: 'razz', betting: 'fixed-limit', gameName: 'Razz', by: 'B', seat: 1, how: 'picked' }, canKeep: true, defaultIndex: 1 };
      render(<GamePicker view={view} skew={0} onClose={() => {}} onRules={() => {}} />);
      expect(screen.queryByRole('button', { name: 'Keep playing Razz' })).toBeNull();
    });

    it('greys nothing out for a change that leaves the menu as it is', () => {
      render(<GamePicker view={viewWith({ table: { name: 'Friday night' } } as SettingsPatch)} skew={0} onClose={() => {}} onRules={() => {}} />);
      for (const name of ["No-Limit Hold'em", 'Razz', 'Pot-Limit Omaha']) expect(pickButton(name).disabled).toBe(false);
      expect(screen.queryByText('The host is taking it off the menu')).toBeNull();
    });
  });
});

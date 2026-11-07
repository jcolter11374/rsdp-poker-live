// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '@rsdp/engine/settings';
import type { ChoiceView, TableView } from '@rsdp/engine/wire';
import { GamePicker } from './Choice';

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
});

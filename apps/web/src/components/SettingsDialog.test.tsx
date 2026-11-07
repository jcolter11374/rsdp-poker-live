// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings, type TableSettings } from '@rsdp/engine/settings';
import type { TableView } from '@rsdp/engine/wire';
import { SettingsDialog } from './SettingsDialog';

// The dialog reaches the server only through call(): a spy here that answers at once.
const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../socket', () => ({
  call,
  socket: { on: () => {}, off: () => {}, emit: () => {}, connected: false },
  currentSession: () => null,
  onSession: () => () => {},
}));

/** The parts of the table the dialog reads: its settings, whether a hand is on, and who is sitting. */
const viewOf = (settings: TableSettings) =>
  ({
    settings,
    hand: null,
    mode: 'cash',
    seats: Array(settings.table.maxSeats).fill(null),
  }) as unknown as TableView;
const sentPatch = () => call.mock.calls.find(([event]) => event === 'host:settings')?.[1].patch;
const mode = () => screen.getByLabelText('How the game is chosen');

describe('Table settings: How the game is chosen', () => {
  beforeEach(() => {
    call.mockReset();
    call.mockResolvedValue({});
  });

  it("taking a look at Dealer's choice and going back to One game leaves the stakes as they were", () => {
    const settings = defaultSettings('cash');
    expect(settings.stakes.ante).toBe(0);
    render(<SettingsDialog view={viewOf(settings)} onClose={() => {}} />);
    fireEvent.change(mode(), { target: { value: 'choice' } });
    fireEvent.change(mode(), { target: { value: 'one' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(sentPatch()?.stakes).toBeUndefined();
  });

  it("switching to Dealer's choice sends the rotation switch too, so a mix queued earlier in the hand can't clash", () => {
    render(<SettingsDialog view={viewOf(defaultSettings('cash'))} onClose={() => {}} />);
    fireEvent.change(mode(), { target: { value: 'choice' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(sentPatch()?.game).toMatchObject({
      rotation: { enabled: false },
      dealersChoice: { enabled: true },
    });
  });

  it('lets the host type a pick time over the old one, and keeps it at least 10 seconds', () => {
    render(<SettingsDialog view={viewOf(defaultSettings('cash'))} onClose={() => {}} />);
    fireEvent.change(mode(), { target: { value: 'choice' } });
    const field = screen.getByLabelText(/Time to pick/) as HTMLInputElement;
    fireEvent.change(field, { target: { value: '3' } });
    expect(field.value).toBe('3');
    fireEvent.change(field, { target: { value: '30' } });
    expect(field.value).toBe('30');
    fireEvent.change(field, { target: { value: '4' } });
    fireEvent.blur(field);
    expect(field.value).toBe('10');
  });
});

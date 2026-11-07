// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ShortcutsDialog } from './Shortcuts';

// The dialog's frame comes from a module that talks to the table; nothing is ever sent here.
vi.mock('../socket', () => ({
  call: vi.fn(),
  socket: { on: () => {}, off: () => {}, emit: () => {}, connected: false },
  currentSession: () => null,
  onSession: () => () => {},
  saveName: () => {},
  savedName: () => '',
}));

/** What the list says a key does. */
function says(key: string) {
  const row = Array.from(document.querySelectorAll('dl.shortcuts > div')).find((d) => d.querySelector('dt')?.textContent === key);
  return row?.querySelector('dd')?.textContent ?? null;
}

describe('the keyboard shortcuts list', () => {
  it('keeps A as Call any before your turn', () => {
    render(<ShortcutsDialog onClose={() => {}} />);
    expect(says('A')).toBe('Call any (before your turn)');
    expect(screen.getByText(/Before your turn, F, K, C and A tick a pre-move/).textContent).toContain('Call any');
  });

  it('lists Shift+A twice as the most you can bet, with the second press, the pot-limit most, and where it does nothing (#307)', () => {
    render(<ShortcutsDialog onClose={() => {}} />);
    const shiftA = says('Shift+A');
    expect(shiftA).toMatch(/^Twice, on your turn: the most you can bet \(all in\)\./);
    expect(shiftA).toContain('In pot limit, or with Trim bets nobody can call on, the most can be less, and it says so.');
    expect(shiftA).toContain('The first press says what the second will send; Enter sends it too, Esc cancels.');
    expect(shiftA).toContain('Not in fixed limit.');
    // Enter after Shift+A sends the all-in rather than starting a chat message.
    expect(says('Enter')).toContain('Just after Shift+A, Enter sends the all-in instead');
  });
});

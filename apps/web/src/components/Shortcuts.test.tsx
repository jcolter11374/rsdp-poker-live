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
  it('lists A as all in, with the second press, the pot-limit most, and where it does nothing (#307)', () => {
    render(<ShortcutsDialog onClose={() => {}} />);
    const a = says('A');
    expect(a).toMatch(/^All in, on your turn in no limit and pot limit games\./);
    expect(a).toContain('Press A again or Enter to send it, or Esc to cancel.');
    expect(a).toContain('In pot limit');
    expect(a).toContain('less than all in');
    expect(a).toContain('Not in limit games, and it does nothing before your turn.');
    // Enter after A sends the all-in rather than starting a chat message.
    expect(says('Enter')).toContain('Just after A, Enter sends the all-in instead');
  });

  it('no longer gives Call any a key, and says to click it', () => {
    render(<ShortcutsDialog onClose={() => {}} />);
    expect(screen.queryByText(/Call any \(before your turn\)/)).toBeNull();
    expect(screen.getByText(/Before your turn, F, K and C tick a pre-move/).textContent).toContain('Call any has no key: click it.');
  });
});

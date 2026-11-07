// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useRef, useState } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { useScrollReach } from './scrollReach';
import { Modal } from './SeatDialog';
import { Sheet } from './Sheet';
import { Table } from './Table';
import { TableAnnouncer } from './table/Announcer';
import { CHECKED_TO_ME, seatView, tableView } from '../test-table';

// The table's parts that talk to the server load with the table; nothing is ever sent here.
vi.mock('../socket', () => ({
  call: vi.fn(() => new Promise(() => {})),
  socket: { on: () => {}, off: () => {}, emit: () => {}, connected: false },
  currentSession: () => null,
  onSession: () => () => {},
}));

beforeAll(() => {
  // jsdom has no layout: the table measures itself with these, and gets nothing back.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })) as unknown as typeof window.matchMedia;
});

const tab = (shift = false) => fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Tab', shiftKey: shift });

/** A page with a button that opens a dialog, like the table's seats and menus. */
function Opener({ autoFocus = false, sheet = false }: { autoFocus?: boolean; sheet?: boolean }) {
  const [open, setOpen] = useState(false);
  const Box = sheet ? Sheet : Modal;
  return (
    <>
      <button onClick={() => setOpen(true)}>Open</button>
      <button>Behind</button>
      {open && (
        <Box title="Note on Bo" onClose={() => setOpen(false)}>
          <input aria-label="Note" autoFocus={autoFocus} />
          <button onClick={() => setOpen(false)}>Save</button>
        </Box>
      )}
    </>
  );
}

describe('dialogs and the keyboard', () => {
  it('moves focus in, keeps Tab inside, and gives focus back when it closes', () => {
    render(<Opener autoFocus />);
    const opener = screen.getByText('Open');
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'Note on Bo' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    // The box that asked for focus has it.
    expect(document.activeElement).toBe(screen.getByLabelText('Note'));
    tab();
    expect(document.activeElement).toBe(screen.getByText('Save'));
    // Round from the last control to the first, never to the page behind.
    tab();
    expect(document.activeElement).toBe(screen.getByLabelText('Note'));
    tab(true);
    expect(document.activeElement).toBe(screen.getByText('Save'));
    fireEvent.click(screen.getByText('Save'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('focuses the dialog itself when nothing inside asks to be, and Escape closes it', () => {
    render(<Opener />);
    const opener = screen.getByText('Open');
    opener.focus();
    fireEvent.click(opener);
    expect(document.activeElement).toBe(screen.getByRole('dialog'));
    tab();
    expect(document.activeElement).toBe(screen.getByLabelText('Note'));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('does the same for a phone sheet', () => {
    render(<Opener sheet />);
    const opener = screen.getByText('Open');
    opener.focus();
    fireEvent.click(opener);
    const sheet = screen.getByRole('dialog', { name: 'Note on Bo' });
    expect(sheet.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(sheet);
    // The sheet's own Close button comes first.
    tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
    tab(true);
    expect(document.activeElement).toBe(screen.getByText('Save'));
  });
});

describe('the table for a keyboard and a screen reader', () => {
  const noop = () => {};

  it('lets the keyboard open each player\'s menu from their nameplate', () => {
    const onSeatClick = vi.fn();
    render(<Table view={tableView({ hand: { toAct: 1 } })} skew={0} fmt={String} onSeatClick={onSeatClick} />);
    const bo = screen.getByRole('button', { name: 'Bo: player menu' });
    expect(screen.getByRole('button', { name: 'Ann: your seat' })).toBeTruthy();
    fireEvent.click(bo);
    expect(onSeatClick).toHaveBeenCalledTimes(1);
    expect(onSeatClick.mock.calls[0][0].name).toBe('Bo');
  });

  it('says in words who is to act and who has the button', () => {
    render(<Table view={tableView({ hand: { toAct: 1, button: 0 }, seats: [seatView(0), seatView(1), seatView(2, { folded: true })] })} skew={0} fmt={String} onSeatClick={noop} />);
    const plate = (name: string) => screen.getByRole('button', { name: `${name}: ${name === 'Ann' ? 'your seat' : 'player menu'}` }).closest('.nameplate')!;
    expect(plate('Bo').textContent).toContain('to act');
    expect(plate('Ann').textContent).toContain('dealer');
    expect(plate('Cy').textContent).toContain('folded');
    // The D on the felt itself is left out, so it isn't read as a stray letter.
    expect(document.querySelector('.dealer')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('names each empty seat', () => {
    const view = tableView({ hand: null, seats: [seatView(0), null, seatView(2)], view: { me: { playerId: 'p9', seat: null } } });
    render(<Table view={view} skew={0} fmt={String} onPickSeat={noop} />);
    expect(screen.getByRole('button', { name: 'Sit in seat 2' })).toBeTruthy();
  });

  it('reads out each change to the table in a live region', () => {
    const quiet = { current: false };
    const before = tableView({ hand: { events: [] } });
    const { rerender } = render(<TableAnnouncer view={before} fmt={String} skew={0} preQueued={quiet} />);
    const log = screen.getByRole('log');
    expect(log.getAttribute('aria-live')).toBe('polite');
    expect(log.textContent).toBe('');
    const check = { seq: 1, t: 'action' as const, seat: 1, action: 'check' as const, amount: 0, to: 0, allIn: false, auto: false };
    act(() => rerender(<TableAnnouncer view={tableView({ hand: { toAct: 0, events: [check] }, legal: CHECKED_TO_ME })} fmt={String} skew={0} preQueued={quiet} />));
    expect(log.textContent).toBe('Bo checks. Your turn: check or bet 20 up to 1000. Pot 200.');
  });

  it('warns when ten seconds are left on your clock', () => {
    vi.useFakeTimers();
    try {
      const now = Date.now();
      const view = tableView({ hand: { toAct: 0 }, legal: CHECKED_TO_ME, view: { turn: { seat: 0, startedAt: now, deadline: now + 30_000, usingBank: false } } });
      render(<TableAnnouncer view={view} fmt={String} skew={0} preQueued={{ current: false }} />);
      act(() => vi.advanceTimersByTime(19_000));
      expect(screen.getByRole('log').textContent).toBe('');
      act(() => vi.advanceTimersByTime(1_500));
      expect(screen.getByRole('log').textContent).toBe('10 seconds left to act.');
    } finally {
      vi.useRealTimers();
    }
  });
});

/** A box like a wide code block on the fairness page, which may be wider than the screen. */
function Wide({ label }: { label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div ref={ref} data-testid="box" {...useScrollReach(ref, label)}>
      wide words
    </div>
  );
}

describe('boxes that scroll', () => {
  it('are a Tab stop with a name only while they scroll', () => {
    // jsdom has no layout, so the box is told how wide its words are and how wide it is.
    let words = 300;
    const sizes = [
      vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(() => words),
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => 200),
    ];
    try {
      const { rerender } = render(<Wide label="Code: npm ci" />);
      const box = screen.getByTestId('box');
      expect(box.tabIndex).toBe(0);
      expect(screen.getByRole('region', { name: 'Code: npm ci' })).toBe(box);
      words = 150;
      rerender(<Wide label="Code: npm ci" />);
      expect(box.hasAttribute('tabindex')).toBe(false);
      expect(box.hasAttribute('role')).toBe(false);
    } finally {
      for (const s of sizes) s.mockRestore();
    }
  });
});

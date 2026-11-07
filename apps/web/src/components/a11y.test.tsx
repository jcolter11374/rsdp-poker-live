// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useRef, useState } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { HandRecordView } from '@rsdp/engine/wire';
import { Replayer } from './Replayer';
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

// A replay that breaks is reported to the server; not from here.
vi.mock('../reportError', async (actual) => ({ ...(await actual<typeof import('../reportError')>()), reportError: vi.fn() }));

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

/** The phone's menu: a sheet whose How to play button closes it and opens its own dialog, in the same click. */
function MenuThenDialog() {
  const [open, setOpen] = useState<'menu' | 'rules' | null>(null);
  return (
    <>
      <button onClick={() => setOpen('menu')}>Menu</button>
      {open === 'menu' && (
        <Sheet title="Menu" onClose={() => setOpen(null)}>
          <button onClick={() => setOpen('rules')}>How to play</button>
        </Sheet>
      )}
      {open === 'rules' && (
        <Modal title="Rules" onClose={() => setOpen(null)}>
          <button onClick={() => setOpen(null)}>Done</button>
        </Modal>
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

  it('gives focus back to the menu button when a dialog opened from the menu sheet closes', () => {
    render(<MenuThenDialog />);
    const menu = screen.getByText('Menu');
    menu.focus();
    fireEvent.click(menu);
    const rules = screen.getByText('How to play');
    rules.focus();
    fireEvent.click(rules);
    expect(screen.queryByRole('dialog', { name: 'Menu' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('dialog', { name: 'Rules' }));
    // The button that opened it went with the sheet: focus goes where the sheet would have put it back.
    fireEvent.click(screen.getByText('Done'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(menu);
  });

  it('leaves focus in the dialog on top when another opens by itself underneath, and gives it to that one next', () => {
    // As at the table: Dealer's choice's picker comes before the other dialogs in the page, so they sit on top of it.
    function Page({ pick }: { pick: boolean }) {
      const [keys, setKeys] = useState(false);
      const [picking, setPicking] = useState(true);
      return (
        <>
          <button onClick={() => setKeys(true)}>Keyboard shortcuts</button>
          {pick && picking && (
            <Modal title="Pick the next game" onClose={() => setPicking(false)}>
              <button>Razz</button>
            </Modal>
          )}
          {keys && (
            <Modal title="Keyboard shortcuts" onClose={() => setKeys(false)}>
              <button onClick={() => setKeys(false)}>Done</button>
            </Modal>
          )}
        </>
      );
    }
    const { rerender } = render(<Page pick={false} />);
    const opener = screen.getByText('Keyboard shortcuts');
    opener.focus();
    fireEvent.click(opener);
    const keys = screen.getByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(document.activeElement).toBe(keys);
    // The table starts waiting for my pick: its panel opens by itself, under the shortcuts.
    rerender(<Page pick />);
    expect(screen.getAllByRole('dialog').map((d) => d.getAttribute('aria-label'))).toEqual(['Pick the next game', 'Keyboard shortcuts']);
    expect(document.activeElement).toBe(keys);
    tab();
    expect(document.activeElement).toBe(screen.getByText('Done'));
    // Closing the shortcuts gives focus to the picker, still open, rather than to the page behind it.
    fireEvent.click(screen.getByText('Done'));
    const picker = screen.getByRole('dialog', { name: 'Pick the next game' });
    expect(document.activeElement).toBe(picker);
    tab();
    expect(document.activeElement).toBe(screen.getByText('Razz'));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("leaves focus and Escape with a phone's sheet when the picker opens later in the page but under it", () => {
    // The chat sheet comes before the picker in the page, but sheets are drawn over dialogs.
    function Page({ pick }: { pick: boolean }) {
      const [chat, setChat] = useState(true);
      const [picking, setPicking] = useState(true);
      return (
        <>
          {chat && (
            <Sheet title="Chat" onClose={() => setChat(false)}>
              <input aria-label="Chat message" />
              <button>Send</button>
            </Sheet>
          )}
          {pick && picking && (
            <Modal title="Pick the next game" onClose={() => setPicking(false)}>
              <button>Razz</button>
            </Modal>
          )}
        </>
      );
    }
    const { rerender } = render(<Page pick={false} />);
    const box = screen.getByLabelText('Chat message');
    box.focus();
    // The table starts waiting for my pick while I'm typing: the phone keyboard stays up.
    rerender(<Page pick />);
    expect(document.activeElement).toBe(box);
    tab();
    expect(document.activeElement).toBe(screen.getByText('Send'));
    // Escape closes the sheet I can see, not the picker under it, which then takes focus.
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Chat' })).toBeNull();
    const picker = screen.getByRole('dialog', { name: 'Pick the next game' });
    expect(document.activeElement).toBe(picker);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it("treats the replayer's \"can't be replayed\" box as a dialog too", () => {
    // React reports the error it caught; the replayer shows its fallback instead.
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      function Page() {
        const [open, setOpen] = useState(false);
        return (
          <>
            <button onClick={() => setOpen(true)}>Replay</button>
            {open && <Replayer hands={[{} as HandRecordView]} start={0} tableName="Poker night" seatCount={6} myId="p0" fmt={String} onClose={() => setOpen(false)} />}
          </>
        );
      }
      render(<Page />);
      const opener = screen.getByText('Replay');
      opener.focus();
      fireEvent.click(opener);
      const dialog = screen.getByRole('dialog', { name: 'Hand replay' });
      expect(dialog.textContent).toContain('can’t be replayed');
      expect(dialog.getAttribute('aria-modal')).toBe('true');
      expect(document.activeElement).toBe(dialog);
      fireEvent.click(screen.getByText('Close'));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(document.activeElement).toBe(opener);
    } finally {
      quiet.mockRestore();
    }
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

  it("warns when ten seconds are left to pick the next game (Dealer's choice)", () => {
    vi.useFakeTimers();
    try {
      const now = Date.now();
      const choice = (deadline: number | null) => ({ chip: 0, current: null, handsLeft: 0, next: null, open: true, deadline, count: 3, cap: null, closed: false, defaultIndex: 0, canKeep: true });
      const before = tableView({ hand: { phase: 'complete' }, view: { choice: choice(null) } });
      const { rerender } = render(<TableAnnouncer view={before} fmt={String} skew={0} preQueued={{ current: false }} />);
      const said = () => [...screen.getByRole('log').querySelectorAll('p')].map((p) => p.textContent);
      act(() => rerender(<TableAnnouncer view={tableView({ hand: { phase: 'complete' }, view: { choice: choice(now + 20_000) } })} fmt={String} skew={0} preQueued={{ current: false }} />));
      expect(said()).toEqual(['Your pick: choose the next game.']);
      act(() => vi.advanceTimersByTime(9_000));
      expect(said()).toHaveLength(1);
      act(() => vi.advanceTimersByTime(1_500));
      expect(said()).toEqual(['Your pick: choose the next game.', '10 seconds left to pick.']);
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

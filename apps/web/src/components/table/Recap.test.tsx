// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '@rsdp/engine/settings';
import type { HandRecordView, LedgerView, SeatView, TableView } from '@rsdp/engine/wire';
import { chipFormat } from '../../format';
import { SidePanel } from '../SidePanel';

// The ledger reaches the server only through call() (the hands, for the recap): a spy answers here.
const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../../socket', () => ({
  call,
  socket: { on: () => {}, off: () => {}, emit: () => {}, connected: false },
  currentSession: () => null,
  onSession: () => () => {},
}));
// The ledger's check against the public record asks the server too; it never answers here.
vi.mock('../../audit', async (original) => ({ ...(await original<typeof import('../../audit')>()), tableChips: () => new Promise(() => {}) }));

const fmt = chipFormat(true);

function row(name: string, buyIn: number, stack: number, extra: Partial<LedgerView> = {}): LedgerView {
  return { playerId: `id-${name}`, name, buyIn, cashOut: 0, stack, net: stack - buyIn, ...extra };
}

function seat(n: number, name: string): SeatView {
  return {
    seat: n, playerId: `id-${name}`, name, stack: 2000, sittingOut: false, sitOutReason: null, online: true, inHand: false, folded: false, allIn: false, bet: 0, cards: [],
    lastAction: null, timeBank: 30, leaving: false, owesBlinds: false, waiting: false, waitForBigBlind: false, straddle: false, nitOptIn: false, nit: null, won: 0,
    handName: null, avatar: null, mood: null,
  };
}

let tableNo = 0;
/** A cash table at dollars and cents where Ann is up $5 and Bo down $5, the game stopped. A fresh table id each time. */
function tableView(view: Partial<TableView> = {}): TableView {
  const settings = defaultSettings('cash');
  settings.stakes = { ...settings.stakes, centsMode: true };
  return {
    id: `t${++tableNo}`, name: 'Thursday game', mode: 'cash', tournamentId: null, hostId: 'id-Ann', isHost: false, realGame: true, powers: [], coHosts: [],
    me: { playerId: 'id-Bo', seat: 1 }, settings, pendingSettings: null, started: false, paused: false, stopAfterHand: false, recordsLocked: false,
    seats: [seat(0, 'Ann'), seat(1, 'Bo')], hand: null, legal: null, canDraw: null, canVoteRunItTwice: false, canShow: [], turn: null, nextHandAt: null, serverNow: 0,
    rabbit: { available: false, cards: null }, nit: null, rakeTotal: null, bombPotNext: false, upcoming: null, level: null, requests: [],
    ledger: [row('Bo', 2000, 1500), row('Ann', 2000, 2500)], chat: [], log: [], settingsLog: [], history: [], watchers: [], waitlist: [], offers: [], muted: [],
    spectator: null, cardsWatched: null, fair: { nextCommit: '', handCommit: null, openThrough: 0 },
    ...view,
  };
}

const START = Date.UTC(2026, 10, 5, 20);
function handRecord(handNumber: number, winner: number, amount: number): HandRecordView {
  return {
    handNumber, startedAt: START + (handNumber - 1) * 120_000, endedAt: START + handNumber * 120_000, gameName: "No Limit Hold'em", betting: 'no-limit',
    stakes: defaultSettings('cash').stakes, button: 0,
    seats: [{ seat: 0, playerId: 'id-Ann', name: 'Ann', stack: 2000 }, { seat: 1, playerId: 'id-Bo', name: 'Bo', stack: 2000 }],
    events: [{ seq: 0, t: 'award', pot: 0, run: 0, board: 0, half: 'scoop', seat: winner, amount }],
  };
}

const ledgerOf = (view: TableView) => render(<SidePanel view={view} fmt={fmt} initialTab="ledger" />);
const box = () => screen.getByLabelText('Recap') as HTMLTextAreaElement;

beforeEach(() => {
  call.mockReset();
  // The panel scrolls to its newest line, which the test page can't do.
  Element.prototype.scrollTo = () => {};
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Copy recap in the ledger', () => {
  it('is offered at a cash table where people have played', () => {
    ledgerOf(tableView());
    expect(screen.getByRole('button', { name: 'Copy recap' })).toBeTruthy();
  });

  it('is not offered at a practice table, at a tournament table, or before anyone buys in', () => {
    ledgerOf(tableView({ realGame: false }));
    expect(screen.queryByRole('button', { name: 'Copy recap' })).toBeNull();
    ledgerOf(tableView({ mode: 'tournament', tournamentId: 'x' }));
    expect(screen.queryByRole('button', { name: 'Copy recap' })).toBeNull();
    ledgerOf(tableView({ ledger: [] }));
    expect(screen.queryByRole('button', { name: 'Copy recap' })).toBeNull();
  });

  it('is offered to a spectator watching on a delay only once the delay is up', () => {
    vi.useFakeTimers();
    ledgerOf(tableView({ me: { playerId: 'id-Cy', seat: null }, spectator: { delaySeconds: 60, seeAll: false, blocked: false } }));
    expect(screen.queryByRole('button', { name: 'Copy recap' })).toBeNull();
    act(() => void vi.advanceTimersByTime(61_000));
    expect(screen.getByRole('button', { name: 'Copy recap' })).toBeTruthy();
  });

  it('shows the recap from the ledger and the hands, and copies it', async () => {
    const hands = [handRecord(1, 0, 400), handRecord(2, 1, 900)];
    call.mockImplementation(async (event: string, args?: { handNumber: number }) =>
      event === 'table:export' ? { hands } : { hand: hands.find((h) => h.handNumber === args?.handNumber) },
    );
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    ledgerOf(tableView({ history: hands.map((h) => ({ handNumber: h.handNumber, endedAt: h.endedAt, gameName: h.gameName })) }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy recap' }));
    await screen.findByLabelText('Recap');
    expect(call).toHaveBeenCalledWith('table:export');
    const text = box().value;
    expect(text).toMatch(/^Thursday game · \w{3}, \w{3} \d+\nNo Limit Hold'em\n2 hands in 4m\n\nAnn \+\$5\nBo -\$5\n\nBiggest pot: \$9 to Bo \(hand 2\)$/);
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Copy' })));
    expect(writeText).toHaveBeenCalledWith(text);
    expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy();
  });

  it('says nothing has been played when no hand has finished, without asking for hands', () => {
    ledgerOf(tableView());
    fireEvent.click(screen.getByRole('button', { name: 'Copy recap' }));
    expect(box().value).toContain('No hands played yet.');
    expect(call).not.toHaveBeenCalled();
  });

  it('selects the text to copy by hand when the browser refuses the clipboard', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: () => Promise.reject(new Error('not allowed')) } });
    const execCommand = vi.fn(() => false);
    document.execCommand = execCommand;
    ledgerOf(tableView());
    fireEvent.click(screen.getByRole('button', { name: 'Copy recap' }));
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Copy' })));
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(document.activeElement).toBe(box());
    expect([box().selectionStart, box().selectionEnd]).toEqual([0, box().value.length]);
    expect(screen.getByText(/the text is selected/)).toBeTruthy();
    // Where the old copy command still works, that counts as copied.
    execCommand.mockReturnValue(true);
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Copy' })));
    expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy();
  });

  it('leaves out the hands when they cannot be loaded, and says so', async () => {
    call.mockRejectedValue(new Error('the host has turned watching off'));
    ledgerOf(tableView({ me: { playerId: 'id-Cy', seat: null }, spectator: { delaySeconds: 0, seeAll: false, blocked: true }, history: [{ handNumber: 1, endedAt: START, gameName: 'x' }] }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy recap' }));
    expect(await screen.findByText(/Couldn't get the hands \(the host has turned watching off\)/)).toBeTruthy();
    expect(box().value).not.toMatch(/hands in|Biggest pot|No hands/);
    expect(box().value).toContain('Ann +$5');
  });
});

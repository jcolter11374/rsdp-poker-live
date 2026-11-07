// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '@rsdp/engine/settings';
import type { HandView, SeatView, TableView } from '@rsdp/engine/wire';
import { stadiumPoint } from './geometry';
import { Table } from './Table';

// Parts of the table (notes, chat bubbles, gestures) listen on the socket when they load; nothing is ever sent on it.
vi.mock('../socket', () => ({
  call: vi.fn(),
  socket: { on: () => {}, off: () => {}, emit: () => {}, connected: false },
  currentSession: () => null,
  onSession: () => () => {},
}));

beforeAll(() => {
  // The page jsdom gives has no ResizeObserver; the table measures nothing there and lays out an 800×500 felt.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

const fmt = (n: number) => String(n);
const W = 800;
const H = 500;

function seatView(seat: number, over: Partial<SeatView> = {}): SeatView {
  return {
    seat,
    playerId: `p${seat}`,
    name: `Player ${seat + 1}`,
    stack: 1500,
    sittingOut: false,
    sitOutReason: null,
    online: true,
    inHand: true,
    folded: false,
    allIn: false,
    bet: 0,
    cards: [
      { card: '??', up: false },
      { card: '??', up: false },
    ],
    lastAction: null,
    timeBank: 30,
    leaving: false,
    owesBlinds: false,
    waiting: false,
    waitForBigBlind: false,
    straddle: false,
    nitOptIn: false,
    nit: null,
    won: 0,
    handName: null,
    avatar: null,
    mood: null,
    ...over,
  };
}

function handView(over: Partial<HandView> = {}): HandView {
  return {
    handNumber: 3,
    gameId: 'nlhe',
    gameName: "No Limit Hold'em",
    shortName: 'NLH',
    family: 'flop',
    betting: 'no-limit',
    stakes: { smallBlind: 10, bigBlind: 20, ante: 0, anteType: 'none', bringIn: 5, smallBet: 20, bigBet: 40 },
    names: {},
    phase: 'betting',
    street: 0,
    streetName: 'Preflop',
    button: 0,
    buttonDead: false,
    smallBlind: null,
    bigBlind: null,
    boards: [[[]]],
    pots: [{ amount: 0, eligible: [] }],
    potTotal: 30,
    toAct: null,
    currentBet: 20,
    drawMax: null,
    runItTwice: { offered: false, votes: {}, deadline: null, times: null },
    showdown: false,
    bombPot: false,
    awards: [],
    events: [],
    ...over,
  };
}

/** Five players at a nine-seat table: seats 1, 3, 5, 6 and 8 (0, 2, 4, 5 and 7 counted from 0). */
const HELD = [0, 2, 4, 5, 7];

function tableView(mode: TableView['mode'], over: Partial<TableView> = {}, seatOver: Record<number, Partial<SeatView>> = {}): TableView {
  return {
    id: 't1',
    name: 'Table 1',
    mode,
    tournamentId: mode === 'tournament' ? 'abc' : null,
    hostId: 'p0',
    isHost: false,
    realGame: true,
    powers: [],
    coHosts: [],
    me: { playerId: 'p4', seat: 4 },
    settings: defaultSettings(mode),
    pendingSettings: null,
    started: true,
    paused: false,
    stopAfterHand: false,
    recordsLocked: true,
    seats: Array.from({ length: 9 }, (_, i) => (HELD.includes(i) ? seatView(i, seatOver[i]) : null)),
    hand: handView(),
    legal: null,
    canDraw: null,
    canVoteRunItTwice: false,
    canShow: [],
    turn: null,
    nextHandAt: null,
    serverNow: 0,
    rabbit: { available: false, cards: null },
    nit: null,
    rakeTotal: null,
    bombPotNext: false,
    upcoming: null,
    level: null,
    requests: [],
    ledger: [],
    chat: [],
    log: [],
    settingsLog: [],
    history: [],
    watchers: [],
    waitlist: [],
    offers: [],
    muted: [],
    spectator: null,
    cardsWatched: null,
    fair: { nextCommit: '', handCommit: null, openThrough: 0 },
    ...over,
  };
}

/** Where each drawn seat is, by seat number. */
function placed(container: HTMLElement): Map<number, { x: number; y: number }> {
  const out = new Map<number, { x: number; y: number }>();
  container.querySelectorAll<HTMLElement>('.seat[data-seat]').forEach((el) => out.set(Number(el.dataset.seat), { x: parseFloat(el.style.left), y: parseFloat(el.style.top) }));
  return out;
}

/** Expects the seats, in this order round the table from the bottom, to be spaced evenly. */
function expectEven(at: Map<number, { x: number; y: number }>, order: number[]) {
  expect([...at.keys()].sort()).toEqual([...order].sort());
  order.forEach((seat, i) => {
    const want = stadiumPoint(i / order.length, W, H);
    expect(at.get(seat)!.x).toBeCloseTo(want.x, 5);
    expect(at.get(seat)!.y).toBeCloseTo(want.y, 5);
  });
}

describe('Table: empty seats (#303)', () => {
  it('draws no empty seats at a tournament table, and spreads the players evenly with yours at the bottom', () => {
    const { container } = render(<Table view={tableView('tournament')} skew={0} fmt={fmt} />);
    expect(container.querySelectorAll('.seat.empty')).toHaveLength(0);
    expectEven(placed(container), [4, 5, 7, 0, 2]);
    expect(container.querySelector('.seat.me')?.getAttribute('data-seat')).toBe('4');
  });

  it('keeps the numbered empty seats at a cash table', () => {
    const { container } = render(<Table view={tableView('cash')} skew={0} fmt={fmt} />);
    const empty = [...container.querySelectorAll('.seat.empty')].map((e) => e.textContent);
    expect(empty).toEqual(['2', '4', '7', '9']);
    // Your seat is still at the bottom.
    expect(placed(container).get(4)).toEqual(stadiumPoint(0, W, H));
  });

  it('keeps the Sit and + Bot buttons on the empty seats of a cash table', () => {
    const { container } = render(<Table view={tableView('cash', { me: { playerId: 'x', seat: null } })} skew={0} fmt={fmt} onPickSeat={() => {}} onAddBot={() => {}} />);
    expect(container.querySelectorAll('.seat.empty button:not(.add-bot)')).toHaveLength(4);
    expect(container.querySelectorAll('.seat.empty .add-bot')).toHaveLength(4);
  });

  it('gives the room empty seats took to the players at a tournament table', () => {
    const scale = (mode: TableView['mode']) => {
      const { container, unmount } = render(<Table view={tableView(mode)} skew={0} fmt={fmt} />);
      const s = parseFloat((container.querySelector('.felt') as HTMLElement).style.getPropertyValue('--seat-scale'));
      unmount();
      return s;
    };
    expect(scale('tournament')).toBeGreaterThan(scale('cash'));
  });

  it('puts the first player from seat 1 at the bottom for someone watching a tournament table', () => {
    const view = tableView('tournament', { me: { playerId: 'x', seat: null } }, {});
    view.seats[0] = null;
    const { container } = render(<Table view={view} skew={0} fmt={fmt} />);
    expectEven(placed(container), [2, 4, 5, 7]);
  });

  it('keeps the table turned your way while your seat stays on after you are knocked out', () => {
    const view = tableView('tournament', { me: { playerId: 'p4', seat: null }, hand: handView({ phase: 'complete' }) }, { 4: { departed: 'out', stack: 0 } });
    const { container } = render(<Table view={view} skew={0} fmt={fmt} />);
    expectEven(placed(container), [4, 5, 7, 0, 2]);
    expect(container.querySelector('.seat[data-seat="4"]')?.classList.contains('departed')).toBe(true);
    // Someone else's knocked-out seat doesn't turn the table.
    const watching = tableView('tournament', { me: { playerId: 'x', seat: null }, hand: handView({ phase: 'complete' }) }, { 4: { departed: 'out', stack: 0 } });
    const other = render(<Table view={watching} skew={0} fmt={fmt} />);
    expectEven(placed(other.container), [0, 2, 4, 5, 7]);
  });

  it('puts a dead button on an empty seat between the players either side of it', () => {
    // Seat index 3 is empty and has the button, between seat index 2 and yours (index 4).
    const view = tableView('tournament', { hand: handView({ button: 3, buttonDead: true }) });
    const { container } = render(<Table view={view} skew={0} fmt={fmt} />);
    const button = container.querySelector<HTMLElement>('.dealer.dead');
    expect(button).not.toBeNull();
    const at = placed(container);
    // Yours is at the bottom middle and seat index 2 at the lower right, so the button lands between them.
    const x = parseFloat(button!.style.left);
    expect(x).toBeGreaterThan(at.get(4)!.x);
    expect(x).toBeLessThan(at.get(2)!.x);
  });
});

describe('Table: stud cards in a row over the nameplate (#447)', () => {
  const three = [
    { card: '??', up: false },
    { card: '??', up: false },
    { card: 'Kh', up: true },
  ];
  const cardsOf = (n: number) => Array.from({ length: n }, () => ({ card: '??', up: false }));
  const rows = (gameId: string, n: number) => {
    const view = tableView('cash', { hand: handView({ gameId, family: gameId === 'stud' ? 'stud' : 'flop' }) }, Object.fromEntries(HELD.map((s) => [s, { cards: n === 3 ? three : cardsOf(n) }])));
    const { container, unmount } = render(<Table view={view} skew={0} fmt={fmt} />);
    const out = [...container.querySelectorAll('.seat[data-seat]')].map((el) => el.classList.contains('long-hand'));
    unmount();
    return out;
  };

  it('shows a stud hand as a row from third street, so the cards and nameplates hold still at fifth', () => {
    expect(rows('stud', 3)).toEqual(HELD.map(() => true));
    expect(rows('razz', 4)).toEqual(HELD.map(() => true));
  });

  it("still tucks Hold'em and four-card Omaha cards into the nameplate", () => {
    expect(rows('nlhe', 2)).toEqual(HELD.map(() => false));
    expect(rows('plo4', 4)).toEqual(HELD.map(() => false));
  });
});

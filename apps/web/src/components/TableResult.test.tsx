// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { TableView } from '@rsdp/engine/wire';

// The table reaches the server only through modules that load the socket; nothing is ever sent on it here.
vi.mock('../socket', () => ({
  call: vi.fn(),
  socket: { on: () => {}, off: () => {}, emit: () => {}, connected: false },
  currentSession: () => null,
  onSession: () => () => {},
}));
import { Table } from './Table';

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as never;
});

const BOARD = ['7h', '7d', '3c', 'Qs', '8h'];
const STAKES = { smallBlind: 25, bigBlind: 50, ante: 0, bringIn: 0 };

/**
 * Five seats on the river. Ann (you, seat 0) and Bo bet and called, Cy went all in earlier, Di folded, Ed checked.
 * `phase` 'betting' is the hand's last live view, with each move's line; 'complete' is its result, as the server sends
 * it: the live players' moves cleared, Cy out of chips (knocked out at a tournament, busted at a cash table).
 */
function view(mode: 'cash' | 'tournament', phase: 'betting' | 'complete', winner = 0): TableView {
  const done = phase === 'complete';
  const seat = (i: number, over: object) => ({
    seat: i,
    playerId: 'p' + i,
    name: ['Ann', 'Bo', 'Cy', 'Di', 'Ed'][i],
    stack: 1000,
    sittingOut: false,
    sitOutReason: null,
    online: true,
    inHand: true,
    folded: false,
    allIn: false,
    bet: 0,
    cards: [],
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
  });
  const cards = (c: string[]) => c.map((card) => ({ card, up: false }));
  const out = !done ? { allIn: true, stack: 0, lastAction: 'All in' } : mode === 'tournament' ? { departed: 'out', stack: 0, lastAction: 'All in' } : { sittingOut: true, sitOutReason: 'busted', stack: 0, lastAction: 'All in' };
  const seats = [
    seat(0, { cards: cards(['Qh', 'Qd']), stack: 3000, lastAction: done ? null : 'Bet' }),
    seat(1, { cards: cards(done ? ['7c', '3d'] : ['??', '??']), lastAction: done ? null : 'Call' }),
    seat(2, { cards: cards(done ? ['As', 'Ks'] : ['??', '??']), ...out }),
    seat(3, { cards: cards(['??', '??']), folded: true, lastAction: 'Fold' }),
    seat(4, { cards: cards(done ? ['9h', '9d'] : ['??', '??']), lastAction: done ? null : 'Check' }),
  ];
  return {
    id: 't1',
    name: 'Test',
    mode,
    tournamentId: mode === 'tournament' ? 'T' : null,
    hostId: 'p9',
    isHost: false,
    realGame: true,
    powers: [],
    coHosts: [],
    me: { playerId: 'p0', seat: 0 },
    settings: { stakes: STAKES, table: { felt: 'green' } },
    pendingSettings: null,
    started: true,
    paused: false,
    stopAfterHand: false,
    recordsLocked: true,
    seats,
    legal: null,
    canDraw: null,
    canVoteRunItTwice: false,
    canShow: [],
    turn: null,
    nextHandAt: done ? Date.now() + 6000 : null,
    serverNow: Date.now(),
    rabbit: { available: false, cards: null },
    nit: null,
    rakeTotal: null,
    bombPotNext: false,
    upcoming: null,
    rotation: null,
    choice: null,
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
    hand: {
      handNumber: 7,
      gameId: 'nlhe',
      gameName: "No-Limit Hold'em",
      shortName: 'NLHE',
      family: 'flop',
      betting: 'no-limit',
      stakes: STAKES,
      names: { 0: 'Ann', 1: 'Bo', 2: 'Cy', 3: 'Di', 4: 'Ed' },
      phase,
      street: 3,
      streetName: 'river',
      button: 3,
      buttonDead: false,
      smallBlind: null,
      bigBlind: null,
      boards: [[BOARD]],
      pots: [],
      potTotal: done ? 0 : 2400,
      toAct: done ? null : 1,
      currentBet: 0,
      drawMax: null,
      runItTwice: { offered: false, votes: {}, deadline: null, times: null },
      showdown: done,
      bombPot: false,
      awards: done ? [{ pot: 0, run: 0, board: 0, half: 'high', seat: winner, amount: 2400, handName: 'Full House, Queens full of Sevens', cards: [] }] : [],
      events: [{ seq: 1, t: 'action', seat: 2, action: { type: 'call' }, amount: 1000, allIn: true }],
    },
  } as unknown as TableView;
}

const seatEl = (c: HTMLElement, i: number) => c.querySelector<HTMLElement>(`.seat[data-seat="${i}"]`)!;

/** The table on the river, then at its result: as a page sees a hand end. */
function toResult(mode: 'cash' | 'tournament', compact: boolean, winner = 0) {
  const r = render(<Table view={view(mode, 'betting', winner)} skew={0} fmt={String} compact={compact} />);
  r.rerender(<Table view={view(mode, 'complete', winner)} skew={0} fmt={String} compact={compact} />);
  return r.container;
}

describe('a shown hand and a player out of chips at the result (#455)', () => {
  for (const mode of ['cash', 'tournament'] as const) {
    it(`on a phone (${mode}): the hand's name is on a tab, and no nameplate gains a line`, () => {
      const c = toResult(mode, true);
      expect(seatEl(c, 1).querySelector('.shown-tab')?.textContent).toBe('Full House');
      expect(seatEl(c, 4).querySelector('.shown-tab')?.textContent).toBe('Two Pair');
      expect(seatEl(c, 0).querySelector('.shown-tab')).toBeNull(); // the winner: the result line names their hand
      expect(seatEl(c, 3).querySelector('.shown-tab')).toBeNull(); // folded
      expect(c.querySelectorAll('.nameplate .status')).toHaveLength(0);
      expect(c.querySelectorAll('.nameplate .pill')).toHaveLength(0);
      expect(seatEl(c, 2).querySelector('.stack')?.textContent).toBe(mode === 'cash' ? 'Busted' : 'Knocked out');
      expect(seatEl(c, 2).classList.contains('went-all-in')).toBe(true);
    });

    it(`on a phone (${mode}): each nameplate keeps the lines it showed on the river, unseen`, () => {
      const c = toResult(mode, true);
      // The server cleared these moves when the river's betting ended; their room stays until the next deal.
      expect(seatEl(c, 0).querySelector('.last-action.kept')?.textContent).toBe('Bet');
      expect(seatEl(c, 1).querySelector('.last-action.kept')?.textContent).toBe('Call');
      expect(seatEl(c, 4).querySelector('.last-action.kept')?.textContent).toBe('Check');
      expect(seatEl(c, 1).querySelector('.last-action.kept')?.getAttribute('aria-hidden')).toBe('true');
      // No live line is left beside it, and nothing kept from another hand.
      expect(c.querySelectorAll('.nameplate > .last-action:not(.kept)')).toHaveLength(0);
    });

    it(`on a phone (${mode}): your own seat has no tab, as the bar under the table names your hand`, () => {
      const c = toResult(mode, true, 4);
      expect(seatEl(c, 0).querySelector('.shown-tab')).toBeNull();
      expect(seatEl(c, 1).querySelector('.shown-tab')?.textContent).toBe('Full House');
      expect(seatEl(c, 0).querySelector('.nameplate .status')).toBeNull();
    });

    it(`on a computer (${mode}): as before`, () => {
      const c = toResult(mode, false);
      expect(c.querySelector('.shown-tab')).toBeNull();
      expect(c.querySelector('.went-all-in')).toBeNull();
      expect(c.querySelector('.kept')).toBeNull();
      expect(c.querySelector('.last-action')).toBeNull();
      expect(seatEl(c, 1).querySelector('.nameplate .status')?.textContent).toBe('Full House, Sevens full of Threes');
      if (mode === 'cash') expect(seatEl(c, 2).querySelector('.pill')?.textContent).toBe('Busted');
      else expect(seatEl(c, 2).querySelector('.nameplate .status')?.textContent).toBe('Knocked out');
    });
  }

  it('on a phone, a result seen without its river (the page opened then) keeps no lines', () => {
    const { container } = render(<Table view={view('cash', 'complete')} skew={0} fmt={String} compact />);
    expect(container.querySelector('.kept')).toBeNull();
    expect(seatEl(container, 1).querySelector('.shown-tab')?.textContent).toBe('Full House');
  });
});

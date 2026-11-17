// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { act, fireEvent, render } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { engine, HIDDEN_CARD, type HandState } from '@rsdp/engine/core';
import type { HandRecordView, SeatView, TableView } from '@rsdp/engine/wire';
import { start } from '../../../../packages/engine/test/core/harness';

// The table reaches the server only through modules that load the socket; nothing is ever sent on it here.
vi.mock('../socket', () => ({
  call: vi.fn(),
  socket: { on: () => {}, off: () => {}, emit: () => {}, connected: false },
  currentSession: () => null,
  onSession: () => () => {},
}));
import { Table } from './Table';
import { Replayer } from './Replayer';
import { frameView, replayFrames } from '../replay';
import { useShownTable } from '../runout';
import { handStrength } from '../strength';

const media = (matches: boolean) => ((q: string) => ({ matches, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as never;
const clientRects = Element.prototype.getClientRects;
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
  window.matchMedia ??= media(false);
  // jsdom lays nothing out, so every element has no box. Here an element takes room unless a style hides it, as the
  // all-in stamp's rule in feel.css hides a seat's last move.
  const style = document.createElement('style');
  style.textContent = '.seat.all-in .last-action { display: none; }';
  document.head.append(style);
  Element.prototype.getClientRects = function (this: Element) {
    for (let el: Element | null = this; el; el = el.parentElement) if (getComputedStyle(el).display === 'none') return [] as unknown as DOMRectList;
    return [this.getBoundingClientRect()] as unknown as DOMRectList;
  };
});
afterAll(() => {
  Element.prototype.getClientRects = clientRects;
});

const BOARD = ['7h', '7d', '3c', 'Qs', '8h'];
const STAKES = { smallBlind: 25, bigBlind: 50, ante: 0, bringIn: 0 };

const NAMES = ['Ann', 'Bo', 'Cy', 'Di', 'Ed', 'Flo'];
const seat = (i: number, over: object): SeatView => ({
  seat: i,
  playerId: 'p' + i,
  name: NAMES[i],
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

/**
 * Five seats on the river. Ann (you, seat 0) and Bo bet and called, Cy went all in earlier, Di folded, Ed checked.
 * `phase` 'betting' is the hand's last live view, with each move's line; 'complete' is its result, as the server sends
 * it: the live players' moves cleared, Cy out of chips (knocked out at a tournament, busted at a cash table).
 */
function view(mode: 'cash' | 'tournament', phase: 'betting' | 'complete', winner = 0): TableView {
  const done = phase === 'complete';
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
function toResult(mode: 'cash' | 'tournament', compact: boolean, winner = 0, barNamesHand = false) {
  const r = render(<Table view={view(mode, 'betting', winner)} skew={0} fmt={String} compact={compact} barNamesHand={barNamesHand} />);
  r.rerender(<Table view={view(mode, 'complete', winner)} skew={0} fmt={String} compact={compact} barNamesHand={barNamesHand} />);
  return r.container;
}

/**
 * The table as the server sends it to Ann (seat 0) while the engine plays hand `s` (apps/server/src/runtime/view.ts: the
 * seats and the hand as she sees them; the rest from `view` above), with the clock `turn`. At the result a cash player
 * left with no chips sits out, busted, as the server has them.
 */
function served(s: HandState, turn: TableView['turn'] = null): TableView {
  const me = 0;
  const viewer = { seat: me, seeAll: false };
  const live = s.phase !== 'complete';
  const base = view('cash', live ? 'betting' : 'complete');
  const won = (i: number) => (live ? 0 : s.awards.filter((a) => a.seat === i).reduce((n, a) => n + a.amount, 0));
  const seats = NAMES.map((_, i) => {
    const hs = s.seats.find((x) => x.seat === i);
    if (!hs) return null;
    const cards = hs.cards.map((c, n) => ({ card: c.up || hs.shown.includes(n) || me === i ? c.card : HIDDEN_CARD, up: c.up }));
    const busted = !live && hs.stack === 0 ? { sittingOut: true, sitOutReason: 'busted' } : {};
    return seat(i, { playerId: hs.playerId, stack: hs.stack, folded: hs.folded, allIn: hs.allIn && live, bet: hs.bet, cards, lastAction: hs.lastAction, won: won(i), ...busted });
  });
  return {
    ...base,
    me: { playerId: `p${me}`, seat: me },
    seats,
    turn,
    hand: {
      ...base.hand!,
      handNumber: s.input.handNumber,
      gameId: s.input.game.id,
      family: s.input.game.family,
      betting: s.input.betting,
      stakes: s.input.stakes,
      names: Object.fromEntries(s.seats.map((x) => [x.seat, NAMES[x.seat]])),
      phase: s.phase,
      street: s.street,
      button: s.input.button,
      buttonDead: s.input.buttonDead,
      boards: s.runs.map((run) => run.map((b) => [...b])),
      pots: engine.pots({ ...s, seats: s.seats.map((x) => ({ ...x, total: x.total - x.bet })) }),
      potTotal: s.seats.reduce((n, x) => n + x.total, 0),
      toAct: live ? s.toAct : null,
      currentBet: s.currentBet,
      showdown: s.showdown,
      awards: live ? [] : s.awards,
      events: engine.visibleEvents(s, viewer),
    },
  } as TableView;
}

/**
 * Plays hand `s` to its end, one move at a time: `move` makes each one, by player. Returns the server's view after every
 * move, with the clock `turn` gives then.
 */
function play(s: HandState, move: (id: string, s: HandState) => void, turn: (s: HandState) => TableView['turn'] = () => null): TableView[] {
  const views = [served(s, turn(s))];
  for (let i = 0; i < 80 && s.phase !== 'complete'; i++) {
    move(s.seats.find((x) => x.seat === s.toAct)!.playerId, s);
    views.push(served(s, turn(s)));
  }
  expect(s.phase).toBe('complete');
  return views;
}

const legal = (s: HandState) => engine.legalActions(s, s.toAct!)!;
const checkOrCall = (s: HandState) => engine.act(s, s.toAct!, legal(s).canCheck ? { type: 'check' } : { type: 'call' });
const allIn = (s: HandState) => engine.act(s, s.toAct!, { type: legal(s).raiseKind, to: legal(s).maxTo } as never);

/** The lines in a seat's nameplate that take room (live ones or kept), without the "kept" class, so the two compare. */
const roomLines = (c: HTMLElement, i: number) =>
  [...seatEl(c, i).querySelectorAll<HTMLElement>('.nameplate > :is(.last-action, .low-text, .bank-text)')]
    .filter((l) => l.getClientRects().length > 0)
    .map((l) => `${l.className.replace(/ kept$/, '')}|${l.textContent}`);
const allRoomLines = (c: HTMLElement) => Object.fromEntries([...c.querySelectorAll<HTMLElement>('.seat[data-seat]')].map((el) => [el.dataset.seat, roomLines(c, Number(el.dataset.seat))]));

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

    it(`on a phone (${mode}), where the bar under the table names your hand: your own seat's tab is for a phone on its side`, () => {
      const c = toResult(mode, true, 4, true);
      // styles.css shows the "mine" tab only on a phone on its side, where the bar leaves its hand line out.
      expect(seatEl(c, 0).querySelector('.shown-tab.mine')?.textContent).toBe('Full House');
      expect(seatEl(c, 1).querySelector('.shown-tab')?.textContent).toBe('Full House');
      expect(seatEl(c, 1).querySelector('.shown-tab.mine')).toBeNull();
      expect(seatEl(c, 0).querySelector('.nameplate .status')).toBeNull();
      expect(seatEl(c, 0).querySelector('.last-action.kept')?.textContent).toBe('Bet');
    });

    it(`on a phone (${mode}) with no bar naming your hand (the replayer, a shared hand): your nameplate names it, as before`, () => {
      const c = toResult(mode, true, 4);
      expect(seatEl(c, 0).querySelector('.nameplate .status')?.textContent).toBe('Full House, Queens full of Sevens');
      expect(seatEl(c, 0).querySelector('.shown-tab')).toBeNull();
      // The name stands where the lines kept would have.
      expect(seatEl(c, 0).querySelector('.kept')).toBeNull();
      // Everyone else's is on a tab as usual.
      expect(seatEl(c, 1).querySelector('.shown-tab')?.textContent).toBe('Full House');
      expect(seatEl(c, 1).querySelector('.nameplate .status')).toBeNull();
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

/** The table page's way: the server's table goes through the all-in runout's reveal, then onto a phone's table. */
function Page({ live }: { live: TableView }) {
  const { view: shown } = useShownTable(live);
  return <Table view={shown!} skew={0} fmt={String} compact barNamesHand />;
}

/** Each view in turn on one phone table, as a page sees them arrive. */
function playedOn(views: TableView[]) {
  const r = render(<Table view={views[0]} skew={0} fmt={String} compact barNamesHand />);
  for (const v of views.slice(1)) r.rerender(<Table view={v} skew={0} fmt={String} compact barNamesHand />);
  return r;
}

describe("a phone nameplate keeps the all-in stamp's width only if it had it in the hand's last live view (#455)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("hold'em: a shove whose unmatched chips came back has no stamp by then, so it doesn't keep the stamp's width", () => {
    vi.useFakeTimers();
    // Ann folds, Bo shoves 2000 and Cy calls all in for 800: 1200 goes back to Bo, who is no longer all in.
    const s = start({ stacks: [2000, 2000, 800], button: 0 });
    const views = play(s, (id, s) => (id === 'p0' ? engine.act(s, s.toAct!, { type: 'fold' }) : id === 'p1' ? allIn(s) : checkOrCall(s)));
    expect(s.events.some((e) => e.t === 'uncalled' && e.seat === 1)).toBe(true);
    const r = render(<Page live={views.at(-2)!} />);
    const c = r.container;
    expect(seatEl(c, 1).classList.contains('all-in')).toBe(true);
    // The hand ends with Cy's call. The page deals the runout a street at a time: Bo has his chips back, so no stamp.
    r.rerender(<Page live={views.at(-1)!} />);
    expect(c.querySelector('.pot.result')).toBeNull();
    expect(seatEl(c, 1).classList.contains('all-in')).toBe(false);
    expect(seatEl(c, 2).classList.contains('all-in')).toBe(true);
    for (let i = 0; i < 30 && !c.querySelector('.pot.result'); i++) act(() => vi.advanceTimersByTime(1000));
    expect(c.querySelector('.pot.result')).not.toBeNull();
    expect(seatEl(c, 1).classList.contains('went-all-in')).toBe(false);
    expect(seatEl(c, 2).classList.contains('went-all-in')).toBe(true);
  });

  /**
   * No-limit 2-7 triple draw. Ann folds, Bo shoves 2000 and Cy calls all in for 800, so 1200 goes back to Bo. The draws
   * go on to the end, Bo drawing before Cy. `turn`: Cy's clock on each of his turns.
   */
  const tripleDraw = (turn?: () => TableView['turn']) => {
    const s = start({ game: 'td27', betting: 'no-limit', stacks: [2000, 2000, 800], button: 0 });
    return play(
      s,
      (id, s) =>
        s.phase === 'drawing' ? engine.draw(s, s.toAct!, id === 'p1' ? [0] : [0, 1]) : id === 'p0' ? engine.act(s, s.toAct!, { type: 'fold' }) : id === 'p1' && legal(s).canRaise ? allIn(s) : checkOrCall(s),
      (s) => (turn && s.phase !== 'complete' && s.toAct === 2 ? turn() : null),
    );
  };

  it('2-7 triple draw: the shove whose chips came back keeps its last draw\'s line, and the player all in the stamp\'s width', () => {
    const views = tripleDraw();
    const last = views.at(-2)!;
    // On the last draw Bo, with chips again, shows "Draw 1"; Cy has the stamp, which hides his line.
    expect(last.seats[1]).toMatchObject({ allIn: false, lastAction: 'Draw 1' });
    expect(last.seats[2]).toMatchObject({ allIn: true, lastAction: 'Draw 2' });
    const r = playedOn(views.slice(0, -1));
    const before = allRoomLines(r.container);
    expect(before[1]).toEqual(['last-action a-draw|Draw 1']);
    expect(before[2]).toEqual([]);
    r.rerender(<Table view={views.at(-1)!} skew={0} fmt={String} compact barNamesHand />);
    const c = r.container;
    expect(c.querySelector('.pot.result')).not.toBeNull();
    // Every nameplate takes the room it took: Bo's line is kept, and the line the stamp hid isn't (it took none).
    expect(allRoomLines(c)).toEqual(before);
    expect(seatEl(c, 1).querySelector('.kept')?.textContent).toBe('Draw 1');
    expect(seatEl(c, 2).querySelector('.kept')).toBeNull();
    expect(seatEl(c, 1).classList.contains('went-all-in')).toBe(false);
    expect(seatEl(c, 2).classList.contains('went-all-in')).toBe(true);
  });

  for (const [what, turn, line] of [
    ['its last seconds', () => ({ seat: 2, startedAt: Date.now() - 22_000, deadline: Date.now() + 8_000, usingBank: false }), 'low-text'],
    ['its time bank', () => ({ seat: 2, startedAt: Date.now() - 35_000, deadline: Date.now() + 25_000, usingBank: true }), 'bank-text'],
  ] as const) {
    it(`2-7 triple draw: a player all in, drawing last on ${what}, keeps the clock's line as well as the stamp's width`, () => {
      const views = tripleDraw(turn);
      const r = playedOn(views.slice(0, -1));
      const before = allRoomLines(r.container);
      // The stamp hides Cy's last move, not his clock.
      expect(before[2]).toEqual([expect.stringMatching(new RegExp(`^status ${line}\\|`))]);
      r.rerender(<Table view={views.at(-1)!} skew={0} fmt={String} compact barNamesHand />);
      const c = r.container;
      expect(allRoomLines(c)).toEqual(before);
      expect(seatEl(c, 2).querySelector(`.${line}.kept`)).not.toBeNull();
      expect(seatEl(c, 2).classList.contains('went-all-in')).toBe(true);
    });
  }

  it('no style hides a line kept at the result: each takes the room it took', () => {
    for (const sheet of ['../feel.css', '../styles.css']) expect(readFileSync(new URL(sheet, import.meta.url), 'utf8')).not.toMatch(/\.kept\s*\{[^}]*display:\s*none/);
  });
});

describe('someone new sits down while the result shows (#455)', () => {
  it("their nameplate keeps nothing from the player who sat there before: no line, no stamp's width", () => {
    // Ann (you), Bo and Cy play to the end; Di folds, and Cy goes all in for 600.
    const s = start({ stacks: [2000, 2000, 600, 2000], button: 0 });
    const views = play(s, (id, s) => (id === 'p3' ? engine.act(s, s.toAct!, { type: 'fold' }) : id === 'p2' && legal(s).canRaise ? allIn(s) : checkOrCall(s)));
    const r = playedOn(views.slice(0, -1));
    const c = r.container;
    expect(seatEl(c, 2).classList.contains('all-in')).toBe(true);
    expect(roomLines(c, 3)).toEqual(['last-action a-fold|Fold']);
    const done = views.at(-1)!;
    const show = (v: TableView) => r.rerender(<Table view={v} skew={0} fmt={String} compact barNamesHand />);
    show(done);
    expect(seatEl(c, 2).classList.contains('went-all-in')).toBe(true);
    expect(seatEl(c, 3).querySelector('.kept')?.textContent).toBe('Fold');
    // Cy and Di leave, and Yan and Zed sit down in their seats before the next deal.
    const newcomer = (i: number, name: string) => seat(i, { playerId: name.toLowerCase(), name, stack: 2000, inHand: false, waiting: true });
    show({ ...done, seats: done.seats.map((x, i) => (i === 2 ? newcomer(2, 'Yan') : i === 3 ? newcomer(3, 'Zed') : x)) });
    expect(seatEl(c, 2).querySelector('.name')?.textContent).toBe('Yan');
    for (const i of [2, 3]) {
      expect(seatEl(c, i).classList.contains('went-all-in')).toBe(false);
      expect(seatEl(c, i).querySelector('.kept')).toBeNull();
    }
    // The others keep theirs.
    expect(seatEl(c, 1).querySelector('.kept')).not.toBeNull();
  });
});

/** A finished hand as the hand list has it, seen from `seat`. */
const record = (s: HandState, seat: number | null): HandRecordView => ({
  handNumber: 1,
  startedAt: 0,
  endedAt: 0,
  gameName: s.input.game.name,
  betting: s.input.betting,
  stakes: s.input.stakes,
  button: s.input.button,
  seats: s.seats.map((x) => ({ seat: x.seat, playerId: x.playerId, name: NAMES[x.seat], stack: x.startStack })),
  events: engine.visibleEvents(s, { seat, seeAll: false }),
});

describe('the replayer on a phone (#455)', () => {
  it("keeps the last live step's lines at the result, after jumping to the end and stepping back and on again", () => {
    // Three-handed: a raise and two calls, the flop and turn checked, then a bet, a fold and a call on the river.
    const s = start({ stacks: [200, 200, 200] });
    const moves: ((s: HandState) => void)[] = [
      (s) => engine.act(s, s.toAct!, { type: 'raise', to: 6 }),
      checkOrCall,
      checkOrCall,
      ...Array<(s: HandState) => void>(6).fill(checkOrCall),
      (s) => engine.act(s, s.toAct!, { type: 'bet', to: 10 }),
      (s) => engine.act(s, s.toAct!, { type: 'fold' }),
      checkOrCall,
    ];
    for (const move of moves) move(s);
    expect(s.phase).toBe('complete');
    const h = record(s, 0);
    const frames = replayFrames(h, 'p0', String);
    expect(frames.at(-1)!.done).toBe(true);
    expect(frames.at(-2)!.done).toBe(false);
    // The replayer keeps one table for a hand's every step (Replayer.tsx keys it by hand), as this does.
    const step = (i: number) => <Table view={frameView('T', 3, h, frames.at(i)!, 'p0')} skew={0} fmt={String} compact />;
    const r = render(step(2));
    const c = r.container;
    // Others' lines: your own nameplate names your hand at the result, if you lost (see below).
    const others = () => ({ ...allRoomLines(c), 0: null });
    const early = others();
    r.rerender(step(-1)); // End: the result, reached from an early step, keeps that step's lines.
    expect(others()).toEqual(early);
    r.rerender(step(-2)); // Left: the river's last move.
    const lastLive = others();
    expect(lastLive).not.toEqual(early);
    r.rerender(step(-1)); // Right: the result again.
    expect(others()).toEqual(lastLive);
    r.rerender(step(-2));
    r.rerender(step(-1));
    expect(others()).toEqual(lastLive);
  });

  /** Heads up, checked down, and Ann loses at the showdown. Returns the hand and what Ann made. */
  function lostByAnn(): { s: HandState; made: string } {
    for (const top of [['2c', 'As', '7d', 'Ad'], ['As', '2c', 'Ad', '7d'], ['2c', '7d', 'As', 'Ad'], ['As', 'Ad', '2c', '7d']]) {
      const s = start({ stacks: [100, 100], top });
      while (s.phase !== 'complete') checkOrCall(s);
      if (s.awards.every((a) => a.seat !== 0)) return { s, made: handStrength('nlhe', s.seats[0].cards.map((c) => c.card), s.runs[0][0])! };
    }
    throw new Error('no deal that Ann loses');
  }

  for (const [who, myId, sharerSeat] of [
    ['your own hand', 'p0', null],
    ['a shared hand, the sharer seen by someone else', null, 0],
  ] as const) {
    it(`names ${who} in the nameplate at the result, as there is no bar under the table to name it`, () => {
      const { s, made } = lostByAnn();
      window.matchMedia = media(true);
      try {
        const r = render(<Replayer hands={[record(s, 0)]} start={0} tableName="T" seatCount={2} myId={myId} sharerSeat={sharerSeat} fmt={String} onClose={() => {}} />);
        act(() => {
          fireEvent.keyDown(window, { key: 'End' });
        });
        const c = r.container;
        expect(c.querySelector('.felt.compact .pot.result')).not.toBeNull();
        expect(c.querySelector('.seat.me')?.getAttribute('data-seat')).toBe('0');
        expect(c.querySelector('.seat.me .nameplate .status')?.textContent).toBe(made);
        expect(c.querySelector('.seat.me .shown-tab')).toBeNull();
      } finally {
        window.matchMedia = media(false);
      }
    });
  }
});

describe('a bunched row of cards on a phone (#455)', () => {
  const box = Element.prototype.getBoundingClientRect;
  afterEach(() => {
    Element.prototype.getBoundingClientRect = box;
    delete (document.documentElement as { clientWidth?: number }).clientWidth;
  });

  it("drops the tab over it to meet its smaller cards' suits; a row with its room keeps the tab where it is", () => {
    // A 390px phone. Bo's nameplate sits under Cy's and Ed's, so his cards have only 38px between theirs and bunch up
    // at 25px wide; the others' rows have the room they need.
    Object.defineProperty(document.documentElement, 'clientWidth', { value: 390, configurable: true });
    const plates: Record<number, [number, number, number, number]> = { 0: [150, 226, 600, 650], 1: [100, 176, 200, 250], 2: [40, 116, 150, 200], 3: [300, 376, 400, 450], 4: [160, 236, 150, 200] };
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const at = this.classList.contains('nameplate') ? plates[Number(this.closest<HTMLElement>('.seat[data-seat]')?.dataset.seat)] : undefined;
      const [left, right, top, bottom] = at ?? [0, 0, 0, 0];
      return { left, right, top, bottom, x: left, y: top, width: right - left, height: bottom - top, toJSON() {} } as DOMRect;
    };
    const c = toResult('cash', true);
    expect(seatEl(c, 1).querySelector('.hole')?.classList.contains('bunched')).toBe(true);
    expect(seatEl(c, 1).querySelector<HTMLElement>('.hole')?.style.getPropertyValue('--row-cw')).toBe('25px');
    // A suit ends 3 - 0.34 x 25 px from the nameplate's top: the 12px tab's bottom goes 15 - 8.5 px into it.
    expect(seatEl(c, 1).querySelector<HTMLElement>('.shown-tab')?.style.getPropertyValue('--tab-drop')).toBe('6.5px');
    for (const i of [2, 4]) {
      expect(seatEl(c, i).querySelector('.hole')?.classList.contains('bunched')).toBe(false);
      expect(seatEl(c, i).querySelector('.shown-tab')).not.toBeNull();
      expect(seatEl(c, i).querySelector<HTMLElement>('.shown-tab')?.style.getPropertyValue('--tab-drop')).toBe('');
    }
  });
});

describe('a cash player who busts, on a phone (#455)', () => {
  it('reads "Busted" where the chips were at the result of the hand they busted in, and has the Busted pill from the next deal', () => {
    const r = render(<Table view={view('cash', 'betting')} skew={0} fmt={String} compact />);
    const c = r.container;
    const show = (v: TableView) => r.rerender(<Table view={v} skew={0} fmt={String} compact />);
    show(view('cash', 'complete'));
    expect(seatEl(c, 2).querySelector('.stack')?.textContent).toBe('Busted');
    expect(seatEl(c, 2).querySelector('.pill')).toBeNull();
    // The next hand: Cy sits out, dealt nothing.
    const out = { sittingOut: true, sitOutReason: 'busted', stack: 0, inHand: false, cards: [] };
    const next = (phase: 'betting' | 'complete') => {
      const v = view('cash', phase);
      return { ...v, hand: { ...v.hand!, handNumber: 8 }, seats: v.seats.map((x, i) => (i === 2 ? seat(2, out) : x)) };
    };
    for (const v of [next('betting'), next('complete'), { ...next('complete'), hand: null }]) {
      show(v);
      expect(seatEl(c, 2).querySelector('.pill')?.textContent).toBe('Busted');
      expect(seatEl(c, 2).querySelector('.stack')?.textContent).toBe('0');
      expect(seatEl(c, 2).querySelector('.out-mark')).toBeNull();
    }
  });
});

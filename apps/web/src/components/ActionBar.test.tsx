// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEffect, useRef, type ComponentProps } from 'react';
import type { LegalActions, Stakes } from '@rsdp/engine/core';
import { defaultSettings } from '@rsdp/engine/settings';
import type { HandView, SeatView, TableView } from '@rsdp/engine/wire';
import { ActionBar } from './ActionBar';

// The bar reaches the server only through call(): a spy here that answers at once, unless a test holds the answer back.
const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../socket', () => ({
  call,
  // Modules the bar pulls in start listening on the socket when they load; nothing is ever sent on it.
  socket: { on: () => {}, off: () => {}, emit: () => {}, connected: false },
  currentSession: () => null,
  onSession: () => () => {},
}));

// ---------------------------------------------------------------- the table as Ann (seat 0) sees it

const STAKES: Stakes = { smallBlind: 10, bigBlind: 20, ante: 0, anteType: 'none', bringIn: 5, smallBet: 20, bigBet: 40 };
const NAMES = ['Ann', 'Bo', 'Cy'];
const fmt = (n: number) => String(n);

function seatView(seat: number, over: Partial<SeatView> = {}): SeatView {
  return {
    seat,
    playerId: `p${seat}`,
    name: NAMES[seat],
    stack: 1000,
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

/** Hand 7 of no-limit hold'em at 10/20, on the flop with 200 in the middle. Ann has the button, so Bo acts first, then Cy, then Ann. */
function handView(over: Partial<HandView> = {}): HandView {
  return {
    handNumber: 7,
    gameId: 'nlhe',
    gameName: "No Limit Hold'em",
    shortName: 'NLH',
    family: 'flop',
    betting: 'no-limit',
    stakes: STAKES,
    names: { 0: 'Ann', 1: 'Bo', 2: 'Cy' },
    phase: 'betting',
    street: 1,
    streetName: 'Flop',
    button: 0,
    buttonDead: false,
    smallBlind: 1,
    bigBlind: 2,
    boards: [[['2c', '7d', 'Jh']]],
    pots: [{ amount: 200, eligible: [0, 1, 2] }],
    potTotal: 200,
    toAct: 1,
    currentBet: 0,
    drawMax: null,
    runItTwice: { offered: false, votes: {}, deadline: null, times: null },
    showdown: false,
    bombPot: false,
    awards: [],
    events: [],
    ...over,
  };
}

interface Spot {
  hand?: Partial<HandView> | null;
  /** What Ann may do now: null while it is someone else's turn. */
  legal?: LegalActions | null;
  /** Ann's seat. */
  me?: Partial<SeatView>;
  /** Bo's and Cy's seats. */
  others?: { 1?: Partial<SeatView>; 2?: Partial<SeatView> };
  view?: Partial<TableView>;
}

function tableView({ hand = {}, legal = null, me, others = {}, view }: Spot = {}): TableView {
  const settings = defaultSettings('cash');
  settings.stakes = { ...STAKES, centsMode: false };
  const mine = [
    { card: 'As', up: false },
    { card: 'Kh', up: false },
  ];
  return {
    id: 't1',
    name: 'Poker night',
    mode: 'cash',
    tournamentId: null,
    hostId: 'p1',
    isHost: false,
    realGame: true,
    powers: [],
    coHosts: [],
    me: { playerId: 'p0', seat: 0 },
    settings,
    pendingSettings: null,
    started: true,
    paused: false,
    stopAfterHand: false,
    recordsLocked: true,
    seats: [seatView(0, { cards: mine, ...me }), seatView(1, others[1]), seatView(2, others[2])],
    hand: hand && handView(hand),
    legal,
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
    ...view,
  };
}

// The spots below give Ann the moves the engine's computeLegal gives at 10/20 no limit.

/** Ann's turn after Bo and Cy checked. */
function checkedToMe(over: Partial<HandView> = {}): TableView {
  return tableView({
    hand: { toAct: 0, ...over },
    legal: { canFold: true, canCheck: true, callAmount: 0, canRaise: true, raiseKind: 'bet', minTo: 20, maxTo: 1000, canBringIn: false },
  });
}

/** Ann's turn after Bo bet `bet` and Cy called; Ann has `stack` behind. */
function facingBet(bet: number, stack = 1000): TableView {
  const canRaise = stack > bet;
  return tableView({
    hand: { toAct: 0, currentBet: bet, potTotal: 200 + 2 * bet },
    me: { stack },
    others: { 1: { bet }, 2: { bet } },
    legal: {
      canFold: true,
      canCheck: false,
      callAmount: Math.min(bet, stack),
      canRaise,
      raiseKind: 'raise',
      minTo: canRaise ? Math.min(2 * bet, stack) : 0,
      maxTo: canRaise ? stack : 0,
      canBringIn: false,
    },
  });
}

/** Cy's turn, Ann acts after him; Bo has bet `bet` (0: he checked). */
function waitingOn(bet = 0, street = 1): TableView {
  return tableView({ hand: { toAct: 2, currentBet: bet, potTotal: 200 + bet, street }, others: { 1: { bet } } });
}

// ---------------------------------------------------------------- driving the bar

type Props = Omit<ComponentProps<typeof ActionBar>, 'view'>;

function renderBar(view: TableView, props: Partial<Props> = {}) {
  const all: Props = { fmt, skew: 0, discard: [], clearDiscard: () => {}, ...props };
  const r = render(<ActionBar view={view} {...all} />);
  return { update: (next: TableView, more: Partial<Props> = {}) => r.rerender(<ActionBar view={next} {...all} {...more} />) };
}

/**
 * The bar inside a page that, like TablePage, keeps what onPreAction last said in a ref and reads it in its own
 * effect on each new view. That effect runs after the bar's, in the same commit, and is where TablePage decides
 * on the your-turn sound, so `queuedPerView` holds what the page knew on each view it was given.
 */
function renderInPage(view: TableView) {
  const queuedPerView: boolean[] = [];
  function Page({ view }: { view: TableView }) {
    const queued = useRef(false);
    useEffect(() => {
      queuedPerView.push(queued.current);
    }, [view]);
    return <ActionBar view={view} fmt={fmt} skew={0} discard={[]} clearDiscard={() => {}} onPreAction={(q) => (queued.current = q)} />;
  }
  const r = render(<Page view={view} />);
  return { update: (next: TableView) => r.rerender(<Page view={next} />), queuedPerView };
}

// Taken before the fake timers go in: one real task lets every promise callback already queued run.
const realSetTimeout = globalThis.setTimeout;
/** Lets the answers already given come back, and the bar redraw for them. */
const settle = () => act(() => new Promise<void>((resolve) => realSetTimeout(resolve, 0)));

/** Taps a button, then lets the answer to whatever it sent come back. */
async function tap(name: string | RegExp) {
  fireEvent.click(screen.getByRole('button', { name }));
  await settle();
}

/** Moves the clock on by `ms`, running the timers due. */
async function later(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
  await settle();
}

/** Every move sent (hand:act), oldest first. */
const moves = () => call.mock.calls.filter(([event]) => event === 'hand:act').map(([, move]) => move);

/** The words on the buttons in one part of the bar, without the keyboard hints. */
const labels = (part: string) =>
  Array.from(document.querySelectorAll(`.action-bar ${part} button`), (b) =>
    Array.from(b.childNodes)
      .filter((n) => n.nodeName !== 'KBD')
      .map((n) => n.textContent)
      .join('')
      .trim(),
  );

/** A promise for call() to return that answers only when the test says. */
function held() {
  let ok = () => {};
  const promise = new Promise<object>((resolve) => {
    ok = () => resolve({});
  });
  return {
    promise,
    answer: () => {
      ok();
      return settle();
    },
  };
}

const box = () => screen.getByRole('spinbutton', { name: /^Amount/ }) as HTMLInputElement;

beforeEach(() => {
  vi.useFakeTimers();
  call.mockReset();
  call.mockResolvedValue({});
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------- tests

describe('double taps and moves in flight', () => {
  it('ignores a second tap within half a second of a move, but not one after', async () => {
    renderBar(checkedToMe());
    await tap('Check');
    expect(moves()).toEqual([expect.objectContaining({ type: 'check' })]);
    await later(300);
    await tap('Check');
    expect(moves()).toHaveLength(1);
    await later(250);
    await tap('Check');
    expect(moves()).toHaveLength(2);
  });

  it('sends one move at a time: nothing goes while the last is unanswered, and the answer frees the buttons', async () => {
    const answer = held();
    call.mockReturnValueOnce(answer.promise);
    renderBar(facingBet(100));
    await tap('Call 100');
    expect(document.querySelector('.action-bar.sending')).not.toBeNull();
    await later(1000);
    await tap('Raise to 200');
    expect(moves()).toEqual([expect.objectContaining({ type: 'call' })]);
    await answer.answer();
    expect(document.querySelector('.action-bar.sending')).toBeNull();
    await tap('Raise to 200');
    expect(moves()).toEqual([expect.objectContaining({ type: 'call' }), expect.objectContaining({ type: 'raise', to: 200 })]);
  });

  it('says so when the table is slow to answer, and gives the buttons back if it never does', async () => {
    call.mockReturnValueOnce(new Promise(() => {}));
    renderBar(checkedToMe());
    await tap('Check');
    await later(2500);
    expect(screen.getByText(/your connection seems slow/)).toBeTruthy();
    await later(5500);
    expect(screen.getByText(/No answer from the table/)).toBeTruthy();
    await tap('Check');
    expect(moves()).toHaveLength(2);
  });

  it('frees the buttons when the next turn comes before the answer, but still not within half a second of the move', async () => {
    call.mockReturnValueOnce(new Promise(() => {}));
    const bar = renderBar(checkedToMe());
    await tap('Check');
    // Everyone checked behind her, and the next street's view, with Ann first to act, comes before the answer to her check.
    bar.update(checkedToMe({ street: 2, streetName: 'Turn' }));
    await later(200);
    await tap('Check');
    expect(moves()).toHaveLength(1);
    await later(400);
    await tap('Check');
    expect(moves()).toHaveLength(2);
  });

  // Every table:state carries a new `legal` object, so a chat line (or anyone sitting down) while a move is unanswered
  // must not free the buttons: a tap more than half a second after the move would send a second one.
  it('keeps the buttons held while a move is unanswered when a view that is not a new turn arrives', async () => {
    call.mockReturnValueOnce(new Promise(() => {}));
    const bar = renderBar(facingBet(100));
    await tap('Call 100');
    // The same turn again, with a chat line: the server sends everyone a fresh view for it.
    const same = facingBet(100);
    bar.update({ ...same, chat: [{ at: 1, playerId: 'p1', name: 'Bo', text: 'nice' }] });
    await later(600);
    await tap('Raise to 200');
    expect(moves()).toHaveLength(1);
  });
});

describe('folding when checking is free', () => {
  it('folds at once when there is a bet to call', async () => {
    renderBar(facingBet(100));
    await tap('Fold');
    expect(moves()).toEqual([expect.objectContaining({ type: 'fold' })]);
  });

  it('asks first, ignores a tap within half a second of asking, and folds on the next', async () => {
    renderBar(checkedToMe());
    await tap('Fold');
    expect(moves()).toEqual([]);
    expect(labels('.buttons')).toContain('Fold anyway?');
    await later(300);
    await tap('Fold anyway?');
    expect(moves()).toEqual([]);
    await later(300);
    await tap('Fold anyway?');
    expect(moves()).toEqual([expect.objectContaining({ type: 'fold' })]);
  });

  it('forgets the question on the next street', async () => {
    const bar = renderBar(checkedToMe());
    await tap('Fold');
    bar.update(checkedToMe({ street: 2, streetName: 'Turn' }));
    expect(labels('.buttons')).toEqual(['Fold', 'Check', 'Bet 20']);
  });
});

describe('which buttons show', () => {
  it('offers check and bet when nobody has bet, with the pot presets and the bet box', () => {
    renderBar(checkedToMe());
    expect(labels('.buttons')).toEqual(['Fold', 'Check', 'Bet 20']);
    expect(labels('.presets')).toEqual(['½ pot', '¾ pot', 'Pot', 'All in']);
    expect(box().value).toBe('20');
    expect(screen.getByRole('slider', { name: 'Bet size' })).toBeTruthy();
  });

  it('offers fold, call and raise facing a bet', () => {
    renderBar(facingBet(100));
    expect(labels('.buttons')).toEqual(['Fold', 'Call 100', 'Raise to 200']);
  });

  it('says a call is all in when it takes every chip, and offers no raise then', () => {
    renderBar(facingBet(300, 150));
    expect(labels('.buttons')).toEqual(['Fold', 'Call 150 (all in)']);
    expect(document.querySelector('.sizing')).toBeNull();
  });

  it('names an all-in raise as all in', async () => {
    renderBar(facingBet(100, 250));
    expect(labels('.presets')).toContain('All in');
    expect(labels('.buttons')).toEqual(['Fold', 'Call 100', 'Raise to 200']);
    await tap('All in');
    expect(labels('.buttons')).toEqual(['Fold', 'Call 100', 'All in 250']);
    await tap('All in 250');
    expect(moves()).toEqual([expect.objectContaining({ type: 'raise', to: 250 })]);
  });

  it('offers just the all-in when the smallest raise is every chip', async () => {
    renderBar(facingBet(100, 180));
    expect(labels('.buttons')).toEqual(['Fold', 'Call 100', 'All in 180']);
    expect(document.querySelector('.sizing')).toBeNull();
    await tap('All in 180');
    expect(moves()).toEqual([expect.objectContaining({ type: 'raise', to: 180 })]);
  });

  it('in fixed limit, offers the one raise with no presets or bet box', async () => {
    renderBar(
      tableView({
        hand: { betting: 'fixed-limit', toAct: 0, currentBet: 20, potTotal: 60 },
        others: { 1: { bet: 20 }, 2: { bet: 20 } },
        legal: { canFold: true, canCheck: false, callAmount: 20, canRaise: true, raiseKind: 'raise', minTo: 40, maxTo: 40, canBringIn: false },
      }),
    );
    expect(labels('.buttons')).toEqual(['Fold', 'Call 20', 'Raise to 40']);
    expect(document.querySelector('.sizing')).toBeNull();
    await tap('Raise to 40');
    expect(moves()).toEqual([expect.objectContaining({ type: 'raise', to: 40 })]);
  });

  it('in a draw game, offers stand pat, or a draw of the cards picked', async () => {
    const draw = (discard: number[]) => {
      const view = tableView({
        hand: { gameId: 'td27', family: 'draw', betting: 'fixed-limit', phase: 'drawing', streetName: 'First draw', boards: [[[]]], toAct: 0 },
        me: { cards: ['2c', '3d', '4h', '7s', 'Kc'].map((card) => ({ card, up: false })) },
      });
      return { ...view, canDraw: { max: 3 } };
    };
    const clearDiscard = vi.fn();
    const bar = renderBar(draw([]), { clearDiscard });
    expect(labels('.buttons')).toEqual(['Clear', 'Stand pat']);
    expect(screen.getByRole('button', { name: 'Clear' }).hasAttribute('disabled')).toBe(true);
    await tap('Stand pat');
    expect(call).toHaveBeenLastCalledWith('hand:draw', expect.objectContaining({ discard: [] }));

    await later(600);
    bar.update(draw([]), { discard: [1, 4] });
    expect(labels('.buttons')).toEqual(['Clear', 'Draw 2']);
    clearDiscard.mockClear();
    await tap('Draw 2');
    expect(call).toHaveBeenLastCalledWith('hand:draw', expect.objectContaining({ discard: [1, 4] }));
    // The picked cards are let go once the table has the draw.
    expect(clearDiscard).toHaveBeenCalledTimes(1);

    bar.update(draw([]), { discard: [0, 1, 2, 3] });
    expect(screen.getByRole('button', { name: 'Draw 4' }).hasAttribute('disabled')).toBe(true);
  });

  it('in stud, offers the bring-in and completing, and no fold', async () => {
    renderBar(
      tableView({
        hand: { gameId: 'stud', family: 'stud', betting: 'fixed-limit', street: 0, streetName: 'Third street', boards: [[[]]], potTotal: 0, toAct: 0 },
        me: {
          cards: [
            { card: '9c', up: false },
            { card: '8d', up: false },
            { card: '2h', up: true },
          ],
        },
        legal: { canFold: false, canCheck: false, callAmount: 0, canRaise: true, raiseKind: 'bet', minTo: 20, maxTo: 20, canBringIn: true },
      }),
    );
    expect(labels('.buttons')).toEqual(['Bring in 5', 'Complete to 20']);
    await tap('Bring in 5');
    await later(600);
    await tap('Complete to 20');
    expect(moves()).toEqual([expect.objectContaining({ type: 'bring-in' }), expect.objectContaining({ type: 'bet', to: 20 })]);
  });

  it('after the hand, offers to show the cards nobody had to see, together or one at a time', async () => {
    const done = (canShow: number[]) => ({ ...tableView({ hand: { phase: 'complete', toAct: null } }), canShow });
    const bar = renderBar(done([0, 1]));
    expect(labels('.buttons')).toEqual(['Show cards', 'Show A♠', 'Show K♥']);
    await tap('Show cards');
    expect(call).toHaveBeenLastCalledWith('hand:show', expect.objectContaining({ cards: [0, 1] }));
    await later(600);
    await tap('Show K♥');
    expect(call).toHaveBeenLastCalledWith('hand:show', expect.objectContaining({ cards: [1] }));

    bar.update(done([1]));
    expect(labels('.buttons')).toEqual(['Show cards']);
    bar.update(done([]));
    expect(labels('.buttons')).toEqual([]);
  });

  it('asks everyone all in whether to run it twice', async () => {
    renderBar({ ...tableView({ hand: { toAct: null } }), canVoteRunItTwice: true });
    expect(labels('.buttons')).toEqual(['Run it once', 'Run it twice']);
    await tap('Run it twice');
    expect(call).toHaveBeenLastCalledWith('hand:runItTwice', expect.objectContaining({ yes: true }));
  });

  it('shows no buttons once you have folded', () => {
    renderBar(tableView({ me: { folded: true, cards: [] } }));
    expect(document.querySelector('.action-bar.idle')).not.toBeNull();
    expect(document.querySelectorAll('.action-bar button')).toHaveLength(0);
  });
});

describe('the bet box and presets', () => {
  it('bets a share of the pot from the presets, and the button sends that amount', async () => {
    renderBar(checkedToMe());
    await tap('½ pot');
    expect(labels('.buttons')).toContain('Bet 100');
    await tap('¾ pot');
    expect(labels('.buttons')).toContain('Bet 150');
    await tap('Pot');
    expect(labels('.buttons')).toContain('Bet 200');
    await tap('Bet 200');
    await later(600);
    await tap('All in');
    await tap('All in 1000');
    expect(moves()).toEqual([expect.objectContaining({ type: 'bet', to: 200 }), expect.objectContaining({ type: 'bet', to: 1000 })]);
  });

  it('facing a bet, sizes a raise as the call plus that share of the pot after it', async () => {
    // Bo bet 100 and Cy called: 400 in the middle, 500 once Ann calls.
    renderBar(facingBet(100));
    await tap('½ pot');
    expect(labels('.buttons')).toContain('Raise to 350');
    await tap('¾ pot');
    expect(labels('.buttons')).toContain('Raise to 480');
    await tap('Pot');
    await tap('Raise to 600');
    expect(moves()).toEqual([expect.objectContaining({ type: 'raise', to: 600 })]);
  });

  it('rounds a preset to the small blind', async () => {
    renderBar(checkedToMe({ potTotal: 230, pots: [{ amount: 230, eligible: [0, 1, 2] }] }));
    // Half of 230 is 115: 120 to the nearest 10.
    await tap('½ pot');
    expect(labels('.buttons')).toContain('Bet 120');
  });

  it('in pot limit, makes the Pot preset the exact most, and calls the last preset Max', async () => {
    const view = facingBet(100);
    view.hand!.betting = 'pot-limit';
    view.legal = { ...view.legal!, maxTo: 600 };
    renderBar(view);
    expect(labels('.presets')).toEqual(['½ pot', '¾ pot', 'Pot', 'Max']);
    await tap('Pot');
    await tap('Raise to 600');
    expect(moves()).toEqual([expect.objectContaining({ type: 'raise', to: 600 })]);
  });

  it('sends what is typed in the bet box, from the button or with Enter', async () => {
    renderBar(facingBet(100));
    fireEvent.change(box(), { target: { value: '350' } });
    expect(labels('.buttons')).toContain('Raise to 350');
    fireEvent.keyDown(box(), { key: 'Enter' });
    await settle();
    await later(600);
    fireEvent.change(box(), { target: { value: '420' } });
    await tap('Raise to 420');
    expect(moves()).toEqual([expect.objectContaining({ type: 'raise', to: 350 }), expect.objectContaining({ type: 'raise', to: 420 })]);
  });

  it('holds an amount typed past either end to the most or least allowed', async () => {
    renderBar(facingBet(100));
    fireEvent.change(box(), { target: { value: '5000' } });
    await tap('All in 1000');
    await later(600);
    fireEvent.change(box(), { target: { value: '150' } });
    await tap('Raise to 200');
    expect(moves()).toEqual([expect.objectContaining({ type: 'raise', to: 1000 }), expect.objectContaining({ type: 'raise', to: 200 })]);
  });

  it('works in big blinds when amounts are shown in big blinds', async () => {
    renderBar(facingBet(100), { bigBlind: 20 });
    const inBB = screen.getByRole('spinbutton', { name: 'Amount in big blinds' }) as HTMLInputElement;
    expect(inBB.value).toBe('10');
    fireEvent.change(inBB, { target: { value: '17.5' } });
    await tap('Raise to 17.5 BB');
    expect(moves()).toEqual([expect.objectContaining({ type: 'raise', to: 350 })]);
  });

  it('puts the far end of the slider at the most allowed', async () => {
    renderBar(facingBet(100));
    const slider = screen.getByRole('slider', { name: 'Bet size' }) as HTMLInputElement;
    fireEvent.change(slider, { target: { value: slider.max } });
    await tap('All in 1000');
    expect(moves()).toEqual([expect.objectContaining({ type: 'raise', to: 1000 })]);
  });
});

describe('pre-moves', () => {
  it('offers moves that fit what you will face', () => {
    const bar = renderBar(waitingOn(0));
    expect(labels('.buttons')).toEqual(['Check / Fold', 'Check', 'Call any']);
    bar.update(waitingOn(100));
    expect(labels('.buttons')).toEqual(['Fold', 'Call 100', 'Call any']);
  });

  it('sends a ticked pre-move when the turn comes, and a second tap unticks it', async () => {
    const onPreAction = vi.fn();
    const bar = renderBar(waitingOn(0), { onPreAction });
    await tap('Call any');
    expect(screen.getByRole('button', { name: /Call any/ }).getAttribute('aria-pressed')).toBe('true');
    expect(onPreAction).toHaveBeenLastCalledWith(true);
    await tap(/Call any/);
    expect(onPreAction).toHaveBeenLastCalledWith(false);
    await tap('Check');
    expect(moves()).toEqual([]);
    bar.update(checkedToMe());
    await settle();
    expect(moves()).toEqual([expect.objectContaining({ type: 'check' })]);
  });

  it('calls whatever it costs with Call any', async () => {
    const page = renderInPage(waitingOn(100));
    await tap('Call any');
    page.update(facingBet(300));
    await settle();
    expect(moves()).toEqual([expect.objectContaining({ type: 'call' })]);
    // On the view that gave Ann the turn the page knew a move was queued, so it did not call her with the turn sound.
    expect(page.queuedPerView).toEqual([false, true]);
  });

  it('turns check/fold into fold once someone bets, and folds when the turn comes', async () => {
    const bar = renderBar(waitingOn(0));
    await tap('Check / Fold');
    bar.update(waitingOn(100));
    expect(labels('.buttons')).toEqual(['✓ Fold', 'Call 100', 'Call any']);
    bar.update(facingBet(100));
    await settle();
    expect(moves()).toEqual([expect.objectContaining({ type: 'fold' })]);
  });

  it('clears a ticked check when someone bets, so you decide again', async () => {
    const onPreAction = vi.fn();
    const bar = renderBar(waitingOn(0), { onPreAction });
    await tap('Check');
    bar.update(waitingOn(100));
    expect(labels('.buttons')).toEqual(['Fold', 'Call 100', 'Call any']);
    expect(onPreAction).toHaveBeenLastCalledWith(false);
    bar.update(facingBet(100));
    await settle();
    expect(moves()).toEqual([]);
  });

  it('clears a ticked call when someone raises before the turn comes', async () => {
    const onPreAction = vi.fn();
    const bar = renderBar(waitingOn(100), { onPreAction });
    await tap('Call 100');
    bar.update(waitingOn(300));
    expect(labels('.buttons')).toEqual(['Fold', 'Call 300', 'Call any']);
    // Nothing is queued any more, so the page plays the your-turn sound when the turn comes.
    expect(onPreAction).toHaveBeenLastCalledWith(false);
    bar.update(facingBet(300));
    await settle();
    expect(moves()).toEqual([]);
  });

  it('drops a pre-move that no longer fits when the turn comes, and says so before the page picks a sound', async () => {
    const page = renderInPage(waitingOn(100));
    await tap('Call 100');
    // Cy raised to 300, and that view is the one that gives Ann the turn.
    page.update(facingBet(300));
    await settle();
    expect(moves()).toEqual([]);
    // The page already knew on that view that nothing is queued, so it calls Ann with the turn sound.
    expect(page.queuedPerView).toEqual([false, false]);
    expect(labels('.buttons')).toEqual(['Fold', 'Call 300', 'Raise to 600']);
  });

  it('keeps a pre-move for one betting round only', async () => {
    const bar = renderBar(waitingOn(0, 1));
    await tap('Check');
    bar.update(waitingOn(0, 2));
    expect(labels('.buttons')).toEqual(['Check / Fold', 'Check', 'Call any']);
    bar.update(checkedToMe({ street: 2 }));
    await settle();
    expect(moves()).toEqual([]);
  });

  it('does not tick a pre-move with a tap within half a second of a move', async () => {
    const bar = renderBar(checkedToMe());
    await tap('Check');
    bar.update(waitingOn(0, 2));
    await later(200);
    await tap('Check');
    expect(labels('.buttons')).toEqual(['Check / Fold', 'Check', 'Call any']);
    await later(400);
    await tap('Check');
    expect(labels('.buttons')).toEqual(['Check / Fold', '✓ Check', 'Call any']);
  });
});

describe('keyboard', () => {
  const press = async (key: string) => {
    fireEvent.keyDown(window, { key });
    await settle();
  };

  it('checks with K, calls with C, and asks before folding with F', async () => {
    const bar = renderBar(checkedToMe());
    await press('c');
    expect(moves()).toEqual([]);
    await press('k');
    await later(600);
    await press('f');
    expect(labels('.buttons')).toContain('Fold anyway?');
    await later(600);
    await press('f');
    bar.update(facingBet(100));
    await later(600);
    await press('c');
    expect(moves()).toEqual([expect.objectContaining({ type: 'check' }), expect.objectContaining({ type: 'fold' }), expect.objectContaining({ type: 'call' })]);
  });

  it('puts the cursor in the bet box with R, and Enter sends it', async () => {
    renderBar(facingBet(100));
    await press('r');
    expect(document.activeElement).toBe(box());
    // Typing in the box is not a shortcut.
    fireEvent.keyDown(box(), { key: 'f' });
    fireEvent.change(box(), { target: { value: '300' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await settle();
    expect(moves()).toEqual([expect.objectContaining({ type: 'raise', to: 300 })]);
  });

  it('puts the cursor in the bet box when you type a number on your turn, with the old amount selected to be replaced (#320)', async () => {
    renderBar(facingBet(100));
    const ev = new KeyboardEvent('keydown', { key: '3', cancelable: true });
    window.dispatchEvent(ev);
    await settle();
    expect(document.activeElement).toBe(box());
    // The browser types the digit into the box: the shortcut must not swallow it.
    expect(ev.defaultPrevented).toBe(false);
    expect(moves()).toEqual([]);
  });

  it('leaves numbers alone before your turn', async () => {
    renderBar(waitingOn(100));
    await press('3');
    expect(document.activeElement).toBe(document.body);
  });

  it('ticks a pre-move with its key before your turn', async () => {
    renderBar(waitingOn(100));
    await press('c');
    expect(labels('.buttons')).toEqual(['Fold', '✓ Call 100', 'Call any']);
    expect(moves()).toEqual([]);
  });
});

describe('all in with Shift+A pressed twice (#307)', () => {
  const press = async (key: string, over: KeyboardEventInit = {}) => {
    fireEvent.keyDown(window, { key, ...over });
    await settle();
  };
  /** Shift+A, as a browser reports it with Shift held (Caps Lock off). */
  const shiftA = () => press('A', { shiftKey: true });
  /** Shift+A, then Shift+A again after a pause long enough to count as the go-ahead. */
  const shiftATwice = async () => {
    await shiftA();
    await later(400);
    await shiftA();
  };
  /** The line saying what the next Shift+A or Enter sends, or null when nothing is armed. */
  const note = () => document.querySelector('.action-bar .armed-note')?.textContent ?? null;
  /** The words on the button the next Shift+A or Enter presses, which is ringed. */
  const armedButtons = () => labels('.buttons').filter((_, i) => document.querySelectorAll('.action-bar .buttons button')[i].classList.contains('armed'));
  const slider = () => screen.getByRole('slider', { name: 'Bet size' }) as HTMLInputElement;
  /** The bet box, the slider and the raise button as they stand. */
  const sizing = () => ({ box: box().value, slider: slider().value, button: labels('.buttons').at(-1) });
  const HOW = 'Shift+A or Enter sends it, Esc cancels';

  afterEach(() => {
    document.querySelectorAll('.test-extra').forEach((el) => el.remove());
  });

  it('puts every chip in the box with the first Shift+A, says what the second sends, and sends it with the second', async () => {
    renderBar(facingBet(100));
    await shiftA();
    expect(moves()).toEqual([]);
    expect(box().value).toBe('1000');
    expect(slider().value).toBe(slider().max);
    expect(labels('.buttons')).toEqual(['Fold', 'Call 100', 'All in 1000']);
    expect(armedButtons()).toEqual(['All in 1000']);
    expect(note()).toBe(`All in 1000. ${HOW}`);
    await later(400);
    await shiftA();
    expect(moves()).toEqual([expect.objectContaining({ type: 'raise', to: 1000 })]);
    expect(note()).toBeNull();
  });

  it('bets every chip when nobody has bet', async () => {
    renderBar(checkedToMe());
    await shiftATwice();
    expect(moves()).toEqual([expect.objectContaining({ type: 'bet', to: 1000 })]);
  });

  it('takes Shift+A with Caps Lock on too, as the browser then reports a lower-case a with Shift held', async () => {
    renderBar(facingBet(100));
    await press('a', { shiftKey: true });
    await later(400);
    await press('a', { shiftKey: true });
    expect(moves()).toEqual([expect.objectContaining({ type: 'raise', to: 1000 })]);
  });

  it('never arms on a plain a, an A typed with Caps Lock, or with Ctrl, Alt or Cmd held', async () => {
    renderBar(facingBet(100));
    const before = sizing();
    for (const over of [{ key: 'a' }, { key: 'A' }, { key: 'A', shiftKey: true, ctrlKey: true }, { key: 'A', shiftKey: true, altKey: true }, { key: 'A', shiftKey: true, metaKey: true }]) {
      const { key, ...rest } = over;
      await press(key, rest);
      await later(400);
      await press(key, rest);
    }
    expect(note()).toBeNull();
    expect(sizing()).toEqual(before);
    expect(moves()).toEqual([]);
  });

  it('does not count a second Shift+A straight after the first: it stays armed, and the pause starts again', async () => {
    renderBar(facingBet(100));
    await shiftA();
    // Two A's typed in a row, or three: none of them sends.
    await later(100);
    await shiftA();
    await later(250);
    await shiftA();
    expect(moves()).toEqual([]);
    expect(note()).toContain('All in 1000.');
    // 350 ms after the first press but only 250 after the last: still not.
    await later(250);
    await shiftA();
    expect(moves()).toEqual([]);
    await later(300);
    await shiftA();
    expect(moves()).toEqual([expect.objectContaining({ type: 'raise', to: 1000 })]);
  });

  it('lets an Enter straight after the first press go to the page, and puts the box back', async () => {
    const toChat = vi.fn();
    const page = (e: KeyboardEvent) => e.key === 'Enter' && !e.defaultPrevented && toChat();
    window.addEventListener('keydown', page);
    try {
      renderBar(facingBet(100));
      const before = sizing();
      await shiftA();
      await later(100);
      await press('Enter');
      expect(moves()).toEqual([]);
      expect(note()).toBeNull();
      expect(sizing()).toEqual(before);
      expect(toChat).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('keydown', page);
    }
  });

  it('lets it go after about three seconds with no second press, putting the box back; the next Shift+A only arms it', async () => {
    renderBar(facingBet(100));
    fireEvent.change(box(), { target: { value: '300' } });
    const before = sizing();
    expect(before.button).toBe('Raise to 300');
    await shiftA();
    await later(2_900);
    expect(note()).toContain('All in 1000.');
    await later(200);
    expect(note()).toBeNull();
    expect(sizing()).toEqual(before);
    await shiftA();
    expect(moves()).toEqual([]);
    expect(note()).toContain('All in 1000.');
  });

  it("says so on the bar's top line, in place of the hand's strength, so the bar grows no taller", async () => {
    const view = facingBet(100);
    view.turn = { seat: 0, startedAt: 0, deadline: 60_000, usingBank: false };
    renderBar(view);
    const bar = document.querySelector('.action-bar')!;
    const lines = () => Array.from(bar.children, (c) => c.classList[0]);
    const before = lines();
    expect(document.querySelector('.bar-head .strength')?.textContent).toBe('Ace high');
    await shiftA();
    expect(lines()).toEqual(before);
    expect(document.querySelector('.bar-head .armed-note')?.textContent).toContain('All in 1000.');
    expect(document.querySelector('.bar-head .strength')).toBeNull();
    expect(screen.getByRole('button', { name: /Time bank/ })).toBeTruthy();
    await press('Escape');
    expect(document.querySelector('.bar-head .strength')?.textContent).toBe('Ace high');
  });

  it('keeps that line on a turn with no Time bank, no Tip and nothing to say about the hand, so arming adds no line there either', async () => {
    // Preflop, no turn clock, no coach: on the develop branch the bar had no top line at all here.
    const view = facingBet(100);
    view.hand = { ...view.hand!, street: 0, streetName: 'Preflop', boards: [[[]]] };
    view.seats[0] = { ...view.seats[0]!, cards: [{ card: '9c', up: false }, { card: '4d', up: false }] };
    renderBar(view);
    const bar = document.querySelector('.action-bar')!;
    const lines = () => Array.from(bar.children, (c) => c.classList[0]);
    const before = lines();
    expect(before[0]).toBe('bar-head');
    expect(document.querySelector('.bar-head')?.textContent).toBe('');
    await shiftA();
    expect(lines()).toEqual(before);
    expect(document.querySelector('.bar-head .armed-note')?.textContent).toContain('All in 1000.');
    await press('Escape');
    expect(lines()).toEqual(before);
    expect(document.querySelector('.bar-head')?.textContent).toBe('');
  });

  it('has no top line to keep where Shift+A can do nothing: you may only call, and the call leaves you chips', () => {
    const view = facingBet(100);
    view.hand = { ...view.hand!, street: 0, streetName: 'Preflop', boards: [[[]]] };
    view.seats[0] = { ...view.seats[0]!, cards: [{ card: '9c', up: false }, { card: '4d', up: false }] };
    view.legal = { ...view.legal!, canRaise: false, minTo: 0, maxTo: 0 };
    renderBar(view);
    expect(document.querySelector('.bar-head')).toBeNull();
  });

  it('sends it with Enter too, which the page then leaves alone instead of starting a chat message', async () => {
    // Like TablePage, which starts listening before the bar is drawn (while the table loads), and takes an Enter
    // nobody has used to the chat box.
    const toChat = vi.fn();
    const page = (e: KeyboardEvent) => e.key === 'Enter' && !e.defaultPrevented && toChat();
    window.addEventListener('keydown', page);
    try {
      renderBar(facingBet(100));
      await shiftA();
      await later(400);
      const enter = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
      window.dispatchEvent(enter);
      await settle();
      expect(moves()).toEqual([expect.objectContaining({ type: 'raise', to: 1000 })]);
      expect(enter.defaultPrevented).toBe(true);
      expect(toChat).not.toHaveBeenCalled();
      // With nothing armed, Enter is the page's again.
      await later(600);
      await press('Enter');
      expect(toChat).toHaveBeenCalledTimes(1);
      expect(moves()).toHaveLength(1);
    } finally {
      window.removeEventListener('keydown', page);
    }
  });

  it('lets it go with Escape, putting the box and slider back as they were, and leaves the records panel open', async () => {
    const records = vi.fn();
    // The page closes the records panel on an Escape nobody has used.
    const page = (e: KeyboardEvent) => e.key === 'Escape' && !e.defaultPrevented && records();
    window.addEventListener('keydown', page);
    try {
      renderBar(facingBet(100));
      fireEvent.change(box(), { target: { value: '200' } });
      fireEvent.blur(box());
      const before = sizing();
      expect(before).toEqual({ box: '200', slider: expect.any(String), button: 'Raise to 200' });
      await shiftA();
      expect(sizing()).toEqual({ box: '1000', slider: slider().max, button: 'All in 1000' });
      await press('Escape');
      expect(note()).toBeNull();
      expect(armedButtons()).toEqual([]);
      expect(sizing()).toEqual(before);
      expect(records).not.toHaveBeenCalled();
      // The main button now sends what was there before, not the all-in.
      await tap('Raise to 200');
      expect(moves()).toEqual([expect.objectContaining({ type: 'raise', to: 200 })]);
    } finally {
      window.removeEventListener('keydown', page);
    }
  });

  it('puts back an amount half typed in the box, as typed', async () => {
    renderBar(facingBet(100), { bigBlind: 20 });
    const inBB = screen.getByRole('spinbutton', { name: 'Amount in big blinds' }) as HTMLInputElement;
    fireEvent.change(inBB, { target: { value: '12.5' } });
    await shiftA();
    expect(inBB.value).toBe('50');
    await press('Escape');
    expect(inBB.value).toBe('12.5');
    expect(labels('.buttons').at(-1)).toBe('Raise to 12.5 BB');
  });

  it('after Escape, the next Shift+A arms it again rather than sending', async () => {
    renderBar(facingBet(100));
    await shiftA();
    await later(400);
    await press('Escape');
    await shiftA();
    expect(moves()).toEqual([]);
    expect(note()).toContain('All in 1000');
    await later(400);
    await shiftA();
    expect(moves()).toEqual([expect.objectContaining({ type: 'raise', to: 1000 })]);
  });

  it('lets it go on a click anywhere, or when the window loses focus, putting the box back each time', async () => {
    renderBar(facingBet(100));
    const before = sizing();
    await shiftA();
    fireEvent.pointerDown(document.body);
    await settle();
    expect(note()).toBeNull();
    expect(sizing()).toEqual(before);
    await later(400);
    await shiftA();
    expect(moves()).toEqual([]);
    expect(note()).not.toBeNull();
    fireEvent.blur(window);
    await settle();
    expect(note()).toBeNull();
    expect(sizing()).toEqual(before);
    await later(400);
    await shiftA();
    expect(moves()).toEqual([]);
  });

  it('still sends from a click on the ringed button, which shows the all-in', async () => {
    renderBar(facingBet(100));
    await shiftA();
    const button = screen.getByRole('button', { name: /All in 1000/ });
    fireEvent.pointerDown(button);
    fireEvent.click(button);
    await settle();
    expect(moves()).toEqual([expect.objectContaining({ type: 'raise', to: 1000 })]);
  });

  it('lets it go when another amount is picked, keeping that amount; the next Shift+A only arms it again', async () => {
    renderBar(facingBet(100));
    await shiftA();
    fireEvent.pointerDown(screen.getByRole('button', { name: '½ pot' }));
    await tap('½ pot');
    expect(note()).toBeNull();
    expect(labels('.buttons')).toContain('Raise to 350');
    await later(400);
    await shiftA();
    expect(moves()).toEqual([]);
    expect(box().value).toBe('1000');
    // Picking the all-in again by hand doesn't arm it.
    fireEvent.change(box(), { target: { value: '400' } });
    fireEvent.change(box(), { target: { value: '1000' } });
    await later(400);
    await press('Enter');
    expect(note()).toBeNull();
    expect(moves()).toEqual([]);
  });

  it('lets any other key go and do its own job: C calls rather than going all in', async () => {
    renderBar(facingBet(100));
    await shiftA();
    await press('c');
    expect(note()).toBeNull();
    expect(moves()).toEqual([expect.objectContaining({ type: 'call' })]);
  });

  it('R puts the box back first, so R and Enter send what was there before (#320)', async () => {
    renderBar(facingBet(100));
    fireEvent.change(box(), { target: { value: '300' } });
    await shiftA();
    await press('r');
    expect(note()).toBeNull();
    expect(document.activeElement).toBe(box());
    expect(box().value).toBe('300');
    fireEvent.keyDown(box(), { key: 'Enter' });
    await settle();
    expect(moves()).toEqual([expect.objectContaining({ type: 'raise', to: 300 })]);
  });

  it('is not let go by Shift on the way to the second press, and holding the keys down sends nothing', async () => {
    renderBar(facingBet(100));
    await shiftA();
    await later(400);
    await press('A', { shiftKey: true, repeat: true });
    await press('A', { shiftKey: true, repeat: true });
    await press('Enter', { repeat: true });
    expect(moves()).toEqual([]);
    await press('Shift', { shiftKey: true });
    expect(note()).toContain('All in 1000');
    await shiftA();
    expect(moves()).toEqual([expect.objectContaining({ type: 'raise', to: 1000 })]);
  });

  it('never carries over to a later street, a later hand, or a later turn on the same street', async () => {
    const bar = renderBar(checkedToMe());
    await shiftA();
    // Ann's time ran out and she checked; the view after brings her the next street, with its own bet box.
    bar.update(checkedToMe({ street: 2, streetName: 'Turn' }));
    await settle();
    expect(note()).toBeNull();
    expect(box().value).toBe('20');
    await later(400);
    await shiftA();
    expect(moves()).toEqual([]);
    bar.update(checkedToMe({ handNumber: 8 }));
    await settle();
    expect(note()).toBeNull();
    expect(box().value).toBe('20');
    await later(400);
    await press('Enter');
    await shiftA();
    expect(moves()).toEqual([]);
    // Someone else's turn comes between two of hers on one street: armed for the first, not the second, and the box
    // is back as it was before the first press.
    const between = waitingOn(0, 1);
    between.hand = { ...between.hand!, handNumber: 8 };
    bar.update(between);
    await settle();
    const next = facingBet(100);
    next.hand = { ...next.hand!, handNumber: 8, events: [{ t: 'act' } as never] };
    bar.update(next);
    await settle();
    expect(note()).toBeNull();
    await later(400);
    await press('Enter');
    expect(moves()).toEqual([]);
  });

  it('when the turn passes and comes back on the same street, starts the box where a new turn always does, not all in', async () => {
    const bar = renderBar(facingBet(100));
    fireEvent.change(box(), { target: { value: '300' } });
    await shiftA();
    expect(box().value).toBe('1000');
    // The turn passes (paused, say) and comes back on the same street.
    bar.update(waitingOn(100));
    await settle();
    const again = facingBet(100);
    again.hand = { ...again.hand!, events: [{ t: 'act' } as never] };
    bar.update(again);
    await settle();
    expect(note()).toBeNull();
    expect(box().value).toBe('200');
  });

  it('never carries an armed all-in call over either', async () => {
    const shoved = (over: Partial<HandView>) => {
      const view = facingBet(300, 150);
      view.hand = { ...view.hand!, ...over };
      return view;
    };
    const bar = renderBar(shoved({ events: [{ t: 'act' } as never] }));
    await shiftA();
    expect(note()).toContain('Call 150, all in.');
    // Facing a shove again on the next street, and in the next hand.
    bar.update(shoved({ street: 2, streetName: 'Turn', events: [{ t: 'act' } as never] }));
    await settle();
    expect(note()).toBeNull();
    await later(400);
    await shiftA();
    bar.update(shoved({ handNumber: 8, events: [{ t: 'act' } as never] }));
    await settle();
    expect(note()).toBeNull();
    await later(400);
    await press('Enter');
    expect(moves()).toEqual([]);
  });

  it('is let go by any move, even one made with the mouse', async () => {
    const bar = renderBar(checkedToMe());
    await shiftA();
    await tap('Check');
    expect(moves()).toEqual([expect.objectContaining({ type: 'check' })]);
    expect(note()).toBeNull();
    // The same turn's view again (the check refused, say): the Shift+A pressed before it is gone.
    bar.update(checkedToMe());
    await later(600);
    await shiftA();
    expect(moves()).toHaveLength(1);
  });

  it('in pot limit, puts in the most the pot allows and says that is not all in', async () => {
    const view = facingBet(100);
    view.hand!.betting = 'pot-limit';
    view.legal = { ...view.legal!, maxTo: 600 };
    renderBar(view);
    await shiftA();
    expect(box().value).toBe('600');
    expect(armedButtons()).toEqual(['Raise to 600']);
    expect(note()).toBe(`Raise to 600, the pot-limit most, not all in. ${HOW}`);
    await later(400);
    await press('Enter');
    expect(moves()).toEqual([expect.objectContaining({ type: 'raise', to: 600 })]);
  });

  it('in pot limit with a short stack, says all in when the pot allows every chip', async () => {
    const view = facingBet(100, 450);
    view.hand!.betting = 'pot-limit';
    renderBar(view);
    await shiftA();
    expect(note()).toContain('All in 450.');
  });

  it('when bets are trimmed to what others can call, says it is the most they can call, not all in', async () => {
    const view = checkedToMe();
    view.legal = { ...view.legal!, maxTo: 400 };
    renderBar(view);
    await shiftA();
    expect(note()).toContain('Bet 400, the most others can call, not all in.');
    await later(400);
    await shiftA();
    expect(moves()).toEqual([expect.objectContaining({ type: 'bet', to: 400 })]);
  });

  it('works in big blinds too', async () => {
    renderBar(facingBet(100), { bigBlind: 20 });
    await shiftA();
    expect((screen.getByRole('spinbutton', { name: 'Amount in big blinds' }) as HTMLInputElement).value).toBe('50');
    expect(note()).toContain('All in 50 BB.');
    await later(400);
    await shiftA();
    expect(moves()).toEqual([expect.objectContaining({ type: 'raise', to: 1000 })]);
  });

  it('arms the all-in when the smallest raise is every chip, with no bet box', async () => {
    renderBar(facingBet(100, 180));
    await shiftA();
    expect(armedButtons()).toEqual(['All in 180']);
    await later(400);
    await shiftA();
    expect(moves()).toEqual([expect.objectContaining({ type: 'raise', to: 180 })]);
  });

  it('facing a bet of all your chips or more, arms the call', async () => {
    renderBar(facingBet(300, 150));
    await shiftA();
    expect(moves()).toEqual([]);
    expect(armedButtons()).toEqual(['Call 150 (all in)']);
    expect(note()).toBe(`Call 150, all in. ${HOW}`);
    await later(400);
    await shiftA();
    expect(moves()).toEqual([expect.objectContaining({ type: 'call' })]);
  });

  it('does nothing when you may only call and the call leaves you chips', async () => {
    // Facing an all-in that was not a full raise, after Ann had already acted: she may call or fold, not raise.
    const view = facingBet(100);
    view.legal = { ...view.legal!, canRaise: false, minTo: 0, maxTo: 0 };
    renderBar(view);
    await shiftATwice();
    expect(note()).toBeNull();
    expect(moves()).toEqual([]);
  });

  it('does nothing in fixed limit, where a raise has only one size', async () => {
    renderBar(
      tableView({
        hand: { betting: 'fixed-limit', toAct: 0, currentBet: 20, potTotal: 60 },
        others: { 1: { bet: 20 }, 2: { bet: 20 } },
        legal: { canFold: true, canCheck: false, callAmount: 20, canRaise: true, raiseKind: 'raise', minTo: 40, maxTo: 40, canBringIn: false },
      }),
    );
    await shiftATwice();
    await later(400);
    await press('Enter');
    expect(note()).toBeNull();
    expect(moves()).toEqual([]);
  });

  it('before your turn, A still ticks and unticks Call any, and Shift+A does nothing', async () => {
    const bar = renderBar(waitingOn(100));
    expect(screen.getByRole('button', { name: /Call any/ }).querySelector('kbd')?.textContent).toBe('A');
    await press('a');
    expect(labels('.buttons')).toEqual(['Fold', 'Call 100', '✓ Call any']);
    await press('a');
    expect(labels('.buttons')).toEqual(['Fold', 'Call 100', 'Call any']);
    // Shift+A ticks nothing, so a pair split by the turn coming plays nothing: the second press only arms it.
    await shiftA();
    expect(labels('.buttons')).toEqual(['Fold', 'Call 100', 'Call any']);
    bar.update(facingBet(100));
    await settle();
    expect(moves()).toEqual([]);
    expect(note()).toBeNull();
    await later(400);
    await shiftA();
    expect(moves()).toEqual([]);
    expect(note()).toContain('All in 1000');
  });

  it('plays Call any ticked with A when the turn comes, as before', async () => {
    const bar = renderBar(waitingOn(0));
    await press('A');
    expect(labels('.buttons')).toEqual(['Check / Fold', 'Check', '✓ Call any']);
    bar.update(facingBet(100));
    await settle();
    expect(moves()).toEqual([expect.objectContaining({ type: 'call' })]);
  });

  it('on your turn, a plain A does nothing, as before', async () => {
    renderBar(facingBet(100));
    await press('a');
    expect(note()).toBeNull();
    expect(box().value).toBe('200');
    expect(moves()).toEqual([]);
  });

  it('never fires while typing in the chat box or another box, or behind a dialog', async () => {
    renderBar(facingBet(100));
    const chat = document.createElement('input');
    chat.className = 'test-extra';
    document.body.appendChild(chat);
    chat.focus();
    fireEvent.keyDown(chat, { key: 'A', shiftKey: true });
    await later(400);
    fireEvent.keyDown(chat, { key: 'A', shiftKey: true });
    fireEvent.keyDown(chat, { key: 'Enter' });
    await settle();
    expect(note()).toBeNull();
    expect(moves()).toEqual([]);
    // In the bet box Shift+A is no shortcut either.
    fireEvent.keyDown(box(), { key: 'A', shiftKey: true });
    await settle();
    expect(note()).toBeNull();
    const dialog = document.createElement('div');
    dialog.className = 'modal-backdrop test-extra';
    document.body.appendChild(dialog);
    await shiftA();
    expect(note()).toBeNull();
    // Armed, and then a dialog opens over the table: Enter there is the dialog's, and lets the all-in go.
    dialog.remove();
    await shiftA();
    expect(note()).not.toBeNull();
    document.body.appendChild(dialog);
    await later(400);
    await press('Enter');
    dialog.remove();
    expect(note()).toBeNull();
    await shiftA();
    expect(moves()).toEqual([]);
  });

  it('shows the key on the All in preset, and on Max in pot limit', () => {
    const bar = renderBar(facingBet(100));
    const allIn = screen.getByRole('button', { name: 'All in' });
    expect(allIn.querySelector('kbd')?.textContent).toBe('⇧A');
    expect(allIn.getAttribute('aria-keyshortcuts')).toBe('Shift+A');
    const pl = facingBet(100);
    pl.hand!.betting = 'pot-limit';
    pl.legal = { ...pl.legal!, maxTo: 600 };
    bar.update(pl);
    expect(screen.getByRole('button', { name: 'Max' }).querySelector('kbd')?.textContent).toBe('⇧A');
  });

  describe('in every game it applies to', () => {
    it('Omaha, pot limit', async () => {
      const view = checkedToMe({ gameId: 'plo4', gameName: 'Pot Limit Omaha', betting: 'pot-limit' });
      view.legal = { ...view.legal!, maxTo: 200 };
      renderBar(view);
      await shiftA();
      expect(note()).toContain('Bet 200, the pot-limit most, not all in.');
      await later(400);
      await shiftA();
      expect(moves()).toEqual([expect.objectContaining({ type: 'bet', to: 200 })]);
    });

    const studBringIn = (betting: 'no-limit' | 'pot-limit', maxTo: number, potTotal: number) =>
      tableView({
        hand: { gameId: 'stud', family: 'stud', betting, street: 0, streetName: 'Third street', boards: [[[]]], potTotal, toAct: 0 },
        me: {
          cards: [
            { card: '9c', up: false },
            { card: '8d', up: false },
            { card: '2h', up: true },
          ],
        },
        legal: { canFold: false, canCheck: false, callAmount: 0, canRaise: true, raiseKind: 'bet', minTo: 20, maxTo, canBringIn: true },
      });

    it('no-limit stud: the bring-in seat can open for every chip', async () => {
      // An unusual pairing the game settings gently warn about, but allowed.
      renderBar(studBringIn('no-limit', 1000, 15));
      await shiftA();
      expect(armedButtons()).toEqual(['All in 1000']);
      await later(400);
      await shiftA();
      expect(moves()).toEqual([expect.objectContaining({ type: 'bet', to: 1000 })]);
    });

    it('pot-limit stud: a completion to the pot-limit most says Complete to, as its button does', async () => {
      renderBar(studBringIn('pot-limit', 60, 60));
      await shiftA();
      expect(armedButtons()).toEqual(['Complete to 60']);
      expect(note()).toBe(`Complete to 60, the pot-limit most, not all in. ${HOW}`);
      await later(400);
      await shiftA();
      expect(moves()).toEqual([expect.objectContaining({ type: 'bet', to: 60 })]);
    });

    it('no-limit draw, on a betting round; nothing while drawing', async () => {
      const draw = { gameId: 'td27', family: 'draw' as const, betting: 'no-limit' as const, boards: [[[]]] as HandView['boards'] };
      const drawing = {
        ...tableView({ hand: { ...draw, phase: 'drawing', streetName: 'First draw', toAct: 0 }, me: { cards: ['2c', '3d', '4h', '7s', 'Kc'].map((card) => ({ card, up: false })) } }),
        canDraw: { max: 5 },
      };
      const bar = renderBar(drawing);
      await shiftATwice();
      expect(note()).toBeNull();
      expect(call).not.toHaveBeenCalled();
      bar.update(checkedToMe({ ...draw, street: 2, streetName: 'Second betting round' }));
      await shiftATwice();
      expect(moves()).toEqual([expect.objectContaining({ type: 'bet', to: 1000 })]);
    });

    it('a bomb pot', async () => {
      renderBar(checkedToMe({ bombPot: true }));
      await shiftATwice();
      expect(moves()).toEqual([expect.objectContaining({ type: 'bet', to: 1000 })]);
    });

    it("mixed games follow the hand being played, not the table's settings", async () => {
      // The table's settings say no limit, but this hand of the mix is limit: nothing.
      const bar = renderBar(
        tableView({
          hand: { betting: 'fixed-limit', toAct: 0 },
          legal: { canFold: true, canCheck: true, callAmount: 0, canRaise: true, raiseKind: 'bet', minTo: 20, maxTo: 20, canBringIn: false },
        }),
      );
      await shiftA();
      expect(note()).toBeNull();
      // The next hand of the mix is no limit, though the settings now say limit.
      const nl = checkedToMe({ handNumber: 8 });
      nl.settings.game.betting = 'fixed-limit';
      bar.update(nl);
      await shiftATwice();
      expect(moves()).toEqual([expect.objectContaining({ type: 'bet', to: 1000 })]);
    });
  });
});

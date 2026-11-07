import { describe, expect, it } from 'vitest';
import { registerAllVariants } from '@rsdp/engine/variants';
import { engine, runoutSteps, variants } from '@rsdp/engine/core';
import type { HandEvent, HandState } from '@rsdp/engine/core';
import type { TableView } from '@rsdp/engine/wire';
import { start as startHand } from '../../../packages/engine/test/core/harness';
import { announcements, spokenCards, spokenLine, turnText } from './announce';
import { holdBack, type Frozen } from './runout';
import { CHECKED_TO_ME, seatView, tableView } from './test-table';

registerAllVariants(variants);
const fmt = (n: number) => String(n);

const start: HandEvent = {
  seq: 0,
  t: 'hand-start',
  handId: 'h8',
  handNumber: 8,
  gameId: 'nlhe',
  betting: 'no-limit',
  stakes: { smallBlind: 10, bigBlind: 20, ante: 0, anteType: 'none', bringIn: 5, smallBet: 20, bigBet: 40 },
  button: 0,
  buttonDead: false,
  seats: [],
  boards: 1,
  bombPot: false,
};
const act = (seq: number, seat: number, action: 'fold' | 'check' | 'call' | 'bet' | 'raise', to = 0): HandEvent => ({ seq, t: 'action', seat, action, amount: to, to, allIn: false, auto: false });
const board = (seq: number, cards: string[]): HandEvent => ({ seq, t: 'board', run: 0, board: 0, cards });

describe('cards and log lines read aloud', () => {
  it('names cards in words, a comma between them', () => {
    expect(spokenCards('Flop: [2c] [7d] [Jh]')).toBe('Flop: 2 of clubs, 7 of diamonds, jack of hearts');
    expect(spokenCards('You are dealt [As] [Th]')).toBe('You are dealt ace of spades, 10 of hearts');
  });

  it('drops the log\'s rules, dots and hash signs', () => {
    expect(spokenLine("--- Hand #8 · No Limit Hold'em 10/20 · bomb pot")).toBe("Hand 8, No Limit Hold'em 10/20, bomb pot");
    expect(spokenLine('— Third Street —')).toBe('Third Street');
  });
});

describe('what the table says', () => {
  it('says nothing on the first view, so arriving mid-hand reads nothing out', () => {
    expect(announcements(null, tableView({ hand: { events: [act(1, 1, 'check')] } }), fmt)).toEqual([]);
  });

  it('reads each new move and card as it comes, and nothing it has already read', () => {
    const before = tableView({ hand: { events: [start, board(1, ['2c', '7d', 'Jh'])] } });
    const after = tableView({ hand: { events: [start, board(1, ['2c', '7d', 'Jh']), act(2, 1, 'bet', 40), act(3, 2, 'call', 40)] } });
    expect(announcements(before, after, fmt)).toEqual(['Bo bets 40', 'Cy calls 40']);
    const turn = tableView({ hand: { events: [...after.hand!.events, board(4, ['Qs'])] } });
    // Named as the log names it: the fourth card is the turn.
    expect(announcements(after, turn, fmt)).toEqual(['Turn: queen of spades']);
    expect(announcements(turn, turn, fmt)).toEqual([]);
  });

  it('reads a new hand from its start, with your own cards', () => {
    const before = tableView({ hand: { handNumber: 7, events: [start] } });
    const deal: HandEvent = { seq: 1, t: 'deal', seat: 0, cards: [{ card: 'As', up: false }, { card: 'Kh', up: false }] };
    // Bo's cards are face down to Ann: nothing is said about them.
    const theirs: HandEvent = { seq: 2, t: 'deal', seat: 1, cards: [{ card: '??', up: false }, { card: '??', up: false }] };
    const after = tableView({ hand: { handNumber: 8, events: [start, deal, theirs] } });
    expect(announcements(before, after, fmt)).toEqual(["Hand 8, No Limit Hold'em 10/20", 'You are dealt ace of spades, king of hearts']);
  });

  it('calls your turn with what you can do and the pot', () => {
    const before = tableView({ hand: { events: [start, act(1, 1, 'check')] } });
    const mine = tableView({ hand: { toAct: 0, events: [start, act(1, 1, 'check'), act(2, 2, 'check')] }, legal: CHECKED_TO_ME });
    expect(announcements(before, mine, fmt)).toEqual(['Cy checks', 'Your turn: check or bet 20 up to 1000. Pot 200.']);
    // Facing a bet: call, raise or fold.
    const facing = { ...CHECKED_TO_ME, canCheck: false, callAmount: 40, raiseKind: 'raise' as const, minTo: 80 };
    expect(turnText(tableView({ hand: {}, legal: facing }), fmt)).toBe('Your turn: call 40, raise to 80 up to 1000 or fold. Pot 200.');
  });

  it('calls a new turn straight after another, as when a check closes the flop and you act first on the turn', () => {
    const flop = tableView({ hand: { toAct: 0, events: [start, act(1, 1, 'check')] }, legal: CHECKED_TO_ME });
    const turn = tableView({ hand: { toAct: 0, events: [start, act(1, 1, 'check'), act(2, 0, 'check'), board(3, ['Qs'])] }, legal: CHECKED_TO_ME });
    expect(announcements(flop, turn, fmt).at(-1)).toMatch(/^Your turn: check/);
    // The same turn, seen again (a chat line arrived), isn't called twice.
    expect(announcements(turn, { ...turn, chat: [] }, fmt)).toEqual([]);
  });

  it("doesn't call a turn a ticked move will answer by itself", () => {
    const before = tableView({ hand: { events: [start] } });
    const mine = tableView({ hand: { toAct: 0, events: [start] }, legal: CHECKED_TO_ME });
    expect(announcements(before, mine, fmt, true)).toEqual([]);
  });

  it('calls the vote on running it twice once, however many others vote meanwhile', () => {
    const before = tableView({ hand: { events: [start] } });
    const vote = tableView({ hand: { events: [start, { seq: 1, t: 'rit-offer', seats: [0, 1] }] }, view: { canVoteRunItTwice: true } });
    expect(announcements(before, vote, fmt).at(-1)).toBe('Your turn: everyone is all in. Run it once or run it twice?');
    const voted = tableView({ hand: { events: [...vote.hand!.events, { seq: 2, t: 'rit-vote', seat: 1, yes: true }] }, view: { canVoteRunItTwice: true } });
    expect(announcements(vote, voted, fmt)).toEqual(['Bo says yes to running it twice']);
  });

  it('says when the game pauses and starts again', () => {
    const on = tableView({ hand: null });
    const off = tableView({ hand: null, view: { paused: true } });
    expect(announcements(on, off, fmt)).toEqual(['The game is paused.']);
    expect(announcements(off, on, fmt)).toEqual(['The game is back on.']);
  });

  it("says who is picking the next game once the table waits for it (Dealer's choice), and once only", () => {
    const choice = (chip: number | null, deadline: number | null) => ({ chip, current: null, handsLeft: 0, next: null, open: deadline !== null, deadline, count: 3, cap: null, closed: false, defaultIndex: 0, canKeep: true });
    const at = (chip: number | null, deadline: number | null, over: Partial<TableView> = {}) => tableView({ hand: { phase: 'complete' }, view: { choice: choice(chip, deadline), ...over } });
    const before = at(1, null);
    expect(announcements(before, at(1, 20_000), fmt)).toEqual(['Bo is picking the next game']);
    // The clock ticks on, or stands still while paused: nothing new to say.
    expect(announcements(at(1, 20_000), at(1, 20_000, { serverNow: 5_000 }), fmt)).toEqual([]);
    expect(announcements(at(1, 20_000, { paused: true }), at(1, 25_000, { paused: true }), fmt)).toEqual([]);
    // Bo leaves it to Cy, and then it's mine.
    expect(announcements(at(1, 20_000), at(2, 40_000), fmt)).toEqual(['Cy is picking the next game']);
    expect(announcements(before, at(0, 20_000), fmt)).toEqual(['Your pick: choose the next game']);
    // A pick during the last hand of the one before has no clock, and the table doesn't wait for it.
    expect(announcements(before, tableView({ view: { choice: choice(1, null) } }), fmt)).toEqual([]);
  });

  it('reads the result', () => {
    const before = tableView({ hand: { events: [start] } });
    const win: HandEvent = { seq: 1, t: 'award', pot: 0, run: 0, board: 0, half: 'scoop', seat: 2, amount: 240, handName: 'a pair of jacks' };
    expect(announcements(before, tableView({ hand: { phase: 'complete', events: [start, win] } }), fmt)).toEqual(['Cy wins 240 with a pair of jacks']);
  });
});

/** Ann (seat 0) and Bo heads up, all in and called with `boardCards` cards out: the hand arrives finished, runout and all. */
function allIn(boardCards: number, runItTwice: 'off' | 'always'): HandState {
  const s = startHand({ stacks: [100, 100], options: { runItTwice } });
  while (s.runs[0][0].length < boardCards) {
    const legal = engine.legalActions(s, s.toAct!)!;
    engine.act(s, s.toAct!, legal.canCheck ? { type: 'check' } : { type: 'call' });
  }
  engine.act(s, s.toAct!, { type: 'raise', to: engine.legalActions(s, s.toAct!)!.maxTo });
  engine.act(s, s.toAct!, { type: 'call' });
  expect(s.phase).toBe('complete');
  return s;
}

describe('an all-in runout read aloud', () => {
  const isBoard = (line: string) => /^(Flop|Turn|River|Board)\b/.test(line);
  for (const [cards, runItTwice, what] of [
    [0, 'always', 'before the flop, run twice'],
    [3, 'off', 'on the flop, run once'],
  ] as const) {
    it(`reads each street only as the table deals it, and who won only once the result shows (all in ${what})`, () => {
      const s = allIn(cards, runItTwice);
      const live = tableView({ hand: { handNumber: 1, phase: 'complete', showdown: true, boards: s.runs, pots: [], potTotal: 0, awards: [], events: s.events } });
      const steps = runoutSteps(s.events);
      expect(steps.length).toBeGreaterThan(1);
      const frozen: Frozen = { logCut: 0, seats: live.seats, ledger: [], me: live.me, nit: null };
      // What TablePage hands the announcer: the table just before the last call, the runout as it is revealed a
      // step at a time (useRunoutReveal's holdBack), then the finished hand once the reveal ends.
      const called = s.events.map((e) => e.t).lastIndexOf('action');
      const pre: TableView = { ...live, hand: { ...live.hand!, phase: 'betting', events: s.events.slice(0, called) } };
      const shown = [pre, ...Array.from({ length: steps.length + 1 }, (_, n) => holdBack(live, frozen, n)), live];
      const said = shown.slice(1).map((v, i) => announcements(shown[i], v, fmt));
      // The call is read straight away, without a card of the runout.
      expect(said[0].some((l) => / calls /.test(l))).toBe(true);
      expect(said[0].filter(isBoard)).toEqual([]);
      // Each step reads its own street and nothing else: one line for each run's board it deals, naming its cards.
      for (let k = 0; k < steps.length; k++) {
        const lines = steps[k].map((e) => expect.stringMatching(new RegExp(`^(Flop|Turn|River)\\b.*: ${spokenCards(e.cards.map((c) => `[${c}]`).join(' '))}$`)));
        expect(said[k + 1]).toEqual(lines);
      }
      // Nobody wins aloud before the result shows; then only the result is read, no street again.
    expect(said.slice(0, -1).flat().filter((l) => / wins /.test(l))).toEqual([]);
      const result = said.at(-1)!;
      expect(result.length).toBeGreaterThan(0);
      expect(result.every((l) => / wins /.test(l))).toBe(true);
    });
  }
});

describe('a stud all-in runout read aloud (#216)', () => {
  it('reads each street only as the table deals it to the seats, and never a card before it shows there', () => {
    const s = startHand({ game: 'stud', betting: 'no-limit', stacks: [50, 50, 50], stakes: { ante: 1, anteType: 'per-player', bringIn: 1, smallBet: 2, bigBet: 4 } });
    // Everyone puts their chips in at the first chance, on third street.
    for (let i = 0; i < 50 && s.phase === 'betting'; i++) {
      const legal = engine.legalActions(s, s.toAct!)!;
      engine.act(s, s.toAct!, legal.canRaise && legal.maxTo > legal.callAmount ? { type: legal.raiseKind, to: legal.maxTo } : { type: 'call' });
    }
    expect(s.phase).toBe('complete');
    // The finished hand as Ann (seat 0) is sent it.
    const events = engine.visibleEvents(s, { seat: 0, seeAll: false });
    const dealt = (seat: number) => events.flatMap((e) => (e.t === 'deal' && e.seat === seat ? e.cards : []));
    const seats = [0, 1, 2].map((seat) => seatView(seat, { cards: dealt(seat) }));
    const hand = { handNumber: 1, gameId: 'stud', gameName: 'Seven Card Stud', family: 'stud' as const, phase: 'complete' as const, showdown: true, boards: [[[]]], pots: [], potTotal: 0, awards: [], events };
    const live = tableView({ hand, seats });
    const steps = runoutSteps(events);
    expect(steps).toHaveLength(4);
    const frozen: Frozen = { logCut: 0, seats: live.seats, ledger: [], me: live.me, nit: null };
    const called = events.map((e) => e.t).lastIndexOf('action');
    const pre: TableView = { ...live, hand: { ...live.hand!, phase: 'betting', events: events.slice(0, called) } };
    const shown = [pre, ...Array.from({ length: steps.length + 1 }, (_, n) => holdBack(live, frozen, n)), live];
    const said = shown.slice(1).map((v, i) => announcements(shown[i], v, fmt));
    const onTable = (v: TableView) => new Set([...v.seats.flatMap((x) => x?.cards.map((c) => c.card) ?? []), ...v.hand!.boards.flat(2)]);
    const named = (lines: string[]) => [...lines.join(' ').matchAll(/\b(ace|king|queen|jack|10|[2-9]) of (clubs|diamonds|hearts|spades)\b/g)].map((m) => m[0]);
    const inWords = (card: string) => spokenCards(`[${card}]`);
    // The call is read straight away, without a card of the runout.
    expect(said[0].some((l) => / calls /.test(l))).toBe(true);
    for (let k = 0; k < steps.length; k++) {
      // Each street reads the cards it deals and no others, each as Ann's screen shows it by then. Seventh street's
      // down cards are turned up at the end, so the finished hand she is sent has them: her seats show them from
      // seventh street on, and that is when they are read.
      const dealtNow = steps[k].flatMap((e) => (e.t === 'deal' ? e.cards.map((c) => c.card) : e.cards)).filter((c) => c !== '??');
      expect(named(said[k + 1]).sort()).toEqual(dealtNow.map(inWords).sort());
      // said[k + 1] is what the move to shown[k + 2] says.
      const visible = [...onTable(shown[k + 2])].filter((c) => c !== '??').map(inWords);
      for (const card of named(said[k + 1])) expect(visible).toContain(card);
    }
    expect(said.slice(0, -1).flat().filter((l) => / wins /.test(l))).toEqual([]);
    expect(said.at(-1)!.some((l) => / wins /.test(l))).toBe(true);
  });
});

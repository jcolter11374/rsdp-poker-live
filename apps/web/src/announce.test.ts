import { describe, expect, it } from 'vitest';
import { registerAllVariants } from '@rsdp/engine/variants';
import { variants } from '@rsdp/engine/core';
import type { HandEvent } from '@rsdp/engine/core';
import { announcements, spokenCards, spokenLine, turnText } from './announce';
import { CHECKED_TO_ME, tableView } from './test-table';

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

  it('reads the result', () => {
    const before = tableView({ hand: { events: [start] } });
    const win: HandEvent = { seq: 1, t: 'award', pot: 0, run: 0, board: 0, half: 'scoop', seat: 2, amount: 240, handName: 'a pair of jacks' };
    expect(announcements(before, tableView({ hand: { phase: 'complete', events: [start, win] } }), fmt)).toEqual(['Cy wins 240 with a pair of jacks']);
  });
});

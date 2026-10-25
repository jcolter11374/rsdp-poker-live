import { describe, expect, it } from 'vitest';
import { PokerTable } from '../src';

function table(stacks: number[], sb = 1, bb = 2) {
  const t = new PokerTable({ smallBlind: sb, bigBlind: bb, maxSeats: 9 });
  stacks.forEach((s, i) => t.sit(i, `p${i}`, `P${i}`, s));
  return t;
}

/** Rigs hole cards and the remaining deck (board is dealt from the end, with burns). */
function rig(t: PokerTable, holes: Record<number, string>, board: string) {
  const hand = t.hand!;
  for (const [seat, cards] of Object.entries(holes)) {
    hand.players.find((p) => p.seat === Number(seat))!.cards = cards.split(' ');
  }
  const [f1, f2, f3, turn, river] = board.split(' ');
  // pop order: burn, f1, f2, f3, burn, turn, burn, river
  hand.deck = [river, 'Xx', turn, 'Xx', f3, f2, f1, 'Xx'];
}

const stack = (t: PokerTable, seat: number) => t.seats[seat]!.stack;
const total = (t: PokerTable) => t.seats.reduce((s, x) => s + (x?.stack ?? 0), 0);

describe('PokerTable', () => {
  it('posts blinds and sets action order for three players', () => {
    const t = table([100, 100, 100]);
    const h = t.startHand();
    expect(h.button).toBe(0);
    expect(h.sbSeat).toBe(1);
    expect(h.bbSeat).toBe(2);
    expect(h.toAct).toBe(0);
    expect(stack(t, 1)).toBe(99);
    expect(stack(t, 2)).toBe(98);
  });

  it('heads up: button is small blind and acts first preflop, last after', () => {
    const t = table([100, 100]);
    const h = t.startHand();
    expect(h.sbSeat).toBe(h.button);
    expect(h.toAct).toBe(h.button);
    t.act(`p${h.button}`, { type: 'call' });
    t.act(`p${h.bbSeat}`, { type: 'check' });
    expect(h.street).toBe('flop');
    expect(h.toAct).toBe(h.bbSeat);
  });

  it('gives the big blind an option', () => {
    const t = table([100, 100, 100]);
    const h = t.startHand();
    t.act('p0', { type: 'call' });
    t.act('p1', { type: 'call' });
    expect(h.street).toBe('preflop');
    expect(h.toAct).toBe(2);
    t.act('p2', { type: 'check' });
    expect(h.street).toBe('flop');
  });

  it('awards the pot when everyone folds and returns the uncalled bet', () => {
    const t = table([100, 100, 100]);
    t.startHand();
    t.act('p0', { type: 'raise', amount: 10 });
    t.act('p1', { type: 'fold' });
    t.act('p2', { type: 'fold' });
    expect(t.hand!.street).toBe('complete');
    expect(stack(t, 0)).toBe(103);
    expect(total(t)).toBe(300);
  });

  it('enforces minimum raises', () => {
    const t = table([100, 100, 100]);
    t.startHand();
    expect(() => t.act('p0', { type: 'raise', amount: 3 })).toThrow(/minimum/);
    t.act('p0', { type: 'raise', amount: 6 }); // raise of 4
    expect(t.legalActions('p1')!.minRaiseTo).toBe(10);
  });

  it('builds side pots and pays each to the right winner', () => {
    // P0 short with the best hand, P1 second best, P2 worst.
    const t = table([20, 100, 100]);
    t.startHand();
    rig(t, { 0: 'Ah Ad', 1: 'Kh Kd', 2: 'Qh Qd' }, '2c 7s 9d Jc 3h');
    t.act('p0', { type: 'raise', amount: 20 }); // all in
    t.act('p1', { type: 'raise', amount: 60 });
    t.act('p2', { type: 'call' });
    // flop: p1 and p2 check it down
    for (const street of ['flop', 'turn', 'river']) {
      expect(t.hand!.street).toBe(street);
      t.act('p1', { type: 'check' });
      t.act('p2', { type: 'check' });
    }
    const h = t.hand!;
    expect(h.street).toBe('complete');
    expect(h.results.map((r) => r.amount)).toEqual([60, 80]);
    expect(stack(t, 0)).toBe(60);
    expect(stack(t, 1)).toBe(40 + 80);
    expect(stack(t, 2)).toBe(40);
    expect(total(t)).toBe(220);
  });

  it('runs out the board when everyone is all in', () => {
    const t = table([50, 50]);
    const h = t.startHand();
    rig(t, { 0: 'Ah Ad', 1: 'Kh Kd' }, '2c 7s 9d Jc 3h');
    t.act(`p${h.button}`, { type: 'raise', amount: 50 });
    t.act(`p${h.bbSeat}`, { type: 'call' });
    expect(h.street).toBe('complete');
    expect(h.board).toHaveLength(5);
    expect(h.showdown).toBe(true);
    expect(stack(t, 0)).toBe(100);
  });

  it('splits a chopped pot', () => {
    const t = table([100, 100]);
    const h = t.startHand();
    rig(t, { 0: '2h 3d', 1: '2s 3c' }, 'Ac Kc Qd Jh Ts');
    t.act(`p${h.button}`, { type: 'call' });
    t.act(`p${h.bbSeat}`, { type: 'check' });
    for (let i = 0; i < 3; i++) {
      t.act(`p${h.bbSeat}`, { type: 'check' });
      t.act(`p${h.button}`, { type: 'check' });
    }
    expect(stack(t, 0)).toBe(100);
    expect(stack(t, 1)).toBe(100);
  });

  it('an incomplete all-in raise does not reopen betting', () => {
    const t = table([100, 100, 13]);
    // Move the button so seat 2 is not in the blinds: button 0 -> sb 1, bb 2. Use hand 2.
    t.startHand();
    t.act('p0', { type: 'fold' });
    t.act('p1', { type: 'fold' });
    const h = t.startHand(); // button 1, sb 2, bb 0
    expect(h.toAct).toBe(1);
    t.act('p1', { type: 'raise', amount: 10 }); // raise of 8
    t.act('p2', { type: 'raise', amount: 14 }); // all in (won 1 last hand), raise of 4 is incomplete
    t.act('p0', { type: 'fold' });
    expect(h.toAct).toBe(1);
    const legal = t.legalActions('p1')!;
    expect(legal.canRaise).toBe(false);
    expect(legal.callAmount).toBe(4);
  });

  it('moves the button and frees a leaving seat after the hand', () => {
    const t = table([100, 100, 100]);
    t.startHand();
    t.stand('p1');
    expect(t.seats[1]).not.toBeNull();
    t.act('p0', { type: 'fold' });
    expect(t.hand!.street).toBe('complete');
    expect(t.seats[1]).toBeNull();
    const h = t.startHand();
    expect(h.button).toBe(2);
  });
});

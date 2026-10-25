import { describe, expect, it } from 'vitest';
import { PokerTable, type Action } from '../src';

/** Small seeded RNG so a failing run can be replayed. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('random play', () => {
  it('keeps every invariant over thousands of hands', () => {
    let hands = 0;
    for (let game = 0; game < 300; game++) {
      const rand = mulberry32(game + 1);
      const ri = (n: number) => Math.floor(rand() * n);
      const players = 2 + ri(8);
      const t = new PokerTable({ smallBlind: 1, bigBlind: 2, maxSeats: 10 }, ri);
      const seats = [...Array(10).keys()].sort(() => rand() - 0.5).slice(0, players);
      seats.forEach((s, i) => t.sit(s, `p${i}`, `P${i}`, 5 + ri(300)));
      const chips = () => t.seats.reduce((s, x) => s + (x?.stack ?? 0), 0);
      const startChips = chips();

      for (let h = 0; h < 30 && t.canStartHand(); h++) {
        const hand = t.startHand();
        let steps = 0;
        while (hand.street !== 'complete') {
          if (++steps > 500) throw new Error(`game ${game} hand ${h} never finished`);
          const seat = hand.toAct;
          expect(seat, `game ${game}: nobody to act mid-hand`).not.toBeNull();
          const hp = hand.players.find((p) => p.seat === seat)!;
          expect(hp.folded || hp.allIn).toBe(false);
          const legal = t.legalActions(hp.playerId)!;
          const roll = rand();
          let action: Action;
          if (roll < 0.15 && !legal.canCheck) action = { type: 'fold' };
          else if (roll < 0.6) action = legal.canCheck ? { type: 'check' } : { type: 'call' };
          else if (legal.canRaise) {
            const span = legal.maxRaiseTo - legal.minRaiseTo;
            const to = rand() < 0.2 ? legal.maxRaiseTo : legal.minRaiseTo + ri(span + 1);
            action = { type: 'raise', amount: to };
          } else action = legal.canCheck ? { type: 'check' } : { type: 'call' };
          t.act(hp.playerId, action);

          // Chips in front of players plus stacks always equal what we started with.
          const inPlay = hand.players.reduce((s, p) => s + p.total, 0);
          if (hand.street !== 'complete') expect(chips() + inPlay).toBe(startChips);
        }
        expect(chips(), `game ${game} hand ${h}: chips not conserved`).toBe(startChips);
        for (const s of t.seats) if (s) expect(s.stack).toBeGreaterThanOrEqual(0);
        const paid = hand.results.reduce((s, r) => s + r.winners.reduce((a, w) => a + w.amount, 0), 0);
        const potTotal = hand.players.reduce((s, p) => s + p.total, 0);
        expect(paid).toBe(potTotal);
        if (hand.showdown) expect(hand.board).toHaveLength(5);
        // Nobody can win more from an opponent than they themselves put in (side-pot rule).
        for (const p of hand.players) {
          const won = hand.results.reduce((s, r) => s + r.winners.filter((w) => w.seat === p.seat).reduce((a, w) => a + w.amount, 0), 0);
          const cap = hand.players.reduce((s, o) => s + Math.min(o.total, p.total), 0);
          expect(won, `game ${game} hand ${h}: seat ${p.seat} over-paid`).toBeLessThanOrEqual(cap);
          if (p.folded) expect(won).toBe(0);
        }
        hands++;
        // No duplicate cards anywhere.
        const all = [...hand.board, ...hand.players.flatMap((p) => p.cards)];
        expect(new Set(all).size).toBe(all.length);
      }
    }
  });
});

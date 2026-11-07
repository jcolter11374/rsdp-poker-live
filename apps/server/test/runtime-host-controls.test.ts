import { beforeAll, describe, expect, it } from 'vitest';
import { runoutMs, variants } from '@rsdp/engine/core';
import { defaultSettings, type TableSettings } from '@rsdp/engine/settings';
import { registerAllVariants } from '@rsdp/engine/variants';
import { HOST_HANDOFF_MS, SEAT_OFFER_MS, TableRuntime } from '../src/runtime/table';
import { tableView } from '../src/runtime/view';
import { maskProfanity } from '../src/runtime/profanity';
import { FakeClock, seeded } from './fake-clock';

beforeAll(() => registerAllVariants(variants));

const PEOPLE = ['host', 'a', 'b', 'c', 'd', 'e'];

function table(patch: (s: TableSettings) => void = () => {}) {
  const clock = new FakeClock();
  const settings = defaultSettings('cash');
  settings.seating.requireApproval = false;
  patch(settings);
  const rt = TableRuntime.create({ id: 't1', hostId: 'host', settings }, { clock, rng: seeded() });
  for (const p of PEOPLE) rt.connect(p);
  return { rt, clock };
}

/** Fills seats 0..n-1 with the first n people. */
function fill(rt: TableRuntime, n: number, stack = 200) {
  PEOPLE.slice(0, n).forEach((id, seat) => rt.requestSeat(id, { seat, name: id.toUpperCase(), stack, consent: true }));
}

const seatOf = (rt: TableRuntime, id: string) => rt.seatOf(id)?.seat ?? null;

/** Plays the current hand out by folding to the big blind. */
function foldOut(rt: TableRuntime) {
  for (let i = 0; i < 20 && rt.state.hand && rt.state.hand.phase !== 'complete'; i++) {
    const seat = rt.state.seats[rt.state.hand.toAct!]!;
    rt.act(seat.playerId, { type: 'fold' });
  }
}

describe('waitlist', () => {
  const full = () => {
    const r = table((s) => {
      s.table.maxSeats = 3;
      s.seating.waitlist = true;
    });
    fill(r.rt, 3);
    return r;
  };

  it('queues people for a full table and holds a freed seat for the first in line', () => {
    const { rt, clock } = full();
    rt.joinWaitlist('c', { name: 'Cat', stack: 150 });
    rt.joinWaitlist('d', { name: 'Dan', stack: 150 });
    expect(rt.state.waitlist!.map((w) => w.playerId)).toEqual(['c', 'd']);
    expect(() => rt.joinWaitlist('c', { name: 'Cat', stack: 150 })).toThrow(/already on the waitlist/);

    rt.stand('a');
    expect(rt.state.offers).toEqual([{ seat: 1, playerId: 'c', expiresAt: clock.now() + SEAT_OFFER_MS }]);
    // Nobody else can take it.
    expect(() => rt.requestSeat('e', { seat: 1, name: 'Eve', stack: 100 })).toThrow(/held for Cat/);
    // Cat takes it with any seat number: the held one is theirs.
    rt.requestSeat('c', { seat: 0, name: 'Cat', stack: 150 });
    expect(seatOf(rt, 'c')).toBe(1);
    expect(rt.state.waitlist!.map((w) => w.playerId)).toEqual(['d']);
    expect(rt.state.offers).toEqual([]);
  });

  it('lets an offer lapse and moves on to the next person', () => {
    const { rt, clock } = full();
    rt.joinWaitlist('c', { name: 'Cat', stack: 150 });
    rt.joinWaitlist('d', { name: 'Dan', stack: 150 });
    rt.stand('b');
    clock.advance(SEAT_OFFER_MS);
    expect(rt.state.waitlist!.map((w) => w.playerId)).toEqual(['d']);
    expect(rt.state.offers!.map((o) => [o.seat, o.playerId])).toEqual([[2, 'd']]);
    expect(rt.state.log.some((l) => /Cat didn't take seat 3/.test(l.text))).toBe(true);
  });

  it('skips people who are offline until they come back', () => {
    const { rt } = full();
    rt.joinWaitlist('c', { name: 'Cat', stack: 150 });
    rt.joinWaitlist('d', { name: 'Dan', stack: 150 });
    rt.disconnect('c');
    rt.stand('a');
    expect(rt.state.offers!.map((o) => o.playerId)).toEqual(['d']);
  });

  it('keeps your earlier seat request when a new one is refused', () => {
    const { rt } = table((s) => {
      s.seating.requireApproval = true;
    });
    rt.requestSeat('host', { seat: 0, name: 'H', stack: 100 });
    rt.requestSeat('a', { seat: 3, name: 'Ann', stack: 100 });
    rt.requestSeat('b', { seat: 5, name: 'Bob', stack: 100 });
    expect(() => rt.requestSeat('a', { seat: 5, name: 'Ann', stack: 100 })).toThrow(/Bob has asked/);
    expect(rt.state.requests.find((r) => r.playerId === 'a')?.seat).toBe(3);
  });

  it('queues someone even when a seat is free, and offers it to them at once', () => {
    // During an all-in runout the browser still shows the table full, so a "there is a free seat" answer would say
    // someone in the hand had busted and left before the cards were out (#437): the answer is the same either way.
    const { rt, clock } = full();
    rt.joinWaitlist('c', { name: 'Cat', stack: 150 });
    rt.stand('b');
    rt.declineOffer('c');
    expect(rt.state.offers).toEqual([]);
    rt.joinWaitlist('d', { name: 'Dan', stack: 150 });
    expect(rt.state.waitlist!.map((w) => w.playerId)).toEqual(['d']);
    expect(rt.state.offers).toEqual([{ seat: 2, playerId: 'd', expiresAt: clock.now() + SEAT_OFFER_MS }]);
    expect(rt.state.log.slice(-2).map((l) => l.text)).toEqual(['Dan joined the waitlist', 'Seat 3 is free: Dan is next on the waitlist']);
    // Taking it is the same as taking any offered seat.
    rt.requestSeat('d', { seat: 0, name: 'Dan', stack: 150 });
    expect(seatOf(rt, 'd')).toBe(2);
    expect(rt.state.waitlist).toEqual([]);
  });

  it('offers a random free seat from the waitlist when the table seats newcomers at random', () => {
    // Otherwise joining the waitlist at a table with free seats would be a way to pick the lowest one.
    const seats = new Set<number>();
    for (let seed = 1; seed <= 12; seed++) {
      const clock = new FakeClock();
      const settings = defaultSettings('cash');
      settings.seating.requireApproval = false;
      settings.seating.waitlist = true;
      settings.seating.randomSeats = true;
      settings.table.maxSeats = 6;
      const rt = TableRuntime.create({ id: 't1', hostId: 'host', settings }, { clock, rng: seeded(seed) });
      for (const p of PEOPLE) rt.connect(p);
      rt.requestSeat('host', { seat: 0, name: 'H', stack: 100 });
      rt.joinWaitlist('c', { name: 'Cat', stack: 150 });
      const offer = rt.state.offers!.find((o) => o.playerId === 'c')!;
      expect(offer.seat).toBeGreaterThan(0);
      rt.requestSeat('c', { seat: 1, name: 'Cat', stack: 150 });
      expect(seatOf(rt, 'c')).toBe(offer.seat);
      seats.add(offer.seat);
    }
    expect(seats.size).toBeGreaterThan(1);
  });

  it('lets go of an offer on a seat a smaller table keeps for a player moving in, and keeps them waiting', () => {
    const { rt, clock } = table((s) => {
      s.table.maxSeats = 6;
      s.seating.waitlist = true;
    });
    // Seats 1, 2, 3, 4 and 6 are taken; Eve joins and is offered seat 5.
    ['host', 'a', 'b', 'c'].forEach((id, seat) => rt.requestSeat(id, { seat, name: id.toUpperCase(), stack: 200 }));
    rt.requestSeat('d', { seat: 5, name: 'D', stack: 200 });
    rt.joinWaitlist('e', { name: 'Eve', stack: 150 });
    expect(rt.state.offers).toEqual([{ seat: 4, playerId: 'e', expiresAt: clock.now() + SEAT_OFFER_MS }]);
    // Mid-hand the host takes the table down to 5 seats: D, in seat 6, will move into seat 5, the only free one.
    rt.start('host');
    rt.updateSettings('host', { table: { maxSeats: 5 } });
    expect(rt.state.offers).toEqual([]);
    expect(rt.state.waitlist!.map((w) => w.playerId)).toEqual(['e']);
    expect(() => rt.requestSeat('e', { seat: 4, name: 'Eve', stack: 150 })).toThrow(/kept for a player moving into it/);
    // A minute later Eve is still waiting, not dropped for letting an offer lapse.
    clock.advance(SEAT_OFFER_MS + 1000);
    expect(rt.state.waitlist!.map((w) => w.playerId)).toEqual(['e']);
    expect(rt.state.log.some((l) => /Eve didn't take/.test(l.text))).toBe(false);
  });

  it('offers the seats again in queue order when an offer is let go, so nobody behind takes the next seat first (#453)', () => {
    const { rt, clock } = table((s) => {
      s.table.maxSeats = 6;
      s.seating.waitlist = true;
    });
    for (const id of ['f', 'g']) rt.connect(id);
    // Seats 1 to 5 are taken. Fay joins and is offered seat 6; then C stands, and Gus, who joined after her, is offered
    // seat 4.
    ['host', 'a', 'b', 'c', 'd'].forEach((id, seat) => rt.requestSeat(id, { seat, name: id.toUpperCase(), stack: 200 }));
    rt.joinWaitlist('f', { name: 'Fay', stack: 150 });
    rt.joinWaitlist('g', { name: 'Gus', stack: 150 });
    rt.stand('c');
    expect(rt.state.offers!.map((o) => [o.playerId, o.seat])).toEqual([['f', 5], ['g', 3]]);
    // Mid-hand the host takes the table down to 5 seats for the next hand. Fay's seat 6 goes, so Gus's offer is let go
    // too, and seat 4 is offered to Fay: she was first. Gus waits, and nobody is dropped from the waitlist.
    rt.start('host');
    rt.updateSettings('host', { table: { maxSeats: 5 } });
    expect(rt.state.offers!.map((o) => [o.playerId, o.seat])).toEqual([['f', 3]]);
    expect(rt.state.waitlist!.map((w) => w.playerId)).toEqual(['f', 'g']);
    expect(() => rt.requestSeat('g', { seat: 3, name: 'Gus', stack: 150 })).toThrow(/held for Fay/);
    clock.advance(1000);
    expect(rt.state.log.some((l) => /didn't take/.test(l.text))).toBe(false);
  });

  it('answers a waitlist join the same whether or not a player in the all-in busted and left', () => {
    // Three seats: the host and two bots on small stacks, no rebuys, so a busted bot leaves as the hand ends.
    const outcomes = new Set<string>();
    for (let seed = 1; seed <= 12; seed++) {
      const clock = new FakeClock();
      const settings = defaultSettings('cash');
      settings.seating.requireApproval = false;
      settings.seating.waitlist = true;
      settings.seating.allowRebuys = false;
      settings.play.runItTwice = 'off';
      settings.table.maxSeats = 3;
      settings.stakes = { ...settings.stakes, smallBlind: 1, bigBlind: 2 };
      const rt = TableRuntime.create({ id: 't1', hostId: 'host', settings }, { clock, rng: seeded(seed) });
      for (const p of PEOPLE) rt.connect(p);
      rt.requestSeat('host', { seat: 0, name: 'H', stack: 200, consent: true });
      rt.addBot('host', { stack: 2 });
      rt.addBot('host', { stack: 2 });
      rt.start('host');
      // The host calls whatever the bots do, until the hand is over and before the next one is dealt.
      for (let i = 0; i < 200 && rt.state.handNumber === 1 && rt.state.hand && rt.state.hand.phase !== 'complete'; i++) {
        const h = rt.state.hand;
        if (h.toAct !== null && rt.state.seats[h.toAct]?.playerId === 'host') rt.act('host', { type: 'call' });
        else clock.advance(500);
      }
      expect(rt.state.hand?.phase).toBe('complete');
      const busted = rt.state.seats.filter(Boolean).length < 3;
      const reveal = runoutMs(rt.state.hand!.events);
      // Asking to join gives the same answer either way: no error, on the waitlist.
      expect(() => rt.joinWaitlist('e', { name: 'Eve', stack: 100 })).not.toThrow();
      expect(rt.state.waitlist!.some((w) => w.playerId === 'e')).toBe(true);
      if (reveal) {
        // And nothing else changes while the runout is dealt out: no seat is offered, even a busted player's.
        expect(rt.state.offers).toEqual([]);
        expect(rt.state.log.at(-1)?.text).toBe('Eve joined the waitlist');
        clock.advance(reveal);
        outcomes.add(busted ? 'busted after a runout' : 'full after a runout');
      }
      // Once it has been shown (or at once, with no runout), a seat that came free is offered.
      expect(rt.state.offers!.some((o) => o.playerId === 'e')).toBe(busted);
      outcomes.add(busted ? 'busted' : 'full');
    }
    // Every case came up among the seeds.
    expect([...outcomes].sort()).toEqual(['busted', 'busted after a runout', 'full', 'full after a runout']);
  });

  /**
   * A cash table of `seats` seats at the end of an all-in runout: the host (seat 1) called two bots on 2 chips
   * (`bots`, seats 2 and 3 unless given), rebuys off, so a bot that busted has left. `before` runs before the hand
   * (to seat or queue others), `during` while it is dealt. Null when this seed's hand ended without a runout.
   */
  function afterRunout(
    seed: number,
    seats: number,
    before: (rt: TableRuntime) => void = () => {},
    patch: (s: TableSettings) => void = () => {},
    { bots = [1, 2], during = () => {} }: { bots?: number[]; during?: (rt: TableRuntime) => void } = {},
  ) {
    const clock = new FakeClock();
    const settings = defaultSettings('cash');
    settings.seating.requireApproval = false;
    settings.seating.waitlist = true;
    settings.seating.allowRebuys = false;
    settings.play.runItTwice = 'off';
    settings.table.maxSeats = seats;
    settings.stakes = { ...settings.stakes, smallBlind: 1, bigBlind: 2 };
    patch(settings);
    const rt = TableRuntime.create({ id: 't1', hostId: 'host', settings }, { clock, rng: seeded(seed) });
    for (const p of PEOPLE) rt.connect(p);
    rt.requestSeat('host', { seat: 0, name: 'H', stack: 200, consent: true });
    for (const seat of bots) rt.addBot('host', { seat, stack: 2 });
    before(rt);
    rt.start('host');
    during(rt);
    for (let i = 0; i < 200 && rt.state.handNumber === 1 && rt.state.hand && rt.state.hand.phase !== 'complete'; i++) {
      const h = rt.state.hand;
      if (h.toAct !== null && rt.state.seats[h.toAct]?.playerId === 'host') rt.act('host', { type: 'call' });
      else clock.advance(500);
    }
    const reveal = rt.state.hand?.phase === 'complete' ? runoutMs(rt.state.hand.events) : 0;
    if (!reveal) return null;
    const busted = bots.filter((i) => !rt.state.seats[i]);
    // How long browsers still have to deal it out (the hand may have ended partway through the last clock step).
    const left = rt.state.history.at(-1)!.endedAt + reveal - clock.now();
    return { rt, clock, left, busted };
  }

  it('keeps the seats of the players in a runout taken until it has been dealt out, bust or not', () => {
    // Seat 4 is empty all along. During the runout Eve joins the waitlist and is offered seat 4 either way; a busted
    // bot's seat is offered (to Dan) only once the runout has had time to show. Fay's Sit presses get the same answers
    // whether or not a bot busted, and so does a bot the host adds.
    const outcomes = new Set<boolean>();
    for (let seed = 1; seed <= 16; seed++) {
      const t = afterRunout(seed, 4);
      if (!t) continue;
      const { rt, clock, left, busted } = t;
      const err = (fn: () => void) => {
        try {
          fn();
          return 'ok';
        } catch (e) {
          return (e as Error).message;
        }
      };
      rt.joinWaitlist('e', { name: 'Eve', stack: 100 });
      rt.joinWaitlist('c', { name: 'Dan', stack: 100 });
      expect(rt.state.offers!.map((o) => [o.playerId, o.seat])).toEqual([['e', 3]]);
      expect(err(() => rt.requestSeat('d', { seat: 3, name: 'Fay', stack: 100 }))).toBe('that seat is being held for Eve from the waitlist');
      expect(err(() => rt.requestSeat('d', { seat: 1, name: 'Fay', stack: 100 }))).toBe('that seat is taken');
      expect(err(() => rt.requestSeat('d', { seat: 2, name: 'Fay', stack: 100 }))).toBe('that seat is taken');
      expect(err(() => rt.addBot('host'))).toBe('every seat is taken');
      expect(err(() => rt.addBot('host', { seat: 1 }))).toBe('that seat is taken');
      expect(left).toBeGreaterThan(1);
      clock.advance(left - 1);
      expect(rt.state.offers!.map((o) => o.playerId)).toEqual(['e']);
      clock.advance(1);
      // Once it has been shown, Dan is offered the first busted bot's seat, if one busted.
      expect(rt.state.offers!.map((o) => [o.playerId, o.seat])).toEqual([['e', 3], ...busted.slice(0, 1).map((i) => ['c', i])]);
      outcomes.add(busted.length > 0);
    }
    expect([...outcomes].sort()).toEqual([false, true]);
  });

  it('offers a seat that comes free during a runout for another reason straight away', () => {
    // Al sits out in seat 4, so he isn't in the hand. He stands up during the runout: his seat goes to the first person
    // waiting at once, as at any other time, and nobody else can take it.
    let ran = 0;
    for (let seed = 1; seed <= 8; seed++) {
      const t = afterRunout(seed, 4, (rt) => {
        rt.requestSeat('a', { seat: 3, name: 'Al', stack: 100 });
        rt.sitOut('a', true);
        rt.joinWaitlist('c', { name: 'Cat', stack: 100 });
      });
      if (!t) continue;
      const { rt, clock } = t;
      expect(rt.state.hand!.seats.map((hs) => hs.seat)).not.toContain(3);
      rt.stand('a');
      expect(rt.state.offers).toEqual([{ seat: 3, playerId: 'c', expiresAt: clock.now() + SEAT_OFFER_MS }]);
      expect(() => rt.requestSeat('d', { seat: 3, name: 'Dee', stack: 100 })).toThrow('that seat is being held for Cat from the waitlist');
      ran++;
    }
    expect(ran).toBeGreaterThan(0);
  });

  it('never draws a busted player\'s seat for a random seat while the runout is dealt out', () => {
    // Random seats, seat 4 empty all along: Dee sits during the runout and always gets seat 4.
    const outcomes = new Set<boolean>();
    for (let seed = 1; seed <= 16; seed++) {
      const t = afterRunout(seed, 4, () => {}, (s) => {
        s.seating.randomSeats = true;
      });
      if (!t) continue;
      t.rt.requestSeat('d', { seat: 3, name: 'Dee', stack: 100 });
      expect(seatOf(t.rt, 'd')).toBe(3);
      outcomes.add(t.busted.length > 0);
    }
    expect([...outcomes].sort()).toEqual([false, true]);
  });

  it("keeps the seats a smaller table keeps for its movers the same during a runout, bust or not", () => {
    // Six seats, going down to five after this hand: Al sits out in the sixth, so he moves. Bots in the all-in sit in
    // seats 4 and 5 and seats 2 and 3 are empty. Seat 3 is kept for Al whether or not a bot busted (a busted bot's
    // seat 5 would otherwise be the highest free seat, and kept instead), so Dee and the waitlist answer the same.
    const outcomes = new Set<boolean>();
    for (let seed = 1; seed <= 16; seed++) {
      const t = afterRunout(
        seed,
        6,
        (rt) => {
          rt.requestSeat('a', { seat: 5, name: 'Al', stack: 100 });
          rt.sitOut('a', true);
        },
        () => {},
        { bots: [3, 4], during: (rt) => rt.updateSettings('host', { table: { maxSeats: 5 } }) },
      );
      if (!t) continue;
      const { rt, busted } = t;
      rt.joinWaitlist('e', { name: 'Eve', stack: 100 });
      expect(rt.state.offers!.map((o) => [o.playerId, o.seat])).toEqual([['e', 1]]);
      expect(() => rt.requestSeat('d', { seat: 2, name: 'Dee', stack: 100 })).toThrow(/kept for a player moving into it/);
      outcomes.add(busted.length > 0);
    }
    expect([...outcomes].sort()).toEqual([false, true]);
  });

  it('still counts a player in a dropped seat as moving during the runout, bust or not', () => {
    // Six seats, going down to five after this hand. A bot in the all-in sits in the sixth seat, so it would move: seat
    // 5 is kept for it whether or not it busted, Eve is offered seat 3, and Dee can't take seat 5.
    const outcomes = new Set<boolean>();
    for (let seed = 1; seed <= 24; seed++) {
      const t = afterRunout(seed, 6, () => {}, () => {}, { bots: [1, 5], during: (rt) => rt.updateSettings('host', { table: { maxSeats: 5 } }) });
      if (!t) continue;
      const { rt, busted } = t;
      rt.joinWaitlist('e', { name: 'Eve', stack: 100 });
      expect(rt.state.offers!.map((o) => [o.playerId, o.seat])).toEqual([['e', 2]]);
      expect(() => rt.requestSeat('d', { seat: 4, name: 'Dee', stack: 100 })).toThrow(/kept for a player moving into it/);
      outcomes.add(busted.includes(5));
    }
    expect([...outcomes].sort()).toEqual([false, true]);
  });

  it('counts each player in the runout once, wherever they sit now, and stops holding seats once a new hand is dealt', () => {
    const seated = (rt: TableRuntime) => (rt as unknown as { seatedCount(): number }).seatedCount();
    let ran = 0;
    for (let seed = 1; seed <= 16; seed++) {
      const t = afterRunout(seed, 4, () => {}, (s) => {
        s.timing.autoStartNextHand = false;
      });
      if (!t || t.busted.length !== 1) continue;
      const { rt, busted } = t;
      // Still three during the runout, with one bot gone; moving the other one doesn't count it twice.
      expect(seated(rt)).toBe(3);
      const other = [1, 2].find((i) => i !== busted[0])!;
      rt.moveSeat('host', rt.state.seats[other]!.playerId, 3);
      expect(seated(rt)).toBe(3);
      // The host deals the next hand straight away: browsers drop the runout, and so does the hold.
      expect(() => rt.requestSeat('d', { seat: busted[0], name: 'Dee', stack: 100 })).toThrow('that seat is taken');
      rt.dealNext('host');
      expect(rt.state.handNumber).toBe(2);
      expect(seated(rt)).toBe(2);
      rt.requestSeat('d', { seat: busted[0], name: 'Dee', stack: 100 });
      expect(seatOf(rt, 'd')).toBe(busted[0]);
      ran++;
    }
    expect(ran).toBeGreaterThan(0);
  });

  it("counts a runout's seats as taken in the count a bigger table will have, bust or not (#459)", () => {
    // Dealer's choice works out the game a missed pick deals on the count the table will have once a waiting change
    // to six seats applies. During the runout, five people wait: three seats a bigger table adds, and up to two seats
    // busted bots leave, all go to people waiting, so the answer is six either way, during the runout and after it.
    const coming = (rt: TableRuntime) => {
      const next = structuredClone(rt.state.settings);
      next.table.maxSeats = 6;
      return (rt as unknown as { comingCount(next: TableSettings): number }).comingCount(next);
    };
    const outcomes = new Set<boolean>();
    for (let seed = 1; seed <= 16; seed++) {
      const t = afterRunout(seed, 3);
      if (!t) continue;
      const { rt, clock, left, busted } = t;
      for (const [id, name] of [['a', 'Al'], ['b', 'Bo'], ['c', 'Cy'], ['d', 'Di'], ['e', 'Eve']]) rt.joinWaitlist(id, { name, stack: 100 });
      expect(rt.state.offers).toEqual([]);
      expect(coming(rt)).toBe(6);
      clock.advance(left);
      expect(rt.state.offers!.length).toBe(busted.length);
      expect(coming(rt)).toBe(6);
      outcomes.add(busted.length > 0);
    }
    expect([...outcomes].sort()).toEqual([false, true]);
  });

  it('counts a player who said before the result that they were leaving as gone during the runout (#459)', () => {
    // Four seats: the host, two bots on small stacks and Al, who stands up and folds once the hand is dealt. Bo and Cy
    // wait. With six seats, the table will have the host, both bots and the two waiting players in Al's seat and a
    // new one, five in all, if nobody busted. During the runout the answer is five either way: Al counts as gone,
    // since his leaving showed before the result, and a bot that busted is still counted.
    const coming = (rt: TableRuntime) => {
      const next = structuredClone(rt.state.settings);
      next.table.maxSeats = 6;
      return (rt as unknown as { comingCount(next: TableSettings): number }).comingCount(next);
    };
    const outcomes = new Set<boolean>();
    for (let seed = 1; seed <= 24; seed++) {
      const t = afterRunout(
        seed,
        4,
        (rt) => {
          rt.requestSeat('a', { seat: 3, name: 'Al', stack: 100 });
          rt.joinWaitlist('b', { name: 'Bo', stack: 100 });
          rt.joinWaitlist('c', { name: 'Cy', stack: 100 });
        },
        () => {},
        { during: (rt) => rt.stand('a') },
      );
      if (!t) continue;
      const { rt, clock, left, busted } = t;
      expect(seatOf(rt, 'a')).toBeNull();
      expect(rt.state.offers).toEqual([]);
      expect(coming(rt)).toBe(5);
      clock.advance(left);
      // Once it has been shown: Al's seat, and any busted bot's, go to Bo and Cy.
      expect(rt.state.offers!.length).toBe(Math.min(2, 1 + busted.length));
      expect(coming(rt)).toBe(5 - busted.length);
      outcomes.add(busted.length > 0);
    }
    expect([...outcomes].sort()).toEqual([false, true]);
  });

  it('clears the queue when the waitlist is turned off', () => {
    const { rt } = full();
    expect(() => rt.joinWaitlist('host', { name: 'H', stack: 100 })).toThrow(/already have a seat/);
    rt.joinWaitlist('c', { name: 'Cat', stack: 150 });
    rt.stand('a');
    // Seat 2 is held for Cat, so the table is still full for Dan.
    rt.joinWaitlist('d', { name: 'Dan', stack: 150 });
    rt.updateSettings('host', { table: { maxSeats: 4 } });
    // A new seat goes to Dan.
    expect(rt.state.offers!.map((o) => [o.seat, o.playerId])).toEqual([
      [1, 'c'],
      [3, 'd'],
    ]);
    rt.updateSettings('host', { seating: { waitlist: false } });
    expect(rt.state.waitlist).toEqual([]);
    expect(rt.state.offers).toEqual([]);
    expect(() => rt.joinWaitlist('e', { name: 'Eve', stack: 100 })).toThrow(/no waitlist/);
  });

  it('shows the queue and held seats in the view; leaving and kicking take people off', () => {
    const { rt, clock } = full();
    rt.joinWaitlist('c', { name: 'Cat', stack: 150 });
    rt.joinWaitlist('d', { name: 'Dan', stack: 150 });
    rt.stand('a');
    const v = tableView(rt, 'd', clock.now());
    expect(v.waitlist.map((w) => w.name)).toEqual(['Cat', 'Dan']);
    expect(v.offers).toEqual([{ seat: 1, playerId: 'c', name: 'Cat', expiresAt: clock.now() + SEAT_OFFER_MS }]);
    rt.declineOffer('c');
    expect(rt.state.offers!.map((o) => o.playerId)).toEqual(['d']);
    rt.kick('host', 'd');
    expect(rt.state.waitlist).toEqual([]);
    expect(rt.state.offers).toEqual([]);
  });
});

describe('seat shuffle and placement', () => {
  it('reseats everyone among the taken seats between hands and redraws the button', () => {
    const { rt } = table();
    fill(rt, 4);
    rt.start('host');
    expect(() => rt.shuffleSeats('host')).toThrow(/between hands/);
    foldOut(rt);
    rt.stop('host');
    const before = rt.state.seats.map((s) => s?.playerId ?? null);
    rt.state.seats[2]!.missedBigBlind = true;
    rt.shuffleSeats('host');
    const after = rt.state.seats.map((s) => s?.playerId ?? null);
    expect([...after].sort()).toEqual([...before].sort());
    expect(after).not.toEqual(before);
    expect(rt.state.seats.every((s, i) => !s || (s.seat === i && !s.missedBigBlind))).toBe(true);
    expect(rt.state.positions).toBeNull();
    expect(() => rt.shuffleSeats('a')).toThrow(/only the host/);
  });

  it('lets the host move a player to an empty seat, but not mid-hand', () => {
    const { rt } = table();
    fill(rt, 3);
    rt.moveSeat('host', 'b', 7);
    expect(seatOf(rt, 'b')).toBe(7);
    expect(rt.state.seats[2]).toBeNull();
    expect(() => rt.moveSeat('host', 'a', 0)).toThrow(/taken/);
    rt.start('host');
    const inHand = rt.state.hand!.seats[0].playerId;
    expect(() => rt.moveSeat('host', inHand, 5)).toThrow(/once this hand is over/);
  });

  it('lets the host pick the seat when approving', () => {
    const { rt } = table((s) => {
      s.seating.requireApproval = true;
    });
    rt.requestSeat('host', { seat: 0, name: 'H', stack: 100 });
    rt.requestSeat('a', { seat: 1, name: 'Ann', stack: 100 });
    rt.approve('host', rt.state.requests[0].id, 4);
    expect(seatOf(rt, 'a')).toBe(4);
  });

  it('gives new players a random open seat when the table says so', () => {
    const { rt } = table((s) => {
      s.seating.randomSeats = true;
    });
    rt.requestSeat('host', { seat: 0, name: 'H', stack: 100 });
    const seats = ['a', 'b', 'c', 'd'].map((id) => {
      rt.requestSeat(id, { seat: 1, name: id, stack: 100 });
      return seatOf(rt, id);
    });
    // Everyone asked for seat 2; they were spread around instead.
    expect(new Set(seats).size).toBe(4);
    expect(seats).not.toEqual([1, 2, 3, 4]);
  });
});

describe('releasing offline seats', () => {
  it('cashes out a player who has been offline too long', () => {
    const { rt, clock } = table((s) => {
      s.seating.releaseOfflineSeatMinutes = 5;
    });
    fill(rt, 3);
    rt.disconnect('b');
    clock.advance(4 * 60_000);
    expect(seatOf(rt, 'b')).toBe(2);
    clock.advance(60_000);
    expect(seatOf(rt, 'b')).toBeNull();
    expect(rt.state.ledger.b.cashOut).toBe(200);
    expect(rt.state.log.some((l) => /B has been offline for 5 minutes/.test(l.text))).toBe(true);
  });

  it('never releases when the setting is 0', () => {
    const { rt, clock } = table();
    fill(rt, 3);
    rt.disconnect('b');
    clock.advance(24 * 60 * 60_000);
    expect(seatOf(rt, 'b')).toBe(2);
  });

  it('keeps the seat of a player who comes back before the hand ends', () => {
    const { rt, clock } = table((s) => {
      s.seating.releaseOfflineSeatMinutes = 1;
      s.timing.decisionSeconds = 0;
      s.seating.offlineGraceSeconds = 300;
    });
    fill(rt, 3);
    rt.start('host');
    const p = rt.state.hand!.seats[0].playerId;
    rt.disconnect(p);
    clock.advance(60_000);
    rt.connect(p);
    expect(rt.seatOf(p)?.leaveAfterHand).toBe(false);
  });

  it('lets a player in the hand finish it first', () => {
    const { rt, clock } = table((s) => {
      s.seating.releaseOfflineSeatMinutes = 1;
      s.timing.decisionSeconds = 0;
      s.seating.offlineGraceSeconds = 300;
    });
    fill(rt, 3);
    rt.start('host');
    const p = rt.state.hand!.seats[0].playerId;
    rt.disconnect(p);
    clock.advance(60_000);
    expect(rt.seatOf(p)?.leaveAfterHand).toBe(true);
  });
});

describe('chat controls', () => {
  it('keeps spectators quiet when guest chat is off; the host can always talk', () => {
    const { rt } = table((s) => {
      s.chat.guestChat = false;
    });
    fill(rt, 2);
    rt.stand('host');
    rt.chat('a', 'hi');
    rt.chat('host', 'welcome');
    expect(() => rt.chat('e', 'hello?')).toThrow(/only players/);
    expect(rt.state.chat.map((m) => m.text)).toEqual(['hi', 'welcome']);
  });

  it('host mutes stick until undone', () => {
    const { rt } = table();
    fill(rt, 2);
    rt.mute('host', 'a', true);
    expect(() => rt.chat('a', 'hey')).toThrow(/muted/);
    expect(() => rt.mute('a', 'host', true)).toThrow(/only the host/);
    rt.mute('host', 'a', false);
    rt.chat('a', 'thanks');
    expect(rt.state.chat.at(-1)!.text).toBe('thanks');
  });

  it('masks swearing when the filter is on', () => {
    const { rt } = table((s) => {
      s.chat.profanityFilter = true;
    });
    fill(rt, 2);
    rt.chat('a', 'Fuuuck that river, what a shitty card');
    expect(rt.state.chat.at(-1)!.text).toBe('****** that river, what a ****** card');
  });

  it('leaves ordinary words alone', () => {
    expect(maskProfanity('Scunthorpe cocktail assistant classic Dickens')).toBe('Scunthorpe cocktail assistant classic Dickens');
  });
});

describe('spectators', () => {
  it('see every hole card only when the table allows it', () => {
    const { rt, clock } = table((s) => {
      s.spectators.seeAllCards = true;
    });
    fill(rt, 3);
    rt.start('host');
    const fan = tableView(rt, 'e', clock.now());
    expect(fan.spectator).toEqual({ delaySeconds: 0, seeAll: true, blocked: false });
    expect(fan.seats.filter(Boolean).every((s) => s!.cards.every((c) => c.card !== '??'))).toBe(true);
    // Players still see only their own.
    const player = tableView(rt, 'a', clock.now());
    expect(player.spectator).toBeNull();
    expect(player.seats.filter((s) => s && s.playerId !== 'a').every((s) => s!.cards.every((c) => c.card === '??'))).toBe(true);
  });

  const hidden = (v: ReturnType<typeof tableView>) => v.seats.filter(Boolean).every((x) => x!.cards.every((c) => c.card === '??'));
  const faceUp = (v: ReturnType<typeof tableView>) => v.seats.filter((x) => x?.inHand).every((x) => x!.cards.length > 0 && x!.cards.every((c) => c.card !== '??'));
  const nextHand = (rt: TableRuntime, clock: FakeClock) => {
    const n = rt.state.handNumber;
    for (let i = 0; i < 200 && rt.state.handNumber === n; i++) clock.advance(250);
    expect(rt.state.handNumber).toBe(n + 1);
  };

  it('need everyone sitting down to agree to it', () => {
    const { rt } = table((s) => {
      s.spectators.seeAllCards = true;
    });
    expect(() => rt.requestSeat('a', { seat: 0, name: 'A', stack: 200 })).toThrow(/agree/);
    rt.requestSeat('a', { seat: 0, name: 'A', stack: 200, consent: true });
    expect(rt.seatOf('a')).not.toBeNull();
  });

  it('can only be turned on between hands, is announced, and only shows hands dealt after', () => {
    const { rt, clock } = table();
    fill(rt, 3);
    rt.start('host');
    expect(() => rt.updateSettings('host', { spectators: { seeAllCards: true } })).toThrow(/between hands/);
    // Allowing watching again can't open up the hand either.
    rt.updateSettings('host', { spectators: { allowed: false } });
    rt.state.settings.spectators.seeAllCards = true;
    expect(() => rt.updateSettings('host', { spectators: { allowed: true } })).toThrow(/between hands/);
    rt.state.settings.spectators.seeAllCards = false;
    rt.updateSettings('host', { spectators: { allowed: true } });
    expect(tableView(rt, 'a', clock.now()).cardsWatched).toBeNull();

    foldOut(rt);
    rt.updateSettings('host', { spectators: { seeAllCards: true, delaySeconds: 120 } });
    expect(rt.state.log.at(-1)!.text).toMatch(/turned on spectators seeing hole cards.*2 minutes behind the table/);
    expect(rt.state.chat.at(-1)).toMatchObject({ playerId: null, name: 'Dealer' });
    expect(rt.state.chat.at(-1)!.text).toMatch(/every player's cards/);
    const player = tableView(rt, 'a', clock.now(), null, [{ playerId: 'e', name: 'E' }, { playerId: 'host', name: 'H' }]);
    // The host doesn't count: staff never see the cards.
    expect(player.cardsWatched).toEqual({ delaySeconds: 120, at: clock.now(), watchers: 1 });
    // The hand that just ended was dealt before: its cards, mucked ones too, stay hidden.
    expect(hidden(tableView(rt, 'e', clock.now()))).toBe(true);
    nextHand(rt, clock);
    expect(faceUp(tableView(rt, 'e', clock.now()))).toBe(true);
  });

  it("can't seat someone who asked before it was on without them agreeing", () => {
    const { rt } = table((s) => {
      s.seating.requireApproval = true;
    });
    rt.requestSeat('a', { seat: 0, name: 'A', stack: 200 });
    rt.updateSettings('host', { spectators: { seeAllCards: true } });
    const id = rt.state.requests[0].id;
    expect(() => rt.approve('host', id)).toThrow(/ask again/);
    rt.requestSeat('a', { seat: 0, name: 'A', stack: 200, consent: true });
    rt.approve('host', rt.state.requests[0].id);
    expect(rt.seatOf('a')).not.toBeNull();
  });

  it('announces a change queued in a hand once, however often the host saves', () => {
    const { rt } = table((s) => {
      s.spectators.seeAllCards = true;
      s.spectators.delaySeconds = 300;
    });
    fill(rt, 3);
    rt.start('host');
    rt.updateSettings('host', { spectators: { delaySeconds: 30 } });
    const chats = rt.state.chat.length;
    rt.updateSettings('host', { table: { name: 'Renamed' } });
    expect(rt.state.chat.length).toBe(chats);
    expect(rt.state.log.at(-1)!.text).toBe('HOST changed the table settings: table.');
    // Taking the queued change back is announced too.
    rt.updateSettings('host', { spectators: { delaySeconds: 300 } });
    expect(rt.state.log.at(-1)!.text).toMatch(/5 minutes behind the table from the next hand \(it was 30 seconds behind\)/);
  });

  it('drops a turn-on queued by an older snapshot, and applies a queued turn-off now', () => {
    const on = table();
    on.rt.state.pendingSettings = { spectators: { seeAllCards: true }, stakes: { bigBlind: 4 } };
    const a = new TableRuntime(structuredClone(on.rt.state));
    expect(a.state.pendingSettings).toEqual({ stakes: { bigBlind: 4 } });
    const off = table((s) => {
      s.spectators.seeAllCards = true;
    });
    off.rt.state.pendingSettings = { spectators: { seeAllCards: false } };
    const b = new TableRuntime(structuredClone(off.rt.state));
    expect(b.state.pendingSettings).toBeNull();
    expect(b.settings.spectators.seeAllCards).toBe(false);
  });

  it('can be turned off in the middle of a hand, at once', () => {
    const { rt, clock } = table((s) => {
      s.spectators.seeAllCards = true;
    });
    fill(rt, 3);
    rt.start('host');
    expect(faceUp(tableView(rt, 'e', clock.now()))).toBe(true);
    rt.updateSettings('host', { spectators: { seeAllCards: false } });
    expect(hidden(tableView(rt, 'e', clock.now()))).toBe(true);
    expect(tableView(rt, 'a', clock.now()).cardsWatched).toBeNull();
    expect(rt.state.chat.at(-1)!.text).toMatch(/turned off spectators seeing hole cards/);
  });

  it('tells the table about every change to what people can see', () => {
    const { rt } = table((s) => {
      s.spectators.seeAllCards = true;
      s.spectators.delaySeconds = 300;
      s.chat.guestChat = false;
      s.play.rabbitHunt = true;
    });
    fill(rt, 3);
    rt.start('host');
    const chats = rt.state.chat.length;
    rt.updateSettings('host', { spectators: { delaySeconds: 30 }, chat: { guestChat: true }, play: { rabbitHunt: false }, stakes: { bigBlind: 4 } });
    const log = rt.state.log.map((l) => l.text);
    expect(log).toContain('⚠️ HOST set spectators to watch 30 seconds behind the table from the next hand (it was 5 minutes behind). They see every hole card.');
    expect(log).toContain("HOST let people who aren't seated chat, and spectators here see every hole card.");
    expect(log.some((l) => /rabbit hunting off from the next hand/.test(l))).toBe(true);
    expect(log).toContain('HOST changed the table settings: stakes (from the next hand).');
    // A shorter delay and spectators chatting go to chat too.
    expect(rt.state.chat.length).toBe(chats + 2);
  });

  it('see nothing of the hand when watching is off', () => {
    const { rt, clock } = table((s) => {
      s.spectators.allowed = false;
    });
    fill(rt, 3);
    rt.start('host');
    const fan = tableView(rt, 'e', clock.now());
    expect(fan.spectator?.blocked).toBe(true);
    expect(fan.hand).toBeNull();
  });
});

describe('trimming excess bets', () => {
  it('reaches the engine from the table setting', () => {
    const { rt } = table((s) => {
      s.play.trimExcessBets = true;
    });
    PEOPLE.slice(0, 3).forEach((id, seat) => rt.requestSeat(id, { seat, name: id, stack: seat === 0 ? 1000 : 100 }));
    rt.start('host');
    expect(rt.state.hand!.input.options.trimExcessBets).toBe(true);
  });
});

describe('co-hosts', () => {
  const withCoHost = (powers: string[] = ['approve', 'run']) => {
    const r = table((s) => (s.seating.requireApproval = true));
    r.rt.setCoHost('host', 'a', powers);
    return r;
  };

  it('lets only the host name co-hosts, and only people at the table', () => {
    const { rt } = withCoHost();
    expect(rt.state.coHosts).toEqual([{ playerId: 'a', name: 'Guest', powers: ['approve', 'run'] }]);
    expect(() => rt.setCoHost('a', 'b', ['run'])).toThrow(/only the host/);
    expect(() => rt.setCoHost('host', 'stranger', ['run'])).toThrow(/not at the table/);
    expect(() => rt.setCoHost('host', 'b', ['bogus'])).toThrow();
    expect(rt.state.log.some((l) => /made Guest a co-host/.test(l.text))).toBe(true);
  });

  it('gives co-hosts exactly the powers the host ticked', () => {
    const { rt } = withCoHost(['approve']);
    rt.requestSeat('b', { seat: 1, name: 'Bea', stack: 100 });
    const req = rt.state.requests[0]!;
    // The co-host can approve but not start the game or change settings.
    rt.approve('a', req.id);
    expect(seatOf(rt, 'b')).toBe(1);
    expect(() => rt.start('a')).toThrow(/hasn't given you that power/);
    expect(() => rt.setStack('a', 'b', 50)).toThrow(/hasn't given you that power/);
    expect(() => rt.start('c')).toThrow(/only the host/);

    rt.setCoHost('host', 'a', ['run', 'chips', 'players']);
    expect(() => rt.approve('a', 'nope')).toThrow(/hasn't given you that power/);
    rt.setStack('a', 'b', 50);
    expect(rt.seatOf('b')!.stack).toBe(50);
    rt.mute('a', 'b', true);
    expect(rt.state.muted).toEqual(['b']);
  });

  it('never lets a co-host act on the host', () => {
    const { rt } = withCoHost(['players', 'chips']);
    rt.requestSeat('host', { seat: 0, name: 'Hal', stack: 100 });
    expect(() => rt.kick('a', 'host')).toThrow(/to the host/);
    expect(() => rt.mute('a', 'host', true)).toThrow(/to the host/);
    expect(() => rt.setStack('a', 'host', 1)).toThrow(/to the host/);
    expect(() => rt.hostSitOut('a', 'host')).toThrow(/to the host/);
    // Nor on another co-host.
    rt.setCoHost('host', 'b', ['run']);
    expect(() => rt.mute('a', 'b', true)).toThrow(/co-host/);
    expect(() => rt.kick('a', 'b')).toThrow(/co-host/);
  });

  it("doesn't let a co-host remove the host's bots", () => {
    const { rt } = withCoHost(['players']);
    const bot = rt.addBot('host', { seat: 3 });
    expect(() => rt.removeBot('a', bot)).toThrow(/only the host/);
    rt.removeBot('host', bot);
    expect(rt.seatOf(bot)).toBeNull();
  });

  it('takes co-host powers away from someone the host removes', () => {
    const { rt } = withCoHost(['players']);
    rt.kick('host', 'a');
    expect(rt.state.coHosts ?? []).toEqual([]);
    expect(rt.isStaff('a')).toBe(false);
    expect(() => rt.mute('a', 'b', true)).toThrow(/only the host/);
  });

  it('seats co-hosts with the approve power without asking', () => {
    const { rt } = withCoHost(['approve']);
    rt.requestSeat('a', { seat: 2, name: 'Ann', stack: 100 });
    expect(seatOf(rt, 'a')).toBe(2);
    expect(rt.state.requests).toEqual([]);
  });

  it('shows co-hosts their powers and the requests they can approve', () => {
    const { rt, clock } = withCoHost(['approve']);
    rt.requestSeat('b', { seat: 1, name: 'Bea', stack: 100 });
    const a = tableView(rt, 'a', clock.now());
    expect(a.powers).toEqual(['approve']);
    expect(a.coHosts.map((c) => c.playerId)).toEqual(['a']);
    expect(a.requests).toHaveLength(1);
    expect(tableView(rt, 'c', clock.now()).requests).toHaveLength(0);
    expect(tableView(rt, 'c', clock.now()).powers).toEqual([]);
    expect(tableView(rt, 'host', clock.now()).powers.length).toBeGreaterThan(1);
  });

  it('lets a co-host step down, and only the host remove someone else', () => {
    const { rt } = withCoHost();
    rt.setCoHost('host', 'b', ['run']);
    expect(() => rt.removeCoHost('a', 'b')).toThrow(/only the host/);
    rt.removeCoHost('a', 'a');
    rt.removeCoHost('host', 'b');
    expect(rt.state.coHosts ?? []).toEqual([]);
    expect(rt.state.log.some((l) => /stepped down as co-host/.test(l.text))).toBe(true);
  });

  it('keeps the old host on as a full co-host after handing over', () => {
    const { rt } = withCoHost();
    rt.requestSeat('host', { seat: 0, name: 'Hal', stack: 100 });
    rt.transferHost('host', 'a');
    expect(rt.state.hostId).toBe('a');
    expect(rt.state.coHosts!.map((c) => c.playerId)).toEqual(['host']);
    expect(rt.powersOf('host')).toEqual(expect.arrayContaining(['approve', 'chips', 'run', 'players', 'settings']));
    // And the new host can hand it straight back.
    rt.transferHost('a', 'host');
    expect(rt.state.hostId).toBe('host');
  });

  it('hands an abandoned table to an online co-host before any seated player', () => {
    const { rt, clock } = withCoHost();
    // The host seats themselves (no request needed) and B asks for the seat after.
    rt.requestSeat('host', { seat: 0, name: 'Hal', stack: 100 });
    rt.requestSeat('b', { seat: 1, name: 'Bea', stack: 100 });
    rt.approve('host', rt.state.requests[0]!.id);
    rt.disconnect('host');
    clock.advance(HOST_HANDOFF_MS);
    // B sits next to the host, but A is a co-host (watching, not seated).
    expect(rt.state.hostId).toBe('a');
    expect(rt.state.coHosts!.map((c) => c.playerId)).toEqual(['host']);
  });
});

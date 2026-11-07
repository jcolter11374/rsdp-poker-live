import { beforeAll, describe, expect, it } from 'vitest';
import { engine, variants } from '@rsdp/engine/core';
import { defaultSettings, type TableSettings } from '@rsdp/engine/settings';
import { registerAllVariants } from '@rsdp/engine/variants';
import { FAIR_REVEAL_AFTER_MS, FAIR_STOP_REVEAL_MS, fairRevealsAt, TableRuntime, type ShownTable } from '../src/runtime/table';
import { FakeClock, seeded } from './fake-clock';

/*
 * A spectator on a delay sees the table as it was that long ago (#435). The answers they get when they ask for a
 * seat, throw a gesture or touch a bot must come from what they are shown, or be one answer whatever the live table
 * says: otherwise asking tells them, up to the delay early, that the live hand has ended (a player leaving after it
 * has gone, a smaller table has taken effect, a bot has busted out).
 */

beforeAll(() => registerAllVariants(variants));

const PLAYERS = ['host', 'a', 'b', 'c'];
const DELAY = 30_000;
const CLOSED = 'that seat is closed for now';

/** A cash table with a delay and four players, its first hand dealt unless `start` is false. */
function table(patch: (s: TableSettings) => void = () => {}, { players = PLAYERS, start = true, seed = 3 } = {}) {
  const clock = new FakeClock();
  const settings = defaultSettings('cash');
  settings.timing.autoStartNextHand = false;
  settings.seating.requireApproval = false;
  settings.spectators.delaySeconds = DELAY / 1000;
  patch(settings);
  const rt = TableRuntime.create({ id: 't1', hostId: 'host', settings }, { clock, rng: seeded(seed) });
  for (const p of [...players, 'watcher', 'd']) rt.connect(p);
  players.forEach((p, i) => rt.requestSeat(p, { seat: i, name: p.toUpperCase(), stack: 10_000, consent: true }));
  if (start) rt.start('host');
  return { rt, clock };
}

/** Plays the hand out with checks and calls. */
function checkDown(rt: TableRuntime) {
  for (let i = 0; i < 200 && rt.state.hand && rt.state.hand.phase !== 'complete'; i++) {
    const h = rt.state.hand;
    const id = rt.state.seats[h.toAct ?? -1]?.playerId;
    if (!id) break;
    const legal = engine.legalActions(h, h.toAct!)!;
    rt.act(id, legal.canCheck ? { type: 'check' } : { type: 'call' });
  }
}

/**
 * From now on, everyone unseated and not staff is shown the seats as they are now, as the delayed feed in app.ts
 * goes on showing them until the delay has passed.
 */
function freezeView(rt: TableRuntime, clock: FakeClock): ShownTable {
  const shown = { seats: rt.state.seats.map((x) => x?.playerId ?? null), at: clock.now(), behindMs: DELAY, showsNowInMs: DELAY };
  rt.shownTo = (id) => (rt.seatOf(id) || rt.isStaff(id) ? null : shown);
  return shown;
}

/** The refusal `fn` throws, or 'accepted'. */
function answer(fn: () => void): string {
  try {
    fn();
    return 'accepted';
  } catch (e) {
    return (e as Error).message;
  }
}

const ask = (rt: TableRuntime, seat: number) => answer(() => rt.requestSeat('watcher', { seat, name: 'Watcher', stack: 10_000 }));

describe('a spectator on a delay asking for a seat (#435)', () => {
  it('hears the same about the seat of a player leaving after the hand, before and after it ends live', () => {
    const { rt, clock } = table();
    rt.stand('c', { afterHand: true });
    const shown = freezeView(rt, clock);
    const before = ask(rt, 3);
    checkDown(rt);
    expect(rt.seatOf('c')).toBeNull();
    // Their view still shows C in the seat.
    expect(shown.seats[3]).toBe('c');
    expect(ask(rt, 3)).toBe(before);
    expect(before).toBe('that seat is taken');
    expect(rt.seatOf('watcher')).toBeNull();
    expect(rt.state.requests).toEqual([]);
  });

  it('with random seats, hears "every seat is taken" while their view shows the table full, whatever the live table has free', () => {
    const { rt, clock } = table((s) => {
      s.table.maxSeats = 4;
      s.seating.randomSeats = true;
    });
    rt.stand('c', { afterHand: true });
    freezeView(rt, clock);
    expect(ask(rt, 0)).toBe('every seat is taken');
    checkDown(rt);
    expect(rt.seatOf('c')).toBeNull();
    expect(ask(rt, 0)).toBe('every seat is taken');
    expect(rt.seatOf('watcher')).toBeNull();
  });

  it('with random seats, is given only a seat free both live and in their view', () => {
    // Several draws, so a lucky one can't pass it.
    for (let seed = 1; seed <= 8; seed++) {
      const { rt, clock } = table(
        (s) => {
          s.table.maxSeats = 6;
          s.seating.randomSeats = true;
        },
        { players: [...PLAYERS, 'e'], start: false, seed },
      );
      const shown = freezeView(rt, clock);
      const free = shown.seats.indexOf(null);
      // Three players go between hands: the live table has four seats free, their view still one.
      for (const p of ['a', 'b', 'c']) rt.stand(p);
      expect(rt.state.seats.filter((x) => !x)).toHaveLength(4);
      expect(ask(rt, 0)).toBe('accepted');
      expect(rt.seatOf('watcher')!.seat).toBe(free);
    }
  });

  it('hears one answer for a seat their view shows free that the live table has given away', () => {
    const { rt, clock } = table();
    freezeView(rt, clock);
    rt.requestSeat('d', { seat: 5, name: 'D', stack: 10_000 });
    expect(ask(rt, 5)).toBe(CLOSED);
    // Their own mistakes come first.
    expect(answer(() => rt.requestSeat('watcher', { seat: 5, name: 'Watcher', stack: 0 }))).toMatch(/positive whole number/);
  });

  it('is told "no such seat" by the seats their view has, while a smaller table takes effect live', () => {
    const { rt, clock } = table();
    rt.updateSettings('host', { table: { maxSeats: 6 } });
    const shown = freezeView(rt, clock);
    const before = [ask(rt, 7), ask(rt, 10)];
    checkDown(rt);
    rt.dealNext('host');
    expect(rt.state.seats.length).toBe(6);
    expect(shown.seats.length).toBe(10);
    expect([ask(rt, 7), ask(rt, 10)]).toEqual(before);
    expect(before).toEqual([CLOSED, 'no such seat']);
  });

  it('takes a seat offered from the waitlist once their view shows it free, and hears the same as before until then', () => {
    const { rt, clock } = table((s) => {
      s.table.maxSeats = 4;
      s.seating.waitlist = true;
    });
    rt.joinWaitlist('watcher', { name: 'Watcher', stack: 10_000 });
    rt.stand('c', { afterHand: true });
    const shown = freezeView(rt, clock);
    const before = ask(rt, 3);
    checkDown(rt);
    expect(rt.state.offers).toEqual([expect.objectContaining({ playerId: 'watcher', seat: 3 })]);
    expect(shown.seats[3]).toBe('c');
    // Still shown in seat 3: the offer they can't see yet gives nothing away.
    expect(ask(rt, 3)).toBe(before);
    expect(before).toBe('that seat is taken');
    expect(rt.seatOf('watcher')).toBeNull();
    // Their view reaches the seat coming free (and the offer): it is theirs.
    shown.seats[3] = null;
    expect(ask(rt, 3)).toBe('accepted');
    expect(rt.seatOf('watcher')?.seat).toBe(3);
  });

  it('hears "closed" for a seat their view shows free that someone sat in and left live, until their view gets there', () => {
    const { rt, clock } = table();
    const shown = freezeView(rt, clock);
    clock.advance(1_000);
    rt.requestSeat('d', { seat: 4, name: 'D', stack: 10_000 });
    expect(ask(rt, 4)).toBe(CLOSED);
    clock.advance(1_000);
    rt.stand('d');
    expect(rt.state.seats[4]).toBeNull();
    clock.advance(1_000);
    // Free live and in their view all along, but a yes now would tell them D has come and gone.
    expect(ask(rt, 4)).toBe(CLOSED);
    expect(rt.seatOf('watcher')).toBeNull();
    // Their view reaches the table after D left: the seat is theirs.
    shown.at = clock.now();
    expect(ask(rt, 4)).toBe('accepted');
  });

  it('is not seated from the waitlist in a seat someone sat in and left live, until their view gets there', () => {
    const { rt, clock } = table((s) => {
      s.table.maxSeats = 5;
      s.seating.waitlist = true;
    });
    const shown = freezeView(rt, clock);
    clock.advance(1_000);
    rt.requestSeat('d', { seat: 4, name: 'D', stack: 10_000 });
    expect(ask(rt, 4)).toBe(CLOSED);
    rt.joinWaitlist('watcher', { name: 'Watcher', stack: 10_000 });
    clock.advance(1_000);
    rt.stand('d');
    expect(rt.state.offers).toEqual([expect.objectContaining({ playerId: 'watcher', seat: 4 })]);
    clock.advance(1_000);
    expect(ask(rt, 4)).toBe(CLOSED);
    expect(rt.seatOf('watcher')).toBeNull();
    shown.at = clock.now();
    expect(ask(rt, 4)).toBe('accepted');
    expect(rt.seatOf('watcher')?.seat).toBe(4);
  });

  it('tells a player who has just left live, and is still shown in their seat, what they heard before it', () => {
    const { rt, clock } = table();
    rt.stand('c', { afterHand: true });
    freezeView(rt, clock);
    // A stack that would be refused: asking can't tell them the live hand has ended by the answer changing.
    const sit = () => answer(() => rt.requestSeat('c', { seat: 5, name: 'C', stack: 0 }));
    const before = sit();
    checkDown(rt);
    expect(rt.seatOf('c')).toBeNull();
    expect(sit()).toBe(before);
    expect(before).toBe('you already have a seat');
  });

  it('leaves the answers of anyone who sees the table live as they were', () => {
    const { rt } = table();
    rt.updateSettings('host', { table: { maxSeats: 6 } });
    // The watcher sees the table live, as the host and co-hosts do, and everyone at a table without a delay.
    rt.shownTo = () => null;
    expect(ask(rt, 7)).toMatch(/going down to 6 seats/);
    expect(ask(rt, 1)).toBe('that seat is taken');
    expect(ask(rt, 10)).toBe('no such seat');
  });
});

describe('a spectator on a delay throwing a gesture (#435)', () => {
  it('may throw at a player their view shows seated, before and after that player leaves live', () => {
    const { rt, clock } = table();
    rt.stand('c', { afterHand: true });
    freezeView(rt, clock);
    const before = answer(() => rt.checkGesture('watcher', 'c'));
    checkDown(rt);
    expect(rt.seatOf('c')).toBeNull();
    expect(answer(() => rt.checkGesture('watcher', 'c'))).toBe(before);
    expect(before).toBe('accepted');
    // Someone seated sees the live table.
    expect(answer(() => rt.checkGesture('a', 'c'))).toBe('that player is not seated');
  });

  it('is told a player who sat down after their view is not seated yet', () => {
    const { rt, clock } = table();
    freezeView(rt, clock);
    rt.requestSeat('d', { seat: 5, name: 'D', stack: 10_000 });
    expect(answer(() => rt.checkGesture('watcher', 'd'))).toBe('that player is not seated');
    expect(answer(() => rt.checkGesture('a', 'd'))).toBe('accepted');
  });
});

describe('touching a bot (#435)', () => {
  it('tells someone who may not remove or change a bot the same whether or not it is still here', () => {
    const { rt } = table();
    const bot = rt.addBot('host', { seat: 5 });
    const tries = () => [
      answer(() => rt.removeBot('watcher', bot)),
      answer(() => rt.setBotLevel('watcher', bot, 'hard')),
      answer(() => rt.setBotLevel('watcher', bot, 'nope' as 'hard')),
    ];
    const here = tries();
    rt.removeBot('host', bot);
    expect(rt.botInfo(bot)).toBeNull();
    expect(tries()).toEqual(here);
    expect(here).toEqual([
      'only its owner or the host can remove a bot',
      "only its owner or the host can change a bot's level",
      'no such level',
    ]);
    // The host still hears that it has gone.
    expect(answer(() => rt.removeBot('host', bot))).toBe('no such bot');
    expect(answer(() => rt.setBotLevel('host', bot, 'hard'))).toBe('no such bot');
  });

  it("answers its owner, watching on a delay, as if the bot were still there while their view shows it", () => {
    const { rt, clock } = table();
    const bot = rt.addBot('a', { seat: 5 });
    // A stands up after the hand and watches on the delay; their view still shows their bot seated.
    rt.stand('a', { afterHand: true });
    checkDown(rt);
    expect(rt.seatOf('a')).toBeNull();
    freezeView(rt, clock);
    const tries = () => [answer(() => rt.setBotLevel('a', bot, 'normal')), answer(() => rt.setBotLevel('a', bot, 'nope' as 'hard'))];
    const here = tries();
    // The bot leaves the live table.
    rt.removeBot('host', bot);
    if (rt.botInfo(bot)) checkDown(rt);
    expect(rt.botInfo(bot)).toBeNull();
    expect(tries()).toEqual(here);
    expect(here).toEqual(['accepted', 'no such level']);
    expect(answer(() => rt.removeBot('a', bot))).toBe('accepted');
  });

  it('tells anyone who sees the table live that a bot has gone, its owner tapping again included', () => {
    const { rt } = table();
    const bot = rt.addBot('a', { seat: 5 });
    expect(answer(() => rt.removeBot('b', bot))).toBe('only its owner or the host can remove a bot');
    rt.removeBot('a', bot);
    expect(rt.botInfo(bot)).toBeNull();
    expect(answer(() => rt.removeBot('a', bot))).toBe('no such bot');
    expect(answer(() => rt.setBotLevel('a', bot, 'hard'))).toBe('no such bot');
    expect(answer(() => rt.removeBot('b', bot))).toBe('no such bot');
    expect(answer(() => rt.setBotLevel('b', bot, 'nope' as 'hard'))).toBe('no such bot');
  });
});

describe('fair reveal times on a delay (#435)', () => {
  it('leave out a stop made after the time asked about', () => {
    const fair = { revealedThrough: 0, stopped: { through: 3, at: 5_000_000 } };
    const ended = 4_000_000;
    expect(fairRevealsAt(fair, 2, ended)).toBe(5_000_000 + FAIR_STOP_REVEAL_MS);
    expect(fairRevealsAt(fair, 2, ended, FAIR_STOP_REVEAL_MS, 5_000_000)).toBe(5_000_000 + FAIR_STOP_REVEAL_MS);
    expect(fairRevealsAt(fair, 2, ended, FAIR_STOP_REVEAL_MS, 4_999_999)).toBe(ended + FAIR_REVEAL_AFTER_MS);
  });

  it('on the table, stay where they were when a stop at the end of the live hand moves them', () => {
    const { rt, clock } = table();
    rt.stop('host');
    // What a spectator a second behind is shown: the hand still being played.
    const asOf = clock.now();
    clock.advance(1000);
    checkDown(rt);
    const ended = rt.state.history.at(-1)!.endedAt;
    expect(rt.state.fair?.stopped?.at).toBeGreaterThan(asOf);
    expect(rt.fairRevealsAt(1, ended)).toBe(rt.state.fair!.stopped!.at + FAIR_STOP_REVEAL_MS);
    expect(rt.fairRevealsAt(1, ended, asOf)).toBe(ended + FAIR_REVEAL_AFTER_MS);
  });

  it('on the table, stay where they were when the host starts the game again live', () => {
    const { rt, clock } = table();
    rt.stop('host');
    checkDown(rt);
    const ended = rt.state.history.at(-1)!.endedAt;
    const opens = rt.state.fair!.stopped!.at + FAIR_STOP_REVEAL_MS;
    clock.advance(10 * 60_000);
    // A spectator on the delay is shown the game still stopped, its hands opening half an hour after the stop.
    const asOf = clock.now() - DELAY;
    expect(rt.fairRevealsAt(1, ended, asOf)).toBe(opens);
    rt.start('host');
    // Live, the hands stay private for the 12 hours again; their view still shows the stop.
    expect(rt.fairRevealsAt(1, ended)).toBe(ended + FAIR_REVEAL_AFTER_MS);
    expect(rt.fairRevealsAt(1, ended, asOf)).toBe(opens);
    // Weighed against the time they are shown, the hands aren't open to them while the live table keeps them private.
    expect(asOf < opens).toBe(true);
    // Once their view reaches the start, they see the 12 hours too.
    expect(rt.fairRevealsAt(1, ended, clock.now())).toBe(ended + FAIR_REVEAL_AFTER_MS);
  });

  it('on the table, follow each stop and start when the host does both twice within the delay', () => {
    const { rt, clock } = table();
    rt.stop('host');
    checkDown(rt);
    const first = { ended: rt.state.history.at(-1)!.endedAt, opens: rt.state.fair!.stopped!.at + FAIR_STOP_REVEAL_MS };
    clock.advance(1000);
    const duringFirst = clock.now();
    clock.advance(1000);
    rt.start('host');
    clock.advance(1000);
    const between = clock.now();
    clock.advance(1000);
    rt.stop('host');
    checkDown(rt);
    expect(rt.state.handNumber).toBe(2);
    const secondOpens = rt.state.fair!.stopped!.at + FAIR_STOP_REVEAL_MS;
    clock.advance(1000);
    const duringSecond = clock.now();
    clock.advance(1000);
    rt.start('host');
    expect(rt.fairRevealsAt(1, first.ended, duringFirst)).toBe(first.opens);
    expect(rt.fairRevealsAt(1, first.ended, between)).toBe(first.ended + FAIR_REVEAL_AFTER_MS);
    expect(rt.fairRevealsAt(1, first.ended, duringSecond)).toBe(secondOpens);
    expect(rt.fairRevealsAt(1, first.ended, clock.now())).toBe(first.ended + FAIR_REVEAL_AFTER_MS);
  });

  it('on the table, read the same once a stop has opened its hands, before and after the game starts again', () => {
    const { rt, clock } = table();
    rt.stop('host');
    checkDown(rt);
    const ended = rt.state.history.at(-1)!.endedAt;
    clock.advance(FAIR_STOP_REVEAL_MS + 60_000);
    const asOf = clock.now() - DELAY;
    const before = rt.fairRevealsAt(1, ended, asOf);
    expect(before).toBeLessThanOrEqual(asOf);
    rt.start('host');
    expect(rt.fairRevealsAt(1, ended)).toBe(-Infinity);
    expect(rt.fairRevealsAt(1, ended, asOf)).toBe(before);
  });
});

describe('the delay notice (#435)', () => {
  it('reads the same in chat whether the host changes the delay mid-hand or between hands', () => {
    const seeing = (s: TableSettings) => {
      s.spectators.seeAllCards = true;
      s.spectators.delaySeconds = 300;
    };
    const mid = table(seeing).rt;
    mid.updateSettings('host', { spectators: { delaySeconds: 30 } });
    const between = table(seeing).rt;
    checkDown(between);
    between.updateSettings('host', { spectators: { delaySeconds: 30 } });
    const said = (rt: TableRuntime) => rt.state.chat.at(-1)!.text;
    expect(said(between)).toBe(said(mid));
    expect(said(mid)).toMatch(/30 seconds behind the table, from the next hand/);
  });
});

describe('records', () => {
  it('know who never played here', () => {
    const { rt } = table();
    expect(rt.neverPlayedHere('a')).toBe(false);
    expect(rt.neverPlayedHere('watcher')).toBe(true);
  });
});

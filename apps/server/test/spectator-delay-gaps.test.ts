import { beforeAll, describe, expect, it } from 'vitest';
import { engine, variants } from '@rsdp/engine/core';
import { defaultSettings, type TableSettings } from '@rsdp/engine/settings';
import { registerAllVariants } from '@rsdp/engine/variants';
import type { TableView } from '@rsdp/engine/wire';
import { SpectatorFeed } from '../src/runtime/feed';
import { TableRuntime } from '../src/runtime/table';
import { behind, delayedPart, shownKey, tableView, type DelayedPart } from '../src/runtime/view';
import { FakeClock, seeded } from './fake-clock';

/*
 * Spectators on a delay (#435): nothing they are shown should tell them, up to the delay early, that the live hand
 * has ended or the next one has been dealt. These test the delayed view itself (runtime/view.ts) and the feed it is
 * shown from (runtime/feed.ts); app.test.ts and late-moves.test.ts test them through the server.
 */

beforeAll(() => registerAllVariants(variants));

const PLAYERS = ['host', 'a', 'b', 'c'];
const DELAY = 30_000;

function table(patch: (s: TableSettings) => void = () => {}, players = PLAYERS) {
  const clock = new FakeClock();
  const settings = defaultSettings('cash');
  settings.timing.autoStartNextHand = false;
  settings.spectators.delaySeconds = DELAY / 1000;
  patch(settings);
  const rt = TableRuntime.create({ id: 't1', hostId: 'host', settings }, { clock, rng: seeded(3) });
  for (const p of [...players, 'watcher', 'fan']) rt.connect(p);
  rt.updateSettings('host', { seating: { requireApproval: false } });
  players.forEach((p, i) => rt.requestSeat(p, { seat: i, name: p.toUpperCase(), stack: 10_000 }));
  rt.start('host');
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

/** What spectators are shown at this moment, as the server keeps it. */
const snap = (rt: TableRuntime, clock: FakeClock) => delayedPart(tableView(rt, '', clock.now()));
const watcherNow = (rt: TableRuntime, clock: FakeClock) => tableView(rt, 'watcher', clock.now());
const fake = (at: number) => ({ serverNow: at }) as unknown as DelayedPart;

describe('the delayed feed (item 2: the delay itself changes at the live deal)', () => {
  // H1 is dealt at 0 and ends at 60 s; the host's change to the delay applies when H2 is dealt at 65 s.
  const s = (n: number) => n * 1000;

  it('a longer delay holds the view on the gap between hands for the difference: H1 still ends on time', () => {
    const feed = new SpectatorFeed();
    feed.add(s(0), s(30), fake(s(0)));
    feed.add(s(60), s(30), fake(s(60)));
    feed.add(s(65), s(120), fake(s(65)));
    feed.add(s(100), s(120), fake(s(100)));
    const at = (t: number) => feed.shown(s(t), true)?.at;
    expect(at(89)).toBe(s(0));
    // H1's end shows 30 s after it happened, as it would have with no change.
    expect(at(90)).toBe(s(60));
    expect(at(184)).toBe(s(60));
    // H2 shows under its own delay, two minutes after it was dealt.
    expect(at(185)).toBe(s(65));
    expect(at(220)).toBe(s(100));
  });

  it('a shorter delay shows H1 to its end and the gap after it in full, on the old delay, then skips ahead in H2', () => {
    const feed = new SpectatorFeed();
    feed.add(s(0), s(120), fake(s(0)));
    feed.add(s(60), s(120), fake(s(60)));
    feed.add(s(65), s(30), fake(s(65)));
    feed.add(s(100), s(30), fake(s(100)));
    feed.add(s(150), s(30), fake(s(150)));
    feed.add(s(170), s(30), fake(s(170)));
    const at = (t: number) => feed.shown(s(t), true)?.at;
    expect(at(179)).toBe(s(0));
    expect(at(180)).toBe(s(60));
    // The whole gap after H1, 5 s, before anything of H2.
    expect(at(184)).toBe(s(60));
    // Reaching H2 on the old delay, the view goes straight to where H2 is 30 s behind: nothing of it is early.
    expect(at(185)).toBe(s(150));
    expect(at(199)).toBe(s(150));
    expect(at(200)).toBe(s(170));
  });

  it('turned off, the delay runs out the same way before spectators see the table live', () => {
    const feed = new SpectatorFeed();
    feed.add(s(0), s(120), fake(s(0)));
    feed.add(s(60), s(120), fake(s(60)));
    feed.add(s(65), 0, fake(s(65)));
    feed.add(s(100), 0, fake(s(100)));
    expect(feed.caughtUp(s(184))).toBe(false);
    expect(feed.shown(s(184), true)?.at).toBe(s(60));
    expect(feed.shown(s(185), true)?.at).toBe(s(100));
    expect(feed.caughtUp(s(185))).toBe(true);
  });

  it('turned on, the first hand under it shows the delay after it was dealt', () => {
    const feed = new SpectatorFeed();
    feed.add(s(65), s(120), fake(s(65)));
    expect(feed.shown(s(184), true)).toBeNull();
    expect(feed.shown(s(185), true)?.at).toBe(s(65));
  });

  it('says when a moment taken now would be shown, and never shows anything twice or goes back', () => {
    const feed = new SpectatorFeed();
    feed.add(s(0), s(120), fake(s(0)));
    expect(feed.showAtFor(s(10), s(30))).toBe(s(130));
    feed.add(s(10), s(30), fake(s(10)));
    expect(feed.showAtFor(s(20), s(30))).toBe(s(130));
    let last = -Infinity;
    for (let t = 0; t < 300; t += 5) {
      const m = feed.shown(s(t));
      if (m) {
        expect(m.at).toBeGreaterThanOrEqual(last);
        last = m.at;
      }
    }
    expect(feed.size).toBe(1);
  });

  it('never goes back to an earlier moment, though a timer fired early and the next ask comes a moment sooner', () => {
    const feed = new SpectatorFeed();
    feed.add(s(0), s(30), fake(s(0)));
    feed.add(s(10), s(30), fake(s(10)));
    // The timer for the second moment fires a millisecond early and shows it, counted as due.
    expect(feed.shown(s(40))?.at).toBe(s(10));
    // A live change in that millisecond asks with the real time: still the second moment, not none and not the first.
    expect(feed.shown(s(40) - 1)?.at).toBe(s(10));
    expect(feed.shown(s(40) - 1, true)?.at).toBe(s(10));
    expect(feed.caughtUp(s(40) - 1)).toBe(true);
  });

  it('turning off "see every card" plays on the moments still to come without the cards, and drops none', () => {
    const feed = new SpectatorFeed();
    const withCards = { serverNow: 1, spectator: { delaySeconds: 30, seeAll: true, blocked: false } } as unknown as DelayedPart;
    const plain = { serverNow: 1, spectator: { delaySeconds: 30, seeAll: false, blocked: false } } as unknown as DelayedPart;
    feed.add(s(0), s(30), withCards, plain);
    feed.add(s(1), s(30), withCards, plain);
    feed.hideCards();
    expect(feed.size).toBe(2);
    expect(feed.oldest()?.part).toBe(plain);
  });
});

describe('the seats (item 1: a change to the number of seats, seat moves and new players)', () => {
  it('are sized from the hand shown, each player where they sat then, when the table goes down to fewer seats', () => {
    const { rt, clock } = table((x) => (x.table.maxSeats = 9), ['host', 'a', 'b']);
    // Seat c in seat 8, then the host takes the table down to 6 seats during the hand.
    rt.connect('c');
    rt.requestSeat('c', { seat: 8, name: 'C', stack: 10_000 });
    checkDown(rt);
    rt.dealNext('host');
    rt.updateSettings('host', { table: { maxSeats: 6 } });
    const past = snap(rt, clock);
    expect(past.seats).toHaveLength(9);
    checkDown(rt);
    rt.dealNext('host');
    const live = watcherNow(rt, clock);
    expect(live.seats).toHaveLength(6);
    const moved = live.seats.findIndex((x) => x?.playerId === 'c');
    expect(moved).toBeGreaterThanOrEqual(0);
    const shown = behind(live, past, DELAY);
    // Still the nine seats of the hand being shown, C in seat 9 with their cards in it, and nobody twice.
    expect(shown.seats).toHaveLength(9);
    expect(shown.seats[8]?.playerId).toBe('c');
    expect(shown.seats[8]?.inHand).toBe(true);
    expect(shown.seats.filter((x) => x?.playerId === 'c')).toHaveLength(1);
    expect(shown.hand?.handNumber).toBe(past.hand?.handNumber);
  });

  it('show someone who sat down since only once the view gets there, with the chips they sat down with', () => {
    const { rt, clock } = table();
    const past = snap(rt, clock);
    checkDown(rt);
    rt.connect('d');
    rt.updateSettings('host', { table: { maxSeats: 6 } });
    rt.requestSeat('d', { seat: 5, name: 'D', stack: 777 });
    rt.dealNext('host');
    const live = watcherNow(rt, clock);
    expect(live.seats[5]?.playerId).toBe('d');
    const shown = behind(live, past, DELAY);
    expect(shown.seats[5] ?? null).toBeNull();
    expect(shown.seats.length).toBe(past.seats.length);
    // Once a moment with them in it is shown, they are there.
    const later = behind(live, snap(rt, clock), DELAY);
    expect(later.seats[5]?.playerId).toBe('d');
  });

  it('show a seat as it was when its player has left and someone else has sat down in it', () => {
    const { rt, clock } = table();
    rt.stand('c', { afterHand: true });
    const past = snap(rt, clock);
    checkDown(rt);
    rt.connect('e');
    rt.requestSeat('e', { seat: 3, name: 'E', stack: 500 });
    const live = watcherNow(rt, clock);
    expect(live.seats[3]?.playerId).toBe('e');
    const shown = behind(live, past, DELAY);
    expect(shown.seats[3]?.playerId).toBe('c');
    expect(shown.seats[3]?.stack).toBe(past.seats[3]?.stack);
  });
});

describe('before anything is old enough to show (item 3)', () => {
  it('shows each player the chips they had before the hand in the snapshot shown next, not live bets', () => {
    const { rt, clock } = table();
    // A bet, then the snapshot spectators will see first (after a restart, say), then more betting live.
    const h = rt.state.hand!;
    rt.act(rt.state.seats[h.toAct!]!.playerId, { type: 'raise', to: 500 });
    const oldest = snap(rt, clock);
    const raiser = oldest.seats.find((x) => x?.lastAction?.startsWith?.('raise') || (x?.bet ?? 0) >= 500)!;
    checkDown(rt);
    const live = watcherNow(rt, clock);
    const waiting = behind(live, null, DELAY, oldest);
    expect(waiting.hand).toBeNull();
    // The raiser shows the 10,000 they started the hand with: neither the raise nor the result of the live hand.
    expect(waiting.seats.find((x) => x?.playerId === raiser.playerId)?.stack).toBe(10_000);
    expect(waiting.seats.every((x) => !x || (x.bet === 0 && !x.inHand && x.cards.length === 0))).toBe(true);
    // Every seat the oldest snapshot had, and only those.
    expect(waiting.seats.map((x) => x?.playerId ?? null)).toEqual(oldest.seats.map((x) => x?.playerId ?? null));
  });

  it('stays the same as time passes and the live table plays on, so no live change sends anything new', () => {
    const { rt, clock } = table();
    checkDown(rt);
    // The delay is turned on between hands, a while after the hand: the oldest snapshot is taken now, shown in 30 s.
    clock.advance(20_000);
    const oldest = snap(rt, clock);
    const at = (ms: number) => {
      clock.advance(ms);
      return shownKey(behind(watcherNow(rt, clock), null, DELAY, oldest));
    };
    const first = at(0);
    // Live, the next hand is dealt and played, with lines in the log, up to just before the oldest snapshot is due.
    rt.dealNext('host');
    expect(at(10_000)).toBe(first);
    checkDown(rt);
    expect(at(19_000)).toBe(first);
  });

  it('takes Dealer’s choice from that snapshot too, with no pick clock and no next game', () => {
    const { rt, clock } = table();
    const oldest = snap(rt, clock);
    const live = watcherNow(rt, clock);
    const waiting = behind({ ...live, choice: { chip: 3 } as never }, null, DELAY, { ...oldest, choice: { chip: 1, open: true, deadline: 5, next: { gameId: 'x' } } as never });
    expect(waiting.choice).toMatchObject({ chip: 1, open: false, deadline: null, next: null });
  });
});

describe('the delay banner (item 2)', () => {
  it('is the delay the hand shown is watched under, until the first hand dealt under a new one shows', () => {
    const { rt, clock } = table();
    rt.updateSettings('host', { spectators: { delaySeconds: 120 } });
    const past = snap(rt, clock);
    checkDown(rt);
    rt.dealNext('host');
    const live = watcherNow(rt, clock);
    expect(live.spectator?.delaySeconds).toBe(120);
    expect(behind(live, past, DELAY).spectator?.delaySeconds).toBe(30);
    expect(behind(live, snap(rt, clock), 120_000).spectator?.delaySeconds).toBe(120);
  });
});

describe('the rest of the view (what the read-through of #435 found)', () => {
  it('keeps the log as it was even once the live log has more lines than are sent', () => {
    const { rt, clock } = table();
    for (let i = 0; i < 70; i++) rt.requestBombPot('host', i % 2 === 0);
    const past = snap(rt, clock);
    const before = behind(watcherNow(rt, clock), past, DELAY).log;
    // The live hand ends: more lines, which would push the oldest ones out of a log cut by time.
    checkDown(rt);
    rt.dealNext('host');
    const after = behind(watcherNow(rt, clock), past, DELAY).log;
    expect(after).toEqual(before);
    expect(after.length).toBe(60);
  });

  it('counts a player who left as the live hand ended, tab still open, in their seat and not among the watchers', () => {
    const { rt, clock } = table();
    rt.stand('c', { afterHand: true });
    const past = snap(rt, clock);
    checkDown(rt);
    const audience = ['host', 'a', 'b', 'c', 'watcher'].map((p) => ({ playerId: p, name: p }));
    const live = tableView(rt, 'watcher', clock.now(), null, audience);
    expect(live.watchers.map((w) => w.playerId)).toContain('c');
    const shown = behind(live, past, DELAY, null, { audience });
    expect(shown.watchers.map((w) => w.playerId)).toEqual(['watcher']);
  });

  it('shows downloads closed while the game shown runs, though the live game has stopped after its hand', () => {
    const { rt, clock } = table((x) => (x.table.maxSeats = 4));
    checkDown(rt);
    rt.dealNext('host');
    rt.stop('host');
    const past = snap(rt, clock);
    expect(past.recordsLocked).toBe(true);
    checkDown(rt);
    const live = watcherNow(rt, clock);
    expect(live.recordsLocked).toBe(false);
    expect(behind(live, past, DELAY).recordsLocked).toBe(true);
    // Someone who played here has downloads open whenever they aren't seated, as at a live table.
    expect(behind(live, past, DELAY, null, { neverPlayed: false }).recordsLocked).toBe(false);
  });

  it('hides the hand at once when the host turns watching off', () => {
    const { rt, clock } = table();
    const past = snap(rt, clock);
    rt.updateSettings('host', { spectators: { allowed: false } });
    const shown = behind(watcherNow(rt, clock), past, DELAY);
    expect(shown.hand).toBeNull();
    expect(shown.seats.every((x) => !x || x.cards.length === 0)).toBe(true);
  });

  it('shows someone else’s waitlist offer, and my own, only once the view has it', () => {
    const { rt, clock } = table((x) => {
      x.table.maxSeats = 4;
      x.seating.waitlist = true;
    });
    rt.joinWaitlist('watcher', { name: 'W', stack: 500 });
    rt.joinWaitlist('fan', { name: 'F', stack: 500 });
    rt.stand('c', { afterHand: true });
    const past = snap(rt, clock);
    checkDown(rt);
    const liveW = watcherNow(rt, clock);
    expect(liveW.offers.map((o) => o.playerId)).toEqual(['watcher']);
    const shownW = behind(liveW, past, DELAY);
    expect(shownW.offers).toEqual([]);
    expect(shownW.waitlist.map((w) => w.playerId)).toEqual(['watcher', 'fan']);
    const liveF = tableView(rt, 'fan', clock.now());
    expect(behind(liveF, past, DELAY).offers).toEqual([]);
    // Once the view shows the seat free, the offer shows with it.
    const later = snap(rt, clock);
    expect(behind(liveW, later, DELAY).offers.map((o) => o.playerId)).toEqual(['watcher']);
    expect(behind(liveF, later, DELAY).offers.map((o) => o.playerId)).toEqual(['watcher']);
  });

  it('keeps showing my offer as it was when the live table lets it go, while I am still waiting', () => {
    const { rt, clock } = table((x) => {
      x.table.maxSeats = 4;
      x.seating.waitlist = true;
    });
    rt.joinWaitlist('watcher', { name: 'W', stack: 500 });
    rt.stand('c', { afterHand: true });
    checkDown(rt);
    const shown = snap(rt, clock);
    expect(shown.offers.map((o) => o.playerId)).toEqual(['watcher']);
    // Live, the host makes the table smaller between hands: the seat goes, and the offer with it, but W stays waiting.
    rt.updateSettings('host', { table: { maxSeats: 3 } });
    const live = watcherNow(rt, clock);
    expect(live.offers).toEqual([]);
    expect(live.waitlist.map((w) => w.playerId)).toEqual(['watcher']);
    expect(behind(live, shown, DELAY).offers).toEqual(shown.offers);
    // Leaving the waitlist myself takes it away at once.
    rt.leaveWaitlist('watcher');
    expect(behind(watcherNow(rt, clock), shown, DELAY).offers).toEqual([]);
  });

  it('shows my own place on the waitlist the moment I join it', () => {
    const { rt, clock } = table((x) => {
      x.table.maxSeats = 4;
      x.seating.waitlist = true;
    });
    const past = snap(rt, clock);
    rt.joinWaitlist('watcher', { name: 'W', stack: 500 });
    expect(behind(watcherNow(rt, clock), past, DELAY).waitlist.map((w) => w.playerId)).toEqual(['watcher']);
    // Someone else's only once the view gets there.
    rt.joinWaitlist('fan', { name: 'F', stack: 500 });
    expect(behind(watcherNow(rt, clock), past, DELAY).waitlist.map((w) => w.playerId)).toEqual(['watcher']);
  });
});

describe('when a spectator on a delay is sent a view (item 6)', () => {
  it('a live bet or the end of the live hand leaves what they are shown the same; chat changes it', () => {
    const { rt, clock } = table();
    const past = snap(rt, clock);
    const key = () => shownKey(behind(watcherNow(rt, clock), past, DELAY));
    const before = key();
    clock.advance(1_000);
    checkDown(rt);
    expect(key()).toBe(before);
    rt.dealNext('host');
    expect(key()).toBe(before);
    rt.chat('a', 'nh');
    expect(key()).not.toBe(before);
  });

  it('a paused moment shown at two different times is the same', () => {
    const { rt, clock } = table();
    rt.pause('host', true);
    const past = snap(rt, clock);
    const v1: TableView = behind(watcherNow(rt, clock), past, DELAY);
    clock.advance(5_000);
    const v2: TableView = behind(watcherNow(rt, clock), past, DELAY);
    expect(v2.serverNow).not.toBe(v1.serverNow);
    expect(shownKey(v2)).toBe(shownKey(v1));
  });
});

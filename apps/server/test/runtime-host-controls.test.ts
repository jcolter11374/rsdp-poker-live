import { beforeAll, describe, expect, it } from 'vitest';
import { variants } from '@rsdp/engine/core';
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
  PEOPLE.slice(0, n).forEach((id, seat) => rt.requestSeat(id, { seat, name: id.toUpperCase(), stack }));
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

  it('refuses to queue when a seat is free, and clears the queue when turned off', () => {
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

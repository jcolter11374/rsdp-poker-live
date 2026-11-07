import { beforeAll, describe, expect, it } from 'vitest';
import { engine, variants } from '@rsdp/engine/core';
import { defaultSettings, parseSettings, type ChoiceGame, type TableSettings } from '@rsdp/engine/settings';
import { registerAllVariants } from '@rsdp/engine/variants';
import { RESUME_MIN_MS, TableRuntime } from '../src/runtime/table';
import { BOT_PICK_MS } from '../src/runtime/choice';
import { behind, delayedPart, tableView } from '../src/runtime/view';
import { FakeClock, seeded } from './fake-clock';

beforeAll(() => registerAllVariants(variants));

const PEOPLE = ['host', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
const MENU: ChoiceGame[] = [
  { gameId: 'nlhe', betting: 'no-limit' },
  { gameId: 'razz', betting: 'fixed-limit' },
  { gameId: 'badugi', betting: 'fixed-limit' },
  { gameId: 'plo4', betting: 'pot-limit' },
];

function table(patch: (s: TableSettings) => void = () => {}, rng = seeded()) {
  const clock = new FakeClock();
  const settings = defaultSettings('cash');
  settings.table.maxSeats = 9;
  settings.seating.requireApproval = false;
  settings.stakes = { ...settings.stakes, smallBlind: 1, bigBlind: 2, ante: 1, anteType: 'per-player', bringIn: 1, smallBet: 2, bigBet: 4 };
  settings.game.dealersChoice = { enabled: true, games: MENU, hands: 0, pickSeconds: 20 };
  patch(settings);
  const rt = TableRuntime.create({ id: 't1', hostId: 'host', settings: parseSettings(settings) }, { clock, rng });
  for (const p of PEOPLE) rt.connect(p);
  return { rt, clock };
}

function seat(rt: TableRuntime, n: number, stack = 1000) {
  const ids = PEOPLE.slice(0, n);
  ids.forEach((id, i) => rt.requestSeat(id, { seat: i, name: id.toUpperCase(), stack }));
  return ids;
}

const hand = (rt: TableRuntime) => rt.state.hand!;
const live = (rt: TableRuntime) => !!rt.state.hand && rt.state.hand.phase !== 'complete';
const toActId = (rt: TableRuntime) => rt.state.seats[hand(rt).toAct!]!.playerId;
const chooser = (rt: TableRuntime) => rt.choice.chooser()!;
const menuIndex = (rt: TableRuntime, gameId: string) => rt.settings.game.dealersChoice!.games.findIndex((g) => g.gameId === gameId);
const pick = (rt: TableRuntime, gameId: string) => rt.chooseGame(chooser(rt).playerId, { index: menuIndex(rt, gameId) });

function checkDown(rt: TableRuntime) {
  for (let i = 0; i < 200 && live(rt); i++) {
    const h = hand(rt);
    if (h.phase === 'drawing') {
      rt.draw(toActId(rt), []);
      continue;
    }
    if (h.toAct === null) break;
    const legal = engine.legalActions(h, h.toAct)!;
    rt.act(toActId(rt), legal.canCheck ? { type: 'check' } : legal.canBringIn ? { type: 'bring-in' } : { type: 'call' });
  }
}

/** Plays hands out until the table waits for a pick (or `max` hands); returns the games dealt. */
function playUntilPick(rt: TableRuntime, clock: FakeClock, max = 30) {
  const games: string[] = [];
  for (let i = 0; i < max; i++) {
    if (!live(rt)) {
      if (rt.state.choice?.deadline != null) break;
      clock.advance(10_000);
      if (!live(rt)) break;
    }
    games.push(hand(rt).input.game.id);
    checkDown(rt);
    clock.advance(10_000);
  }
  return games;
}

describe("Dealer's choice", () => {
  it('waits for the first pick, gives the chooser the first button, and plays each pick for one orbit', () => {
    const { rt, clock } = table();
    seat(rt, 3);
    rt.start('host');
    // Nothing is dealt until the first chooser picks.
    expect(rt.state.hand).toBeNull();
    expect(rt.state.choice!.deadline).toBe(clock.now() + 20_000);
    const first = chooser(rt);
    expect(tableView(rt, 'a', clock.now()).choice).toMatchObject({ chip: first.seat, open: true, deadline: clock.now() + 20_000, current: null });
    pick(rt, 'plo4');
    expect(hand(rt).input.game.id).toBe('plo4');
    expect(hand(rt).input.button).toBe(first.seat);
    expect(rt.state.log.some((l) => l.text === `${first.name} picked Pot-Limit Omaha`)).toBe(true);
    // The pick keeps the chooser's id for name replacement (replaceName.ts), and no browser is sent it.
    expect(rt.state.choice!.current).toMatchObject({ by: first.name, seat: first.seat, byId: first.playerId, how: 'picked' });
    expect(JSON.stringify(tableView(rt, 'a', clock.now()).choice)).not.toContain('byId');
    // The chip moves one seat to the left.
    const second = chooser(rt);
    expect(second.seat).toBe((first.seat + 1) % 3);
    expect(tableView(rt, 'a', clock.now()).choice).toMatchObject({ chip: second.seat, handsLeft: 2, open: false, current: { gameId: 'plo4', by: first.name, how: 'picked' } });
    const games = playUntilPick(rt, clock);
    expect(games).toEqual(['plo4', 'plo4', 'plo4']);
    expect(chooser(rt).seat).toBe(second.seat);
    pick(rt, 'razz');
    expect(hand(rt).input.game.id).toBe('razz');
    expect(chooser(rt).seat).toBe((second.seat + 1) % 3);
  });

  it('lets the next chooser pick during the last hand of the orbit, so the table never waits', () => {
    const { rt, clock } = table();
    seat(rt, 3);
    rt.start('host');
    pick(rt, 'nlhe');
    checkDown(rt);
    clock.advance(10_000);
    checkDown(rt);
    clock.advance(10_000);
    // Third and last hand of the orbit: picking is open, with no clock.
    expect(live(rt)).toBe(true);
    expect(tableView(rt, 'a', clock.now()).choice).toMatchObject({ open: true, deadline: null, handsLeft: 0 });
    // Not before then, and only the chooser.
    const other = rt.state.seats.find((x) => x && x.playerId !== chooser(rt).playerId)!;
    expect(() => rt.chooseGame(other.playerId, { index: 1 })).toThrow(/isn't your pick/);
    pick(rt, 'razz');
    expect(tableView(rt, 'a', clock.now()).choice!.next).toMatchObject({ gameId: 'razz' });
    checkDown(rt);
    clock.advance(10_000);
    expect(hand(rt).input.game.id).toBe('razz');
    expect(hand(rt).input.handNumber).toBe(4);
  });

  it('refuses a pick out of turn or before the last hand', () => {
    const { rt, clock } = table();
    seat(rt, 3);
    rt.start('host');
    pick(rt, 'nlhe');
    expect(() => pick(rt, 'razz')).toThrow(/isn't time/);
    checkDown(rt);
    clock.advance(10_000);
    expect(() => rt.chooseGame(chooser(rt).playerId, { index: 99 })).toThrow(/isn't time/);
  });

  it('carries the current game on when the chooser runs out of time, and moves the chip on', () => {
    const { rt, clock } = table();
    seat(rt, 3);
    rt.start('host');
    pick(rt, 'razz');
    playUntilPick(rt, clock);
    const late = chooser(rt);
    clock.advance(20_000);
    expect(hand(rt).input.game.id).toBe('razz');
    expect(rt.state.log.some((l) => l.text === `${late.name} didn't pick in time, so Razz carries on`)).toBe(true);
    expect(chooser(rt).seat).toBe((late.seat + 1) % 3);
    expect(rt.state.choice!.current).toMatchObject({ how: 'kept', by: null });
  });

  it('deals the first game on the menu that fits when the very first pick is missed', () => {
    const { rt, clock } = table((s) => {
      s.game.dealersChoice!.games = [MENU[2], MENU[1], MENU[0]];
    });
    seat(rt, 7);
    rt.start('host');
    // Badugi seats 6 and Razz 8: with 7 sitting down, Razz.
    clock.advance(20_000);
    expect(hand(rt).input.game.id).toBe('razz');
  });

  it("greys out games that don't fit the players sitting down", () => {
    const { rt, clock } = table();
    seat(rt, 7);
    rt.start('host');
    expect(() => pick(rt, 'badugi')).toThrow(/Badugi seats at most 6 players, and 7 are sitting down/);
    expect(tableView(rt, 'a', clock.now()).choice!.count).toBe(7);
    pick(rt, 'razz');
    expect(hand(rt).input.game.id).toBe('razz');
  });

  it('closes the other seats while a smaller game is picked or played, and opens them for a bigger one', () => {
    const { rt, clock } = table();
    seat(rt, 6);
    rt.start('host');
    pick(rt, 'badugi');
    expect(hand(rt).input.game.id).toBe('badugi');
    expect(tableView(rt, 'g', clock.now()).choice!.cap).toBe(6);
    expect(() => rt.requestSeat('g', { seat: 7, name: 'G', stack: 1000 })).toThrow(/Badugi seats at most 6 players, so the other seats are closed/);
    expect(() => rt.addBot('host')).toThrow(/closed/);
    playUntilPick(rt, clock);
    // Still Badugi's seats while the next game is being picked.
    expect(() => rt.requestSeat('g', { seat: 7, name: 'G', stack: 1000 })).toThrow(/closed/);
    pick(rt, 'nlhe');
    expect(hand(rt).input.game.id).toBe('nlhe');
    rt.requestSeat('g', { seat: 7, name: 'G', stack: 1000 });
    expect(rt.state.seats[7]?.playerId).toBe('g');
  });

  it('counts a seat offered from the waitlist as taken when checking a game fits', () => {
    const { rt, clock } = table((s) => {
      s.table.maxSeats = 7;
      s.seating.waitlist = true;
    });
    seat(rt, 7);
    rt.joinWaitlist('h', { name: 'H', stack: 1000 });
    rt.stand('f');
    expect(rt.state.offers!.map((o) => o.playerId)).toEqual(['h']);
    rt.start('host');
    expect(tableView(rt, 'a', clock.now()).choice!.count).toBe(7);
    expect(() => pick(rt, 'badugi')).toThrow(/7 are sitting down/);
  });

  it("doesn't count a seat request, which only the host sees, but it waits while a smaller game is on", () => {
    const { rt, clock } = table();
    seat(rt, 6);
    rt.updateSettings('host', { seating: { requireApproval: true } });
    rt.requestSeat('g', { seat: 7, name: 'G', stack: 1000 });
    rt.start('host');
    expect(tableView(rt, 'a', clock.now()).choice!.count).toBe(6);
    pick(rt, 'badugi');
    expect(hand(rt).input.game.id).toBe('badugi');
    expect(() => rt.approve('host', rt.state.requests[0].id)).toThrow(/closed until the next game/);
    expect(rt.state.requests).toHaveLength(1);
  });

  it("doesn't count a waitlist offer to someone who still needs the host's OK, which only asks for the seat (#453)", () => {
    // Nine seats, six seated, and the host approves newcomers. G joins the waitlist and is offered a free seat at once.
    // Counting that offer would let G keep Badugi (six players) off the menu, rejoining each time it lapsed.
    const { rt, clock } = table((s) => {
      s.seating.waitlist = true;
    });
    seat(rt, 6);
    rt.updateSettings('host', { seating: { requireApproval: true } });
    rt.joinWaitlist('g', { name: 'G', stack: 1000 });
    expect(rt.state.offers!.map((o) => o.playerId)).toEqual(['g']);
    rt.start('host');
    expect(tableView(rt, 'a', clock.now()).choice!.count).toBe(6);
    pick(rt, 'badugi');
    expect(hand(rt).input.game.id).toBe('badugi');
    // Taking the offer while Badugi is on asks the host for the seat, as a seat request made before the pick would.
    // It waits: the host can't seat G until the next game, and G isn't dropped from the table's queue for being late.
    rt.requestSeat('g', { seat: rt.state.offers![0].seat, name: 'G', stack: 1000 });
    expect(rt.state.requests.map((r) => r.playerId)).toEqual(['g']);
    expect(rt.state.offers).toEqual([]);
    expect(rt.state.seats.some((x) => x?.playerId === 'g')).toBe(false);
    expect(() => rt.approve('host', rt.state.requests[0].id)).toThrow(/closed until the next game/);
    expect(rt.state.requests).toHaveLength(1);
    // A newcomer without an offer still can't ask for a closed seat.
    expect(() => rt.requestSeat('h', { seat: 8, name: 'H', stack: 1000 })).toThrow(/closed until the next game/);
  });

  it("still counts a waitlist offer to someone who may approve seats, and to anyone once approval is off (#453)", () => {
    const { rt, clock } = table((s) => {
      s.seating.waitlist = true;
    });
    seat(rt, 6);
    rt.updateSettings('host', { seating: { requireApproval: true } });
    rt.setCoHost('host', 'g', ['approve']);
    rt.joinWaitlist('g', { name: 'G', stack: 1000 });
    rt.joinWaitlist('h', { name: 'H', stack: 1000 });
    expect(rt.state.offers!.map((o) => o.playerId)).toEqual(['g', 'h']);
    // G can seat themselves, so G's offer counts; H still needs the host, so H's doesn't.
    expect(tableView(rt, 'a', clock.now()).choice!.count).toBe(7);
    rt.updateSettings('host', { seating: { requireApproval: false } });
    expect(tableView(rt, 'a', clock.now()).choice!.count).toBe(8);
    rt.start('host');
    expect(() => pick(rt, 'badugi')).toThrow(/8 are sitting down/);
  });

  it("doesn't let an uncounted waitlist offer take the room a smaller game was picked with (#453)", () => {
    // Five seated of nine, and the host approves newcomers. E asks for a seat; G joins the waitlist and is offered one.
    // Neither counts, so Badugi (six players) fits, with room for one more.
    const { rt, clock } = table((s) => {
      s.seating.waitlist = true;
    });
    seat(rt, 5);
    rt.updateSettings('host', { seating: { requireApproval: true } });
    rt.requestSeat('e', { seat: 7, name: 'E', stack: 1000 });
    rt.joinWaitlist('g', { name: 'G', stack: 1000 });
    expect(rt.state.offers!.map((o) => o.playerId)).toEqual(['g']);
    expect(tableView(rt, 'a', clock.now()).choice!.count).toBe(5);
    rt.start('host');
    pick(rt, 'badugi');
    // The host can seat E: G's offer, like a seat request, doesn't hold that room.
    rt.approve('host', rt.state.requests[0].id);
    expect(rt.state.seats[7]?.playerId).toBe('e');
    // Badugi is full now. G taking the offer asks for the seat, and the request waits for the next game.
    rt.requestSeat('g', { seat: rt.state.offers![0].seat, name: 'G', stack: 1000 });
    expect(() => rt.approve('host', rt.state.requests[0].id)).toThrow(/closed until the next game/);
    expect(rt.state.requests.map((r) => r.playerId)).toEqual(['g']);
  });

  it('lets go of an offer that starts to count when a smaller game has no room for it, and keeps its holder waiting (#453)', () => {
    // G's offer didn't count, so Badugi was picked with six seated. Once G no longer needs the host's OK, the offer
    // counts and doesn't fit: it is let go, and G stays first on the waitlist instead of being refused until it lapses.
    for (const change of ['approval off', 'co-host'] as const) {
      const { rt, clock } = table((s) => {
        s.seating.waitlist = true;
        s.game.dealersChoice!.hands = 1;
      });
      seat(rt, 6);
      rt.updateSettings('host', { seating: { requireApproval: true } });
      rt.joinWaitlist('g', { name: 'G', stack: 1000 });
      rt.start('host');
      pick(rt, 'badugi');
      if (change === 'approval off') rt.updateSettings('host', { seating: { requireApproval: false } });
      else rt.setCoHost('host', 'g', ['approve']);
      expect(rt.state.offers).toEqual([]);
      expect(tableView(rt, 'a', clock.now()).choice).toMatchObject({ count: 6, cap: 6 });
      clock.advance(61_000);
      expect(rt.state.waitlist!.map((w) => w.playerId)).toEqual(['g']);
      // Once a game with room is dealt, the seat is offered to G again.
      checkDown(rt);
      pick(rt, 'nlhe');
      clock.advance(10_000);
      expect(hand(rt).input.game.id).toBe('nlhe');
      expect(rt.state.offers!.map((o) => o.playerId)).toEqual(['g']);
    }
  });

  it('keeps the earliest offers that fit when offers start to count, so nobody behind them gets a seat first (#453)', () => {
    const { rt } = table((s) => {
      s.seating.waitlist = true;
    });
    rt.connect('i');
    seat(rt, 5);
    rt.updateSettings('host', { seating: { requireApproval: true } });
    rt.joinWaitlist('g', { name: 'G', stack: 1000 });
    rt.joinWaitlist('h', { name: 'H', stack: 1000 });
    rt.start('host');
    pick(rt, 'badugi');
    rt.joinWaitlist('i', { name: 'I', stack: 1000 });
    // Badugi has room for one more: G keeps the offer and can take it; H waits, still ahead of I, who isn't offered one.
    rt.updateSettings('host', { seating: { requireApproval: false } });
    expect(rt.state.offers!.map((o) => o.playerId)).toEqual(['g']);
    expect(rt.state.waitlist!.map((w) => w.playerId)).toEqual(['g', 'h', 'i']);
    rt.requestSeat('g', { seat: rt.state.offers![0].seat, name: 'G', stack: 1000 });
    expect(rt.state.seats.some((x) => x?.playerId === 'g')).toBe(true);
    expect(rt.state.offers).toEqual([]);
    expect(rt.state.waitlist!.map((w) => w.playerId)).toEqual(['h', 'i']);
  });

  it('lets someone who needs the host take their offer as a request while a smaller table keeps a seat for a mover (#453)', () => {
    // Six seated (E in the ninth seat), approval on, G offered seat 6. Badugi is picked, then the host makes the table
    // seven seats from the next hand: E will move into seat 7, which is kept. G's seat isn't, so G's take is a request.
    const { rt } = table((s) => {
      s.seating.waitlist = true;
    });
    seat(rt, 5);
    rt.requestSeat('e', { seat: 8, name: 'E', stack: 1000 });
    rt.updateSettings('host', { seating: { requireApproval: true } });
    rt.joinWaitlist('g', { name: 'G', stack: 1000 });
    expect(rt.state.offers!.map((o) => [o.playerId, o.seat])).toEqual([['g', 5]]);
    rt.start('host');
    pick(rt, 'badugi');
    rt.updateSettings('host', { table: { maxSeats: 7 } });
    expect(rt.state.offers!.map((o) => [o.playerId, o.seat])).toEqual([['g', 5]]);
    rt.requestSeat('g', { seat: 5, name: 'G', stack: 1000 });
    expect(rt.state.requests.map((r) => [r.playerId, r.seat])).toEqual([['g', 5]]);
    // Someone else asking for the kept seat is still told it's kept.
    rt.updateSettings('host', { seating: { requireApproval: false } });
    expect(() => rt.requestSeat('h', { seat: 6, name: 'H', stack: 1000 })).toThrow(/kept for a player moving into it/);
  });

  it('skips a chooser who sits out, and gives the next player a fresh clock', () => {
    const { rt, clock } = table();
    seat(rt, 4);
    rt.start('host');
    const first = chooser(rt);
    clock.advance(15_000);
    rt.sitOut(first.playerId, true);
    const next = chooser(rt);
    expect(next.seat).not.toBe(first.seat);
    expect(rt.state.choice!.deadline).toBe(clock.now() + 20_000);
    pick(rt, 'nlhe');
    expect(hand(rt).input.game.id).toBe('nlhe');
  });

  it('a bot holding the chip picks at random from the games that fit, a moment after picking opens', () => {
    const { rt, clock } = table();
    seat(rt, 1);
    rt.addBot('host', { seat: 1 });
    rt.addBot('host', { seat: 2 });
    rt.start('host');
    const botPicks = new Map<number, string>();
    let timed = false;
    for (let i = 0; i < 30; i++) {
      if (!live(rt)) {
        if (rt.isBot(chooser(rt).playerId)) clock.advance(BOT_PICK_MS);
        else pick(rt, 'nlhe');
      }
      const c = rt.state.choice!;
      if (c.current?.how === 'bot') botPicks.set(rt.state.handNumber - c.hands, c.current.gameId);
      // The last hand of a pick, with a bot to choose next: it picks once BOT_PICK_MS has passed.
      if (!timed && rt.choice.pickOpen() && rt.isBot(chooser(rt).playerId) && c.botAt !== null) {
        const due = c.botAt;
        clock.advance(due - clock.now() - 1);
        expect(rt.state.choice!.next).toBeNull();
        clock.advance(1);
        expect(rt.state.choice!.next).toMatchObject({ how: 'bot' });
        timed = true;
      }
      checkDown(rt);
      // Up to the next deal, in small steps, so the check above sees a bot's pick before it is made.
      for (let t = 0; t < 100 && !live(rt) && rt.state.choice!.deadline === null; t++) clock.advance(100);
    }
    expect(timed).toBe(true);
    expect(botPicks.size).toBeGreaterThanOrEqual(3);
    for (const g of botPicks.values()) expect(MENU.some((m) => m.gameId === g)).toBe(true);
    // Random, not always the same game.
    expect(new Set(botPicks.values()).size).toBeGreaterThan(1);
  });

  it('stops the pick clock while paused and gives at least 5 seconds after', () => {
    const { rt, clock } = table();
    seat(rt, 3);
    rt.start('host');
    clock.advance(18_000);
    rt.pause('host', true);
    clock.advance(60_000);
    expect(rt.state.hand).toBeNull();
    expect(tableView(rt, 'a', clock.now()).choice!.deadline).toBe(clock.now() + RESUME_MIN_MS);
    rt.pause('host', false);
    expect(rt.state.choice!.deadline).toBe(clock.now() + RESUME_MIN_MS);
    clock.advance(RESUME_MIN_MS - 100);
    expect(rt.state.hand).toBeNull();
    pick(rt, 'razz');
    expect(hand(rt).input.game.id).toBe('razz');
  });

  it('gives the chooser a fresh clock after a restart', () => {
    const { rt, clock } = table();
    seat(rt, 3);
    rt.start('host');
    clock.advance(19_000);
    const saved = JSON.parse(JSON.stringify(rt.state));
    rt.dispose();
    clock.advance(60_000);
    const back = new TableRuntime(saved, { clock, rng: seeded() });
    back.resume();
    for (const p of PEOPLE) back.connect(p);
    expect(back.state.hand).toBeNull();
    expect(back.state.choice!.deadline).toBe(clock.now() + 20_000);
    back.chooseGame(back.choice.chooser()!.playerId, { index: 0 });
    expect(back.state.hand!.input.game.id).toBe('nlhe');
  });

  it('shortens the orbit when players leave', () => {
    const { rt, clock } = table();
    seat(rt, 5);
    rt.start('host');
    pick(rt, 'nlhe');
    checkDown(rt);
    // Three of five leave after the first hand: with two dealt in, the orbit ends after its second hand.
    for (const id of ['b', 'c', 'd']) rt.stand(id);
    clock.advance(10_000);
    expect(playUntilPick(rt, clock)).toEqual(['nlhe']);
    expect(rt.state.choice!.hands).toBe(2);
    expect(rt.state.choice!.deadline).not.toBeNull();
  });

  it('can last a set number of hands instead of an orbit', () => {
    const { rt, clock } = table((s) => (s.game.dealersChoice!.hands = 2));
    seat(rt, 4);
    rt.start('host');
    pick(rt, 'plo4');
    expect(playUntilPick(rt, clock)).toEqual(['plo4', 'plo4']);
  });

  it('with a stud game on the menu, only the stud games ante', () => {
    const { rt, clock } = table();
    seat(rt, 3);
    rt.start('host');
    pick(rt, 'nlhe');
    expect(hand(rt).input.stakes.ante).toBe(0);
    playUntilPick(rt, clock);
    pick(rt, 'razz');
    expect(hand(rt).input.stakes.ante).toBe(1);
  });

  it('keeps the current game going on purpose', () => {
    const { rt, clock } = table();
    seat(rt, 3);
    rt.start('host');
    pick(rt, 'nlhe');
    playUntilPick(rt, clock);
    expect(tableView(rt, 'a', clock.now()).choice!.canKeep).toBe(true);
    const keeper = chooser(rt);
    pick(rt, 'nlhe');
    expect(rt.state.log.some((l) => l.text === `${keeper.name} kept No-Limit Hold'em going`)).toBe(true);
  });

  it('forgets the chip when the host turns it off', () => {
    const { rt, clock } = table();
    seat(rt, 3);
    rt.start('host');
    pick(rt, 'razz');
    rt.updateSettings('host', { game: { dealersChoice: { enabled: false } } });
    checkDown(rt);
    clock.advance(10_000);
    expect(hand(rt).input.game.id).toBe('nlhe');
    expect(rt.state.choice).toBeUndefined();
    expect(tableView(rt, 'a', clock.now()).choice).toBeNull();
  });

  it('checks the menu against the table', () => {
    const { rt, clock } = table();
    seat(rt, 7);
    expect(() => rt.updateSettings('host', { game: { dealersChoice: { games: [MENU[1], MENU[2]] } } })).toThrow(/the biggest game on the menu, Razz, seats at most 8: lower the table to 8 seats/);
    expect(() => rt.updateSettings('host', { table: { maxSeats: 7 }, game: { dealersChoice: { games: [MENU[2], { gameId: 'td27', betting: 'fixed-limit' }] } } })).toThrow(/No game on the menu seats 7/);
    expect(() => rt.updateSettings('host', { game: { dealersChoice: { games: [MENU[0], MENU[0]] } } })).toThrow(/on the menu twice/);
    expect(() => rt.updateSettings('host', { game: { dealersChoice: { games: [MENU[0]] } } })).toThrow(/at least two games/);
    expect(() =>
      rt.updateSettings('host', { game: { rotation: { enabled: true, steps: [{ gameId: 'nlhe', betting: 'no-limit', length: 1, unit: 'hands' }] } } }),
    ).toThrow(/turn off rotating games/);
  });

  it('is for cash tables only', () => {
    const s = defaultSettings('tournament');
    s.game.dealersChoice = { enabled: true, games: MENU, hands: 0, pickSeconds: 20 };
    expect(() => parseSettings(s)).toThrow(/cash games only/);
  });

  it('settings saved before Dealer’s choice existed still load, with it off', () => {
    const s = defaultSettings('cash') as TableSettings & { game: { dealersChoice?: unknown } };
    delete s.game.dealersChoice;
    expect(parseSettings(s).game.dealersChoice).toBeUndefined();
    const clock = new FakeClock();
    const rt = TableRuntime.create({ id: 't2', hostId: 'host', settings: s }, { clock, rng: seeded() });
    expect(tableView(rt, 'host', clock.now()).choice).toBeNull();
  });

  it('runs on the delay for spectators', () => {
    const { rt, clock } = table((s) => (s.spectators.delaySeconds = 30));
    seat(rt, 3);
    rt.start('host');
    const before = delayedPart(tableView(rt, 'zed', clock.now()));
    clock.advance(5_000);
    pick(rt, 'razz');
    const now = tableView(rt, 'zed', clock.now());
    expect(now.choice!.current).toMatchObject({ gameId: 'razz' });
    const shown = behind(now, before, 5_000);
    expect(shown.choice!.current).toBeNull();
    expect(shown.choice!.deadline).toBe(before.choice!.deadline! + 5_000);
  });
});

// From the review pass on PR #366: the clock and the gate when the table can't deal, or players leave mid-orbit.
describe("Dealer's choice: the pick clock when the table can't deal", () => {
  const others = (rt: TableRuntime, ids: string[]) => ids.filter((x) => x !== chooser(rt).playerId);

  it('stops the clock when the host stops the game, and gives a fresh one when it starts again', () => {
    const { rt, clock } = table();
    seat(rt, 3);
    rt.start('host');
    const first = chooser(rt);
    rt.stop('host');
    // The fake clock throws if a timer keeps firing.
    clock.advance(30_000);
    expect(rt.state.choice!.deadline).toBeNull();
    rt.start('host');
    expect(live(rt)).toBe(false);
    expect(chooser(rt).playerId).toBe(first.playerId);
    expect(rt.state.choice!.deadline).toBe(clock.now() + 20_000);
  });

  it('stops the clock while too few players can be dealt in, or everyone has gone', () => {
    const { rt, clock } = table();
    seat(rt, 3);
    rt.start('host');
    for (const id of others(rt, ['host', 'a', 'b'])) rt.sitOut(id, true);
    clock.advance(30_000);
    expect(live(rt)).toBe(false);
    expect(rt.state.choice!.deadline).toBeNull();

    const gone = table();
    seat(gone.rt, 3);
    gone.rt.start('host');
    for (const id of ['host', 'a', 'b']) gone.rt.stand(id);
    gone.clock.advance(30_000);
    expect(live(gone.rt)).toBe(false);
  });

  it('lets the chooser pick when a player leaves before the last hand of an orbit', () => {
    const { rt, clock } = table();
    seat(rt, 4);
    rt.start('host');
    pick(rt, 'nlhe');
    for (let i = 0; i < 3; i++) {
      checkDown(rt);
      if (i < 2) clock.advance(10_000);
    }
    expect(rt.state.choice).toMatchObject({ hands: 3, length: 4 });
    const next = chooser(rt);
    rt.stand(others(rt, ['host', 'a', 'b', 'c'])[0]);
    clock.advance(10_000);
    // Three are left, so the orbit was three hands: the table waits for the pick, and the chooser can make it.
    expect(live(rt)).toBe(false);
    expect(tableView(rt, next.playerId, clock.now()).choice).toMatchObject({ open: true, chip: next.seat });
    pick(rt, 'razz');
    expect(hand(rt).input.game.id).toBe('razz');
  });

  it('a bot holding the chip picks when a player leaves before the last hand of an orbit', () => {
    const { rt, clock } = table();
    seat(rt, 1);
    for (const at of [1, 2, 3]) rt.addBot('host', { seat: at });
    rt.start('host');
    if (rt.isBot(chooser(rt).playerId)) clock.advance(BOT_PICK_MS);
    else pick(rt, 'nlhe');
    for (let i = 0; i < 3; i++) {
      checkDown(rt);
      if (i < 2) clock.advance(10_000);
    }
    const next = chooser(rt);
    const victim = rt.state.seats.find((x) => x && rt.isBot(x.playerId) && x.playerId !== next.playerId)!;
    rt.removeBot('host', victim.playerId);
    clock.advance(10_000);
    if (rt.isBot(next.playerId)) expect(rt.state.choice!.current!.how).toBe('bot');
    else pick(rt, 'razz');
    expect(live(rt)).toBe(true);
  });

  it('deals as soon as play resumes when the pick came in while the game was paused', () => {
    const { rt, clock } = table();
    seat(rt, 3);
    rt.start('host');
    clock.advance(2_000);
    rt.pause('host', true);
    pick(rt, 'razz');
    clock.advance(5_000);
    rt.pause('host', false);
    expect(live(rt)).toBe(true);
    expect(hand(rt).input.game.id).toBe('razz');
  });

  it('stops waiting when the host turns Dealer\'s choice off during the pick clock', () => {
    const { rt, clock } = table();
    seat(rt, 3);
    rt.start('host');
    clock.advance(1_000);
    rt.updateSettings('host', { game: { dealersChoice: { enabled: false } } });
    expect(live(rt)).toBe(true);
    expect(rt.state.choice).toBeUndefined();
  });

  it('refuses a pick if the menu changed while it was on its way', () => {
    const { rt } = table();
    seat(rt, 3);
    rt.start('host');
    const who = chooser(rt).playerId;
    expect(() => rt.chooseGame(who, { index: 0, gameId: 'razz', betting: 'fixed-limit' })).toThrow(/changed the menu/);
    rt.chooseGame(who, { index: 1, gameId: 'razz', betting: 'fixed-limit' });
    expect(hand(rt).input.game.id).toBe('razz');
  });
});

describe("Dealer's choice: a smaller table and the table's own game", () => {
  /** Host in seat 0, A in seat 1, then the rest in seats 7 and 8. Plays picks until `who` holds the chip. */
  function farSeats(far: string[], who: string) {
    const { rt, clock } = table();
    rt.requestSeat('host', { seat: 0, name: 'HOST', stack: 1000 });
    rt.requestSeat('a', { seat: 1, name: 'A', stack: 1000 });
    far.forEach((id, i) => rt.requestSeat(id, { seat: 7 + i, name: id.toUpperCase(), stack: 1000 }));
    rt.start('host');
    pick(rt, 'nlhe');
    for (let i = 0; i < 4 && chooser(rt).playerId !== who; i++) {
      playUntilPick(rt, clock);
      pick(rt, 'nlhe');
    }
    expect(chooser(rt).playerId).toBe(who);
    return { rt, clock };
  }

  it('moves the Pick chip with its player when the host makes the table smaller', () => {
    const { rt, clock } = farSeats(['b'], 'b');
    rt.updateSettings('host', { table: { maxSeats: 6 } });
    checkDown(rt);
    clock.advance(10_000);
    expect(rt.state.seats).toHaveLength(6);
    // B moved into a kept seat, and still picks next.
    expect(rt.state.seats.some((x) => x?.playerId === 'b')).toBe(true);
    expect(chooser(rt).playerId).toBe('b');
  });

  it('gives the chip of an empty seat that goes to the next player round from it', () => {
    const { rt, clock } = farSeats(['b', 'c'], 'b');
    rt.stand('b');
    // B's seat is empty: C, the next player to its left, picks next.
    expect(chooser(rt).playerId).toBe('c');
    rt.updateSettings('host', { table: { maxSeats: 6 } });
    checkDown(rt);
    clock.advance(10_000);
    expect(rt.state.seats.some((x) => x?.playerId === 'c')).toBe(true);
    expect(chooser(rt).playerId).toBe('c');
  });

  it('refuses a table whose own game it doesn’t know, which it deals before the first pick at a table already playing', () => {
    const s = defaultSettings('cash');
    s.game.dealersChoice = { enabled: true, games: MENU, hands: 0, pickSeconds: 20 };
    s.game.gameId = 'nosuch';
    expect(() => TableRuntime.checkGameSettings(s)).toThrow(/unknown game nosuch/);
  });
});

describe("Dealer's choice: from the final review", () => {
  it('moves the chip on for good: a chooser who sits out and back in, or a newcomer in their seat, never takes it back', () => {
    const { rt, clock } = table();
    seat(rt, 4);
    rt.start('host');
    const a = chooser(rt);
    rt.sitOut(a.playerId, true);
    const b = chooser(rt);
    expect(b.playerId).not.toBe(a.playerId);
    const deadline = rt.state.choice!.deadline;
    clock.advance(5_000);
    rt.sitOut(a.playerId, false);
    expect(chooser(rt).playerId).toBe(b.playerId);
    expect(rt.state.choice!.deadline).toBe(deadline);
    // Gone and replaced: whoever sits in the old seat doesn't take the pick either.
    rt.stand(a.playerId);
    rt.requestSeat('h', { seat: a.seat, name: 'H', stack: 1000 });
    expect(chooser(rt).playerId).toBe(b.playerId);
    // B's pick deals, with the first button on B, the player who picked.
    pick(rt, 'nlhe');
    expect(hand(rt).input.button).toBe(b.seat);
  });

  it('keeps the orbit its full length when a player sits out a single hand of it', () => {
    const { rt, clock } = table();
    seat(rt, 5);
    rt.start('host');
    pick(rt, 'razz');
    const sitter = rt.state.seats.find((x) => x && x.playerId !== chooser(rt).playerId)!.playerId;
    rt.sitOut(sitter, true);
    checkDown(rt);
    clock.advance(10_000);
    expect(hand(rt).input.game.id).toBe('razz');
    rt.sitOut(sitter, false);
    checkDown(rt);
    const games = ['razz', 'razz', ...playUntilPick(rt, clock)];
    // 5 were dealt into the first hand, and 5 are back: five hands of Razz, not four.
    expect(games.filter((g) => g === 'razz')).toHaveLength(5);
  });

  it('shows no pick clock once the pick is made while the game is paused', () => {
    const { rt, clock } = table();
    seat(rt, 3);
    rt.start('host');
    clock.advance(2_000);
    rt.pause('host', true);
    pick(rt, 'razz');
    const v = tableView(rt, 'a', clock.now()).choice!;
    expect(v).toMatchObject({ deadline: null, open: false, next: { gameId: 'razz' } });
  });

  it('tells someone without a seat only that it isn’t their pick, whatever the hand', () => {
    const { rt, clock } = table();
    seat(rt, 3);
    rt.start('host');
    expect(() => rt.chooseGame('h', { index: 0, handNumber: 7 })).toThrow(/isn't your pick/);
    pick(rt, 'nlhe');
    expect(() => rt.chooseGame('h', { index: 0, handNumber: 0 })).toThrow(/isn't your pick/);
    expect(() => rt.chooseGame('h', { index: 0, handNumber: rt.state.handNumber })).toThrow(/isn't your pick/);
    clock.advance(1);
  });

  it("doesn't name the game picked to a spectator on the delay who tries to sit in a closed seat", () => {
    const { rt } = table((s) => {
      s.spectators.delaySeconds = 30;
    });
    seat(rt, 8);
    rt.start('host');
    pick(rt, 'razz');
    expect(() => rt.requestSeat('h', { seat: 8, name: 'H', stack: 1000 })).toThrow(/^that seat is closed for now$/);
  });

  it('shows the seats closed when a seat request fills a smaller game', () => {
    const { rt, clock } = table();
    seat(rt, 5);
    rt.updateSettings('host', { seating: { requireApproval: true } });
    rt.requestSeat('f', { seat: 7, name: 'F', stack: 1000 });
    rt.start('host');
    pick(rt, 'badugi');
    // The request isn't counted when checking the game fits (5 of 6), but it takes the last seat Badugi deals.
    expect(tableView(rt, 'g', clock.now()).choice).toMatchObject({ count: 5, cap: 6, closed: true });
    rt.cancelRequest('f');
    expect(tableView(rt, 'g', clock.now()).choice).toMatchObject({ count: 5, cap: 6, closed: false });
  });

  it('lets the host approve one of two seat requests when one seat is left in a smaller game', () => {
    const { rt } = table();
    seat(rt, 5);
    rt.updateSettings('host', { seating: { requireApproval: true } });
    rt.requestSeat('f', { seat: 6, name: 'F', stack: 1000 });
    rt.requestSeat('g', { seat: 7, name: 'G', stack: 1000 });
    rt.start('host');
    pick(rt, 'badugi');
    const [first, second] = rt.state.requests;
    rt.approve('host', first.id);
    expect(rt.state.seats.filter(Boolean)).toHaveLength(6);
    expect(() => rt.approve('host', second.id)).toThrow(/Badugi seats at most 6/);
  });

  it('lets a waitlisted player take the seat offered to them when a seat request is also waiting', () => {
    const { rt } = table((s) => {
      s.table.maxSeats = 7;
      s.seating.waitlist = true;
      s.game.dealersChoice!.hands = 1;
    });
    seat(rt, 7);
    rt.start('host');
    pick(rt, 'nlhe');
    rt.joinWaitlist('h', { name: 'H', stack: 1000 });
    checkDown(rt);
    // F leaves: the seat is offered to H. E leaves, and G asks for that seat (the host approves seats for a moment).
    rt.stand('f');
    expect(rt.state.offers).toHaveLength(1);
    rt.stand('e');
    rt.updateSettings('host', { seating: { requireApproval: true } });
    rt.requestSeat('g', { seat: 5, name: 'G', stack: 1000 });
    rt.updateSettings('host', { seating: { requireApproval: false } });
    // Badugi fits: 5 seated and H's offer. G's request waits; it can't take the seat H was counted in.
    pick(rt, 'badugi');
    rt.requestSeat('h', { seat: rt.state.offers![0].seat, name: 'H', stack: 1000 });
    expect(rt.state.seats.some((x) => x?.playerId === 'h')).toBe(true);
    expect(() => rt.approve('host', rt.state.requests[0].id)).toThrow(/Badugi seats at most 6/);
  });

  it('starts afresh when the host turns Dealer’s choice off and on again, so an old pick never comes back', () => {
    const { rt, clock } = table();
    seat(rt, 6);
    rt.start('host');
    pick(rt, 'badugi');
    checkDown(rt);
    rt.updateSettings('host', { game: { dealersChoice: { enabled: false } } });
    for (const id of ['g', 'h']) rt.requestSeat(id, { seat: PEOPLE.indexOf(id), name: id.toUpperCase(), stack: 1000 });
    rt.updateSettings('host', { game: { dealersChoice: { enabled: true } } });
    clock.advance(10_000);
    expect(rt.state.log.some((l) => /Couldn't deal/.test(l.text))).toBe(false);
    // The table waits for a fresh first pick; the game it was dealing before (its own) is what a missed one keeps.
    expect(tableView(rt, 'a', clock.now()).choice).toMatchObject({ current: null, open: true, cap: null });
    expect(rt.choice.chooser()).not.toBeNull();
  });

  it("after a rotation, keeps the game the rotation was dealing when the first pick is missed", () => {
    const { rt, clock } = table((s) => {
      s.game.dealersChoice!.enabled = false;
      s.game.rotation = {
        enabled: true,
        steps: [
          { gameId: 'nlhe', betting: 'no-limit', length: 1, unit: 'hands' },
          { gameId: 'razz', betting: 'fixed-limit', length: 1, unit: 'hands' },
        ],
      };
    });
    seat(rt, 3);
    rt.start('host');
    expect(hand(rt).input.game.id).toBe('nlhe');
    checkDown(rt);
    clock.advance(10_000);
    expect(hand(rt).input.game.id).toBe('razz');
    // Mid-hand, the host switches to Dealer's choice: it starts when this hand ends.
    rt.updateSettings('host', { game: { rotation: { enabled: false }, dealersChoice: { enabled: true } } });
    checkDown(rt);
    clock.advance(10_000);
    expect(live(rt)).toBe(false);
    const view = tableView(rt, 'a', clock.now()).choice!;
    expect(view.canKeep).toBe(true);
    expect(rt.settings.game.dealersChoice!.games[view.defaultIndex].gameId).toBe('razz');
    clock.advance(25_000);
    expect(hand(rt).input.game.id).toBe('razz');
    expect(rt.state.log.some((l) => /didn't pick in time, so Razz carries on/.test(l.text))).toBe(true);
  });
});

describe("Dealer's choice: the host can't move the pick (release review)", () => {
  /** Four players at a 9-seat table; plays one hand of the first pick and stops between hands. */
  function between(rng = seeded()) {
    const { rt, clock } = table(() => {}, rng);
    seat(rt, 4);
    rt.start('host');
    pick(rt, 'nlhe');
    checkDown(rt);
    expect(live(rt)).toBe(false);
    return { rt, clock };
  }

  it('keeps the Pick chip with its player when the host moves them, or moves someone else', () => {
    for (let n = 1; n <= 8; n++) {
      const { rt } = between(seeded(n));
      const holder = chooser(rt).playerId;
      const other = rt.state.seats.find((x) => x && x.playerId !== holder && x.playerId !== 'host')!.playerId;
      if (holder !== 'host') {
        rt.moveSeat('host', holder, 7);
        expect(rt.seatOf(holder)!.seat).toBe(7);
        expect(chooser(rt).playerId).toBe(holder);
      }
      rt.moveSeat('host', other, 8);
      expect(chooser(rt).playerId).toBe(holder);
      expect(tableView(rt, 'a', 0).choice!.chip).toBe(rt.seatOf(holder)!.seat);
    }
  });

  it("doesn't give the pick to a player the host moves into the empty seat of a chooser who left", () => {
    for (let n = 1; n <= 8; n++) {
      const { rt } = between(seeded(n));
      const holder = chooser(rt);
      if (holder.playerId === 'host') continue;
      const empty = holder.seat;
      rt.stand(holder.playerId);
      // The next player round from the empty seat picks.
      const next = chooser(rt).playerId;
      const mover = rt.state.seats.find((x) => x && x.playerId !== next && x.playerId !== 'host');
      if (!mover) continue;
      rt.moveSeat('host', mover.playerId, empty);
      expect(chooser(rt).playerId).toBe(next);
    }
  });

  it('keeps the Pick chip with its player when the host shuffles the seats', () => {
    let moved = 0;
    for (let n = 1; n <= 12; n++) {
      const { rt } = between(seeded(n));
      const holder = chooser(rt);
      const was = holder.seat;
      rt.shuffleSeats('host');
      if (rt.seatOf(holder.playerId)!.seat !== was) moved++;
      expect(chooser(rt).playerId).toBe(holder.playerId);
      expect(rt.state.choice!.chip).toBe(rt.seatOf(holder.playerId)!.seat);
    }
    // The shuffle did move chip holders around.
    expect(moved).toBeGreaterThan(0);
  });

  it('keeps the first pick, and the first button, with the player drawn at a new table when the host shuffles', () => {
    let moved = 0;
    for (let n = 1; n <= 12; n++) {
      const { rt } = table(() => {}, seeded(n));
      seat(rt, 4);
      rt.start('host');
      expect(rt.state.hand).toBeNull();
      const first = chooser(rt);
      const was = first.seat;
      rt.shuffleSeats('host');
      if (rt.seatOf(first.playerId)!.seat !== was) moved++;
      expect(chooser(rt).playerId).toBe(first.playerId);
      pick(rt, 'nlhe');
      expect(hand(rt).input.button).toBe(rt.seatOf(first.playerId)!.seat);
    }
    expect(moved).toBeGreaterThan(0);
  });
});

describe("Dealer's choice: the host can't move the pick (second review)", () => {
  function between(rng = seeded()) {
    const { rt, clock } = table(() => {}, rng);
    seat(rt, 4);
    rt.start('host');
    pick(rt, 'nlhe');
    checkDown(rt);
    expect(live(rt)).toBe(false);
    return { rt, clock };
  }

  it('draws the button afresh after a mid-game shuffle, rather than giving it to the first chooser', () => {
    const buttons = new Set<string>();
    for (let n = 1; n <= 24; n++) {
      const { rt, clock } = between(seeded(n));
      expect(rt.state.choice!.firstButton).toBeNull();
      rt.shuffleSeats('host');
      clock.advance(10_000);
      expect(live(rt)).toBe(true);
      buttons.add(rt.state.seats[hand(rt).input.button]!.playerId);
    }
    // Every player gets it some of the time.
    expect(buttons.size).toBe(4);
  });

  it('keeps the PICK tag on whoever picks in place of a holder who is sitting out, through a move or a shuffle', () => {
    for (let n = 1; n <= 12; n++) {
      const { rt } = between(seeded(n));
      const holder = chooser(rt);
      rt.sitOut(holder.playerId, true);
      const standIn = chooser(rt).playerId;
      expect(standIn).not.toBe(holder.playerId);
      if (holder.playerId !== 'host') {
        const empty = rt.state.seats.findIndex((x, i) => !x && i > holder.seat);
        rt.moveSeat('host', holder.playerId, empty >= 0 ? empty : rt.state.seats.indexOf(null));
        expect(chooser(rt).playerId).toBe(standIn);
      }
      rt.shuffleSeats('host');
      expect(chooser(rt).playerId).toBe(standIn);
      expect(tableView(rt, 'a', 0).choice!.chip).toBe(rt.seatOf(standIn)!.seat);
    }
  });

  it('lets a holder who is sitting out keep the chip through a seat change that leaves the PICK tag where it is', () => {
    let kept = 0;
    for (let n = 1; n <= 12; n++) {
      const { rt } = between(seeded(n));
      const holder = chooser(rt);
      rt.sitOut(holder.playerId, true);
      const standIn = chooser(rt);
      const len = rt.state.seats.length;
      // Seats strictly between the holder and the stand-in, going left: a player moved there would pick in their place.
      const between_ = new Set(Array.from({ length: (standIn.seat - holder.seat + len) % len - 1 }, (_, i) => (holder.seat + 1 + i) % len));
      const mover = rt.state.seats.find((x) => x && x.playerId !== 'host' && x.playerId !== holder.playerId && x.playerId !== standIn.playerId);
      const to = rt.state.seats.findIndex((x, i) => !x && !between_.has(i));
      if (!mover || to < 0) continue;
      rt.moveSeat('host', mover.playerId, to);
      expect(chooser(rt).playerId).toBe(standIn.playerId);
      // Back in before picking opens: the holder picks after all.
      rt.sitOut(holder.playerId, false);
      expect(chooser(rt).playerId).toBe(holder.playerId);
      kept++;
    }
    expect(kept).toBeGreaterThan(0);
  });

  it('passes the chip on when its holder leaves, so a bot the host adds in their seat, or a newcomer, never takes it', () => {
    for (let n = 1; n <= 8; n++) {
      const { rt } = between(seeded(n));
      const holder = chooser(rt);
      if (holder.playerId === 'host') continue;
      rt.stand(holder.playerId);
      const next = chooser(rt).playerId;
      rt.addBot('host', { seat: holder.seat });
      expect(chooser(rt).playerId).toBe(next);
      rt.stand(rt.state.seats[holder.seat]!.playerId);
      rt.requestSeat('h', { seat: holder.seat, name: 'H', stack: 1000 });
      expect(chooser(rt).playerId).toBe(next);
    }
  });

  it('keeps the PICK tag where it is when the host makes the table smaller while its holder is sitting out', () => {
    let checked = 0;
    for (let n = 1; n <= 12; n++) {
      const { rt, clock } = table(() => {}, seeded(n));
      rt.requestSeat('host', { seat: 0, name: 'HOST', stack: 1000 });
      rt.requestSeat('a', { seat: 3, name: 'A', stack: 1000 });
      rt.requestSeat('b', { seat: 5, name: 'B', stack: 1000 });
      rt.requestSeat('c', { seat: 7, name: 'C', stack: 1000 });
      rt.start('host');
      pick(rt, 'nlhe');
      checkDown(rt);
      const holder = chooser(rt);
      rt.sitOut(holder.playerId, true);
      const standIn = chooser(rt).playerId;
      rt.updateSettings('host', { table: { maxSeats: 6 } });
      clock.advance(10_000);
      expect(rt.state.seats).toHaveLength(6);
      expect(chooser(rt).playerId).toBe(standIn);
      checked++;
    }
    expect(checked).toBe(12);
  });

  it('gives the first hand’s button to whoever the chip passes to when the first chooser leaves before the first hand', () => {
    for (let n = 1; n <= 8; n++) {
      const { rt } = table(() => {}, seeded(n));
      seat(rt, 4);
      rt.start('host');
      const first = chooser(rt);
      if (first.playerId === 'host') continue;
      rt.stop('host');
      rt.stand(first.playerId);
      const next = chooser(rt);
      rt.requestSeat('h', { seat: first.seat, name: 'H', stack: 1000 });
      // The next chooser picks while the game is stopped, so no clock moves the chip (or the button) to them.
      pick(rt, 'nlhe');
      rt.start('host');
      expect(hand(rt).input.button).toBe(next.seat);
    }
  });
});


describe("Dealer's choice: the first hand's button and a holder who is moved (third review, #421)", () => {
  /** A new 4-player table: Start draws the first chooser, then the host pauses or stops before the first hand. */
  function fresh(n: number, hold: 'pause' | 'stop') {
    const { rt, clock } = table(() => {}, seeded(n));
    seat(rt, 4);
    rt.start('host');
    if (hold === 'pause') rt.pause('host', true);
    else rt.stop('host');
    return { rt, clock, first: chooser(rt) };
  }
  const go = (rt: TableRuntime, clock: FakeClock, hold: 'pause' | 'stop') => {
    if (hold === 'pause') rt.pause('host', false);
    else rt.start('host');
    clock.advance(RESUME_MIN_MS + 10_000);
  };

  it('passes the first button on when the first chooser picks and then leaves, so whoever sits in their seat never gets it', () => {
    let checked = 0;
    for (const hold of ['pause', 'stop'] as const) {
      for (let n = 1; n <= 8; n++) {
        const { rt, clock, first } = fresh(n, hold);
        if (first.playerId === 'host') continue;
        pick(rt, 'nlhe');
        rt.stand(first.playerId);
        // The next player round from their seat has it now (the same rule as for the Pick chip).
        const len = rt.state.seats.length;
        const next = Array.from({ length: len }, (_, i) => rt.state.seats[(first.seat + 1 + i) % len]).find((x) => x)!;
        // A newcomer sits down in that seat.
        rt.requestSeat('h', { seat: first.seat, name: 'H', stack: 1000 });
        go(rt, clock, hold);
        expect(live(rt)).toBe(true);
        expect(hand(rt).input.button).toBe(next.seat);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(8);
  });

  it('gives the first button to a player who makes the first pick in place of the first chooser while the table is paused', () => {
    let checked = 0;
    for (const hold of ['pause', 'stop'] as const) {
      for (let n = 1; n <= 8; n++) {
        const { rt, clock, first } = fresh(n, hold);
        rt.sitOut(first.playerId, true);
        const standIn = chooser(rt);
        expect(standIn.playerId).not.toBe(first.playerId);
        pick(rt, 'nlhe');
        rt.sitOut(first.playerId, false);
        go(rt, clock, hold);
        expect(live(rt)).toBe(true);
        expect(hand(rt).input.button).toBe(standIn.seat);
        checked++;
      }
    }
    expect(checked).toBe(16);
  });

  it('gives the first button with the chip to the stand-in when a host move would put the PICK tag on someone else', () => {
    let checked = 0;
    for (let n = 1; n <= 24; n++) {
      const { rt, clock } = table(() => {}, seeded(n));
      rt.requestSeat('host', { seat: 0, name: 'HOST', stack: 1000 });
      rt.requestSeat('a', { seat: 3, name: 'A', stack: 1000 });
      rt.requestSeat('b', { seat: 5, name: 'B', stack: 1000 });
      rt.requestSeat('c', { seat: 7, name: 'C', stack: 1000 });
      rt.start('host');
      rt.pause('host', true);
      const first = chooser(rt);
      rt.sitOut(first.playerId, true);
      const standIn = chooser(rt);
      // The host moves someone else into the gap between them, which would put the PICK tag on them.
      const len = rt.state.seats.length;
      const gap = Array.from({ length: (standIn.seat - first.seat + len) % len - 1 }, (_, i) => (first.seat + 1 + i) % len).find((i) => !rt.state.seats[i]);
      const mover = rt.state.seats.find((x) => x && ![first.playerId, standIn.playerId, 'host'].includes(x.playerId));
      if (gap === undefined || !mover) continue;
      rt.moveSeat('host', mover.playerId, gap);
      // So the chip, and the first button with it, went to the stand-in for good.
      expect(chooser(rt).playerId).toBe(standIn.playerId);
      rt.sitOut(first.playerId, false);
      expect(chooser(rt).playerId).toBe(standIn.playerId);
      pick(rt, 'nlhe');
      rt.pause('host', false);
      clock.advance(RESUME_MIN_MS + 10_000);
      expect(hand(rt).input.button).toBe(standIn.seat);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  /** The first seat round from `from` (not counting it) with someone in it who will be dealt in. */
  const nextIn = (rt: TableRuntime, from: number) => {
    const len = rt.state.seats.length;
    return Array.from({ length: len }, (_, i) => rt.state.seats[(from + 1 + i) % len]).find((x) => x && !x.sittingOut)!;
  };

  it('gives the first button to the next player dealt in when the first picker sits out or leaves, not a random one (fourth review)', () => {
    let checked = 0;
    for (const hold of ['pause', 'stop'] as const) {
      for (let n = 1; n <= 8; n++) {
        // The first picker sits out before the first hand.
        const a = fresh(n, hold);
        pick(a.rt, 'nlhe');
        a.rt.sitOut(a.first.playerId, true);
        go(a.rt, a.clock, hold);
        expect(live(a.rt)).toBe(true);
        expect(hand(a.rt).input.button).toBe(nextIn(a.rt, a.first.seat).seat);
        // The player after them sits out, then the first picker leaves: the button passes them by too.
        const b = fresh(n, hold);
        if (b.first.playerId === 'host') continue;
        pick(b.rt, 'nlhe');
        const after = nextIn(b.rt, b.first.seat);
        if (after.playerId === 'host') continue;
        b.rt.sitOut(after.playerId, true);
        b.rt.stand(b.first.playerId);
        go(b.rt, b.clock, hold);
        expect(live(b.rt)).toBe(true);
        expect(hand(b.rt).input.button).toBe(nextIn(b.rt, b.first.seat).seat);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(4);
  });

  it('puts the first button on the first picker when they pick a stud game (fourth review)', () => {
    for (let n = 1; n <= 8; n++) {
      const { rt, clock } = table(() => {}, seeded(n));
      seat(rt, 4);
      rt.start('host');
      const first = chooser(rt);
      pick(rt, 'razz');
      clock.advance(10_000);
      expect(live(rt)).toBe(true);
      expect(hand(rt).input.game.id).toBe('razz');
      expect(hand(rt).input.button).toBe(first.seat);
    }
  });

  it('starts afresh when everyone leaves a new table before its first hand, so the first picker still gets the first button (fourth review)', () => {
    for (let n = 1; n <= 8; n++) {
      const { rt, clock } = table(() => {}, seeded(n));
      rt.requestSeat('a', { seat: 2, name: 'A', stack: 1000 });
      rt.requestSeat('b', { seat: 5, name: 'B', stack: 1000 });
      rt.start('host');
      expect(rt.state.choice).toBeDefined();
      rt.stand('a');
      rt.stand('b');
      expect(rt.state.choice).toBeUndefined();
      rt.requestSeat('c', { seat: 5, name: 'C', stack: 1000 });
      rt.requestSeat('d', { seat: 0, name: 'D', stack: 1000 });
      rt.requestSeat('e', { seat: 7, name: 'E', stack: 1000 });
      // A new first chooser at once, with a whole clock: the table doesn't wait out the old one (fifth review).
      clock.advance(1);
      const first = chooser(rt);
      expect(rt.state.choice!.deadline! - clock.now()).toBeGreaterThan(19_000);
      expect(tableView(rt, first.playerId, clock.now()).choice!.open).toBe(true);
      pick(rt, 'nlhe');
      clock.advance(10_000);
      expect(live(rt)).toBe(true);
      expect(hand(rt).input.button).toBe(first.seat);
    }
  });

  it('starts afresh when everyone leaves a new table while it is paused, with a fresh clock once the host resumes (fifth review)', () => {
    for (let n = 1; n <= 8; n++) {
      const { rt, clock } = table(() => {}, seeded(n));
      rt.requestSeat('a', { seat: 2, name: 'A', stack: 1000 });
      rt.requestSeat('b', { seat: 5, name: 'B', stack: 1000 });
      rt.start('host');
      clock.advance(5_000);
      rt.pause('host', true);
      pick(rt, 'razz');
      rt.stand('a');
      rt.stand('b');
      expect(rt.state.choice).toBeUndefined();
      rt.requestSeat('c', { seat: 5, name: 'C', stack: 1000 });
      rt.requestSeat('d', { seat: 0, name: 'D', stack: 1000 });
      rt.pause('host', false);
      clock.advance(1);
      // The leavers' pick is gone with them, and the new first chooser picks straight away, with a whole clock.
      expect(live(rt)).toBe(false);
      const first = chooser(rt);
      expect(rt.state.choice!.deadline! - clock.now()).toBeGreaterThan(19_000);
      pick(rt, 'nlhe');
      clock.advance(10_000);
      expect(live(rt)).toBe(true);
      expect(hand(rt).input.game.id).toBe('nlhe');
      expect(hand(rt).input.button).toBe(first.seat);
    }
  });

  it('gives the chip of a table everyone has left to the first player who sits down, wherever they sit (fifth review)', () => {
    let checked = 0;
    for (let n = 1; n <= 8; n++) {
      for (const order of [['a', 'b', 'c'], ['c', 'b', 'a'], ['b', 'a', 'c']]) {
        const { rt, clock } = table(() => {}, seeded(n));
        rt.requestSeat('a', { seat: 2, name: 'A', stack: 1000 });
        rt.requestSeat('b', { seat: 5, name: 'B', stack: 1000 });
        rt.requestSeat('c', { seat: 7, name: 'C', stack: 1000 });
        rt.start('host');
        pick(rt, 'nlhe');
        clock.advance(10_000);
        checkDown(rt);
        clock.advance(1);
        for (const id of order) rt.stand(id);
        expect(rt.state.seats.some(Boolean)).toBe(false);
        const left = rt.state.choice!.chip;
        // D sits down first, away from it; E then sits in the seat it was left on, and a bot next to it.
        const away = (left + 4) % 9;
        rt.requestSeat('d', { seat: away, name: 'D', stack: 1000 });
        expect(chooser(rt).playerId).toBe('d');
        rt.requestSeat('e', { seat: left, name: 'E', stack: 1000 });
        expect(chooser(rt).playerId).toBe('d');
        rt.addBot('host', { seat: (left + 1) % 9 });
        expect(chooser(rt).playerId).toBe('d');
        checked++;
      }
    }
    expect(checked).toBe(24);
  });

  it("moves a first button left on an empty seat by older code to the next player, so a newcomer there doesn't get it (fourth review)", () => {
    let checked = 0;
    for (let n = 1; n <= 8; n++) {
      const { rt, clock, first } = fresh(n, 'pause');
      if (first.playerId === 'host') continue;
      pick(rt, 'nlhe');
      rt.stand(first.playerId);
      // What a snapshot from before #421 holds: the button still on the leaver's seat.
      rt.state.choice!.firstButton = first.seat;
      const saved = JSON.parse(JSON.stringify(rt.state));
      rt.dispose();
      const back = new TableRuntime(saved, { clock, rng: seeded(n) });
      back.resume();
      for (const p of PEOPLE) back.connect(p);
      const next = nextIn(back, first.seat);
      expect(back.state.choice!.firstButton).toBe(next.seat);
      back.requestSeat('h', { seat: first.seat, name: 'H', stack: 1000 });
      back.pause('host', false);
      clock.advance(RESUME_MIN_MS + 10_000);
      expect(live(back)).toBe(true);
      expect(hand(back).input.button).toBe(next.seat);
      checked++;
    }
    expect(checked).toBeGreaterThan(2);
  });

  it('starts afresh at once when it restores a paused new table everyone left, saved by older code with its pick clock (fifth review)', () => {
    for (let n = 1; n <= 4; n++) {
      const { rt, clock } = table(() => {}, seeded(n));
      rt.requestSeat('a', { seat: 2, name: 'A', stack: 1000 });
      rt.requestSeat('b', { seat: 5, name: 'B', stack: 1000 });
      rt.start('host');
      clock.advance(5_000);
      rt.pause('host', true);
      const kept = { choice: JSON.parse(JSON.stringify(rt.state.choice)), pausedLeft: { ...rt.state.pausedLeft! }, nextHandAt: rt.state.nextHandAt };
      expect(kept.pausedLeft.pick).toBe(15_000);
      rt.stand('a');
      rt.stand('b');
      // What older code saved: the choice, its first button on an empty seat, and the paused clocks, all kept.
      Object.assign(rt.state, kept);
      const saved = JSON.parse(JSON.stringify(rt.state));
      rt.dispose();
      const back = new TableRuntime(saved, { clock, rng: seeded(n) });
      back.resume();
      for (const p of PEOPLE) back.connect(p);
      expect(back.state.choice).toBeUndefined();
      back.requestSeat('c', { seat: 5, name: 'C', stack: 1000 });
      back.requestSeat('d', { seat: 0, name: 'D', stack: 1000 });
      back.pause('host', false);
      clock.advance(1);
      expect(back.choice.chooser()).toBeTruthy();
      expect(back.state.choice!.deadline! - clock.now()).toBeGreaterThan(19_000);
    }
  });

  it('keeps the chip with a holder who is sitting out when the host moves them, so whoever sits in their old seat never takes it', () => {
    let checked = 0;
    for (let n = 1; n <= 12; n++) {
      const { rt, clock } = table(() => {}, seeded(n));
      rt.requestSeat('host', { seat: 0, name: 'HOST', stack: 1000 });
      rt.requestSeat('a', { seat: 3, name: 'A', stack: 1000 });
      rt.requestSeat('b', { seat: 6, name: 'B', stack: 1000 });
      rt.requestSeat('c', { seat: 8, name: 'C', stack: 1000 });
      rt.start('host');
      pick(rt, 'nlhe');
      checkDown(rt);
      clock.advance(1);
      const holder = chooser(rt);
      if (holder.playerId === 'host') continue;
      rt.sitOut(holder.playerId, true);
      const standIn = chooser(rt);
      // Move the holder one seat on, which leaves the tag on the stand-in, if that seat is free and short of them.
      const len = rt.state.seats.length;
      const to = (holder.seat + 1) % len;
      if (rt.state.seats[to] || to === standIn.seat) continue;
      const old = holder.seat;
      rt.moveSeat('host', holder.playerId, to);
      expect(chooser(rt).playerId).toBe(standIn.playerId);
      // A newcomer sits in the holder's old seat: the stand-in still picks for now, and the holder once back in.
      rt.requestSeat('h', { seat: old, name: 'H', stack: 1000 });
      expect(chooser(rt).playerId).toBe(standIn.playerId);
      rt.sitOut(holder.playerId, false);
      expect(chooser(rt).playerId).toBe(holder.playerId);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });
});

// #423: the host switches a Dealer's choice table to one game, or to a rotation, during the last hand of a pick. The
// change waits for the next hand, so nobody may pick a game that would never be dealt.
describe("Dealer's choice: a switch to another game that waits for the next hand (#423)", () => {
  const ROTATION = {
    enabled: true,
    steps: [
      { gameId: 'razz', betting: 'fixed-limit' as const, length: 1, unit: 'hands' as const },
      { gameId: 'plo4', betting: 'pot-limit' as const, length: 1, unit: 'hands' as const },
    ],
  };
  const SWITCHES = [
    { name: 'one game', patch: { game: { dealersChoice: { enabled: false }, gameId: 'plo4', betting: 'pot-limit' as const } }, dealt: 'plo4' },
    { name: 'a rotation', patch: { table: { maxSeats: 8 }, game: { dealersChoice: { enabled: false }, rotation: ROTATION } }, dealt: 'razz' },
  ];

  /** Three players; the last hand of the first pick is being played, so picking the next game is open. */
  function lastHand() {
    const { rt, clock } = table();
    seat(rt, 3);
    rt.start('host');
    pick(rt, 'nlhe');
    checkDown(rt);
    clock.advance(10_000);
    checkDown(rt);
    clock.advance(10_000);
    expect(live(rt)).toBe(true);
    expect(tableView(rt, 'a', clock.now()).choice).toMatchObject({ open: true, handsLeft: 0 });
    return { rt, clock };
  }

  for (const sw of SWITCHES) {
    it(`closes picking once the host switches to ${sw.name} mid-hand, and refuses a pick`, () => {
      const { rt, clock } = lastHand();
      const who = chooser(rt);
      const picks = rt.state.log.filter((l) => / picked /.test(l.text)).length;
      rt.updateSettings('host', sw.patch);
      // Still Dealer's choice until the hand ends, but there's no next game to pick, and nobody holds the PICK tag.
      expect(rt.settings.game.dealersChoice!.enabled).toBe(true);
      for (const viewer of [who.playerId, 'a', 'host']) expect(tableView(rt, viewer, clock.now()).choice).toMatchObject({ open: false, chip: null, handsLeft: 0 });
      expect(rt.choice.pickOpen()).toBe(false);
      expect(() => pick(rt, 'razz')).toThrow(/the host has changed how the game is chosen from the next hand/);
      expect(rt.state.log.filter((l) => / picked /.test(l.text)).length).toBe(picks);
      expect(rt.state.choice!.next).toBeNull();
      checkDown(rt);
      // The hand is over and the change still waits for the next deal: still nothing to pick.
      expect(live(rt)).toBe(false);
      expect(rt.state.pendingSettings).not.toBeNull();
      expect(tableView(rt, 'a', clock.now()).choice).toMatchObject({ open: false, chip: null });
      expect(() => pick(rt, 'razz')).toThrow(/the host has changed how the game is chosen/);
      clock.advance(10_000);
      expect(hand(rt).input.game.id).toBe(sw.dealt);
      expect(rt.state.choice).toBeUndefined();
      expect(tableView(rt, 'a', clock.now()).choice).toBeNull();
    });
  }

  // #444: once the hand is over the switch still waits for the deal. The next hand's preview names the game the switch
  // deals, at the stakes it sets, not the game picked for Dealer's choice.
  for (const sw of SWITCHES) {
    it(`previews the game the switch to ${sw.name} deals, not the game picked (#444)`, () => {
      const { rt, clock } = lastHand();
      pick(rt, 'badugi');
      rt.updateSettings('host', { ...sw.patch, stakes: { smallBlind: 3, bigBlind: 6 } });
      checkDown(rt);
      expect(live(rt)).toBe(false);
      expect(rt.state.pendingSettings).not.toBeNull();
      const shown = tableView(rt, 'a', clock.now()).upcoming!;
      expect(shown).toMatchObject({ gameId: sw.dealt, stakes: { bigBlind: 6 } });
      clock.advance(10_000);
      expect(hand(rt).input.game.id).toBe(sw.dealt);
    });
  }

  it('says it is the last hand of the pick when the host switches part way through it', () => {
    const { rt, clock } = table();
    seat(rt, 3);
    rt.start('host');
    pick(rt, 'razz');
    expect(tableView(rt, 'a', clock.now()).choice!.handsLeft).toBe(2);
    rt.updateSettings('host', SWITCHES[0].patch);
    expect(tableView(rt, 'a', clock.now()).choice).toMatchObject({ handsLeft: 0, open: false, chip: null, current: { gameId: 'razz' } });
    checkDown(rt);
    clock.advance(10_000);
    expect(hand(rt).input.game.id).toBe('plo4');
  });

  it('opens picking again if the host switches back to Dealer’s choice before the hand ends', () => {
    const { rt, clock } = lastHand();
    rt.updateSettings('host', SWITCHES[0].patch);
    expect(tableView(rt, 'a', clock.now()).choice!.open).toBe(false);
    rt.updateSettings('host', { game: { dealersChoice: { enabled: true } } });
    expect(tableView(rt, 'a', clock.now()).choice!.open).toBe(true);
    pick(rt, 'razz');
    checkDown(rt);
    clock.advance(10_000);
    expect(hand(rt).input.game.id).toBe('razz');
  });

  it('keeps picking open for a change that leaves Dealer’s choice on (the stakes, say)', () => {
    const { rt, clock } = lastHand();
    rt.updateSettings('host', { stakes: { smallBlind: 2, bigBlind: 4 } });
    expect(rt.state.pendingSettings).not.toBeNull();
    expect(tableView(rt, 'a', clock.now()).choice!.open).toBe(true);
    pick(rt, 'razz');
    checkDown(rt);
    clock.advance(10_000);
    expect(hand(rt).input.game.id).toBe('razz');
  });

  for (const sw of SWITCHES) {
    it(`a bot holding the chip doesn't pick once the host switches to ${sw.name} mid-hand`, () => {
      const { rt, clock } = table();
      seat(rt, 1);
      rt.addBot('host', { seat: 1 });
      rt.addBot('host', { seat: 2 });
      rt.start('host');
      let found = false;
      for (let i = 0; i < 30 && !found; i++) {
        if (!live(rt)) {
          if (rt.isBot(chooser(rt).playerId)) clock.advance(BOT_PICK_MS);
          else pick(rt, 'nlhe');
        }
        // The last hand of a pick, with a bot to choose next, before its moment comes.
        if (live(rt) && rt.choice.pickOpen() && rt.isBot(chooser(rt).playerId) && rt.state.choice!.botAt! > clock.now()) {
          found = true;
          break;
        }
        checkDown(rt);
        for (let t = 0; t < 100 && !live(rt) && rt.state.choice!.deadline === null; t++) clock.advance(100);
      }
      expect(found).toBe(true);
      const picks = rt.state.log.filter((l) => / picked /.test(l.text)).length;
      rt.updateSettings('host', sw.patch);
      expect(rt.choice.due()).toBeNull();
      clock.advance(BOT_PICK_MS * 2);
      expect(rt.state.choice!.next).toBeNull();
      expect(rt.state.log.filter((l) => / picked /.test(l.text)).length).toBe(picks);
      checkDown(rt);
      clock.advance(10_000);
      expect(hand(rt).input.game.id).toBe(sw.dealt);
    });
  }
});

// #425: the host takes a game off the menu during the last hand of a pick. The new menu waits for the next hand,
// so that game can't be picked for it.
describe("Dealer's choice: a game taken off the menu that waits for the next hand (#425)", () => {
  const WITHOUT_RAZZ = { game: { dealersChoice: { games: [MENU[0], MENU[2], MENU[3]] } } };
  const SAME_GAME = { game: { dealersChoice: { enabled: false }, gameId: 'plo4', betting: 'pot-limit' as const } };

  /** Three players (or the host and two bots); the last hand of the first pick is being played. */
  function lastHand(rng = seeded(), bots = false) {
    const { rt, clock } = table(() => {}, rng);
    seat(rt, bots ? 1 : 3);
    if (bots) {
      rt.addBot('host', { seat: 1 });
      rt.addBot('host', { seat: 2 });
    }
    rt.start('host');
    for (let i = 0; i < 30; i++) {
      if (!live(rt)) {
        if (rt.isBot(chooser(rt).playerId)) clock.advance(BOT_PICK_MS);
        else pick(rt, 'razz');
      }
      if (live(rt) && rt.choice.pickOpen() && (!bots || (rt.isBot(chooser(rt).playerId) && rt.state.choice!.botAt! > clock.now()))) return { rt, clock };
      checkDown(rt);
      for (let t = 0; t < 100 && !live(rt) && rt.state.choice!.deadline === null; t++) clock.advance(100);
    }
    throw new Error('never reached the last hand of a pick');
  }

  it('refuses a pick of the game the host is taking off, and deals another one picked instead', () => {
    const { rt, clock } = lastHand();
    expect(rt.state.choice!.current).toMatchObject({ gameId: 'razz' });
    expect(tableView(rt, 'a', clock.now()).choice!.canKeep).toBe(true);
    rt.updateSettings('host', WITHOUT_RAZZ);
    // Picking stays open for the games that stay, but Razz can't be kept going.
    const view = tableView(rt, 'a', clock.now()).choice!;
    expect(view).toMatchObject({ open: true, canKeep: false });
    expect(() => pick(rt, 'razz')).toThrow(/the host is taking Razz off the menu from the next hand: pick another game/);
    expect(() => rt.chooseGame(chooser(rt).playerId, { index: 1, gameId: 'razz', betting: 'fixed-limit' })).toThrow(/taking Razz off the menu/);
    pick(rt, 'badugi');
    checkDown(rt);
    clock.advance(10_000);
    expect(hand(rt).input.game.id).toBe('badugi');
    expect(rt.settings.game.dealersChoice!.games.map((g) => g.gameId)).toEqual(['nlhe', 'badugi', 'plo4']);
  });

  it('doesn’t name a game being taken off as what a missed pick deals', () => {
    const { rt, clock } = lastHand();
    const menu = () => rt.settings.game.dealersChoice!.games;
    expect(menu()[tableView(rt, 'a', clock.now()).choice!.defaultIndex].gameId).toBe('razz');
    rt.updateSettings('host', WITHOUT_RAZZ);
    const shown = menu()[tableView(rt, 'a', clock.now()).choice!.defaultIndex].gameId;
    expect(shown).toBe('nlhe');
    // Nobody picks: once the hand is over the table waits, and when the clock runs out the game shown is dealt.
    const who = chooser(rt);
    checkDown(rt);
    clock.advance(10_000);
    expect(live(rt)).toBe(false);
    clock.advance(25_000);
    expect(hand(rt).input.game.id).toBe(shown);
    expect(rt.state.log.some((l) => l.text === `${who.name} didn't pick in time, so No-Limit Hold'em is dealt`)).toBe(true);
  });

  // #444: the new menu puts the games in another order, or adds one in front. The pick clock only runs once the change
  // has applied, so a missed pick deals from the new menu; the panel's "If time runs out" says that game all along.
  for (const sw of [
    { name: 'in another order', games: [MENU[3], MENU[2]], dealt: 'plo4', title: 'Pot-Limit Omaha' },
    { name: 'with a game added in front', games: [{ gameId: 'stud', betting: 'fixed-limit' as const }, MENU[2], MENU[3]], dealt: 'stud', title: 'Seven Card Stud' },
  ]) {
    it(`names the game a missed pick deals when the new menu waiting for the next hand is ${sw.name} (#444)`, () => {
      const { rt, clock } = lastHand();
      expect(tableView(rt, 'a', clock.now()).choice!.fallback).toEqual({ gameId: 'razz', betting: 'fixed-limit', gameName: 'Razz' });
      rt.updateSettings('host', { game: { dealersChoice: { games: sw.games } } });
      // Razz and Hold'em are coming off; on the current menu the first game that stays is Badugi, but it isn't dealt.
      const during = tableView(rt, 'a', clock.now()).choice!;
      expect(during.open).toBe(true);
      expect(during.fallback).toMatchObject({ gameId: sw.dealt, gameName: sw.title });
      const who = chooser(rt);
      checkDown(rt);
      clock.advance(10_000);
      expect(live(rt)).toBe(false);
      const after = tableView(rt, 'a', clock.now());
      expect(after.choice!.fallback).toMatchObject({ gameId: sw.dealt });
      expect(after.upcoming).toMatchObject({ gameId: sw.dealt });
      clock.advance(25_000);
      expect(hand(rt).input.game.id).toBe(sw.dealt);
      expect(rt.state.log.some((l) => l.text === `${who.name} didn't pick in time, so ${sw.title} is dealt`)).toBe(true);
    });
  }

  it('waits for the hand to end when the host changes the whole menu, then the chooser picks from the new one', () => {
    const { rt, clock } = lastHand();
    const who = chooser(rt);
    rt.updateSettings('host', { game: { dealersChoice: { games: [{ gameId: 'stud', betting: 'fixed-limit' }, { gameId: 'plo8', betting: 'pot-limit' }] } } });
    expect(tableView(rt, 'a', clock.now()).choice).toMatchObject({ open: false, chip: who.seat, canKeep: false });
    expect(() => pick(rt, 'nlhe')).toThrow(/the host is changing the menu from the next hand: pick from it when this hand is over/);
    checkDown(rt);
    clock.advance(10_000);
    // The new menu is in: the table waits for the chooser, who picks from it.
    expect(live(rt)).toBe(false);
    expect(tableView(rt, 'a', clock.now()).choice).toMatchObject({ open: true, chip: who.seat });
    expect(chooser(rt).playerId).toBe(who.playerId);
    pick(rt, 'plo8');
    expect(hand(rt).input.game.id).toBe('plo8');
  });

  it('a bot holding the chip waits for the new menu instead of trying again and again', () => {
    const { rt, clock } = lastHand(seeded(), true);
    rt.updateSettings('host', { game: { dealersChoice: { games: [{ gameId: 'stud', betting: 'fixed-limit' }, { gameId: 'plo8', betting: 'pot-limit' }] } } });
    expect(rt.choice.due()).toBeNull();
    clock.advance(BOT_PICK_MS * 3);
    expect(rt.state.choice!.next).toBeNull();
    checkDown(rt);
    for (let t = 0; t < 200 && !live(rt); t++) clock.advance(500);
    expect(['stud', 'plo8']).toContain(hand(rt).input.game.id);
    expect(rt.state.choice!.current).toMatchObject({ how: 'bot' });
  });

  it('keeps a pick made before the host took that game off the menu', () => {
    const { rt, clock } = lastHand();
    pick(rt, 'plo4');
    rt.updateSettings('host', { game: { dealersChoice: { games: [MENU[0], MENU[1]] } } });
    checkDown(rt);
    clock.advance(10_000);
    expect(hand(rt).input.game.id).toBe('plo4');
  });

  it('a bot holding the chip only picks from the games that stay on the menu', () => {
    let checked = 0;
    for (let n = 1; n <= 8; n++) {
      const { rt, clock } = lastHand(seeded(n), true);
      rt.updateSettings('host', { game: { dealersChoice: { games: [MENU[0], MENU[3]] } } });
      clock.advance(BOT_PICK_MS * 2);
      const next = rt.state.choice!.next!;
      expect(next).toMatchObject({ how: 'bot' });
      expect(['nlhe', 'plo4']).toContain(next.gameId);
      checkDown(rt);
      clock.advance(10_000);
      expect(hand(rt).input.game.id).toBe(next.gameId);
      checked++;
    }
    expect(checked).toBe(8);
  });

  it('says in the log when a pick made before the host turned Dealer’s choice off isn’t dealt', () => {
    const { rt, clock } = lastHand();
    const who = chooser(rt);
    pick(rt, 'badugi');
    rt.updateSettings('host', { game: { dealersChoice: { enabled: false }, gameId: 'plo4', betting: 'pot-limit' } });
    checkDown(rt);
    clock.advance(10_000);
    expect(hand(rt).input.game.id).toBe('plo4');
    expect(rt.state.log.some((l) => l.text === `Dealer's choice is over, so ${who.name}'s pick, Badugi, isn't dealt`)).toBe(true);
  });

  it('says nothing about the pick when the host switches to the very game that was picked', () => {
    const { rt, clock } = lastHand();
    pick(rt, 'plo4');
    rt.updateSettings('host', SAME_GAME);
    checkDown(rt);
    clock.advance(10_000);
    expect(hand(rt).input.game.id).toBe('plo4');
    expect(rt.state.log.some((l) => /isn't dealt/.test(l.text))).toBe(false);
  });

  it('says so when a pick is dropped by the host turning Dealer’s choice off and on again between hands', () => {
    const { rt, clock } = lastHand();
    const who = chooser(rt);
    pick(rt, 'badugi');
    checkDown(rt);
    // Between hands, each change applies at once.
    expect(live(rt)).toBe(false);
    rt.updateSettings('host', SAME_GAME);
    rt.updateSettings('host', { game: { dealersChoice: { enabled: true } } });
    expect(rt.state.log.filter((l) => l.text === `Dealer's choice is over, so ${who.name}'s pick, Badugi, isn't dealt`)).toHaveLength(1);
    // Turned on again it starts afresh, with a new first pick.
    clock.advance(10_000);
    expect(live(rt)).toBe(false);
    expect(tableView(rt, 'a', clock.now()).choice).toMatchObject({ current: null, next: null, open: true });
  });
});

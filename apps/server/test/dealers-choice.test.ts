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

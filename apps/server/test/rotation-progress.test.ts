import { beforeAll, describe, expect, it } from 'vitest';
import { engine, variants } from '@rsdp/engine/core';
import { defaultSettings, type TableSettings } from '@rsdp/engine/settings';
import { MIXED_GAMES, registerAllVariants } from '@rsdp/engine/variants';
import type { RotationView } from '@rsdp/engine/wire';
import { TableRuntime } from '../src/runtime/table';
import { behind, delayedPart, tableView } from '../src/runtime/view';
import { FakeClock, seeded } from './fake-clock';

/*
 * The table's "3 more hands, then Stud" (#373): the count the view sends is checked against the hands the table then
 * really deals, with nobody coming or going.
 */

beforeAll(() => registerAllVariants(variants));

const PLAYERS = ['host', 'a', 'b', 'c', 'd', 'e', 'f'];

function table(patch: (s: TableSettings) => void, seed = 7) {
  const clock = new FakeClock();
  const settings = defaultSettings('cash');
  settings.table.maxSeats = 8;
  settings.stakes = { ...settings.stakes, ante: 1, anteType: 'per-player', bringIn: 1, smallBet: 2, bigBet: 4 };
  patch(settings);
  const rt = TableRuntime.create({ id: 't1', hostId: 'host', settings }, { clock, rng: seeded(seed) });
  for (const p of PLAYERS) rt.connect(p);
  return { rt, clock };
}

/** Seats `n` players in the first seats, or in the seats listed (so some stay empty and the button has to skip them). */
function seat(rt: TableRuntime, n: number | number[]) {
  rt.updateSettings('host', { seating: { requireApproval: false } });
  const seats = typeof n === 'number' ? [...Array(n).keys()] : n;
  seats.forEach((at, i) => rt.requestSeat(PLAYERS[i], { seat: at, name: PLAYERS[i].toUpperCase(), stack: 100_000 }));
}

/** Plays the hand out with checks and calls. */
function checkDown(rt: TableRuntime) {
  for (let i = 0; i < 200 && rt.state.hand && rt.state.hand.phase !== 'complete'; i++) {
    const h = rt.state.hand;
    const id = rt.state.seats[h.toAct ?? -1]?.playerId;
    if (!id) break;
    if (h.phase === 'drawing') {
      rt.draw(id, []);
      continue;
    }
    const legal = engine.legalActions(h, h.toAct!)!;
    rt.act(id, legal.canCheck ? { type: 'check' } : legal.canBringIn ? { type: 'bring-in' } : { type: 'call' });
  }
}

const key = (g: { gameId: string; betting: string }) => `${g.gameId}/${g.betting}`;

interface Seen {
  /** The rotation's game for this hand, as the table dealt it. */
  game: string;
  during: RotationView | null | undefined;
  after: RotationView | null | undefined;
  upcomingAfter: string | null;
}

/** Deals `count` hands, noting what the view said during and after each one. */
function play(rt: TableRuntime, clock: FakeClock, count: number) {
  const seen: Seen[] = [];
  for (let i = 0; i < count; i++) {
    const step = rt.state.settings.game.rotation.steps[rt.state.rotation.step];
    const during = tableView(rt, 'a', clock.now()).rotation;
    checkDown(rt);
    const view = tableView(rt, 'a', clock.now());
    seen.push({ game: key(step), during, after: view.rotation, upcomingAfter: view.upcoming ? key(view.upcoming) : null });
    clock.advance(10_000);
  }
  return seen;
}

/** For every hand but those of the last, unfinished game: the view's count against the hands really dealt after it. */
function checkCounts(seen: Seen[]) {
  let checked = 0;
  for (let i = 0; i < seen.length; i++) {
    let end = i;
    while (end + 1 < seen.length && seen[end + 1].game === seen[i].game) end++;
    if (end === seen.length - 1) break;
    const want = end - i;
    const next = seen[end + 1].game;
    for (const v of [seen[i].during, seen[i].after]) {
      expect({ hand: i + 1, game: v && key(v), left: v?.handsLeft, next: v && key(v.next) }).toEqual({ hand: i + 1, game: seen[i].game, left: want, next });
      expect(v!.dealt).toBeGreaterThan(0);
    }
    // Between hands the preview agrees: the same game while hands are left, the next one after the last.
    expect({ hand: i + 1, upcoming: seen[i].upcomingAfter }).toEqual({ hand: i + 1, upcoming: want === 0 ? next : seen[i].game });
    checked++;
  }
  return checked;
}

const horse = (unit: 'orbits' | 'hands', length = 1) => MIXED_GAMES[0].steps.map((st) => ({ ...st, length, unit }));
const eightGame = (unit: 'orbits' | 'hands', length = 1) => MIXED_GAMES[1].steps.map((st) => ({ ...st, length, unit }));

describe('hands left before the game changes (#373)', () => {
  it('HORSE by orbits: the count is right on every hand, for every table size and button draw', () => {
    for (const players of [2, 3, 4, 5]) {
      for (const seed of [1, 2, 3]) {
        const { rt, clock } = table((s) => (s.game.rotation = { enabled: true, steps: horse('orbits') }), seed);
        seat(rt, players);
        rt.start('host');
        expect(checkCounts(play(rt, clock, players * 7))).toBeGreaterThan(players * 4);
      }
    }
  });

  it('8-Game by orbits with empty seats between the players', () => {
    for (const [i, seats] of [[0, 2, 4], [0, 1, 4], [1, 5]].entries()) {
      const { rt, clock } = table((s) => {
        s.table.maxSeats = 6;
        s.game.rotation = { enabled: true, steps: eightGame('orbits') };
      }, i + 1);
      seat(rt, seats);
      rt.start('host');
      expect(checkCounts(play(rt, clock, 30))).toBeGreaterThan(20);
    }
  });

  it('steps of more than one orbit, and steps counted in hands', () => {
    for (const steps of [horse('orbits', 2), eightGame('hands', 3), horse('hands', 1)]) {
      const { rt, clock } = table((s) => {
        s.table.maxSeats = 6;
        s.game.rotation = { enabled: true, steps };
      });
      seat(rt, 4);
      rt.start('host');
      expect(checkCounts(play(rt, clock, 36))).toBeGreaterThan(20);
    }
  });

  it('with regular bomb pots, which still count as hands of the game', () => {
    const { rt, clock } = table((s) => {
      s.modifiers['bomb-pot'] = { ...(s.modifiers['bomb-pot'] as object), enabled: true, chancePercent: 0, everyHands: 4, gameId: 'nlhe', betting: 'no-limit' };
      s.game.rotation = { enabled: true, steps: horse('orbits') };
    });
    seat(rt, 3);
    rt.start('host');
    const seen = play(rt, clock, 40);
    expect(checkCounts(seen)).toBeGreaterThan(30);
  });

  it('counts later steps of the same game in, and names the next different game', () => {
    const { rt, clock } = table(
      (s) =>
        (s.game.rotation = {
          enabled: true,
          steps: [
            { gameId: 'nlhe', betting: 'no-limit', length: 1, unit: 'orbits' },
            { gameId: 'nlhe', betting: 'no-limit', length: 2, unit: 'hands' },
            { gameId: 'plo4', betting: 'pot-limit', length: 1, unit: 'orbits' },
          ],
        }),
    );
    seat(rt, 3);
    rt.start('host');
    const first = tableView(rt, 'a', clock.now()).rotation!;
    // An orbit of three, then two more hands of Hold'em.
    expect(first).toMatchObject({ gameId: 'nlhe', dealt: 1, handsLeft: 4, next: { gameId: 'plo4', gameName: 'Pot-Limit Omaha' } });
    expect(checkCounts(play(rt, clock, 24))).toBeGreaterThan(15);
  });

  it('before the first hand: the whole game is left, and the view names it', () => {
    const { rt, clock } = table((s) => (s.game.rotation = { enabled: true, steps: horse('orbits') }));
    seat(rt, 4);
    expect(tableView(rt, 'a', clock.now()).rotation).toEqual({
      gameId: 'nlhe',
      betting: 'fixed-limit',
      gameName: "Limit Hold'em",
      dealt: 0,
      handsLeft: 4,
      next: { gameId: 'plo8', betting: 'fixed-limit', gameName: 'Limit Omaha Hi-Lo (8 or better)' },
    });
  });

  it('moves with the players: one fewer sitting in is one fewer hand in the orbit', () => {
    const { rt, clock } = table((s) => {
      s.timing.autoStartNextHand = false;
      s.game.rotation = { enabled: true, steps: horse('orbits', 2) };
    });
    seat(rt, 5);
    rt.start('host');
    const before = tableView(rt, 'a', clock.now()).rotation!.handsLeft!;
    // A player behind the button sits out: the orbits still to come have one hand fewer each.
    const out = rt.state.seats.find((x) => x && x.seat !== rt.state.hand!.input.button && x.playerId !== 'host')!;
    rt.sitOut(out.playerId, true);
    const after = tableView(rt, 'a', clock.now()).rotation!.handsLeft!;
    expect(after).toBeLessThan(before);
  });

  it('stays right after a player sits out, in steps longer than an orbit and steps followed by the same game (#373 review)', () => {
    const rotations = [
      [
        { gameId: 'nlhe', betting: 'fixed-limit' as const, length: 2, unit: 'orbits' as const },
        { gameId: 'stud', betting: 'fixed-limit' as const, length: 1, unit: 'orbits' as const },
      ],
      [
        { gameId: 'plo8', betting: 'fixed-limit' as const, length: 1, unit: 'orbits' as const },
        { gameId: 'plo8', betting: 'fixed-limit' as const, length: 3, unit: 'orbits' as const },
        { gameId: 'plo4', betting: 'pot-limit' as const, length: 1, unit: 'orbits' as const },
      ],
      [
        { gameId: 'nlhe', betting: 'no-limit' as const, length: 2, unit: 'hands' as const },
        { gameId: 'nlhe', betting: 'no-limit' as const, length: 1, unit: 'orbits' as const },
        { gameId: 'razz', betting: 'fixed-limit' as const, length: 1, unit: 'orbits' as const },
      ],
    ];
    let checked = 0;
    for (const [r, steps] of rotations.entries()) {
      for (let before = 0; before < 6; before++) {
        for (const out of ['a', 'b', 'c']) {
          const { rt, clock } = table((s) => {
            s.table.maxSeats = 6;
            s.game.rotation = { enabled: true, steps };
          }, 10 * r + before + 1);
          seat(rt, 5);
          rt.start('host');
          play(rt, clock, before);
          // Sits out from the next hand on; nobody else comes or goes.
          rt.sitOut(out, true);
          checked += checkCounts(play(rt, clock, 24));
        }
      }
    }
    expect(checked).toBeGreaterThan(500);
  });

  it('still counts when the button and both blinds sit out in one hand, so the button has many seats to pass', () => {
    for (const seed of [1, 2, 3, 4]) {
      const { rt, clock } = table((s) => (s.game.rotation = { enabled: true, steps: horse('orbits') }), seed);
      seat(rt, [0, 1, 2, 3, 5, 6, 7]);
      rt.start('host');
      const p = rt.state.positions!;
      for (const at of [p.button, p.smallBlind, p.bigBlind]) {
        const id = at === null ? null : rt.state.seats[at]?.playerId;
        if (id) rt.sitOut(id, true);
      }
      expect(tableView(rt, 'host', clock.now()).rotation?.handsLeft).not.toBeNull();
      expect(checkCounts(play(rt, clock, 20))).toBeGreaterThan(10);
    }
  });

  it('counts a rotation changed during a hand from its start, as the next deal begins it', () => {
    const { rt, clock } = table((s) => {
      s.table.maxSeats = 6;
      s.game.rotation = { enabled: true, steps: horse('orbits') };
    });
    seat(rt, 4);
    rt.start('host');
    rt.updateSettings('host', { game: { rotation: { enabled: true, steps: eightGame('orbits') } } });
    // 2-7 Triple Draw comes next, for a whole orbit of four, though a hand of Limit Hold'em is on the table.
    expect(tableView(rt, 'a', clock.now()).rotation).toMatchObject({ gameId: 'td27', dealt: 0, handsLeft: 4, next: { gameId: 'nlhe', betting: 'fixed-limit' } });
    checkDown(rt);
    clock.advance(10_000);
    expect(tableView(rt, 'a', clock.now()).hand?.gameId).toBe('td27');
    rt.updateSettings('host', { game: { rotation: { enabled: false, steps: eightGame('orbits') } } });
    expect(tableView(rt, 'a', clock.now()).rotation).toBeNull();
  });

  it('has nothing to say without a rotation, with one game in it, or with too few players', () => {
    const plain = table(() => {});
    seat(plain.rt, 3);
    expect(tableView(plain.rt, 'a', plain.clock.now()).rotation).toBeNull();
    const same = table(
      (s) =>
        (s.game.rotation = {
          enabled: true,
          steps: [
            { gameId: 'nlhe', betting: 'no-limit', length: 1, unit: 'orbits' },
            { gameId: 'nlhe', betting: 'no-limit', length: 3, unit: 'hands' },
          ],
        }),
    );
    seat(same.rt, 3);
    expect(tableView(same.rt, 'a', same.clock.now()).rotation).toBeNull();
    const alone = table((s) => (s.game.rotation = { enabled: true, steps: horse('orbits') }));
    seat(alone.rt, 1);
    expect(tableView(alone.rt, 'a', alone.clock.now()).rotation).toMatchObject({ gameId: 'nlhe', handsLeft: null, next: { gameId: 'plo8' } });
  });

  it('runs behind for spectators on a delay, with the hand it goes with', () => {
    const { rt, clock } = table((s) => {
      s.timing.autoStartNextHand = false;
      s.game.rotation = { enabled: true, steps: horse('hands', 3) };
    });
    seat(rt, 3);
    rt.start('host');
    const past = delayedPart(tableView(rt, 'watcher', clock.now()));
    checkDown(rt);
    rt.dealNext('host');
    const live = tableView(rt, 'watcher', clock.now());
    expect(live.rotation?.handsLeft).toBe(1);
    expect(behind(live, past, 30_000).rotation?.handsLeft).toBe(2);
    expect(behind(live, null, 30_000).rotation).toBeNull();
  });
});

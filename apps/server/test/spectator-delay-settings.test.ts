import { beforeAll, describe, expect, it } from 'vitest';
import { engine, variants } from '@rsdp/engine/core';
import { defaultSettings, type TableSettings } from '@rsdp/engine/settings';
import { registerAllVariants } from '@rsdp/engine/variants';
import { TableRuntime } from '../src/runtime/table';
import type { TableView } from '@rsdp/engine/wire';
import { behind, delayedPart, tableView, type DelayedPart } from '../src/runtime/view';
import { FakeClock, seeded } from './fake-clock';

/*
 * A spectator on a delay sees the table's settings, the change waiting for the next hand and the blind level as they
 * were, with the hand they go with (#432). Live, a change the host made during a hand, or a level counted in hands,
 * moves on the moment the live table deals its next hand, which would tell the spectator the live hand had ended.
 */

beforeAll(() => registerAllVariants(variants));

const PLAYERS = ['host', 'a', 'b', 'c'];
const DELAY = 30_000;

function table(patch: (s: TableSettings) => void = () => {}) {
  const clock = new FakeClock();
  const settings = defaultSettings('cash');
  settings.timing.autoStartNextHand = false;
  patch(settings);
  const rt = TableRuntime.create({ id: 't1', hostId: 'host', settings }, { clock, rng: seeded(3) });
  for (const p of [...PLAYERS, 'watcher']) rt.connect(p);
  rt.updateSettings('host', { seating: { requireApproval: false } });
  PLAYERS.forEach((p, i) => rt.requestSeat(p, { seat: i, name: p.toUpperCase(), stack: 10_000 }));
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

/** The table state that runs behind with the hand, but isn't the hand itself. */
const stateOf = (v: TableView) => ({
  paused: v.paused,
  started: v.started,
  stopAfterHand: v.stopAfterHand,
  bombPotNext: v.bombPotNext,
  rakeTotal: v.rakeTotal,
  nit: v.nit,
  settings: v.settings,
  pendingSettings: v.pendingSettings,
  level: v.level,
  seeAll: v.spectator?.seeAll,
});

/** What the spectator was shown `DELAY` ago, and what they are shown now the live table has dealt its next hand. */
function acrossTheDeal(rt: TableRuntime, clock: FakeClock, during: () => void) {
  during();
  const past = delayedPart(tableView(rt, 'watcher', clock.now()));
  checkDown(rt);
  rt.dealNext('host');
  const live = tableView(rt, 'watcher', clock.now());
  return { past, live, shown: behind(live, past, DELAY) };
}

describe('spectators on a delay (#432)', () => {
  it('see a change the host made during the hand only with the hand it is dealt in', () => {
    const { rt, clock } = table();
    const { live, shown } = acrossTheDeal(rt, clock, () => rt.updateSettings('host', { stakes: { smallBlind: 5, bigBlind: 10 } }));
    expect(live.settings.stakes.bigBlind).toBe(10);
    expect(live.pendingSettings).toBeNull();
    // The delayed view still shows the hand the change waited through, so the old blinds and the change still waiting.
    expect(shown.hand?.handNumber).toBe(1);
    expect(shown.settings.stakes.bigBlind).toBe(2);
    expect(shown.pendingSettings).toMatchObject({ stakes: { bigBlind: 10 } });
  });

  it('see a blind level counted in hands move on with the hand they are shown', () => {
    const { rt, clock } = table((s) => {
      s.blindSchedule = {
        enabled: true,
        countdown: 'hands',
        levels: [
          { smallBlind: 1, bigBlind: 2, ante: 0, minutes: 20, hands: 4 },
          { smallBlind: 2, bigBlind: 4, ante: 0, minutes: 20, hands: 4 },
        ],
      };
    });
    const { past, live, shown } = acrossTheDeal(rt, clock, () => {});
    expect(live.level?.handsLeft).toBe((past.level?.handsLeft ?? 0) - 1);
    expect(shown.level).toEqual(past.level);
  });

  it("see a timed level's end moved on by the delay, so it counts down in step", () => {
    const { rt, clock } = table((s) => {
      s.blindSchedule = {
        enabled: true,
        countdown: 'per-level-timer',
        levels: [
          { smallBlind: 1, bigBlind: 2, ante: 0, minutes: 20, hands: 30 },
          { smallBlind: 2, bigBlind: 4, ante: 0, minutes: 20, hands: 30 },
        ],
      };
    });
    const past = delayedPart(tableView(rt, 'watcher', clock.now()));
    clock.advance(DELAY);
    const shown = behind(tableView(rt, 'watcher', clock.now()), past, DELAY);
    expect(past.level?.endsAt).toBeGreaterThan(0);
    expect(shown.level?.endsAt).toBe(past.level!.endsAt! + DELAY);
  });

  it('see what changes at once, mid-hand too, as it is now', () => {
    const { rt, clock } = table();
    const past = delayedPart(tableView(rt, 'watcher', clock.now()));
    rt.updateSettings('host', { table: { name: 'Late night' }, chat: { guestChat: false } });
    const shown = behind(tableView(rt, 'watcher', clock.now()), past, DELAY);
    expect(shown.settings.table.name).toBe('Late night');
    expect(shown.settings.chat.guestChat).toBe(false);
    // The rest is still as it was.
    expect(shown.settings.table.maxSeats).toBe(past.settings.table.maxSeats);
    expect(shown.settings.stakes).toBe(past.settings.stakes);
  });

  it('with nothing kept to show yet (just after a restart), see the settings as they are', () => {
    const { rt, clock } = table();
    const live = tableView(rt, 'watcher', clock.now());
    expect(behind(live, null, DELAY).settings).toBe(live.settings);
  });

  it('with nothing old enough to show yet, see the settings of the oldest snapshot kept, so they never go back', () => {
    const { rt, clock } = table((s) => {
      s.blindSchedule = {
        enabled: true,
        countdown: 'hands',
        levels: [
          { smallBlind: 1, bigBlind: 2, ante: 0, minutes: 20, hands: 4 },
          { smallBlind: 2, bigBlind: 4, ante: 0, minutes: 20, hands: 4 },
        ],
      };
    });
    // The feed starts again mid-hand (the host stopped spectators seeing every card, or raised the delay).
    const { past, live } = acrossTheDeal(rt, clock, () => rt.updateSettings('host', { stakes: { smallBlind: 5, bigBlind: 10 } }));
    const waiting = behind(live, null, DELAY, past);
    expect(waiting.hand).toBeNull();
    expect(waiting.settings.stakes.bigBlind).toBe(2);
    expect(waiting.pendingSettings).toMatchObject({ stakes: { bigBlind: 10 } });
    expect(waiting.level?.handsLeft).toBe(past.level?.handsLeft);
    // Once that snapshot is old enough, it shows the same.
    const shown = behind(live, past, DELAY);
    expect(stateOf(shown)).toEqual(stateOf(waiting));
  });

  it('with nothing old enough to show yet, see all the table state that runs behind as the oldest snapshot has it', () => {
    const { rt, clock } = table();
    const live = tableView(rt, 'watcher', clock.now());
    const kept = delayedPart(live);
    // Each part different from the live table's, so a part taken live would show.
    const oldest: DelayedPart = {
      ...kept,
      paused: !live.paused,
      started: !live.started,
      stopAfterHand: !live.stopAfterHand,
      bombPotNext: !live.bombPotNext,
      rakeTotal: (live.rakeTotal ?? 0) + 123,
      nit: { prize: 7, participants: 3, holders: 1 },
      pendingSettings: { stakes: { bigBlind: 50 } },
      spectator: kept.spectator && { ...kept.spectator, seeAll: !live.spectator!.seeAll },
    };
    const waiting = behind(live, null, DELAY, oldest);
    expect(stateOf(waiting)).toEqual(stateOf({ ...oldest, settings: live.settings } as TableView));
    expect(stateOf(waiting)).not.toEqual(stateOf(live));
  });

  it('see "every card face up" start with the hand it starts with', () => {
    const { rt, clock } = table((s) => {
      s.spectators.delaySeconds = DELAY / 1000;
    });
    checkDown(rt);
    // Between hands, so it applies at once, from the next hand dealt.
    rt.updateSettings('host', { spectators: { seeAllCards: true } });
    const past = delayedPart(tableView(rt, 'watcher', clock.now()));
    rt.dealNext('host');
    const live = tableView(rt, 'watcher', clock.now());
    expect(live.spectator?.seeAll).toBe(true);
    const shown = behind(live, past, DELAY);
    expect(shown.hand?.handNumber).toBe(1);
    expect(shown.spectator?.seeAll).toBe(false);
    // Whether watching is blocked stays as it is now.
    expect(shown.spectator?.blocked).toBe(live.spectator?.blocked);
    // It starts once the hand it starts with shows.
    const next = behind(live, delayedPart(live), DELAY);
    expect(next.hand?.handNumber).toBe(2);
    expect(next.spectator?.seeAll).toBe(true);
  });
});

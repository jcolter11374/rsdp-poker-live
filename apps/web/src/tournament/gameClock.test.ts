import { describe, expect, it } from 'vitest';
import type { BettingKind } from '@rsdp/engine/core';
import { createTournament, defaultSettings, type StructureRow, type TournamentSettings, type TournamentState } from '@rsdp/tournament';
import { levelGameNow, levelNow, levelStakes, nextGame, nextGameText } from './gameClock';

const T0 = 1_800_000_000_000;
const MIN = 60_000;
const L: BettingKind = 'fixed-limit';
const level = (bb: number, minutes = 10): StructureRow => ({ kind: 'level', sb: bb / 2, bb, ante: bb / 4, anteType: 'per-player', minutes });
const HORSE = { games: ['nlhe', 'plo8', 'razz', 'stud', 'stud8'], gameBetting: [L, L, L, L, L] };

/** A tournament whose clock started at T0 and has run `ms` (stopped there when paused). */
function event(settings: Partial<TournamentSettings>, ms: number, status: TournamentState['status'] = 'running'): { s: TournamentState; now: number } {
  const s = createTournament({ id: 't', hostId: 'h', settings: defaultSettings({ seatsPerTable: 8, structure: [100, 200, 300, 400, 600].map((bb) => level(bb)), ...settings }), now: T0, seed: '01'.repeat(32) });
  s.status = status;
  s.clock = status === 'paused' ? { elapsedMs: ms, runningSince: null, rowIndex: 0 } : { elapsedMs: 0, runningSince: T0, rowIndex: 0 };
  return { s, now: T0 + ms };
}

describe('nextGame: the countdown to the next game in a mixed event (#305)', () => {
  it('counts down to the next level when each level is a new game', () => {
    const { s, now } = event(HORSE, 6 * MIN + 40_000);
    const next = nextGame(s, now, { gameId: 'nlhe', betting: L });
    expect(next).toEqual({ gameId: 'plo8', betting: L, inMs: 3 * MIN + 20_000 });
    expect(nextGameText(next!)).toBe('LO8 in 3:20');
    // On a computer, the game's full name.
    expect(nextGameText(next!, 'full')).toBe('Limit Omaha Hi-Lo next, in 3:20');
  });

  it('reads the game from the clock when no hand has been dealt', () => {
    const { s, now } = event(HORSE, 12 * MIN);
    expect(nextGameText(nextGame(s, now, null)!, 'full')).toBe('Razz next, in 8:00');
  });

  it('says the new game starts with the next hand when the level moved on during a hand', () => {
    // Level 2 (Omaha Hi-Lo) has begun, but this table is still finishing a Limit Hold'em hand.
    const { s, now } = event(HORSE, 10 * MIN + 5_000);
    const next = nextGame(s, now, { gameId: 'nlhe', betting: L });
    expect(next).toEqual({ gameId: 'plo8', betting: L, inMs: null });
    expect(nextGameText(next!, 'full')).toBe('Limit Omaha Hi-Lo from the next hand');
    expect(nextGameText(next!)).toBe('LO8 next hand');
  });

  it("doesn't call the game that just ended the next one when this page's clock runs a moment behind (#305 review)", () => {
    // A hand of level 2 (Omaha Hi-Lo) is on the table, but this page's clock still reads 0.7s before level 2.
    const { s, now } = event(HORSE, 10 * MIN - 700);
    expect(nextGame(s, now, { gameId: 'plo8', betting: L })).toEqual({ gameId: 'razz', betting: L, inMs: 10 * MIN });
    // Further from the boundary, the hand on the table is the earlier level's, and the new game starts next hand.
    const early = event(HORSE, 10 * MIN - 20_000);
    expect(nextGame(early.s, early.now, { gameId: 'nlhe', betting: L })).toEqual({ gameId: 'plo8', betting: L, inMs: 20_000 });
    // Paused just before the boundary, with the next level's hand already dealt: the clock stands still, read from the level.
    const paused = event(HORSE, 10 * MIN - 700, 'paused');
    expect(nextGame(paused.s, paused.now + 5 * MIN, { gameId: 'plo8', betting: L })?.inMs).toBe(10 * MIN);
  });

  it('skips levels that play the same game, adding up their time', () => {
    const { s, now } = event({ games: ['nlhe', 'nlhe', 'plo4'], gameBetting: ['no-limit', 'no-limit', 'pot-limit'] }, 4 * MIN);
    expect(nextGameText(nextGame(s, now, { gameId: 'nlhe', betting: 'no-limit' })!)).toBe('PLO in 16:00');
  });

  it("tells Limit and No-Limit Hold'em apart, as 8-Game plays both", () => {
    const { s, now } = event({ games: ['nlhe', 'nlhe'], gameBetting: [L, 'no-limit'] }, 9 * MIN);
    expect(nextGameText(nextGame(s, now, { gameId: 'nlhe', betting: L })!)).toBe('NLH in 1:00');
  });

  it('counts a break in, and on a break names the game after it', () => {
    const structure: StructureRow[] = [level(100), { kind: 'break', minutes: 5 }, level(200), level(300)];
    // Two minutes into level 1: its eight minutes left plus the five-minute break.
    const playing = event({ ...HORSE, structure }, 2 * MIN);
    expect(nextGame(playing.s, playing.now, { gameId: 'nlhe', betting: L })?.inMs).toBe(13 * MIN);
    // On the break, with the last hand of Limit Hold'em over: Omaha Hi-Lo when the break ends.
    const onBreak = event({ ...HORSE, structure }, 11 * MIN);
    expect(nextGame(onBreak.s, onBreak.now, null)).toEqual({ gameId: 'plo8', betting: L, inMs: 4 * MIN });
    expect(nextGame(onBreak.s, onBreak.now, { gameId: 'nlhe', betting: L })?.inMs).toBe(4 * MIN);
  });

  it('has nothing to count down to in a single-game event, on the last level, or once the rotation stops', () => {
    const single = event({}, 3 * MIN);
    expect(nextGame(single.s, single.now, { gameId: 'nlhe', betting: 'no-limit' })).toBeNull();
    // Level 5 of 5 never ends.
    const last = event(HORSE, 45 * MIN);
    expect(nextGame(last.s, last.now, null)).toBeNull();
    const stopped = event({ ...HORSE, stopRotationAtLevel: 2 }, 15 * MIN);
    expect(nextGame(stopped.s, stopped.now, { gameId: 'plo8', betting: L })).toBeNull();
    const before = event({ ...HORSE, stopRotationAtLevel: 2 }, 5 * MIN);
    expect(nextGameText(nextGame(before.s, before.now, null)!)).toBe('LO8 in 5:00');
  });

  it('stands still while the event is paused, and says nothing before the start', () => {
    const { s, now } = event(HORSE, 7 * MIN, 'paused');
    expect(nextGame(s, now + 10 * MIN, null)?.inMs).toBe(3 * MIN);
    const waiting = event(HORSE, 0, 'registering');
    expect(nextGame(waiting.s, waiting.now, null)).toBeNull();
    expect(levelNow(waiting.s, waiting.now)).toBeNull();
  });
});

describe('the level and game for the top bar', () => {
  it('numbers the level, and on a break the one after it', () => {
    const structure: StructureRow[] = [level(100), { kind: 'break', minutes: 5 }, level(200), level(300)];
    const { s } = event({ ...HORSE, structure }, 0);
    expect(levelNow(s, T0 + 3 * MIN)).toEqual({ number: 1, onBreak: false });
    expect(levelNow(s, T0 + 12 * MIN)).toEqual({ number: 2, onBreak: true });
    expect(levelNow(s, T0 + 16 * MIN)).toEqual({ number: 2, onBreak: false });
  });

  it('gives the game and stakes a table with no hand yet will deal, as the server does', () => {
    const { s, now } = event(HORSE, 25 * MIN);
    const l = levelGameNow(s, now)!;
    expect(l).toMatchObject({ levelNumber: 3, gameId: 'razz', betting: L, sb: 150, bb: 300, ante: 75 });
    expect(levelStakes(l)).toEqual({ smallBlind: 150, bigBlind: 300, ante: 75, anteType: 'per-player', bringIn: l.bringIn, smallBet: 300, bigBet: 600 });
    // In a mix with stud, the flop games don't ante (D29).
    const first = event(HORSE, MIN);
    expect(levelGameNow(first.s, first.now)?.ante).toBe(0);
    // Before the start: the first level.
    const waiting = event(HORSE, 0, 'registering');
    expect(levelGameNow(waiting.s, waiting.now)?.gameId).toBe('nlhe');
    const over = event(HORSE, 0, 'finished');
    expect(levelGameNow(over.s, over.now)).toBeNull();
  });
});

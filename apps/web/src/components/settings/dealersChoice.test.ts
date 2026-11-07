import { describe, expect, it } from 'vitest';
import { defaultSettings } from '@rsdp/engine/settings';
import { CHOICE_FILLS, DEFAULT_MENU, levelStudAnte, menuSeats, nextMenuGame, repeatsOf, stakesForGames, stakesForMenu } from './dealersChoice';

/** Blind levels with these antes, the first at big blind `bigBlind` and each one after at twice the one before. */
const levels = (antes: readonly number[], bigBlind = 2) => antes.map((ante, i) => ({ bigBlind: bigBlind * 2 ** i, ante }));

describe("Dealer's choice settings helpers", () => {
  it('fill the menu in one tap, starting with the 8-Game games', () => {
    expect(DEFAULT_MENU.map((g) => g.gameId)).toEqual(['td27', 'nlhe', 'plo8', 'razz', 'stud', 'stud8', 'nlhe', 'plo4']);
    expect(CHOICE_FILLS.find((f) => f.id === 'all')!.games).toHaveLength(12);
    for (const f of CHOICE_FILLS) expect(repeatsOf(f.games)).toEqual([]);
  });

  it('size the table by the biggest game on the menu', () => {
    expect(menuSeats(DEFAULT_MENU)).toBe(10);
    expect(menuSeats([{ gameId: 'badugi', betting: 'fixed-limit' }, { gameId: 'razz', betting: 'fixed-limit' }])).toBe(8);
  });

  it('find repeats and a game to add', () => {
    const nl = { gameId: 'nlhe', betting: 'no-limit' as const };
    expect(repeatsOf([nl, { ...nl, betting: 'fixed-limit' }, nl])).toEqual([2]);
    expect(nextMenuGame([nl])).toMatchObject({ gameId: 'plo4' });
    expect(nextMenuGame(CHOICE_FILLS.find((f) => f.id === 'all')!.games)).toBeNull();
  });

  it('set up the stakes a menu needs, as for HORSE', () => {
    const stakes = { ...defaultSettings('cash').stakes, centsMode: true, smallBlind: 25, bigBlind: 50, smallBet: 0, bigBet: 0, ante: 50, anteType: 'big-blind' as const };
    const next = stakesForMenu(stakes, DEFAULT_MENU, []);
    expect(next).toMatchObject({ smallBet: 50, bigBet: 100, ante: 10, anteType: 'per-player', bringIn: 15 });
    // Adding more games to a menu that already had stud leaves the host's ante alone.
    expect(stakesForMenu({ ...next, ante: 20 }, [...DEFAULT_MENU, { gameId: 'badugi', betting: 'fixed-limit' }], DEFAULT_MENU).ante).toBe(20);
    // Taking the last stud game off takes its ante off too: it would be posted in every Hold'em and Omaha hand.
    const flop = CHOICE_FILLS.find((f) => f.id === 'flop')!.games;
    expect(stakesForMenu(next, flop, DEFAULT_MENU)).toMatchObject({ ante: 0, anteType: 'none' });
    expect(stakesForMenu({ ...stakes, ante: 0 }, flop, []).ante).toBe(0);
  });

  it("work out the stakes for other games from each part's own value (#414)", () => {
    const holdem = [{ gameId: 'nlhe', betting: 'no-limit' as const }];
    const stakes = { ...defaultSettings('cash').stakes, smallBlind: 50, bigBlind: 100, smallBet: 100, bigBet: 200, ante: 0, anteType: 'none' as const, bringIn: 0 };
    const look = stakesForGames(stakes, levels([0], 100), holdem, DEFAULT_MENU, null, false);
    expect(look.stakes).toMatchObject({ ante: 25, anteType: 'per-player', bringIn: 33 });
    // Straight back: as it was.
    expect(stakesForGames(look.stakes, levels(look.antes, 100), DEFAULT_MENU, holdem, look.start, false)).toMatchObject({ stakes, antes: [0] });
    // The host lowers the Limit bets: the bring-in worked out from the old small bet can't stay above the new one.
    const lower = stakesForGames({ ...look.stakes, smallBet: 6, bigBet: 12 }, levels(look.antes, 100), DEFAULT_MENU, CHOICE_FILLS.find((f) => f.id === 'horse')!.games, look.start, false);
    expect(lower.stakes).toMatchObject({ smallBet: 6, bigBet: 12, bringIn: 2 });
  });

  it('take the level antes off with the ante, and put them back with it (#414)', () => {
    const horse = CHOICE_FILLS.find((f) => f.id === 'horse')!.games;
    const stakes = { ...defaultSettings('cash').stakes, ante: 4, anteType: 'per-player' as const, bringIn: 1 };
    const off = stakesForGames(stakes, levels([4, 8]), DEFAULT_MENU, horse.slice(0, 1), null, true);
    expect(off).toMatchObject({ stakes: { ante: 0, anteType: 'none' }, antes: [0, 0] });
    expect(stakesForGames(off.stakes, levels(off.antes), horse.slice(0, 1), DEFAULT_MENU, off.start, true)).toMatchObject({ stakes, antes: [4, 8] });
  });

  it('put a stud ante on each level of the blind schedule with the stud ante, for its own blinds (#426)', () => {
    const holdem = [{ gameId: 'nlhe', betting: 'no-limit' as const }];
    const stakes = { ...defaultSettings('cash').stakes, centsMode: true, smallBlind: 25, bigBlind: 50, smallBet: 0, bigBet: 0 };
    // While the schedule is on, each level's ante is the one posted: with 0 the stud games would have none.
    const on = stakesForGames(stakes, levels([0, 0, 0], 50), holdem, DEFAULT_MENU, null, true);
    expect(on.stakes).toMatchObject({ smallBet: 50, ante: 10, anteType: 'per-player' });
    // About a quarter of each level's small bet, which the server raises with the level's big blind: 1, 2 and 4 dollars.
    expect(on.antes).toEqual([10, 25, 50]);
    // Straight back: as it was.
    expect(stakesForGames(on.stakes, levels(on.antes, 50), DEFAULT_MENU, holdem, on.start, true)).toMatchObject({ stakes, antes: [0, 0, 0] });
    // A Hold'em table's own big-blind antes would be far too big posted by everyone in the stud games: they're replaced, and come back.
    const bigBlindAnte = { ...stakes, ante: 50, anteType: 'big-blind' as const };
    const horse = CHOICE_FILLS.find((f) => f.id === 'horse')!.games;
    const mixed = stakesForGames(bigBlindAnte, levels([50, 100], 50), holdem, horse, null, true);
    expect(mixed).toMatchObject({ stakes: { ante: 10, anteType: 'per-player' }, antes: [10, 25] });
    expect(stakesForGames(mixed.stakes, levels(mixed.antes, 50), horse, holdem, mixed.start, true)).toMatchObject({ stakes: bigBlindAnte, antes: [50, 100] });
    // Going from one stud game to another leaves the levels' antes alone.
    const razz = [{ gameId: 'razz', betting: 'fixed-limit' as const }];
    expect(stakesForGames(mixed.stakes, levels([5, 15], 50), horse, razz, null, true).antes).toEqual([5, 15]);
  });

  it('size a level\'s stud ante to its own blinds, or keep the Stakes tab\'s with none (#426)', () => {
    const stakes = { ...defaultSettings('cash').stakes, smallBlind: 0, bigBlind: 0, smallBet: 0, bigBet: 0, ante: 5, anteType: 'per-player' as const };
    // A table with no big blind bets the level's, as a tournament does.
    expect(levelStudAnte(stakes, { bigBlind: 100 })).toBe(25);
    // A level with no big blind has nothing to go by.
    expect(levelStudAnte(stakes, { bigBlind: 0 })).toBe(5);
    // Limit bets of their own keep their size to the big blind.
    expect(levelStudAnte({ ...stakes, bigBlind: 10, smallBet: 20 }, { bigBlind: 40 })).toBe(20);
  });

  it('let a level added on the way follow the level before, as Add level does, unless the host changed its ante (#426)', () => {
    const holdem = [{ gameId: 'nlhe', betting: 'no-limit' as const }];
    const stakes = { ...defaultSettings('cash').stakes, ante: 4, anteType: 'per-player' as const, bringIn: 1 };
    const off = stakesForGames(stakes, levels([4, 8]), DEFAULT_MENU, holdem, null, true);
    expect(off.antes).toEqual([0, 0]);
    // Two levels added with no ante, then back to the stud games: they follow the antes that come back.
    expect(stakesForGames(off.stakes, levels([0, 0, 0, 0]), holdem, DEFAULT_MENU, off.start, true).antes).toEqual([4, 8, 16, 32]);
    // One whose ante the host typed keeps it.
    expect(stakesForGames(off.stakes, levels([0, 0, 3]), holdem, DEFAULT_MENU, off.start, true).antes).toEqual([4, 8, 3]);
  });
});

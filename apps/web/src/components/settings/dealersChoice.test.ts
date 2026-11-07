import { describe, expect, it } from 'vitest';
import { defaultSettings } from '@rsdp/engine/settings';
import { CHOICE_FILLS, DEFAULT_MENU, menuSeats, nextMenuGame, repeatsOf, stakesForGames, stakesForMenu } from './dealersChoice';

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
    const look = stakesForGames(stakes, [0], holdem, DEFAULT_MENU, null, false);
    expect(look.stakes).toMatchObject({ ante: 25, anteType: 'per-player', bringIn: 33 });
    // Straight back: as it was.
    expect(stakesForGames(look.stakes, look.antes, DEFAULT_MENU, holdem, look.start, false)).toMatchObject({ stakes, antes: [0] });
    // The host lowers the Limit bets: the bring-in worked out from the old small bet can't stay above the new one.
    const lower = stakesForGames({ ...look.stakes, smallBet: 6, bigBet: 12 }, look.antes, DEFAULT_MENU, CHOICE_FILLS.find((f) => f.id === 'horse')!.games, look.start, false);
    expect(lower.stakes).toMatchObject({ smallBet: 6, bigBet: 12, bringIn: 2 });
  });

  it('take the level antes off with the ante, and put them back with it (#414)', () => {
    const horse = CHOICE_FILLS.find((f) => f.id === 'horse')!.games;
    const stakes = { ...defaultSettings('cash').stakes, ante: 4, anteType: 'per-player' as const, bringIn: 1 };
    const off = stakesForGames(stakes, [4, 8], DEFAULT_MENU, horse.slice(0, 1), null, true);
    expect(off).toMatchObject({ stakes: { ante: 0, anteType: 'none' }, antes: [0, 0] });
    expect(stakesForGames(off.stakes, off.antes, horse.slice(0, 1), DEFAULT_MENU, off.start, true)).toMatchObject({ stakes, antes: [4, 8] });
  });
});

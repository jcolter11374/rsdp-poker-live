import { describe, expect, it } from 'vitest';
import { defaultSettings } from '@rsdp/engine/settings';
import { dealtSizes } from './handSizes';
import { dealableGames, tableGames, tournamentGames } from './tableGames';

describe('the games a table is laid out for (#409)', () => {
  it("is a cash table's one game, its rotation, or its Dealer's choice menu", () => {
    const s = defaultSettings('cash');
    s.game.gameId = 'plo4';
    expect(tableGames(s)).toEqual(['plo4']);
    s.game.rotation = { enabled: true, steps: [{ gameId: 'nlhe', betting: 'fixed-limit', length: 1, unit: 'hands' }, { gameId: 'stud', betting: 'fixed-limit', length: 1, unit: 'hands' }] };
    expect(tableGames(s)).toEqual(['nlhe', 'stud']);
    s.game.rotation.enabled = false;
    s.game.dealersChoice = { enabled: true, games: [{ gameId: 'razz', betting: 'fixed-limit' }, { gameId: 'badugi', betting: 'fixed-limit' }], hands: 0, pickSeconds: 20 };
    expect(tableGames(s)).toEqual(['razz', 'badugi']);
    // A menu that is off doesn't count.
    s.game.dealersChoice.enabled = false;
    expect(tableGames(s)).toEqual(['plo4']);
  });
  it("is a tournament's rotation, with any level that names its own game", () => {
    const level = { kind: 'level' as const, sb: 25, bb: 50, ante: 0, anteType: 'per-player' as const, minutes: 10 };
    expect(tournamentGames({ games: ['nlhe'], structure: [level, { kind: 'break', minutes: 5 }, level] })).toEqual(['nlhe']);
    expect(tournamentGames({ games: ['nlhe', 'stud'], structure: [level, { ...level, gameId: 'plo4' }, { ...level, gameId: 'stud' }] })).toEqual(['nlhe', 'stud', 'plo4']);
  });
  it('leaves out the games too small for the players seated', () => {
    const menu = ['td27', 'razz', 'stud', 'plo4', 'nlhe'];
    expect(dealableGames(menu, 4)).toEqual(menu);
    expect(dealableGames(menu, 7)).toEqual(['razz', 'stud', 'plo4', 'nlhe']);
    expect(dealableGames(menu, 9)).toEqual(['plo4', 'nlhe']);
    expect(dealableGames(['nope', 'nlhe'], 2)).toEqual(['nlhe']);
  });
  it('sizes seats for every hand any of the games deals', () => {
    expect(dealtSizes(['nlhe'])).toEqual([2]);
    expect(dealtSizes(['nlhe', 'plo8', 'razz', 'stud', 'stud8'])).toEqual([2, 3, 4, 5, 6, 7]);
    expect(dealtSizes(['td27', 'badugi', 'plo4'])).toEqual([4, 5]);
    expect(dealtSizes([])).toEqual([]);
  });
});

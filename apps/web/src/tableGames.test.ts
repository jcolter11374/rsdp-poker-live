import { describe, expect, it } from 'vitest';
import { defaultSettings } from '@rsdp/engine/settings';
import { dealtShapes } from './handSizes';
import { dealableGames, tableAllLimit, tableGames, tournamentAllLimit, tournamentGames } from './tableGames';

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
    expect(dealtShapes(['nlhe'])).toEqual([2]);
    // Stud's hand is a row over the nameplate from third street (#447): its longest row stands for the shorter ones, and
    // the four cards tucked in are Omaha's.
    expect(dealtShapes(['nlhe', 'plo8', 'razz', 'stud', 'stud8'])).toEqual([2, 4, 7]);
    expect(dealtShapes(['stud'])).toEqual([7]);
    expect(dealtShapes(['td27', 'badugi', 'plo4'])).toEqual([4, 5]);
    expect(dealtShapes(['plo5', 'plo6', 'nlhe'])).toEqual([2, 6]);
    expect(dealtShapes([])).toEqual([]);
  });
});

describe('whether a table only deals Limit games, so the bar under it needs less room (#409)', () => {
  it("follows a cash table's one game, its rotation, or its Dealer's choice menu", () => {
    const s = defaultSettings('cash');
    s.game.gameId = 'nlhe';
    s.game.betting = 'no-limit';
    expect(tableAllLimit(s)).toBe(false);
    s.game.betting = 'fixed-limit';
    expect(tableAllLimit(s)).toBe(true);
    const horse = [{ gameId: 'nlhe', betting: 'fixed-limit' as const, length: 1, unit: 'hands' as const }, { gameId: 'stud', betting: 'fixed-limit' as const, length: 1, unit: 'hands' as const }];
    s.game.betting = 'no-limit';
    s.game.rotation = { enabled: true, steps: horse };
    // The rotation's own betting counts, not the table's game's.
    expect(tableAllLimit(s)).toBe(true);
    s.game.rotation.steps = [...horse, { gameId: 'plo4', betting: 'pot-limit', length: 1, unit: 'hands' }];
    expect(tableAllLimit(s)).toBe(false);
    s.game.rotation.enabled = false;
    s.game.dealersChoice = { enabled: true, games: [{ gameId: 'razz', betting: 'fixed-limit' }, { gameId: 'nlhe', betting: 'fixed-limit' }], hands: 0, pickSeconds: 20 };
    expect(tableAllLimit(s)).toBe(true);
    s.game.dealersChoice.games.push({ gameId: 'nlhe', betting: 'no-limit' });
    expect(tableAllLimit(s)).toBe(false);
  });
  it("follows a tournament's betting for each game, each game's usual betting, and any level's own game", () => {
    const level = { kind: 'level' as const, sb: 25, bb: 50, ante: 0, anteType: 'per-player' as const, minutes: 10 };
    expect(tournamentAllLimit({ games: ['nlhe'], structure: [level] })).toBe(false);
    expect(tournamentAllLimit({ games: ['nlhe', 'stud'], gameBetting: ['fixed-limit', null], structure: [level] })).toBe(true);
    expect(tournamentAllLimit({ games: ['stud', 'razz'], structure: [level, { ...level, gameId: 'plo4' }] })).toBe(false);
    expect(tournamentAllLimit({ games: ['stud', 'razz'], structure: [level, { ...level, gameId: 'stud8' }] })).toBe(true);
  });
});

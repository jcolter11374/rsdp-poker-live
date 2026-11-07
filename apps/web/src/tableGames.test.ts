import { describe, expect, it } from 'vitest';
import { bombPotSchema } from '@rsdp/engine/modifiers';
import { defaultSettings } from '@rsdp/engine/settings';
import { dealtSizes } from './handSizes';
import { dealableGames, layoutOf, tableAllLimit, tableGames, tournamentAllLimit, tournamentGames } from './tableGames';

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
  it('takes in the game bomb pots are dealt in, when they come on their own (#418)', () => {
    const s = defaultSettings('cash');
    s.game.gameId = 'nlhe';
    s.modifiers[bombPotSchema.id] = { ...bombPotSchema.defaults(), enabled: true, gameId: 'plo4' };
    expect(tableGames(s)).toEqual(['nlhe', 'plo4']);
    // Only from the host's button: a one-off, not laid out for.
    s.modifiers[bombPotSchema.id] = { ...bombPotSchema.defaults(), enabled: false, gameId: 'plo4' };
    expect(tableGames(s)).toEqual(['nlhe']);
    // In the table's own game, or a game already on the list.
    s.modifiers[bombPotSchema.id] = { ...bombPotSchema.defaults(), enabled: true, gameId: '' };
    expect(tableGames(s)).toEqual(['nlhe']);
    s.game.rotation = { enabled: true, steps: [{ gameId: 'nlhe', betting: 'no-limit', length: 1, unit: 'hands' }, { gameId: 'plo4', betting: 'pot-limit', length: 1, unit: 'hands' }] };
    s.modifiers[bombPotSchema.id] = { ...bombPotSchema.defaults(), enabled: true, gameId: 'plo4' };
    expect(tableGames(s)).toEqual(['nlhe', 'plo4']);
  });
  it("leaves out bomb pots that can't come on their own, or can't be dealt in their game (#418)", () => {
    const s = defaultSettings('cash');
    s.game.gameId = 'nlhe';
    // On, but with no chance and no count of hands: only the host's button deals one.
    s.modifiers[bombPotSchema.id] = { ...bombPotSchema.defaults(), enabled: true, chancePercent: 0, everyHands: 0, gameId: 'plo4' };
    expect(tableGames(s)).toEqual(['nlhe']);
    s.modifiers[bombPotSchema.id] = { ...bombPotSchema.defaults(), enabled: true, chancePercent: 0, everyHands: 10, gameId: 'plo4' };
    expect(tableGames(s)).toEqual(['nlhe', 'plo4']);
    // Bomb pots are only dealt in flop games with blinds, and a game that doesn't exist is no game.
    s.modifiers[bombPotSchema.id] = { ...bombPotSchema.defaults(), enabled: true, gameId: 'stud' };
    expect(tableGames(s)).toEqual(['nlhe']);
    s.modifiers[bombPotSchema.id] = { ...bombPotSchema.defaults(), enabled: true, gameId: 'nope' };
    expect(tableGames(s)).toEqual(['nlhe']);
  });
  it('keeps room for the big-bet bar when bomb pots come on their own in a No-Limit or Pot-Limit game (#418)', () => {
    const s = defaultSettings('cash');
    s.game.gameId = 'nlhe';
    s.game.betting = 'fixed-limit';
    expect(tableAllLimit(s)).toBe(true);
    s.modifiers[bombPotSchema.id] = { ...bombPotSchema.defaults(), enabled: true, gameId: 'plo4', betting: 'pot-limit' };
    expect(tableAllLimit(s)).toBe(false);
    // The same game, at another betting, counts too; the list of games doesn't change.
    s.modifiers[bombPotSchema.id] = { ...bombPotSchema.defaults(), enabled: true, gameId: 'nlhe', betting: 'no-limit' };
    expect(tableAllLimit(s)).toBe(false);
    expect(tableGames(s)).toEqual(['nlhe']);
    s.modifiers[bombPotSchema.id] = { ...bombPotSchema.defaults(), enabled: true, gameId: 'plo4', betting: 'fixed-limit' };
    expect(tableAllLimit(s)).toBe(true);
    // Only from the host's button, or in the table's own game and betting: no change.
    s.modifiers[bombPotSchema.id] = { ...bombPotSchema.defaults(), enabled: false, gameId: 'plo4', betting: 'pot-limit' };
    expect(tableAllLimit(s)).toBe(true);
    s.modifiers[bombPotSchema.id] = { ...bombPotSchema.defaults(), enabled: true, gameId: '', betting: 'pot-limit' };
    expect(tableAllLimit(s)).toBe(true);
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

describe("what a table's layout takes from its games (#418)", () => {
  const horse = ['nlhe', 'plo8', 'razz', 'stud', 'stud8'];
  it('is the same when a game adds nothing to it', () => {
    // A one-off four-card Omaha bomb pot at HORSE: Omaha hi-lo already has four cards, stud a row over the nameplate.
    expect(layoutOf([...horse, 'plo4'])).toBe(layoutOf(horse));
    expect(layoutOf(['plo4', 'plo8'])).toBe(layoutOf(['plo8']));
  });
  it('changes when a game needs more room', () => {
    expect(layoutOf(['nlhe', 'plo4'])).not.toBe(layoutOf(['nlhe']));
    expect(layoutOf(['nlhe', 'plo5'])).not.toBe(layoutOf(['nlhe', 'plo4']));
    // Hold'em at an Omaha table: a smaller hand is a hand size the layout hasn't measured.
    expect(layoutOf(['plo4', 'nlhe'])).not.toBe(layoutOf(['plo4']));
    // Razz at a table of Badugi and Omaha: a row over the nameplate.
    expect(layoutOf(['badugi', 'plo4', 'razz'])).not.toBe(layoutOf(['badugi', 'plo4']));
    // An Omaha hi-lo bomb pot at a four-card Omaha table: the same hand size, but a longer showdown line (#427).
    expect(layoutOf(['plo4', 'plo8'])).not.toBe(layoutOf(['plo4']));
  });
});

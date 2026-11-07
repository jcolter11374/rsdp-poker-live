// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyAtNextHand, defaultSettings, exportPreset, mergePatches, parseSettings, type SettingsPatch, type TableSettings } from '@rsdp/engine/settings';
import { MIXED_GAMES } from '@rsdp/engine/variants';
import type { TableView } from '@rsdp/engine/wire';
import { SettingsDialog } from './SettingsDialog';
import { CHOICE_FILLS, DEFAULT_MENU, stakesForMenu } from './settings/dealersChoice';

// The dialog reaches the server only through call(): a spy here that answers at once.
const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../socket', () => ({
  call,
  socket: { on: () => {}, off: () => {}, emit: () => {}, connected: false },
  currentSession: () => null,
  onSession: () => () => {},
}));
// The presets the Presets tab lists: none, unless a test puts one here.
const { presetList } = vi.hoisted(() => ({ presetList: [] as { name: string; json: string }[] }));
vi.mock('../presets', async (importOriginal) => ({ ...(await importOriginal<typeof import('../presets')>()), usePresets: () => presetList }));

/** The parts of the table the dialog reads: its settings, whether a hand is on, and who is sitting. */
const viewOf = (settings: TableSettings) =>
  ({
    settings,
    hand: null,
    mode: 'cash',
    seats: Array(settings.table.maxSeats).fill(null),
  }) as unknown as TableView;
const sentPatch = () => call.mock.calls.find(([event]) => event === 'host:settings')?.[1].patch;
const mode = () => screen.getByLabelText('How the game is chosen');

describe('Table settings: How the game is chosen', () => {
  beforeEach(() => {
    call.mockReset();
    call.mockResolvedValue({});
  });

  it("taking a look at Dealer's choice and going back to One game leaves the stakes as they were", () => {
    const settings = defaultSettings('cash');
    expect(settings.stakes.ante).toBe(0);
    render(<SettingsDialog view={viewOf(settings)} onClose={() => {}} />);
    fireEvent.change(mode(), { target: { value: 'choice' } });
    fireEvent.change(mode(), { target: { value: 'one' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(sentPatch()?.stakes).toBeUndefined();
  });

  it("keeps a Dealer's choice menu that is there when the host turns it off", () => {
    const settings = defaultSettings('cash');
    settings.game.dealersChoice = { enabled: true, games: [{ gameId: 'nlhe', betting: 'no-limit' }, { gameId: 'razz', betting: 'fixed-limit' }], hands: 0, pickSeconds: 20 };
    render(<SettingsDialog view={viewOf(settings)} onClose={() => {}} />);
    fireEvent.change(mode(), { target: { value: 'one' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(sentPatch()?.game).toMatchObject({ dealersChoice: { enabled: false } });
  });

  it("switching to Dealer's choice sends the rotation switch too, so a mix queued earlier in the hand can't clash", () => {
    render(<SettingsDialog view={viewOf(defaultSettings('cash'))} onClose={() => {}} />);
    fireEvent.change(mode(), { target: { value: 'choice' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(sentPatch()?.game).toMatchObject({
      rotation: { enabled: false },
      dealersChoice: { enabled: true },
    });
  });

  it('lets the host type a pick time over the old one, and keeps it at least 10 seconds', () => {
    render(<SettingsDialog view={viewOf(defaultSettings('cash'))} onClose={() => {}} />);
    fireEvent.change(mode(), { target: { value: 'choice' } });
    const field = screen.getByLabelText(/Time to pick/) as HTMLInputElement;
    fireEvent.change(field, { target: { value: '3' } });
    expect(field.value).toBe('3');
    fireEvent.change(field, { target: { value: '30' } });
    expect(field.value).toBe('30');
    fireEvent.change(field, { target: { value: '4' } });
    fireEvent.blur(field);
    expect(field.value).toBe('10');
  });
});

describe("Table settings: the ante when switching to or from Dealer's choice (#414)", () => {
  beforeEach(() => {
    call.mockReset();
    call.mockResolvedValue({});
  });
  /** A table that plays Dealer's choice with the 8-Game menu and a stud ante of 4 for everyone. */
  const choiceTable = () => {
    const s = defaultSettings('cash');
    s.game.dealersChoice = { enabled: true, games: DEFAULT_MENU, hands: 0, pickSeconds: 20 };
    s.stakes = { ...s.stakes, ante: 4, anteType: 'per-player', bringIn: 1 };
    return s;
  };
  const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  /** The table's settings with what the dialog sent applied: the server must accept them. */
  const merge = (base: unknown, patch: unknown): unknown =>
    patch && typeof patch === 'object' && !Array.isArray(patch) && base && typeof base === 'object' && !Array.isArray(base)
      ? Object.fromEntries(
          [...new Set([...Object.keys(base), ...Object.keys(patch)])].map((k) => [
            k,
            merge((base as Record<string, unknown>)[k], (patch as Record<string, unknown>)[k]),
          ]),
        )
      : patch === undefined
        ? base
        : patch;
  const savedFrom = (settings: TableSettings) => parseSettings(merge(settings, sentPatch() ?? {}));
  const stakesTab = () => fireEvent.click(screen.getByRole('button', { name: 'Stakes' }));
  const gameTab = () => fireEvent.click(screen.getByRole('button', { name: 'Game' }));

  it("leaving a Dealer's choice table with stud games for Hold'em takes the stud ante off", () => {
    const settings = choiceTable();
    render(<SettingsDialog view={viewOf(settings)} onClose={() => {}} />);
    fireEvent.change(mode(), { target: { value: 'one' } });
    save();
    expect(savedFrom(settings).stakes).toMatchObject({ ante: 0, anteType: 'none' });
  });

  it("a look at One game and back keeps the table's own stud ante", () => {
    const settings = choiceTable();
    render(<SettingsDialog view={viewOf(settings)} onClose={() => {}} />);
    fireEvent.change(mode(), { target: { value: 'one' } });
    fireEvent.change(mode(), { target: { value: 'choice' } });
    save();
    expect(savedFrom(settings).stakes).toMatchObject({ ante: 4, anteType: 'per-player' });
    expect(sentPatch()?.stakes).toBeUndefined();
  });

  it("changing the ante in Dealer's choice and going back to One game leaves settings the server accepts", () => {
    const settings = defaultSettings('cash');
    render(<SettingsDialog view={viewOf(settings)} onClose={() => {}} />);
    fireEvent.change(mode(), { target: { value: 'choice' } });
    stakesTab();
    fireEvent.change(screen.getByLabelText('Ante'), { target: { value: '2' } });
    gameTab();
    fireEvent.change(mode(), { target: { value: 'one' } });
    save();
    // The ante was for the stud games on the menu; Hold'em on its own goes back to no ante.
    expect(savedFrom(settings).stakes).toMatchObject({ ante: 0, anteType: 'none' });
  });

  it("a Hold'em table's own ante comes back after a look at a menu without stud", () => {
    const settings = defaultSettings('cash');
    settings.stakes = { ...settings.stakes, ante: 2, anteType: 'big-blind' };
    render(<SettingsDialog view={viewOf(settings)} onClose={() => {}} />);
    fireEvent.change(mode(), { target: { value: 'choice' } });
    fireEvent.click(screen.getByRole('button', { name: CHOICE_FILLS.find((f) => f.id === 'flop')!.name }));
    fireEvent.change(mode(), { target: { value: 'one' } });
    save();
    expect(savedFrom(settings).stakes).toMatchObject({ ante: 2, anteType: 'big-blind' });
    expect(sentPatch()?.stakes).toBeUndefined();
  });

  it("a HORSE rotation switched off for one Hold'em game takes the stud ante off, and switching back puts it back", () => {
    const settings = defaultSettings('cash');
    settings.game.rotation = {
      enabled: true,
      steps: CHOICE_FILLS.find((f) => f.id === 'horse')!.games.map((g) => ({ ...g, length: 1, unit: 'orbits' as const })),
    };
    settings.stakes = { ...settings.stakes, ante: 3, anteType: 'per-player', bringIn: 1 };
    render(<SettingsDialog view={viewOf(settings)} onClose={() => {}} />);
    fireEvent.change(mode(), { target: { value: 'one' } });
    save();
    expect(savedFrom(settings).stakes).toMatchObject({ ante: 0, anteType: 'none' });
    call.mockReset();
    call.mockResolvedValue({});
    fireEvent.change(mode(), { target: { value: 'rotate' } });
    save();
    expect(sentPatch()?.stakes).toBeUndefined();
  });

  /** Picks each way of choosing the game in turn. */
  const switchTo = (modes: string[]) => {
    for (const value of modes) fireEvent.change(mode(), { target: { value } });
  };
  /** A Hold'em table with a big-blind ante of 2. */
  const anteTable = () => {
    const s = defaultSettings('cash');
    s.stakes = { ...s.stakes, ante: 2, anteType: 'big-blind' };
    return s;
  };
  /** The same table with the blinds going up on a schedule, each level with an ante. */
  const scheduled = (s: TableSettings) => {
    s.blindSchedule = {
      ...s.blindSchedule,
      enabled: true,
      levels: [
        { smallBlind: 1, bigBlind: 2, ante: 4, minutes: 20, hands: 30 },
        { smallBlind: 2, bigBlind: 4, ante: 8, minutes: 20, hands: 30 },
      ],
    };
    return s;
  };
  const horseTable = () => {
    const s = defaultSettings('cash');
    s.game.rotation = { enabled: true, steps: CHOICE_FILLS.find((f) => f.id === 'horse')!.games.map((g) => ({ ...g, length: 1, unit: 'orbits' as const })) };
    s.stakes = { ...s.stakes, ante: 3, anteType: 'per-player', bringIn: 1 };
    return s;
  };

  it.each([[['choice', 'rotate']], [['choice', 'rotate', 'one']], [['rotate', 'choice', 'one']], [['choice', 'one', 'rotate', 'one']]])(
    "a Hold'em table's own ante survives a look at the other ways of choosing the game: %j",
    (modes) => {
      const settings = anteTable();
      render(<SettingsDialog view={viewOf(settings)} onClose={() => {}} />);
      switchTo(modes);
      save();
      expect(sentPatch()?.stakes).toBeUndefined();
    },
  );

  it("a table with no Limit bets doesn't keep the ones a look at Dealer's choice set up", () => {
    const settings = defaultSettings('cash');
    settings.stakes = { ...settings.stakes, smallBet: 0, bigBet: 0 };
    render(<SettingsDialog view={viewOf(settings)} onClose={() => {}} />);
    switchTo(['choice', 'rotate']);
    save();
    expect(sentPatch()?.stakes).toBeUndefined();
  });

  it.each([[['one', 'rotate', 'choice']], [['rotate', 'one', 'rotate', 'choice']]])(
    "a Dealer's choice table's own stud ante survives a longer look: %j",
    (modes) => {
      const settings = choiceTable();
      render(<SettingsDialog view={viewOf(settings)} onClose={() => {}} />);
      switchTo(modes);
      save();
      expect(sentPatch()?.stakes).toBeUndefined();
    },
  );

  it("a HORSE rotation's stud ante stays when the table goes to Dealer's choice by way of One game", () => {
    const settings = horseTable();
    render(<SettingsDialog view={viewOf(settings)} onClose={() => {}} />);
    switchTo(['one', 'choice']);
    save();
    expect(savedFrom(settings).stakes).toMatchObject({ ante: 3, anteType: 'per-player' });
  });

  it.each([
    ["a Dealer's choice table going to One game", () => scheduled(choiceTable()), () => switchTo(['one'])],
    [
      "a Dealer's choice menu losing its stud games",
      () => scheduled(choiceTable()),
      () => fireEvent.click(screen.getByRole('button', { name: CHOICE_FILLS.find((f) => f.id === 'flop')!.name })),
    ],
    ['a HORSE rotation going to One game', () => scheduled(horseTable()), () => switchTo(['one'])],
  ])("with the blinds on a schedule, %s takes the levels' antes off too, so the server accepts it", (_, table, act) => {
    const settings = table();
    render(<SettingsDialog view={viewOf(settings)} onClose={() => {}} />);
    act();
    save();
    const saved = savedFrom(settings);
    expect(saved.stakes).toMatchObject({ ante: 0, anteType: 'none' });
    expect(saved.blindSchedule.levels.map((l) => l.ante)).toEqual([0, 0]);
  });

  it("with the blinds on a schedule, a look at One game and back puts the levels' antes back", () => {
    const settings = scheduled(choiceTable());
    render(<SettingsDialog view={viewOf(settings)} onClose={() => {}} />);
    switchTo(['one', 'choice']);
    save();
    expect(sentPatch()?.stakes).toBeUndefined();
    expect(sentPatch()?.blindSchedule).toBeUndefined();
  });

  it("a Hold'em table's own ante comes back after a look at a standard mix", () => {
    const settings = anteTable();
    render(<SettingsDialog view={viewOf(settings)} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: MIXED_GAMES.find((m) => m.id === 'horse')!.name }));
    switchTo(['one']);
    save();
    expect(savedFrom(settings).stakes).toMatchObject({ ante: 2, anteType: 'big-blind' });
  });

  it("picking a stud game on the way doesn't lose a Dealer's choice table's own stud ante", () => {
    const settings = choiceTable();
    settings.stakes.ante = 40;
    render(<SettingsDialog view={viewOf(settings)} onClose={() => {}} />);
    switchTo(['one']);
    fireEvent.change(screen.getByLabelText('Game'), { target: { value: 'razz' } });
    switchTo(['choice']);
    save();
    expect(savedFrom(settings).stakes).toMatchObject({ ante: 40, anteType: 'per-player' });
  });

  it("a preset loaded after a switch is where switching back starts from, not the table's old stakes", () => {
    const settings = anteTable();
    // A Dealer's choice preset with the very stakes the switch to Dealer's choice sets up at this table.
    const preset = choiceTable();
    preset.stakes = stakesForMenu(settings.stakes, DEFAULT_MENU, [settings.game]);
    presetList.splice(0, presetList.length, { name: 'Stud night', json: exportPreset(preset, 'Stud night') });
    try {
      render(<SettingsDialog view={viewOf(settings)} onClose={() => {}} />);
      switchTo(['choice']);
      fireEvent.click(screen.getByRole('button', { name: 'Presets' }));
      fireEvent.click(screen.getByRole('button', { name: 'Load' }));
      gameTab();
      switchTo(['one']);
      save();
      // The preset's stud ante comes off for Hold'em on its own, rather than the table's ante from before the preset coming back.
      expect(savedFrom(settings).stakes).toMatchObject({ ante: 0, anteType: 'none' });
    } finally {
      presetList.length = 0;
    }
  });

  /** Types an amount into a Stakes field, then goes back to the Game tab. */
  const typeStake = (label: string, value: number) => {
    stakesTab();
    // Some labels carry a hint after the name, so match the name at the start.
    const field = screen.queryByLabelText(label) ?? screen.getByLabelText(new RegExp(`^${label}`));
    fireEvent.change(field, { target: { value: String(value) } });
    gameTab();
  };
  const fill = (id: string) => fireEvent.click(screen.getByRole('button', { name: CHOICE_FILLS.find((f) => f.id === id)!.name }));
  const mix = (id: string) => fireEvent.click(screen.getByRole('button', { name: MIXED_GAMES.find((m) => m.id === id)!.name }));

  it.each([
    ["Limit bets typed in Dealer's choice", () => (switchTo(['choice']), typeStake('Limit small bet', 3), typeStake('Limit big bet', 6), switchTo(['one', 'choice'])), { smallBet: 3, bigBet: 6 }],
    ["an ante typed in Dealer's choice", () => (switchTo(['choice']), typeStake('Ante', 5), fill('horse'), fill('8-game')), { ante: 5, anteType: 'per-player' }],
    ['an ante typed in a rotation', () => (switchTo(['rotate']), typeStake('Ante', 2), switchTo(['one', 'rotate'])), { ante: 2, anteType: 'per-player' }],
    ['blinds typed in a rotation', () => (switchTo(['rotate']), typeStake('Big blind', 10), typeStake('Small blind', 5), switchTo(['one', 'rotate'])), { smallBlind: 5, bigBlind: 10 }],
    ["a bring-in typed in Dealer's choice", () => (switchTo(['choice']), typeStake('Stud bring-in', 2), switchTo(['one', 'choice'])), { bringIn: 2 }],
  ])('what the host types stays, however many switches come after: %s', (_, steps, expected) => {
    const settings = defaultSettings('cash');
    render(<SettingsDialog view={viewOf(settings)} onClose={() => {}} />);
    steps();
    save();
    expect(savedFrom(settings).stakes).toMatchObject(expected);
  });

  it('new blinds count when the stakes for the other games are worked out', () => {
    const settings = defaultSettings('cash');
    settings.stakes = { ...settings.stakes, smallBet: 0, bigBet: 0 };
    render(<SettingsDialog view={viewOf(settings)} onClose={() => {}} />);
    switchTo(['choice', 'one']);
    typeStake('Big blind', 100);
    typeStake('Small blind', 50);
    switchTo(['choice']);
    save();
    expect(savedFrom(settings).stakes).toMatchObject({ smallBet: 100, bigBet: 200, ante: 25, anteType: 'per-player', bringIn: 33 });
  });

  it.each([
    ['a HORSE rotation, One game, then HORSE again', () => horseTable(), () => (switchTo(['one']), mix('horse'))],
    ['the same with the blinds on a schedule', () => scheduled(horseTable()), () => (switchTo(['one']), mix('horse'))],
    ["a Dealer's choice table, One game, then Dealer's choice by way of a picked stud game", () => choiceTable(), () => (switchTo(['one']), fireEvent.change(screen.getByLabelText('Game'), { target: { value: 'razz' } }), switchTo(['choice']))],
  ])("a stud mix or game picked on the way back gets the table's own ante: %s", (_, table, steps) => {
    const settings = table();
    render(<SettingsDialog view={viewOf(settings)} onClose={() => {}} />);
    steps();
    save();
    expect(savedFrom(settings).stakes).toMatchObject({ ante: settings.stakes.ante, anteType: 'per-player' });
    expect(sentPatch()?.blindSchedule).toBeUndefined();
  });

  it("a Dealer's choice table's own ante comes back through Rotate and a HORSE mix", () => {
    const settings = choiceTable();
    settings.stakes.ante = 40;
    render(<SettingsDialog view={viewOf(settings)} onClose={() => {}} />);
    switchTo(['rotate']);
    mix('horse');
    save();
    expect(savedFrom(settings).stakes).toMatchObject({ ante: 40, anteType: 'per-player' });
  });

  it("a level added on the way keeps the others' antes, and comes back following the level before (#426)", () => {
    const settings = scheduled(choiceTable());
    render(<SettingsDialog view={viewOf(settings)} onClose={() => {}} />);
    switchTo(['one']);
    stakesTab();
    fireEvent.click(screen.getByRole('button', { name: 'Add level' }));
    gameTab();
    switchTo(['choice']);
    save();
    const saved = savedFrom(settings);
    expect(saved.stakes).toMatchObject({ ante: 4, anteType: 'per-player' });
    // Added with no ante while the ante was off, it gets the one Add level gives it now, double the level before's:
    // with none, the stud games at that level would have no ante.
    expect(saved.blindSchedule.levels.map((l) => l.ante)).toEqual([4, 8, 16]);
  });

  it("a Hold'em table's big-blind ante and level antes stay when a level is added during a look at Dealer's choice", () => {
    const settings = anteTable();
    scheduled(settings).blindSchedule.levels = settings.blindSchedule.levels.map((l, i) => ({ ...l, ante: [2, 4][i] }));
    render(<SettingsDialog view={viewOf(settings)} onClose={() => {}} />);
    switchTo(['choice']);
    stakesTab();
    fireEvent.click(screen.getByRole('button', { name: 'Add level' }));
    gameTab();
    switchTo(['one']);
    save();
    const saved = savedFrom(settings);
    expect(saved.stakes).toMatchObject({ ante: 2, anteType: 'big-blind' });
    expect(saved.blindSchedule.levels.map((l) => l.ante)).toEqual([2, 4, 8]);
  });

  it('a schedule turned on in Dealer\'s choice loses its ante with the stud games, so the server accepts it', () => {
    const settings = defaultSettings('cash');
    render(<SettingsDialog view={viewOf(settings)} onClose={() => {}} />);
    switchTo(['choice']);
    stakesTab();
    fireEvent.click(screen.getByLabelText('Raise the blinds on a schedule'));
    gameTab();
    fill('horse');
    switchTo(['one']);
    save();
    const saved = savedFrom(settings);
    expect(saved.stakes).toMatchObject({ ante: 0, anteType: 'none' });
    expect(saved.blindSchedule.levels.every((l) => l.ante === 0)).toBe(true);
  });

  it("a bring-in typed for a mix can't end up above the small bet the table goes back to", () => {
    const settings = defaultSettings('cash');
    settings.game.dealersChoice = { enabled: true, games: CHOICE_FILLS.find((f) => f.id === 'flop')!.games.filter((g) => g.betting !== 'fixed-limit'), hands: 0, pickSeconds: 20 };
    settings.stakes = { ...settings.stakes, smallBlind: 5, bigBlind: 10 };
    render(<SettingsDialog view={viewOf(settings)} onClose={() => {}} />);
    switchTo(['one']);
    mix('horse');
    typeStake('Stud bring-in', 5);
    switchTo(['choice']);
    save();
    const saved = savedFrom(settings);
    expect(saved.stakes.bringIn).toBeLessThanOrEqual(saved.stakes.smallBet);
  });

  /** A Seven Card Stud table at No limit, with a bring-in above the Limit small bet it never uses. */
  const noLimitStud = () => {
    const s = defaultSettings('cash');
    s.game = { ...s.game, gameId: 'stud', betting: 'no-limit' };
    s.table.maxSeats = 8;
    s.stakes = { ...s.stakes, ante: 2, anteType: 'per-player', bringIn: 5, smallBet: 2, bigBet: 4 };
    return s;
  };

  it.each([[['rotate']], [['rotate', 'one']]])("a no-limit stud table's bring-in stays through a look at other ways of choosing the game: %j", (modes) => {
    const settings = noLimitStud();
    render(<SettingsDialog view={viewOf(settings)} onClose={() => {}} />);
    switchTo(modes);
    save();
    expect(sentPatch()?.stakes).toBeUndefined();
  });

  it('what the host typed before the first switch counts as theirs', () => {
    const settings = noLimitStud();
    render(<SettingsDialog view={viewOf(settings)} onClose={() => {}} />);
    typeStake('Limit small bet', 3);
    typeStake('Stud bring-in', 5);
    switchTo(['rotate', 'one']);
    save();
    expect(savedFrom(settings).stakes).toMatchObject({ smallBet: 3, bringIn: 5 });
  });

  it("picking another blind game at a table with no small blind leaves it with none", () => {
    const settings = defaultSettings('cash');
    settings.stakes = { ...settings.stakes, smallBlind: 0, bigBlind: 10 };
    render(<SettingsDialog view={viewOf(settings)} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Game'), { target: { value: 'plo4' } });
    save();
    expect(sentPatch()?.stakes).toBeUndefined();
  });

  it("a schedule turned on and off during a look at Dealer's choice has no ante left once the ante comes off", () => {
    const settings = defaultSettings('cash');
    render(<SettingsDialog view={viewOf(settings)} onClose={() => {}} />);
    const schedule = () => (stakesTab(), fireEvent.click(screen.getByLabelText('Raise the blinds on a schedule')), gameTab());
    switchTo(['choice']);
    schedule();
    schedule();
    switchTo(['one']);
    schedule();
    save();
    const saved = savedFrom(settings);
    expect(saved.stakes).toMatchObject({ ante: 0, anteType: 'none' });
    expect(saved.blindSchedule.levels.every((l) => l.ante === 0)).toBe(true);
  });

  /** Takes the first level off the schedule. */
  const removeFirstLevel = () => (stakesTab(), fireEvent.click(screen.getAllByRole('button', { name: '✕' })[0]), gameTab());
  /** Three levels, with these antes. */
  const threeLevels = (s: TableSettings, antes: number[]) => {
    s.blindSchedule = {
      ...s.blindSchedule,
      enabled: true,
      levels: antes.map((ante, i) => ({ smallBlind: i + 1, bigBlind: 2 * (i + 1), ante, minutes: 20, hands: 30 })),
    };
    return s;
  };

  it("a level taken off during a look keeps the other levels' antes with their levels", () => {
    const settings = threeLevels(choiceTable(), [4, 8, 12]);
    render(<SettingsDialog view={viewOf(settings)} onClose={() => {}} />);
    switchTo(['one']);
    removeFirstLevel();
    switchTo(['choice']);
    save();
    expect(savedFrom(settings).blindSchedule.levels.map((l) => [l.bigBlind, l.ante])).toEqual([[4, 8], [6, 12]]);
  });

  it("a level taken off during a look at Dealer's choice doesn't count as a change of the Hold'em table's ante", () => {
    const settings = threeLevels(anteTable(), [2, 4, 6]);
    render(<SettingsDialog view={viewOf(settings)} onClose={() => {}} />);
    switchTo(['choice']);
    removeFirstLevel();
    switchTo(['one']);
    save();
    const saved = savedFrom(settings);
    expect(saved.stakes).toMatchObject({ ante: 2, anteType: 'big-blind' });
    expect(saved.blindSchedule.levels.map((l) => l.ante)).toEqual([4, 6]);
  });

  it('a level added after an earlier look keeps its ante through the next look', () => {
    const settings = scheduled(choiceTable());
    render(<SettingsDialog view={viewOf(settings)} onClose={() => {}} />);
    switchTo(['one', 'choice']);
    stakesTab();
    fireEvent.click(screen.getByRole('button', { name: 'Add level' }));
    gameTab();
    switchTo(['one', 'choice']);
    save();
    expect(savedFrom(settings).blindSchedule.levels.map((l) => l.ante)).toEqual([4, 8, 16]);
  });

  /** Takes the rotation's step at `i` off. */
  const removeStep = (i: number) => fireEvent.click(screen.getAllByRole('button', { name: '✕' })[i]);

  it('taking the stud games out of a HORSE rotation takes the stud ante off, however the host got there', () => {
    for (const before of [[], ['one', 'rotate']]) {
      const settings = horseTable();
      const { unmount } = render(<SettingsDialog view={viewOf(settings)} onClose={() => {}} />);
      call.mockReset();
      call.mockResolvedValue({});
      switchTo(before);
      // Limit Hold'em, Omaha Hi-Lo, Razz, Stud, Stud Hi-Lo: take the last three off.
      for (let n = 0; n < 3; n++) removeStep(2);
      save();
      expect(savedFrom(settings).stakes).toMatchObject({ ante: 0, anteType: 'none' });
      unmount();
    }
  });

  it("changing a Hold'em rotation's game to stud puts the stud ante on", () => {
    const settings = defaultSettings('cash');
    settings.game.rotation = { enabled: true, steps: [{ gameId: 'nlhe', betting: 'no-limit', length: 1, unit: 'orbits' }, { gameId: 'plo4', betting: 'pot-limit', length: 1, unit: 'orbits' }] };
    settings.table.maxSeats = 8;
    render(<SettingsDialog view={viewOf(settings)} onClose={() => {}} />);
    fireEvent.change(screen.getAllByDisplayValue('Omaha')[0], { target: { value: 'stud' } });
    save();
    expect(savedFrom(settings).stakes.anteType).toBe('per-player');
    expect(savedFrom(settings).stakes.ante).toBeGreaterThan(0);
  });

  it('a bring-in typed with Limit bets of 0 comes down to the small bet the Limit games get', () => {
    const settings = defaultSettings('cash');
    render(<SettingsDialog view={viewOf(settings)} onClose={() => {}} />);
    switchTo(['choice', 'one']);
    typeStake('Limit small bet', 0);
    typeStake('Limit big bet', 0);
    typeStake('Stud bring-in', 3);
    switchTo(['choice']);
    save();
    const saved = savedFrom(settings);
    expect(saved.stakes.bringIn).toBeLessThanOrEqual(saved.stakes.smallBet);
  });

  it("a change someone else saves while the dialog is open isn't undone by this host's save", () => {
    const settings = defaultSettings('cash');
    const during = { ...viewOf(settings), hand: { phase: 'betting' }, pendingSettings: null } as unknown as TableView;
    const { rerender } = render(<SettingsDialog view={during} onClose={() => {}} />);
    // A co-host raises the blinds for the next hand.
    rerender(<SettingsDialog view={{ ...during, pendingSettings: { stakes: { smallBlind: 5, bigBlind: 10 } } } as unknown as TableView} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Table name'), { target: { value: 'Renamed' } });
    save();
    expect(sentPatch()).toEqual({ table: { name: 'Renamed' } });
  });

  it("a standard mix's button works the stud ante out from the mix's own Limit bets, on the levels too", () => {
    const settings = defaultSettings('cash');
    settings.stakes = { ...settings.stakes, smallBet: 20, bigBet: 40 };
    threeLevels(settings, [0, 0, 0]);
    render(<SettingsDialog view={viewOf(settings)} onClose={() => {}} />);
    mix('horse');
    save();
    const saved = savedFrom(settings);
    // The mix bets the big blind and twice it: about a quarter of the small bet of 2, not of the old 20.
    expect(saved.stakes).toMatchObject({ smallBet: 2, bigBet: 4, ante: 1, anteType: 'per-player' });
    expect(saved.blindSchedule.levels.map((l) => l.ante)).toEqual([1, 1, 2]);
  });

  it('turning the schedule on at a stud table gives its levels with no ante a stud ante', () => {
    const settings = defaultSettings('cash');
    settings.game = { ...settings.game, gameId: 'razz', betting: 'fixed-limit' };
    settings.table.maxSeats = 8;
    settings.stakes = { ...settings.stakes, ante: 1, anteType: 'per-player', bringIn: 1 };
    threeLevels(settings, [0, 0, 0]).blindSchedule.enabled = false;
    render(<SettingsDialog view={viewOf(settings)} onClose={() => {}} />);
    stakesTab();
    fireEvent.click(screen.getByLabelText('Raise the blinds on a schedule'));
    save();
    expect(savedFrom(settings).blindSchedule.levels.map((l) => l.ante)).toEqual([1, 1, 2]);
  });

  it("changing the one game's betting to Limit brings a bring-in above the small bet down to fit", () => {
    const settings = defaultSettings('cash');
    settings.stakes = { ...settings.stakes, smallBet: 4, bigBet: 8, bringIn: 10 };
    render(<SettingsDialog view={viewOf(settings)} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Betting'), { target: { value: 'fixed-limit' } });
    save();
    expect(savedFrom(settings).stakes).toMatchObject({ smallBet: 4, bringIn: 1 });
  });

  describe('a second save in the same hand', () => {
    /** Saves in the dialog during a hand, with `pending` already waiting for the next hand, and returns what waits after. */
    const saveDuringHand = (settings: TableSettings, pending: SettingsPatch | null, act: () => void): SettingsPatch => {
      call.mockReset();
      call.mockResolvedValue({});
      const view = { ...viewOf(settings), hand: { phase: 'betting' }, pendingSettings: pending } as unknown as TableView;
      const { unmount } = render(<SettingsDialog view={view} onClose={() => {}} />);
      act();
      save();
      const patch = sentPatch() as SettingsPatch;
      unmount();
      return pending ? mergePatches(pending, patch) : patch;
    };

    it("starts from the change that waits, so the stud games of a menu picked after it get their ante", () => {
      const settings = choiceTable();
      const first = saveDuringHand(settings, null, () => switchTo(['one']));
      // Opened again: the dialog shows what the next hand will deal.
      const both = saveDuringHand(settings, first, () => {
        expect(mode()).toHaveProperty('value', 'one');
        switchTo(['choice']);
        fill('horse');
      });
      const next = applyAtNextHand(settings, both).settings;
      expect(next.game.dealersChoice).toMatchObject({ enabled: true, games: CHOICE_FILLS.find((f) => f.id === 'horse')!.games });
      expect(next.stakes.anteType).toBe('per-player');
      expect(next.stakes.ante).toBeGreaterThan(0);
    });

    it("a Hold'em table that saved a switch to Dealer's choice and then picks Rotate deals Hold'em with no ante", () => {
      const settings = defaultSettings('cash');
      const first = saveDuringHand(settings, null, () => switchTo(['choice']));
      expect(applyAtNextHand(settings, first).settings.stakes.anteType).toBe('per-player');
      const both = saveDuringHand(settings, first, () => switchTo(['rotate']));
      const next = applyAtNextHand(settings, both).settings;
      expect(next.game.rotation).toMatchObject({ enabled: true, steps: [{ gameId: 'nlhe' }] });
      expect(next.stakes).toMatchObject({ ante: 0, anteType: 'none' });
    });
  });

  describe("with the blinds on a schedule whose levels have no ante (#426)", () => {
    /** A Hold'em table at 25/50 whose blinds go up on a schedule with no antes, as most Hold'em schedules are. */
    const noAnteSchedule = (s = defaultSettings('cash')) => {
      s.stakes = { ...s.stakes, smallBlind: 25, bigBlind: 50, smallBet: 50, bigBet: 100 };
      s.blindSchedule = {
        ...s.blindSchedule,
        enabled: true,
        levels: [
          { smallBlind: 25, bigBlind: 50, ante: 0, minutes: 20, hands: 30 },
          { smallBlind: 50, bigBlind: 100, ante: 0, minutes: 20, hands: 30 },
          { smallBlind: 100, bigBlind: 200, ante: 0, minutes: 20, hands: 30 },
        ],
      };
      return s;
    };
    const pick = (gameId: string) => fireEvent.change(screen.getByLabelText('Game'), { target: { value: gameId } });

    it.each([
      ["Dealer's choice with the 8-Game menu", () => switchTo(['choice'])],
      ['the HORSE mix', () => mix('horse')],
      ['a stud game', () => pick('stud')],
      ["a menu without stud, then the 8-Game menu", () => (switchTo(['choice']), fill('flop'), fill('8-game'))],
    ])("switching to %s puts a stud ante on each level, for its own blinds", (_, act) => {
      const settings = noAnteSchedule();
      render(<SettingsDialog view={viewOf(settings)} onClose={() => {}} />);
      act();
      save();
      const saved = savedFrom(settings);
      expect(saved.stakes).toMatchObject({ ante: 13, anteType: 'per-player' });
      // While the schedule is on, each level's ante is the one posted: about a quarter of the level's small bet.
      expect(saved.blindSchedule.levels.map((l) => l.ante)).toEqual([13, 25, 50]);
    });

    it('a stud table with no ante that picks another stud game gets the stud ante on its levels too', () => {
      const settings = noAnteSchedule();
      settings.game = { ...settings.game, gameId: 'stud', betting: 'fixed-limit' };
      settings.table.maxSeats = 8;
      settings.stakes = { ...settings.stakes, smallBlind: 0, bringIn: 15 };
      render(<SettingsDialog view={viewOf(settings)} onClose={() => {}} />);
      pick('razz');
      save();
      const saved = savedFrom(settings);
      expect(saved.stakes).toMatchObject({ ante: 13, anteType: 'per-player' });
      expect(saved.blindSchedule.levels.map((l) => l.ante)).toEqual([13, 25, 50]);
    });

    it.each([[['choice', 'one']], [['rotate', 'choice', 'one']]])('a look at the stud games and back leaves the levels as they were: %j', (modes) => {
      const settings = noAnteSchedule();
      render(<SettingsDialog view={viewOf(settings)} onClose={() => {}} />);
      switchTo(modes);
      save();
      expect(sentPatch()?.stakes).toBeUndefined();
      expect(sentPatch()?.blindSchedule).toBeUndefined();
    });

    it('the antes typed for the levels in Dealer\'s choice stay through a change of menu', () => {
      const settings = noAnteSchedule();
      render(<SettingsDialog view={viewOf(settings)} onClose={() => {}} />);
      switchTo(['choice']);
      stakesTab();
      fireEvent.change(screen.getAllByRole('spinbutton').filter((el) => el.closest('.list-editor'))[2], { target: { value: '10' } });
      gameTab();
      fill('horse');
      save();
      expect(savedFrom(settings).blindSchedule.levels.map((l) => l.ante)).toEqual([10, 25, 50]);
    });
  });
});

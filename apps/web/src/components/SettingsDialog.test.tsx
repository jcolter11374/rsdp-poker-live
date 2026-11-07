// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings, exportPreset, parseSettings, type TableSettings } from '@rsdp/engine/settings';
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

  it("a level added on the way keeps the others' antes, and comes back without one", () => {
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
    expect(saved.blindSchedule.levels.map((l) => l.ante)).toEqual([4, 8, 0]);
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
});

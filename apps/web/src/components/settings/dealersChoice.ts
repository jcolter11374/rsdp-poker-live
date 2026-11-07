import { MAX_CHIPS, SETTINGS_LIMITS, type BlindLevel, type ChoiceGame, type DealersChoiceSettings, type TableSettings } from '@rsdp/engine/settings';
import { getVariant, MIXED_GAMES, VARIANT_LIST } from '@rsdp/engine/variants';
import { defaultStudAnte, studBringIn } from '../../format';
import { doubled } from './lists';

/** Dealer's choice settings, filled in for tables saved before it existed (D33). */
export const choiceOf = (settings: TableSettings): DealersChoiceSettings => settings.game.dealersChoice ?? { enabled: false, games: [], hands: 0, pickSeconds: 20 };

const fromMix = (id: string) => MIXED_GAMES.find((m) => m.id === id)!.steps.map((st) => ({ gameId: st.gameId, betting: st.betting }));

/** One-tap menus. HORSE and 8-Game fill the menu with their games; they aren't a single pick (D33, decision 8). */
export const CHOICE_FILLS: { id: string; name: string; games: ChoiceGame[] }[] = [
  { id: '8-game', name: 'The 8-Game games', games: fromMix('8-game') },
  { id: 'horse', name: 'The HORSE games', games: fromMix('horse') },
  {
    id: 'flop',
    name: "Hold'em and Omaha",
    games: [
      { gameId: 'nlhe', betting: 'no-limit' },
      { gameId: 'nlhe', betting: 'fixed-limit' },
      { gameId: 'plo4', betting: 'pot-limit' },
      { gameId: 'plo8', betting: 'pot-limit' },
    ],
  },
  { id: 'all', name: 'Every game', games: VARIANT_LIST.map((v) => ({ gameId: v.id, betting: v.defaultBetting })) },
];

/** The menu a new Dealer's choice table starts with: the 8-Game games. */
export const DEFAULT_MENU: ChoiceGame[] = CHOICE_FILLS[0].games;

export const isStud = (gameId: string) => getVariant(gameId).forcedBets === 'ante-bring-in';

/** Most players the menu's biggest game seats: the table can have that many seats. */
export const menuSeats = (games: readonly ChoiceGame[]) => (games.length ? Math.max(...games.map((g) => getVariant(g.gameId).maxPlayers)) : SETTINGS_LIMITS.maxSeats.max);

/** The same game and betting twice: the server refuses it. */
export const repeatsOf = (games: readonly ChoiceGame[]) => games.flatMap((g, i) => (games.findIndex((x) => x.gameId === g.gameId && x.betting === g.betting) < i ? [i] : []));

/** A game not on the menu yet, for "Add game": the first in the list, with its usual betting. */
export function nextMenuGame(games: readonly ChoiceGame[]): ChoiceGame | null {
  for (const v of VARIANT_LIST) if (!games.some((g) => g.gameId === v.id && g.betting === v.defaultBetting)) return { gameId: v.id, betting: v.defaultBetting };
  return null;
}

/** The stakes stakesForMenu may change, in the groups that change together: the ante and who antes, the two Limit bets. */
export const MENU_STAKE_GROUPS = [['smallBlind'], ['smallBet', 'bigBet'], ['ante', 'anteType'], ['bringIn']] as const;

/**
 * The stakes a menu needs, as for HORSE: Limit bets of the big blind and twice it when a Limit game is added and
 * none are set, a small blind when the first blind game goes on (a table that already deals blind games keeps the
 * small blind it has, even none), and the stud ante and bring-in when the first stud game goes on (in place of any
 * other ante: with stud on the menu, only the stud games ante, D29). When the last stud game comes off, so does that
 * ante (no ante): it would be posted in every blind game instead. stakesForGames uses it for each part of the stakes,
 * with `before` the games that part's own value was for.
 */
export function stakesForMenu(stakes: TableSettings['stakes'], games: readonly ChoiceGame[], before: readonly ChoiceGame[]): TableSettings['stakes'] {
  const next = { ...stakes };
  if (games.some((g) => g.betting === 'fixed-limit') && next.smallBet < 1) {
    next.smallBet = Math.max(1, next.bigBlind);
    next.bigBet = next.smallBet * 2;
  }
  const blinds = (gs: readonly ChoiceGame[]) => gs.some((g) => !isStud(g.gameId));
  if (blinds(games) && !blinds(before) && next.smallBlind === 0 && next.bigBlind > 1) next.smallBlind = Math.floor(next.bigBlind / 2);
  const stud = games.some((g) => isStud(g.gameId));
  if (stud && !before.some((g) => isStud(g.gameId))) {
    next.ante = defaultStudAnte(next);
    next.anteType = 'per-player';
  }
  if (stud && next.bringIn === 0) next.bringIn = studBringIn(next.smallBet || next.bigBlind, next.centsMode);
  if (!stud && before.some((g) => isStud(g.gameId))) {
    next.ante = 0;
    next.anteType = 'none';
  }
  return next;
}

type Stakes = TableSettings['stakes'];
type Group = (typeof MENU_STAKE_GROUPS)[number];

/** One part of the stakes, from one set to another. */
const copyGroup = (to: Stakes, from: Stakes, group: Group) => {
  for (const k of group) (to as Record<string, unknown>)[k] = from[k];
};
const sameGroup = (a: Stakes, b: Stakes, group: Group) => group.every((k) => a[k] === b[k]);
const sameGames = (a: readonly ChoiceGame[], b: readonly ChoiceGame[]) => a.length === b.length && a.every((g, i) => g.gameId === b[i].gameId && g.betting === b[i].betting);
/** The same level antes on the levels both have: adding or taking off a level doesn't change the others' antes. */
const sameAntes = (a: readonly number[], b: readonly number[]) => a.every((x, i) => i >= b.length || x === b[i]);

/**
 * Where each part of the stakes stands in Table settings, so a change of the games dealt (switching how the game is
 * chosen, changing the menu, picking a game or a standard mix) can work each part out from the host's own value
 * (#414). `own` holds, for each of MENU_STAKE_GROUPS, the stakes with the table's or the host's own value of that
 * part and the games it was for; `ownAntes` are the blind schedule's level antes that go with the own ante. `auto`
 * and `autoAntes` are what the dialog last set, to tell the host's changes from its own.
 */
export type StakesStart = { own: { stakes: Stakes; games: readonly ChoiceGame[] }[]; ownAntes: readonly number[]; auto: Stakes; autoAntes: readonly number[] };

/** Where the stakes stand before any change of the games dealt: each part is the table's own, for the games it deals. */
export const stakesStart = (stakes: Stakes, antes: readonly number[], games: readonly ChoiceGame[]): StakesStart => ({
  own: MENU_STAKE_GROUPS.map(() => ({ stakes, games })),
  ownAntes: antes,
  auto: stakes,
  autoAntes: antes,
});

/**
 * The stud ante for a level of a blind schedule: about a quarter of the level's small bet, as `defaultStudAnte`
 * works it out for the Stakes tab. While the schedule is on, the level's ante is the one posted, and the server sizes
 * the level's Limit bets to its big blind (`cashHandStakes`: in step with the table's own big blind, or the level's
 * when the table has none), so the ante is worked out from those (#426). A level with no big blind (a stud schedule
 * that only raises the antes) has nothing to go by, and gets the Stakes tab's ante.
 */
export function levelStudAnte(stakes: Stakes, level: Pick<BlindLevel, 'bigBlind'>): number {
  if (level.bigBlind <= 0) return stakes.ante;
  const smallBet = stakes.bigBlind > 0 && stakes.smallBet > 0 ? Math.max(1, Math.round((stakes.smallBet * level.bigBlind) / stakes.bigBlind)) : 0;
  return Math.min(MAX_CHIPS, defaultStudAnte({ smallBet, bigBlind: level.bigBlind, centsMode: stakes.centsMode }));
}

/**
 * The stakes, and the blind schedule's level antes, for dealing `to` in place of `from` (#414).
 *
 * Each part of the stakes is worked out from its own value, the one the table had or the host last typed, for the
 * games it was for, with stakesForMenu (a stud ante goes on with the first stud game and comes off with the last;
 * Limit bets for a Limit game; a small blind for the first blind game). Coming back to those games gives that value
 * back, so a look at other games and back undoes itself, whichever way the host comes back (a standard mix's button
 * is the exception: it sets that mix's own Limit bets and bring-in, D29). A part the host changes becomes its own value
 * from then on. `start` is where the last call left things, or with none, `stakesStart` for
 * `stakes` and `from`; give the dialog's starting point there, so what the host typed before the first change counts
 * as theirs. `limit` says whether the settings deal a Limit game: one in `to`, or the table's one game, which the
 * server counts in a rotation or Dealer's choice too. The parts: the small blind; the two Limit bets; the ante, who antes
 * and the level antes; the bring-in. With no ante, no level of a schedule that's on has one either (the server
 * refuses that), nor does any level when the ante comes off. When the stud ante goes on, each level gets a stud
 * ante for its own blinds (`levelStudAnte`), in place of any it had: while the schedule is on, the level's ante is
 * the one posted, so a level with none would deal the stud games with no ante (#426).
 */
export function stakesForGames(
  stakes: Stakes,
  levels: readonly Pick<BlindLevel, 'bigBlind' | 'ante'>[],
  from: readonly ChoiceGame[],
  to: readonly ChoiceGame[],
  start: StakesStart | null,
  scheduleOn: boolean,
  limit = to.some((g) => g.betting === 'fixed-limit'),
): { stakes: Stakes; antes: number[]; start: StakesStart; studAnteOn: boolean } {
  const antes = levels.map((l) => l.ante);
  const s = start ?? stakesStart(stakes, antes, from);
  const changed = (group: Group) => !sameGroup(stakes, s.auto, group) || (group[0] === 'ante' && !sameAntes(antes, s.autoAntes));
  const own = MENU_STAKE_GROUPS.map((group, i) => (changed(group) ? { stakes, games: from } : s.own[i]));
  const ante = MENU_STAKE_GROUPS.findIndex((group) => group[0] === 'ante');
  const ownAntes = changed(MENU_STAKE_GROUPS[ante]) ? antes : s.ownAntes;
  // In order, so the stud ante and the bring-in are worked out from the new Limit bets.
  const next = { ...stakes };
  MENU_STAKE_GROUPS.forEach((group, i) => {
    const o = own[i];
    if (sameGames(to, o.games)) return copyGroup(next, o.stakes, group);
    const base = { ...next };
    copyGroup(base, o.stakes, group);
    copyGroup(next, stakesForMenu(base, to, o.games), group);
  });
  // With a Limit game dealt, the server refuses a bring-in above the small bet: one left above it comes down to fit,
  // unless the host typed both, the bring-in and the small bet it ends up with (changed them from the table's, or
  // from what the dialog set). The server then says what's wrong, rather than the dialog changing what they typed.
  const bets = MENU_STAKE_GROUPS.findIndex((group) => group[0] === 'smallBet');
  const bringIn = MENU_STAKE_GROUPS.findIndex((group) => group[0] === 'bringIn');
  const typedBoth = changed(MENU_STAKE_GROUPS[bets]) && changed(MENU_STAKE_GROUPS[bringIn]) && next.smallBet === own[bets].stakes.smallBet;
  if (limit && next.smallBet >= 1 && next.bringIn > next.smallBet && !typedBoth) next.bringIn = studBringIn(next.smallBet, next.centsMode);
  // The level antes go with the own ante. A level added since keeps its own, but one that still has the ante
  // "Add level" gave it, double the level before's, goes on following the level before.
  let nextAntes: number[] = [];
  antes.forEach((a, i) => nextAntes.push(i < ownAntes.length ? ownAntes[i] : i > 0 && a === doubled(antes[i - 1]) ? doubled(nextAntes[i - 1]) : a));
  if (next.anteType === 'none') {
    // No level of a schedule that's on may have an ante then (the server refuses that). With the schedule off, the
    // levels keep the antes they had with no ante, unless the ante comes off now; a level added since has none to keep.
    const off = scheduleOn || own[ante].stakes.anteType !== 'none';
    nextAntes = nextAntes.map((a, i) => (off || i >= ownAntes.length ? 0 : a));
  }
  // The stud ante went on (stakesForMenu, with the first stud game): the levels' antes go with it (#426).
  const studOn = next.anteType !== 'none' && studAnteOn(to, own[ante].games);
  if (studOn) nextAntes = levelStudAntes(next, levels);
  return { stakes: next, antes: nextAntes, start: { own, ownAntes, auto: next, autoAntes: nextAntes }, studAnteOn: studOn };
}

/** Whether stakesForMenu puts the stud ante on for dealing `to` in place of `before`: the first stud game goes on. */
const studAnteOn = (to: readonly ChoiceGame[], before: readonly ChoiceGame[]) => !sameGames(to, before) && to.some((g) => isStud(g.gameId)) && !before.some((g) => isStud(g.gameId));

/** A stud ante for each level of the blind schedule, for its own blinds (#426). */
export const levelStudAntes = (stakes: Stakes, levels: readonly Pick<BlindLevel, 'bigBlind'>[]) => levels.map((l) => levelStudAnte(stakes, l));

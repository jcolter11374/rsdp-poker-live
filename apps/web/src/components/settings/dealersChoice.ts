import { SETTINGS_LIMITS, type ChoiceGame, type DealersChoiceSettings, type TableSettings } from '@rsdp/engine/settings';
import { getVariant, MIXED_GAMES, VARIANT_LIST } from '@rsdp/engine/variants';
import { defaultStudAnte, studBringIn } from '../../format';

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
 * none are set, a small blind for the blind games, and the stud ante and bring-in when the first stud game goes
 * on (in place of any other ante: with stud on the menu, only the stud games ante, D29). When the last stud game
 * comes off, so does that ante (no ante): it would be posted in every blind game instead. Switching how the game is
 * chosen uses it too, with the games dealt before and after.
 */
export function stakesForMenu(stakes: TableSettings['stakes'], games: readonly ChoiceGame[], before: readonly ChoiceGame[]): TableSettings['stakes'] {
  const next = { ...stakes };
  if (games.some((g) => g.betting === 'fixed-limit') && next.smallBet < 1) {
    next.smallBet = Math.max(1, next.bigBlind);
    next.bigBet = next.smallBet * 2;
  }
  if (games.some((g) => !isStud(g.gameId)) && next.smallBlind === 0 && next.bigBlind > 1) next.smallBlind = Math.floor(next.bigBlind / 2);
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

/**
 * The stakes, and the blind schedule's level antes, for dealing `to` in place of `from` (#414).
 *
 * Each part of the stakes is worked out from its own value, the one the table had or the host last typed, for the
 * games it was for, with stakesForMenu (a stud ante goes on with the first stud game and comes off with the last;
 * Limit bets for a Limit game; a small blind for the blind games). Coming back to those games gives that value back
 * exactly, so a look at other games and back undoes itself, whichever way the host comes back. A part the host
 * changes becomes its own value from then on. The parts: the small blind; the two Limit bets; the ante, who antes
 * and the level antes; the bring-in. With no ante, no level of a schedule that's on has one either (the server
 * refuses that), nor does any level when the ante comes off.
 */
export function stakesForGames(
  stakes: Stakes,
  antes: readonly number[],
  from: readonly ChoiceGame[],
  to: readonly ChoiceGame[],
  start: StakesStart | null,
  scheduleOn: boolean,
): { stakes: Stakes; antes: number[]; start: StakesStart } {
  const s = start ?? { own: MENU_STAKE_GROUPS.map(() => ({ stakes, games: from })), ownAntes: antes, auto: stakes, autoAntes: antes };
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
  // A bring-in above the small bet makes no sense (the server refuses it with a Limit game), unless the host typed both.
  const bets = MENU_STAKE_GROUPS.findIndex((group) => group[0] === 'smallBet');
  const bringIn = MENU_STAKE_GROUPS.findIndex((group) => group[0] === 'bringIn');
  if (next.smallBet >= 1 && next.bringIn > next.smallBet && !(changed(MENU_STAKE_GROUPS[bets]) && changed(MENU_STAKE_GROUPS[bringIn]))) {
    next.bringIn = studBringIn(next.smallBet, next.centsMode);
  }
  // The level antes go with the own ante; a level added since keeps its own.
  let nextAntes = antes.map((a, i) => (i < ownAntes.length ? ownAntes[i] : a));
  if (next.anteType === 'none' && (scheduleOn || own[ante].stakes.anteType !== 'none')) nextAntes = antes.map(() => 0);
  return { stakes: next, antes: nextAntes, start: { own, ownAntes, auto: next, autoAntes: nextAntes } };
}

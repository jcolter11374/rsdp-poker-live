import { useRef, useState } from 'react';
import '@rsdp/engine/modifiers';
import type { BettingKind } from '@rsdp/engine/core';
import { getModifierSchema, SETTINGS_LIMITS, type SettingsPatch, type TableSettings } from '@rsdp/engine/settings';
import { getVariant, mixedGameMaxPlayers, mixedGameOf, MIXED_GAMES, VARIANT_LIST, type MixedGame } from '@rsdp/engine/variants';
import type { TableView } from '@rsdp/engine/wire';
import { call } from '../socket';
import { BETTING_NAME, defaultStudAnte, fromInput, studBringIn, toInput } from '../format';
import { Modal } from './SeatDialog';
import { BettingNudge } from './BettingNudge';
import { Field } from './settings/fields';
import { SideGamesTab } from './settings/SideGamesTab';
import { PresetsTab } from './settings/PresetsTab';
import { canAddGame, canAddLevel, nextBlindLevel, scheduleBetsNote } from './settings/lists';
import { DealersChoiceFields } from './settings/DealersChoiceFields';
import { choiceOf, comingSettings, DEFAULT_MENU, levelStudAnte, levelStudAntes, menuSeats, repeatsOf, stakesForGames, stakesStart, type StakesStart } from './settings/dealersChoice';
import type { ChoiceGame, DealersChoiceSettings } from '@rsdp/engine/settings';

type Tab = 'game' | 'stakes' | 'clock' | 'seats' | 'rules' | 'side' | 'chat' | 'presets';
type Mode = 'one' | 'rotate' | 'choice';
const modeOf = (d: TableSettings): Mode => (choiceOf(d).enabled ? 'choice' : d.game.rotation.enabled ? 'rotate' : 'one');
/** The games dealt in each way of choosing the game: the one game, the rotation's games, or the menu. */
const dealtIn = (d: TableSettings, mode: Mode): readonly ChoiceGame[] =>
  mode === 'choice' ? choiceOf(d).games : mode === 'rotate' && d.game.rotation.steps.length ? d.game.rotation.steps : [d.game];
const levelAntes = (d: TableSettings) => d.blindSchedule.levels.map((l) => l.ante);
/** Where the stakes stand at `d` before any change of the games dealt (#414). */
const startOf = (d: TableSettings): StakesStart => stakesStart(d.stakes, levelAntes(d), dealtIn(d, modeOf(d)));
const TABS: { id: Tab; label: string }[] = [
  { id: 'game', label: 'Game' },
  { id: 'stakes', label: 'Stakes' },
  { id: 'clock', label: 'Clock' },
  { id: 'seats', label: 'Seats' },
  { id: 'rules', label: 'Rules' },
  { id: 'side', label: 'Side games' },
  { id: 'chat', label: 'Chat & watching' },
  { id: 'presets', label: 'Presets' },
];
const BETTINGS: BettingKind[] = ['no-limit', 'pot-limit', 'fixed-limit'];

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The fields of `next` that differ from `prev`, nested like the settings. Lists are sent whole. */
function diff(prev: unknown, next: unknown): unknown {
  if (isObject(prev) && isObject(next)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(next)) {
      const d = diff(prev[key], next[key]);
      if (d !== undefined) out[key] = d;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return JSON.stringify(prev) === JSON.stringify(next) ? undefined : next;
}

const maxSeatsFor = (gameIds: string[]) => Math.min(...gameIds.map((id) => getVariant(id).maxPlayers));

export function SettingsDialog({ view, onClose }: { view: TableView; onClose: () => void }) {
  // Taken once, as the dialog opens: a save sends only what this host changed here, so a change someone else saves
  // in the meantime (a co-host, say) isn't undone.
  const [base] = useState(() => comingSettings(view.settings, view.pendingSettings));
  const [draft, setDraft] = useState<TableSettings>(() => structuredClone(base));
  const [tab, setTab] = useState<Tab>('game');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const cents = draft.stakes.centsMode;
  const handLive = !!view.hand && view.hand.phase !== 'complete';
  const tournament = view.mode === 'tournament';
  const seated = view.seats.filter(Boolean).length;

  /** Edit one section of the draft. */
  const set = <K extends keyof TableSettings>(section: K, patch: Partial<TableSettings[K]>) =>
    setDraft((d) => ({ ...d, [section]: { ...(d[section] as object), ...patch } }));

  const setModifier = (id: string, patch: object) =>
    setDraft((d) => {
      const cur = (getModifierSchema(id)?.get(d) as object | undefined) ?? {};
      return { ...d, modifiers: { ...d.modifiers, [id]: { ...cur, ...patch } } };
    });

  const rot = draft.game.rotation;
  const choice = choiceOf(draft);
  const mode = modeOf(draft);
  // Each part of the stakes' own value (the table's, or what the host typed) and the games it was for, so a change of
  // the games dealt works the stakes out from it, and a look at other games and back undoes itself (#414).
  const started = useRef<StakesStart | null>(null);
  const games = draft.game.rotation.enabled && draft.game.rotation.steps.length ? draft.game.rotation.steps.map((s) => s.gameId) : [draft.game.gameId];
  // Dealer's choice keeps the table's seats, up to the menu's biggest game; smaller games are greyed out when picking (D33).
  const seatLimit = mode === 'choice' ? menuSeats(choice.games) : maxSeatsFor(games);

  // A game with fewer seats than the table: say up front who has to leave, or who moves seats.
  const tightest = games.map((id) => getVariant(id)).reduce((a, b) => (b.maxPlayers < a.maxPlayers ? b : a));
  const newSeats = Math.min(draft.table.maxSeats, seatLimit);
  const tooMany = !tournament && seated > newSeats;
  const moving = view.seats.flatMap((x, i) => (x && i >= newSeats ? [i + 1] : []));
  const seatNote = tooMany
    ? seated > seatLimit
      ? mode === 'choice'
        ? `No game on the menu seats ${seated}: the biggest seats at most ${seatLimit}. ${seated - seatLimit} ${seated - seatLimit === 1 ? 'player needs' : 'players need'} to leave the table (or remove ${seated - seatLimit === 1 ? 'a bot' : 'some bots'}), or add a bigger game.`
        : `${games.length > 1 ? `${tightest.name}, one of the games in the rotation,` : tightest.name} seats at most ${seatLimit} players and ${seated} are sitting down. ${seated - seatLimit} ${seated - seatLimit === 1 ? 'player needs' : 'players need'} to leave the table (or remove ${seated - seatLimit === 1 ? 'a bot' : 'some bots'}) before you can switch.`
      : `${seated} players are sitting down, so the table needs at least ${seated} seats.`
    : !tournament && moving.length
      ? `The table goes down to ${newSeats} seats. ${moving.length === 1 ? 'The player' : 'Players'} in seat${moving.length === 1 ? '' : 's'} ${moving.join(' and ').replace(/ and (?=.* and )/g, ', ')} will move to ${moving.length === 1 ? 'a free seat' : 'free seats'}${handLive ? ' when this hand ends' : ''}.`
      : '';

  /**
   * The stakes and the blind schedule for dealing `to` in place of the games dealt now (#414), with `adjust` laid on
   * top (a standard mix's own Limit bets, say), which counts as set up by the dialog too. A stud ante that `adjust`
   * puts on goes on the levels too, as one stakesForGames puts on does (#426). `game` is the table's one game
   * afterwards, which the server's check on the Limit bets counts even in a rotation or Dealer's choice.
   */
  const forGames = (
    d: TableSettings,
    to: readonly ChoiceGame[],
    adjust = (st: TableSettings['stakes']) => st,
    game: ChoiceGame = d.game,
  ): Pick<TableSettings, 'stakes' | 'blindSchedule'> => {
    const { levels } = d.blindSchedule;
    const limit = [...to, game].some((g) => g.betting === 'fixed-limit');
    const next = stakesForGames(d.stakes, levels, dealtIn(d, mode), to, started.current ?? startOf(base), d.blindSchedule.enabled, limit);
    let stakes = adjust(next.stakes);
    let antes = next.antes;
    // A stud ante put on now is worked out from the small bet: from the one `adjust` sets (a standard mix's), if it
    // changes it. One that `adjust` puts on goes on the levels too.
    if (next.studAnteOn && stakes.smallBet !== next.stakes.smallBet) {
      stakes = { ...stakes, ante: defaultStudAnte(stakes) };
      antes = levelStudAntes(stakes, levels);
    } else if (next.stakes.ante === 0 && stakes.ante > 0) antes = levelStudAntes(stakes, levels);
    started.current = { ...next.start, auto: stakes, autoAntes: antes };
    const blindSchedule = antes.every((a, i) => a === levels[i].ante) ? d.blindSchedule : { ...d.blindSchedule, levels: levels.map((l, i) => ({ ...l, ante: antes[i] })) };
    return { stakes, blindSchedule };
  };

  const pickGame = (gameId: string) => {
    const spec = getVariant(gameId);
    const d = draft;
    const stud = spec.forcedBets === 'ante-bring-in';
    setDraft({
      ...d,
      game: { ...d.game, gameId, betting: spec.defaultBetting },
      table: { ...d.table, maxSeats: Math.min(d.table.maxSeats, spec.maxPlayers) },
      // Stud is meant to be played with antes; without one the pot starts with the bring-in alone.
      ...forGames(d, [{ gameId, betting: spec.defaultBetting }], (st) => (stud && st.ante === 0 ? { ...st, ante: defaultStudAnte(st), anteType: 'per-player' } : st), { gameId, betting: spec.defaultBetting }),
    });
  };

  /** The one game's betting, and the stakes it needs: Limit bets, and a bring-in that fits them. */
  const setBetting = (betting: BettingKind) => {
    const d = draft;
    const game = { gameId: d.game.gameId, betting };
    setDraft({ ...d, game: { ...d.game, betting }, ...forGames(d, [game], undefined, game) });
  };

  /** Fills the rotation with a standard mix, one orbit per game, and sets up the stud ante and bring-in it needs. */
  const pickMix = (mix: MixedGame) => {
    const d = draft;
    const stud = mix.steps.some((st) => getVariant(st.gameId).forcedBets === 'ante-bring-in');
    const first = mix.steps[0];
    const steps = mix.steps.map((st) => ({ ...st, length: 1, unit: 'orbits' as const }));
    // The Limit games bet the big blind and twice it, as on a new table, so older Limit amounts don't linger, and the
    // stud bring-in goes with them.
    const bets = (st: TableSettings['stakes']) => {
      const smallBet = Math.max(1, st.bigBlind);
      return { ...st, smallBet, bigBet: smallBet * 2, ...(stud ? { bringIn: studBringIn(smallBet, st.centsMode) } : {}) };
    };
    setDraft({
      ...d,
      game: {
        ...d.game,
        gameId: first.gameId,
        betting: first.betting,
        rotation: { enabled: true, steps },
        ...(d.game.dealersChoice ? { dealersChoice: { ...d.game.dealersChoice, enabled: false } } : {}),
      },
      table: { ...d.table, maxSeats: Math.min(d.table.maxSeats, mixedGameMaxPlayers(mix)) },
      // The ante is the stud ante (everyone posts it in the stud games), and the hold'em and Omaha rounds need a small blind.
      ...forGames(d, steps, bets, first),
    });
  };
  const currentMix = rot.enabled ? mixedGameOf(rot.steps) : null;
  const menuBad = mode === 'choice' && (choice.games.length < 2 || repeatsOf(choice.games).length > 0);

  const setChoice = (patch: Partial<DealersChoiceSettings>) => setDraft((d) => ({ ...d, game: { ...d.game, dealersChoice: { ...choiceOf(d), ...patch } } }));
  /** A new menu, and the stakes its games need (Limit bets, a stud ante), as for HORSE. */
  const setMenu = (menu: ChoiceGame[]) => {
    const d = draft;
    setDraft({ ...d, game: { ...d.game, dealersChoice: { ...choiceOf(d), games: menu } }, ...forGames(d, menu) });
  };
  /** New rotation steps, and the stakes their games need, as for a new menu: a stud ante comes off with the last stud game. */
  const setSteps = (steps: TableSettings['game']['rotation']['steps']) => {
    const d = draft;
    const same = steps.length === d.game.rotation.steps.length && steps.every((st, i) => st.gameId === d.game.rotation.steps[i].gameId && st.betting === d.game.rotation.steps[i].betting);
    const rotation = { ...d.game.rotation, steps };
    // A step's length or unit doesn't change the games dealt.
    setDraft({ ...d, game: { ...d.game, rotation }, ...(same ? {} : forGames(d, steps)) });
  };
  /**
   * The levels kept when the schedule is turned on or off. While it's on, each level's ante is the one posted: with
   * No ante, they have none (the server refuses one), and with stud dealt and a stud ante set, a level with none
   * gets a stud ante for its own blinds, or the stud games would have none there (#426).
   */
  const scheduleLevels = (enabled: boolean) => {
    const { levels } = draft.blindSchedule;
    if (!enabled) return levels;
    if (draft.stakes.anteType === 'none') return levels.map((l) => ({ ...l, ante: 0 }));
    const stud = dealtIn(draft, mode).some((g) => getVariant(g.gameId).forcedBets === 'ante-bring-in');
    return stud && draft.stakes.ante > 0 ? levels.map((l) => (l.ante === 0 ? { ...l, ante: levelStudAnte(draft.stakes, l) } : l)) : levels;
  };
  /** Takes a level off the schedule. The antes kept for switching back stay with their levels (#414). */
  const removeLevel = (i: number) => {
    const s = started.current ?? startOf(base);
    started.current = { ...s, ownAntes: s.ownAntes.filter((_, j) => j !== i), autoAntes: s.autoAntes.filter((_, j) => j !== i) };
    set('blindSchedule', { levels: draft.blindSchedule.levels.filter((_, j) => j !== i) });
  };
  const setMode = (next: Mode) => {
    if (next === mode) return;
    const d = draft;
    const dc = choiceOf(d);
    const rotation = { ...d.game.rotation, enabled: next === 'rotate' };
    if (next === 'rotate' && !rotation.steps.length) rotation.steps = [{ gameId: d.game.gameId, betting: d.game.betting, length: 1, unit: 'orbits' }];
    // A new menu starts with the 8-Game games, and the stakes they need.
    const menu = next === 'choice' && dc.games.length < 2 ? DEFAULT_MENU : dc.games;
    // The stakes the new games need: a stud ante goes on with the first stud game (one the table already has, from a
    // HORSE rotation or a stud game, is kept) and comes off with the last, and what a look at another mode set up is
    // undone on the way back.
    const to = next === 'choice' ? menu : next === 'rotate' ? rotation.steps : [d.game];
    setDraft({ ...d, game: { ...d.game, rotation, dealersChoice: { ...dc, enabled: next === 'choice', games: menu } }, ...forGames(d, to) });
  };

  const save = () => {
    const dc = draft.game.dealersChoice;
    const fixed = {
      ...draft,
      table: { ...draft.table, maxSeats: Math.min(draft.table.maxSeats, seatLimit) },
      // Saved straight from the pick time field, before it lost focus: the lowest it can be.
      game: dc ? { ...draft.game, dealersChoice: { ...dc, pickSeconds: Math.max(SETTINGS_LIMITS.pickSeconds.min, dc.pickSeconds) } } : draft.game,
    };
    const patch = diff(base, fixed) as SettingsPatch | undefined;
    if (!patch) return onClose();
    // How the game is chosen: send both switches, so the mode shown is the one dealt even if someone else's change
    // was saved for the next hand since the dialog opened.
    const g = patch.game as { rotation?: object; dealersChoice?: object } | undefined;
    if (g && (g.rotation || g.dealersChoice)) {
      g.rotation = { ...g.rotation, enabled: fixed.game.rotation.enabled };
      if (fixed.game.dealersChoice) g.dealersChoice = { ...g.dealersChoice, enabled: fixed.game.dealersChoice.enabled };
    }
    setBusy(true);
    call('host:settings', { patch })
      .then(onClose)
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };

  const chipsField = (label: string, value: number, onChange: (v: number) => void, hint?: string) => (
    <Field label={label} hint={hint}>
      <input type="number" min={0} step={cents ? 0.01 : 1} value={toInput(cents, value)} onChange={(e) => onChange(fromInput(cents, +e.target.value))} />
    </Field>
  );
  const numberField = (label: string, value: number, onChange: (v: number) => void, min: number, max: number, hint?: string) => (
    <Field label={label} hint={hint}>
      <input type="number" min={min} max={max} value={value} onChange={(e) => onChange(Math.round(+e.target.value))} />
    </Field>
  );
  const toggle = (label: string, checked: boolean, onChange: (v: boolean) => void, disabled = false) => (
    <label className="toggle">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );

  const sched = draft.blindSchedule;

  return (
    <Modal title="Table settings" onClose={onClose}>
      <div className="tabs">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? 'active' : ''} aria-pressed={tab === t.id} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="settings-body">
        {tab === 'game' && (
          <>
            <Field label="Table name">
              <input value={draft.table.name} maxLength={40} onChange={(e) => set('table', { name: e.target.value })} />
            </Field>
            {!tournament && (
              <>
                <Field label="How the game is chosen">
                  <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
                    <option value="one">One game</option>
                    <option value="rotate">Rotate games in order (mixed games)</option>
                    <option value="choice">Dealer&apos;s choice</option>
                  </select>
                </Field>
                {mode === 'one' && (
                <div className="row">
                  <Field label="Game">
                    <select value={draft.game.gameId} onChange={(e) => pickGame(e.target.value)}>
                      {VARIANT_LIST.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Betting">
                    <select value={draft.game.betting} onChange={(e) => setBetting(e.target.value as BettingKind)}>
                      {BETTINGS.map((b) => (
                        <option key={b} value={b}>
                          {BETTING_NAME[b]}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
                )}
                {mode === 'one' && <BettingNudge gameId={draft.game.gameId} betting={draft.game.betting} onSwitch={setBetting} />}
                {numberField('Seats', Math.min(draft.table.maxSeats, seatLimit), (v) => set('table', { maxSeats: v }), Math.max(2, seated), seatLimit, mode === 'choice' ? `Up to ${seatLimit}, for the biggest game on the menu.` : `Up to ${seatLimit} for ${games.length > 1 ? 'these games' : 'this game'}.`)}
                {seatNote && !tooMany && <p className="hint">{seatNote}</p>}
                {mode === 'choice' && <DealersChoiceFields choice={choice} seated={seated} onChange={setChoice} setMenu={setMenu} />}
                {mode !== 'choice' && (
                <div className="mixed-game-picks" role="group" aria-label="Standard mixed games">
                  <span className="muted">Or play a standard mix:</span>
                  {MIXED_GAMES.map((mix) => {
                    const cap = mixedGameMaxPlayers(mix);
                    const mixTooBig = seated > cap;
                    return (
                      <button
                        type="button"
                        key={mix.id}
                        className={currentMix?.id === mix.id ? 'on' : ''}
                        aria-pressed={currentMix?.id === mix.id}
                        disabled={mixTooBig}
                        title={mixTooBig ? `${mix.name} seats at most ${cap}: ${seated} players are seated` : mix.summary}
                        onClick={() => pickMix(mix)}
                      >
                        {mix.name}
                      </button>
                    );
                  })}
                </div>
                )}
                {currentMix && (
                  <p className="muted">
                    {currentMix.name}: {currentMix.summary} One orbit each; change the lengths below. Only the stud games ante; the others play on the blinds, and
                    the Limit games bet the Limit amounts in Stakes.
                  </p>
                )}
                {rot.enabled && (
                  <div className="list-editor">
                    {rot.steps.map((st, i) => {
                      const update = (p: Partial<typeof st>) => setSteps(rot.steps.map((x, j) => (j === i ? { ...x, ...p } : x)));
                      return (
                        <div key={i}>
                          <div className="row">
                            <select value={st.gameId} onChange={(e) => update({ gameId: e.target.value, betting: getVariant(e.target.value).defaultBetting })}>
                              {VARIANT_LIST.map((v) => (
                                <option key={v.id} value={v.id}>
                                  {v.name}
                                </option>
                              ))}
                            </select>
                            <select value={st.betting} onChange={(e) => update({ betting: e.target.value as BettingKind })}>
                              {BETTINGS.map((b) => (
                                <option key={b} value={b}>
                                  {BETTING_NAME[b]}
                                </option>
                              ))}
                            </select>
                            <input type="number" min={1} value={st.length} onChange={(e) => update({ length: Math.max(1, Math.round(+e.target.value)) })} />
                            <select value={st.unit} onChange={(e) => update({ unit: e.target.value as 'hands' | 'orbits' })}>
                              <option value="hands">hands</option>
                              <option value="orbits">orbits</option>
                            </select>
                            <button
                              type="button"
                              disabled={rot.steps.length <= 1}
                              onClick={() => setSteps(rot.steps.filter((_, j) => j !== i))}
                            >
                              ✕
                            </button>
                          </div>
                          {/* Rows are keyed by position, so a removed row would hand its note to the next one: start them afresh. */}
                          <BettingNudge key={rot.steps.length} gameId={st.gameId} betting={st.betting} onSwitch={(betting) => update({ betting })} />
                        </div>
                      );
                    })}
                    <button
                      type="button"
                      disabled={!canAddGame(rot.steps)}
                      title={canAddGame(rot.steps) ? undefined : `A rotation holds up to ${SETTINGS_LIMITS.rotationSteps.max} games`}
                      onClick={() => setSteps([...rot.steps, { ...rot.steps[rot.steps.length - 1] }])}
                    >
                      Add game
                    </button>
                  </div>
                )}
              </>
            )}
          </>
        )}

        {tab === 'stakes' && !tournament && (
          <>
            <div className="row">
              {chipsField('Small blind', draft.stakes.smallBlind, (v) => set('stakes', { smallBlind: v }))}
              {chipsField('Big blind', draft.stakes.bigBlind, (v) => set('stakes', { bigBlind: v }))}
            </div>
            <div className="row">
              {chipsField('Ante', draft.stakes.ante, (v) => set('stakes', { ante: v, anteType: v > 0 && draft.stakes.anteType === 'none' ? 'per-player' : draft.stakes.anteType }))}
              <Field label="Who antes">
                <select value={draft.stakes.anteType} onChange={(e) => set('stakes', { anteType: e.target.value as TableSettings['stakes']['anteType'], ante: e.target.value === 'none' ? 0 : draft.stakes.ante })}>
                  <option value="none">No ante</option>
                  <option value="per-player">Everyone</option>
                  <option value="big-blind">Big blind (for the table)</option>
                </select>
              </Field>
            </div>
            <div className="row">
              {chipsField('Stud bring-in', draft.stakes.bringIn, (v) => set('stakes', { bringIn: v }), '0 = about a third of the small bet')}
            </div>
            <div className="row">
              {chipsField('Limit small bet', draft.stakes.smallBet, (v) => set('stakes', { smallBet: v }), '0 = the big blind')}
              {chipsField('Limit big bet', draft.stakes.bigBet, (v) => set('stakes', { bigBet: v }), '0 = twice the small bet')}
            </div>
            {toggle('Raise the blinds on a schedule', sched.enabled, (enabled) =>
              set('blindSchedule', {
                enabled,
                levels: sched.levels.length
                  ? scheduleLevels(enabled)
                  : [{ smallBlind: draft.stakes.smallBlind, bigBlind: draft.stakes.bigBlind, ante: draft.stakes.ante, minutes: 20, hands: 30 }],
              }),
            )}
            {sched.enabled && (
              <div className="list-editor">
                <Field label="Levels change">
                  <select value={sched.countdown} onChange={(e) => set('blindSchedule', { countdown: e.target.value as typeof sched.countdown })}>
                    <option value="per-level-timer">On a timer</option>
                    <option value="hands">After a number of hands</option>
                  </select>
                </Field>
                <div className="row head">
                  <span>SB</span>
                  <span>BB</span>
                  <span>Ante</span>
                  <span>{sched.countdown === 'hands' ? 'Hands' : 'Minutes'}</span>
                  <span />
                </div>
                {sched.levels.map((lv, i) => {
                  const update = (p: Partial<typeof lv>) => set('blindSchedule', { levels: sched.levels.map((x, j) => (j === i ? { ...x, ...p } : x)) });
                  const amount = (k: 'smallBlind' | 'bigBlind' | 'ante') => (
                    <input type="number" min={0} step={cents ? 0.01 : 1} value={toInput(cents, lv[k])} onChange={(e) => update({ [k]: fromInput(cents, +e.target.value) })} />
                  );
                  return (
                    <div className="row" key={i}>
                      {amount('smallBlind')}
                      {amount('bigBlind')}
                      {amount('ante')}
                      {sched.countdown === 'hands' ? (
                        <input type="number" min={1} value={lv.hands} onChange={(e) => update({ hands: Math.max(1, Math.round(+e.target.value)) })} />
                      ) : (
                        <input type="number" min={2} value={lv.minutes} onChange={(e) => update({ minutes: Math.max(2, Math.round(+e.target.value)) })} />
                      )}
                      <button type="button" disabled={sched.levels.length <= 1} onClick={() => removeLevel(i)}>
                        ✕
                      </button>
                    </div>
                  );
                })}
                {scheduleBetsNote(draft.game) && <p className="muted">{scheduleBetsNote(draft.game)}</p>}
                <button
                  type="button"
                  disabled={!canAddLevel(sched.levels)}
                  title={canAddLevel(sched.levels) ? undefined : `A schedule holds up to ${SETTINGS_LIMITS.blindLevels.max} levels`}
                  onClick={() => set('blindSchedule', { levels: [...sched.levels, nextBlindLevel(sched.levels[sched.levels.length - 1])] })}
                >
                  Add level
                </button>
              </div>
            )}
          </>
        )}
        {tab === 'stakes' && tournament && <p className="muted">The tournament sets the blinds.</p>}

        {tab === 'clock' && (
          <>
            {numberField('Seconds to act', draft.timing.decisionSeconds, (v) => set('timing', { decisionSeconds: v }), 0, 600, '0 = no clock, otherwise 5 to 600')}
            <div className="row">
              {numberField('Time bank (seconds)', draft.timing.timeBankSeconds, (v) => set('timing', { timeBankSeconds: v }), 0, 300)}
              {numberField('Refill every (hands)', draft.timing.timeBankRefillHands, (v) => set('timing', { timeBankRefillHands: v }), 0, 200, '0 = never')}
            </div>
            {toggle('Use the time bank automatically', draft.timing.autoActivateTimeBank, (autoActivateTimeBank) => set('timing', { autoActivateTimeBank }))}
            {!tournament && toggle('Deal the next hand automatically', draft.timing.autoStartNextHand, (autoStartNextHand) => set('timing', { autoStartNextHand }))}
            <div className="row">
              <Field label="Showdown pause">
                <select value={draft.timing.showdownSeconds} onChange={(e) => set('timing', { showdownSeconds: +e.target.value as 3 | 6 | 9 })}>
                  {[3, 6, 9].map((s) => (
                    <option key={s} value={s}>
                      {s} seconds
                    </option>
                  ))}
                </select>
              </Field>
              {numberField('Pause between hands (s)', draft.timing.nextHandDelaySeconds, (v) => set('timing', { nextHandDelaySeconds: v }), 0, 30)}
            </div>
          </>
        )}

        {tab === 'seats' && (
          <>
            {!tournament && (
              <>
                {toggle('Approve new players', draft.seating.requireApproval, (requireApproval) => set('seating', { requireApproval }))}
                {toggle('Allow rebuys', draft.seating.allowRebuys, (allowRebuys) => set('seating', { allowRebuys }))}
                {toggle('Approve rebuys', draft.seating.rebuyRequiresApproval, (rebuyRequiresApproval) => set('seating', { rebuyRequiresApproval }), !draft.seating.allowRebuys)}
                <div className="row">
                  {chipsField('Minimum buy-in', draft.seating.minBuyIn, (v) => set('seating', { minBuyIn: v }), '0 = none')}
                  {chipsField('Maximum buy-in', draft.seating.maxBuyIn, (v) => set('seating', { maxBuyIn: v }), '0 = none')}
                </div>
                {numberField('Return with your old stack within (minutes)', draft.seating.ratholeMinutes, (v) => set('seating', { ratholeMinutes: v }), 0, 1440, '0 = off')}
                {toggle('Waitlist when the table is full', draft.seating.waitlist, (waitlist) => set('seating', { waitlist }))}
                <span className="hint">When a seat comes free it is held for the next person in line for a minute.</span>
                {toggle('Seat new players at random', !!draft.seating.randomSeats, (randomSeats) => set('seating', { randomSeats }))}
                <span className="hint">Players who sit down get a random open seat instead of the one they clicked.</span>
                {toggle('Players can add practice bots', draft.seating.allowPlayerBots !== false, (allowPlayerBots) => set('seating', { allowPlayerBots }))}
                <span className="hint">Anyone seated can add a bot to practice against (up to three each). You can always add and remove bots.</span>
                {numberField('Free the seat of a player offline for (minutes)', draft.seating.releaseOfflineSeatMinutes, (v) => set('seating', { releaseOfflineSeatMinutes: v }), 0, 1440, '0 = never. Their chips go back to the ledger.')}
              </>
            )}
            <div className="row">
              {numberField('Timeouts before away', draft.seating.awayAfterTimeouts, (v) => set('seating', { awayAfterTimeouts: v }), 0, 10, '0 = never')}
              {numberField('Disconnect grace (s)', draft.seating.offlineGraceSeconds, (v) => set('seating', { offlineGraceSeconds: v }), 0, 300)}
            </div>
            {toggle('Keep dealing to away players (they check or fold)', draft.seating.dealToAway, (dealToAway) => set('seating', { dealToAway }))}
            {toggle('Players can throw gestures at each other', draft.chat.gestures !== false, (gestures) => set('chat', { gestures }))}
          </>
        )}

        {tab === 'chat' && (
          <>
            {toggle('Spectators can chat', draft.chat.guestChat, (guestChat) => set('chat', { guestChat }))}
            <span className="hint">Off: only seated players and the host can chat.</span>
            {toggle('Hide swear words in chat', draft.chat.profanityFilter, (profanityFilter) => set('chat', { profanityFilter }))}
            <h4>Watching</h4>
            {toggle(
              'Let people watch',
              draft.spectators.allowed,
              (allowed) => set('spectators', { allowed }),
              // Watching again would show every card of the hand in progress.
              handLive && !view.settings.spectators.allowed && view.settings.spectators.seeAllCards && !draft.spectators.allowed,
            )}
            <span className="hint">Off: people who aren't seated see the seats but not the hand.</span>
            {toggle(
              'Spectators see every hole card',
              draft.spectators.seeAllCards,
              // Turning it on starts with a two-minute delay, so nobody watching can pass cards on during the hand.
              (seeAllCards) => set('spectators', seeAllCards && draft.spectators.delaySeconds === 0 ? { seeAllCards, delaySeconds: 120 } : { seeAllCards }),
              !draft.spectators.allowed || (handLive && !view.settings.spectators.seeAllCards && !draft.spectators.seeAllCards),
            )}
            <span className="hint">
              {handLive && !view.settings.spectators.seeAllCards
                ? 'You can turn this on between hands. '
                : ''}
              Everyone at the table is told when it goes on, sees a red rail and a reminder while it's on, and must agree to it before sitting down.
            </span>
            {numberField('Spectators run behind by (seconds)', draft.spectators.delaySeconds, (v) => set('spectators', { delaySeconds: v }), 0, 600, 'A delay stops anyone passing on what they see. 0 = live.')}
            {draft.spectators.seeAllCards && draft.spectators.delaySeconds === 0 && <p className="error">With no delay, anyone watching can tell a player what everyone holds.</p>}
          </>
        )}

        {tab === 'presets' && <PresetsTab
            draft={draft}
            onApply={(next) => {
              // A preset is a new start: switching back afterwards doesn't undo onto the stakes from before it.
              started.current = startOf(next);
              setDraft(next);
            }}
            tournament={tournament}
          />}

        {tab === 'side' && tournament && <p className="muted">Side games are for cash tables.</p>}
        {tab === 'side' && !tournament && <SideGamesTab draft={draft} cents={cents} setModifier={setModifier} />}

        {tab === 'rules' && (
          <>
            <Field label="Run it twice" hint={tournament ? 'Cash games only.' : undefined}>
              <select disabled={tournament} value={draft.play.runItTwice} onChange={(e) => set('play', { runItTwice: e.target.value as TableSettings['play']['runItTwice'] })}>
                <option value="off">Off</option>
                <option value="ask">Players choose</option>
                <option value="always">Always</option>
              </select>
            </Field>
            <Field label="Straddles" hint={tournament ? 'Cash games only.' : 'Players turn their straddle on from their seat.'}>
              <select disabled={tournament} value={draft.play.straddle} onChange={(e) => set('play', { straddle: e.target.value as TableSettings['play']['straddle'] })}>
                <option value="off">Off</option>
                <option value="utg">Under the gun</option>
                <option value="utg-and-button">Under the gun and button re-straddle</option>
              </select>
            </Field>
            <div className="row">
              {numberField('Limit bets per round', draft.play.fixedLimitCap, (v) => set('play', { fixedLimitCap: v }), 2, 10, 'The bet plus raises')}
            </div>
            {toggle('No cap when heads up', draft.play.uncappedHeadsUp, (uncappedHeadsUp) => set('play', { uncappedHeadsUp }))}
            {toggle('Show every hand at showdown', draft.play.revealAllAtShowdown, (revealAllAtShowdown) => set('play', { revealAllAtShowdown }))}
            <span className="hint">Off: the last bettor shows first and hands that can't win are mucked. Hands are always shown when everyone is all in.</span>
            {toggle('Trim bets nobody can call', draft.play.trimExcessBets, (trimExcessBets) => set('play', { trimExcessBets }))}
            <span className="hint">A bet or all-in is capped at the most anyone left in the hand can put in.</span>
            {toggle('Rabbit hunting', draft.play.rabbitHunt, (rabbitHunt) => set('play', { rabbitHunt }))}
            <span className="hint">After a hand ends early, anyone can peek at the cards that would have come. Only they see them.</span>
          </>
        )}
      </div>
      {handLive && <p className="muted">Changes to the game, stakes and seats take effect when this hand ends.</p>}
      {tooMany && <p className="error">{seatNote}</p>}
      {error && <p className="error">{error}</p>}
      <div className="row">
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button className="primary" disabled={busy || tooMany || menuBad} onClick={save}>
          Save
        </button>
      </div>
    </Modal>
  );
}

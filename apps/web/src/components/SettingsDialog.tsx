import { useState, type ReactNode } from 'react';
import type { BettingKind } from '@rsdp/engine/core';
import type { SettingsPatch, TableSettings } from '@rsdp/engine/settings';
import { getVariant, VARIANT_LIST } from '@rsdp/engine/variants';
import type { TableView } from '@rsdp/engine/wire';
import { call } from '../socket';
import { BETTING_NAME, fromInput, toInput } from '../format';
import { Modal } from './SeatDialog';

type Tab = 'game' | 'stakes' | 'clock' | 'seats' | 'rules';
const TABS: { id: Tab; label: string }[] = [
  { id: 'game', label: 'Game' },
  { id: 'stakes', label: 'Stakes' },
  { id: 'clock', label: 'Clock' },
  { id: 'seats', label: 'Seats' },
  { id: 'rules', label: 'Rules' },
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
  const [draft, setDraft] = useState<TableSettings>(() => structuredClone(view.settings));
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

  const games = draft.game.rotation.enabled && draft.game.rotation.steps.length ? draft.game.rotation.steps.map((s) => s.gameId) : [draft.game.gameId];
  const seatLimit = maxSeatsFor(games);

  const pickGame = (gameId: string) => {
    const spec = getVariant(gameId);
    setDraft((d) => ({
      ...d,
      game: { ...d.game, gameId, betting: spec.defaultBetting },
      table: { ...d.table, maxSeats: Math.min(d.table.maxSeats, spec.maxPlayers) },
    }));
  };

  const save = () => {
    const fixed = { ...draft, table: { ...draft.table, maxSeats: Math.min(draft.table.maxSeats, seatLimit) } };
    const patch = diff(view.settings, fixed) as SettingsPatch | undefined;
    if (!patch) return onClose();
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

  const rot = draft.game.rotation;
  const sched = draft.blindSchedule;

  return (
    <Modal title="Table settings" onClose={onClose}>
      <div className="tabs">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
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
                    <select value={draft.game.betting} onChange={(e) => set('game', { betting: e.target.value as BettingKind })}>
                      {BETTINGS.map((b) => (
                        <option key={b} value={b}>
                          {BETTING_NAME[b]}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
                {numberField('Seats', Math.min(draft.table.maxSeats, seatLimit), (v) => set('table', { maxSeats: v }), Math.max(2, seated), seatLimit, `Up to ${seatLimit} for ${games.length > 1 ? 'these games' : 'this game'}.`)}
                {toggle('Rotate games (mixed games)', rot.enabled, (enabled) =>
                  set('game', {
                    rotation: { ...rot, enabled, steps: rot.steps.length ? rot.steps : [{ gameId: draft.game.gameId, betting: draft.game.betting, length: 1, unit: 'orbits' }] },
                  }),
                )}
                {rot.enabled && (
                  <div className="list-editor">
                    {rot.steps.map((st, i) => {
                      const update = (p: Partial<typeof st>) =>
                        set('game', { rotation: { ...rot, steps: rot.steps.map((x, j) => (j === i ? { ...x, ...p } : x)) } });
                      return (
                        <div className="row" key={i}>
                          <select value={st.gameId} onChange={(e) => update({ gameId: e.target.value, betting: getVariant(e.target.value).defaultBetting })}>
                            {VARIANT_LIST.map((v) => (
                              <option key={v.id} value={v.id}>
                                {v.shortName}
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
                            onClick={() => set('game', { rotation: { ...rot, steps: rot.steps.filter((_, j) => j !== i) } })}
                          >
                            ✕
                          </button>
                        </div>
                      );
                    })}
                    <button
                      type="button"
                      onClick={() => set('game', { rotation: { ...rot, steps: [...rot.steps, { ...rot.steps[rot.steps.length - 1] }] } })}
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
              {chipsField('Stud bring-in', draft.stakes.bringIn, (v) => set('stakes', { bringIn: v }), '0 = a third of the small bet')}
            </div>
            <div className="row">
              {chipsField('Limit small bet', draft.stakes.smallBet, (v) => set('stakes', { smallBet: v }), '0 = the big blind')}
              {chipsField('Limit big bet', draft.stakes.bigBet, (v) => set('stakes', { bigBet: v }), '0 = twice the small bet')}
            </div>
            {toggle('Show chips as dollars and cents', cents, (centsMode) => set('stakes', { centsMode }))}
            {toggle('Raise the blinds on a schedule', sched.enabled, (enabled) =>
              set('blindSchedule', {
                enabled,
                levels: sched.levels.length
                  ? sched.levels
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
                      <button type="button" disabled={sched.levels.length <= 1} onClick={() => set('blindSchedule', { levels: sched.levels.filter((_, j) => j !== i) })}>
                        ✕
                      </button>
                    </div>
                  );
                })}
                <button
                  type="button"
                  onClick={() => {
                    const last = sched.levels[sched.levels.length - 1];
                    set('blindSchedule', { levels: [...sched.levels, { ...last, smallBlind: last.smallBlind * 2, bigBlind: last.bigBlind * 2, ante: last.ante * 2 }] });
                  }}
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
              </>
            )}
            <div className="row">
              {numberField('Timeouts before away', draft.seating.awayAfterTimeouts, (v) => set('seating', { awayAfterTimeouts: v }), 0, 10, '0 = never')}
              {numberField('Disconnect grace (s)', draft.seating.offlineGraceSeconds, (v) => set('seating', { offlineGraceSeconds: v }), 0, 300)}
            </div>
            {toggle('Keep dealing to away players (they check or fold)', draft.seating.dealToAway, (dealToAway) => set('seating', { dealToAway }))}
          </>
        )}

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
          </>
        )}
      </div>
      {handLive && <p className="muted">Changes to the game, stakes and seats take effect when this hand ends.</p>}
      {error && <p className="error">{error}</p>}
      <div className="row">
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button className="primary" disabled={busy} onClick={save}>
          Save
        </button>
      </div>
    </Modal>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label>
      {label}
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

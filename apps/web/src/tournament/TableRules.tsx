import { useEffect, useRef, useState } from 'react';
import { nextOccurrence, RSDP_TABLE_RULES, tableRulesOf, validateTableRules, type Command, type TableRules, type TournamentState } from '@rsdp/tournament';
import { tableRulesText } from './format';

/** How long a save may wait for the server's answer (the connection may have dropped) before the inputs open again. */
const SAVE_WAIT_MS = 10_000;

const int = (v: string) => Math.max(0, Math.floor(Number(v) || 0));
const same = (a: TableRules, b: TableRules) =>
  a.decisionSeconds === b.decisionSeconds && a.timeBankSeconds === b.timeBankSeconds && a.timeBankRefillHands === b.timeBankRefillHands && a.rabbitHunt === b.rabbitHunt;

/** The clock, time bank and rabbit hunting inputs, on the new tournament form and in the lobby's Host tab. */
export function TableRulesFields({ rules, onChange, disabled = false }: { rules: TableRules; onChange: (r: TableRules) => void; disabled?: boolean }) {
  return (
    <>
      <div className="tn-grid3">
        <label>
          Decision clock (s)
          <input type="number" min={0} max={600} disabled={disabled} value={rules.decisionSeconds} onChange={(e) => onChange({ ...rules, decisionSeconds: int(e.target.value) })} />
        </label>
        <label>
          Time bank (s)
          <input type="number" min={0} max={300} disabled={disabled} value={rules.timeBankSeconds} onChange={(e) => onChange({ ...rules, timeBankSeconds: int(e.target.value) })} />
        </label>
        <label>
          Refill bank every (hands)
          <input type="number" min={0} max={200} disabled={disabled} value={rules.timeBankRefillHands} onChange={(e) => onChange({ ...rules, timeBankRefillHands: int(e.target.value) })} />
        </label>
      </div>
      <label className="tn-check">
        <input type="checkbox" disabled={disabled} checked={rules.rabbitHunt} onChange={(e) => onChange({ ...rules, rabbitHunt: e.target.checked })} />
        Allow rabbit hunting
      </label>
      <p className="muted">Straddles are always off in tournaments.</p>
    </>
  );
}

/**
 * The Host tab's table rules: editable until the first table opens, then
 * locked so every table plays the same way. A change carries on to the next
 * event of a series or the next Sit & Go.
 */
export function TableRulesEditor({ state, by, send }: { state: TournamentState; by: string; send: (c: Command) => Promise<boolean> }) {
  const saved = tableRulesOf(state.settings);
  const [draft, setDraft] = useState<TableRules>(saved);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  /** A save went unanswered for SAVE_WAIT_MS. */
  const [slow, setSlow] = useState(false);
  const draftNow = useRef(draft);
  draftNow.current = draft;
  /** Counts saves, so only the latest one's answer counts. */
  const saves = useRef(0);
  const key = JSON.stringify(saved);
  useEffect(() => {
    if (!dirty) setDraft(tableRulesOf(state.settings));
  }, [key, dirty]);

  if (state.tables.length > 0)
    return (
      <p className="muted">
        {tableRulesText(saved)} Locked now the tables are open, so every table plays the same way.
      </p>
    );

  const errors = validateTableRules(draft);
  const save = async (rules: TableRules) => {
    const n = ++saves.current;
    setBusy(true);
    setSlow(false);
    // A reply lost to a dropped connection never comes, so the inputs open again after a while.
    const timer = setTimeout(() => {
      if (saves.current !== n) return;
      setBusy(false);
      setSlow(true);
    }, SAVE_WAIT_MS);
    try {
      const ok = await send({ type: 'updateSettings', by, settings: { tableRules: rules } });
      // An edit made after the inputs opened again stays until it is saved or discarded.
      if (ok && saves.current === n && same(draftNow.current, rules)) {
        setDirty(false);
        setSlow(false);
      }
    } finally {
      clearTimeout(timer);
      if (saves.current === n) setBusy(false);
    }
  };
  const { start } = state.settings;
  const carried = start.kind === 'sng' && start.autoSpawn ? ' The next Sit & Go gets them too.' : moreToCome(state) ? ' Later events in this series get them too.' : '';
  return (
    <>
      <p className="muted">Change these until the first table opens.{carried}</p>
      {/* Locked while a save is on its way, so an edit made meanwhile can't be lost when it lands. */}
      <TableRulesFields
        rules={draft}
        disabled={busy}
        onChange={(r) => {
          setDraft(r);
          setDirty(true);
        }}
      />
      {errors.length > 0 && <p className="error">{errors.join('. ')}.</p>}
      {slow && dirty && <p className="error">No answer from the server yet. Check your connection, then save again.</p>}
      <div className="tn-actions">
        {dirty && (
          <>
            <button className="primary" disabled={busy || errors.length > 0} onClick={() => save(draft)}>
              Save table rules
            </button>
            <button
              disabled={busy}
              onClick={() => {
                setDraft(saved);
                setDirty(false);
              }}
            >
              Discard
            </button>
          </>
        )}
        {!dirty && !same(saved, RSDP_TABLE_RULES) && (
          <button disabled={busy} onClick={() => save({ ...RSDP_TABLE_RULES })}>
            Use the RSDP rules (10 s, no rabbit hunting)
          </button>
        )}
      </div>
    </>
  );
}

/** A repeating event with another date still to come (the last one of a series with an end date has none). */
function moreToCome(state: TournamentState) {
  const { start } = state.settings;
  if (start.kind !== 'scheduled' || !start.schedule?.repeat) return false;
  try {
    return nextOccurrence(start.schedule, start.startAt) !== null;
  } catch {
    return false;
  }
}

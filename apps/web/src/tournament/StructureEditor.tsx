import { useState } from 'react';
import {
  generateStructure,
  plannedMinutes,
  presetStructure,
  validateStructure,
  type AnteType,
  type LevelRow,
  type PresetName,
  type StructureRow,
} from '@rsdp/tournament';
import { GAMES, chips } from './format';

interface Props {
  rows: StructureRow[];
  onChange: (rows: StructureRow[]) => void;
  startingStack: number;
  expectedEntrants: number;
  maxRebuys: number;
  /** Rows up to and including this index are locked (already played). */
  lockedThrough?: number;
  /** Highlight this row (the current level). */
  currentRow?: number;
  /** Show the per-level game column (mixed games). */
  showGames?: boolean;
}

const PRESET_LABELS: Record<PresetName, string> = {
  hyper: 'Hyper (25 BB, 4 min)',
  turbo: 'Turbo (50 BB, 8 min)',
  regular: 'Regular (100 BB, 15 min)',
  deep: 'Deep (200 BB, 20 min)',
};

const num = (v: string) => Math.max(0, Math.floor(Number(v) || 0));

/** Edit blind levels and breaks. Cards on phones, a grid on wider screens. */
export function StructureEditor({ rows, onChange, startingStack, expectedEntrants, maxRebuys, lockedThrough = -1, currentRow, showGames }: Props) {
  const [preset, setPreset] = useState<PresetName | 'target'>('regular');
  const [target, setTarget] = useState(180);
  const [anteType, setAnteType] = useState<AnteType>('per-player');
  // Collapsed by default on phones, where 20+ level cards make a very long page.
  const [open, setOpen] = useState(() => typeof matchMedia === 'function' && matchMedia('(min-width: 720px)').matches);
  const { errors, warnings } = validateStructure(rows, { maxRebuys });
  const editable = (i: number) => i > lockedThrough;

  const load = () => {
    const opts = { startingStack, expectedEntrants, anteType };
    const fresh = preset === 'target' ? generateStructure({ ...opts, targetMinutes: target }) : presetStructure(preset, opts);
    onChange([...rows.slice(0, lockedThrough + 1), ...fresh.slice(lockedThrough + 1)]);
  };

  const update = (i: number, patch: Partial<LevelRow> | { minutes: number } | { addOn: boolean }) => {
    const next = rows.map((r, j) => (j === i ? ({ ...r, ...patch } as StructureRow) : r));
    onChange(next);
  };

  const setAnte = (i: number, row: LevelRow, ante: number, type: AnteType) => {
    if (type === 'none') update(i, { ante: 0, anteType: 'none' });
    else update(i, { ante: ante || (type === 'big-blind' ? row.bb : Math.max(1, Math.round(row.bb / 8))), anteType: type });
  };

  const insert = (i: number, row: StructureRow) => onChange([...rows.slice(0, i), row, ...rows.slice(i)]);
  const remove = (i: number) => onChange(rows.filter((_, j) => j !== i));

  const addLevel = () => {
    const last = [...rows].reverse().find((r): r is LevelRow => r.kind === 'level');
    const sb = last ? last.sb * 2 : 25;
    insert(rows.length, { kind: 'level', sb, bb: sb * 2, ante: last?.anteType === 'none' ? 0 : (last?.ante ?? 0) * 2, anteType: last?.anteType ?? 'none', minutes: last?.minutes ?? 15, ...(last?.rebuy ? { rebuy: true } : {}) });
  };

  let levelNo = 0;
  return (
    <div className="tn-structure">
      <div className="tn-preset-bar">
        <label>
          Start from
          <select value={preset} onChange={(e) => setPreset(e.target.value as PresetName | 'target')}>
            {(Object.keys(PRESET_LABELS) as PresetName[]).map((p) => (
              <option key={p} value={p}>
                {PRESET_LABELS[p]}
              </option>
            ))}
            <option value="target">Fit a target length…</option>
          </select>
        </label>
        {preset === 'target' && (
          <label>
            Minutes
            <input type="number" min={30} max={1440} value={target} onChange={(e) => setTarget(num(e.target.value))} />
          </label>
        )}
        <label>
          Antes
          <select value={anteType} onChange={(e) => setAnteType(e.target.value as AnteType)}>
            <option value="per-player">Per player</option>
            <option value="big-blind">Big blind ante</option>
            <option value="none">None</option>
          </select>
        </label>
        <button type="button" onClick={load}>
          Load
        </button>
      </div>
      <p className="muted">
        {rows.filter((r) => r.kind === 'level').length} levels, about {Math.round(plannedMinutes(rows) / 6) / 10} h until the last level, which runs until the end.
      </p>

      <details className="tn-details" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>{open ? 'Hide levels' : `Show and edit all ${rows.length} rows`}</summary>
      <div className="tn-rows" role="table">
        <div className="tn-row tn-row-head" role="row">
          <span>#</span>
          <span>Small</span>
          <span>Big</span>
          <span>Ante</span>
          <span>Min</span>
          <span>{maxRebuys > 0 ? 'Rebuy' : ''}</span>
          <span />
        </div>
        {rows.map((r, i) => {
          const locked = !editable(i);
          const cls = `tn-row ${r.kind === 'break' ? 'tn-break' : ''} ${i === currentRow ? 'tn-current' : ''} ${locked ? 'tn-locked' : ''}`;
          if (r.kind === 'break') {
            return (
              <div className={cls} role="row" key={i}>
                <span className="tn-break-label">Break</span>
                <label className="tn-cell tn-span">
                  <span className="tn-cell-label">Minutes</span>
                  <input type="number" min={1} max={240} disabled={locked} value={r.minutes} onChange={(e) => update(i, { minutes: num(e.target.value) })} />
                </label>
                <label className="tn-check tn-span">
                  <input type="checkbox" disabled={locked} checked={!!r.addOn} onChange={(e) => update(i, { addOn: e.target.checked })} /> Add-ons
                </label>
                <span className="tn-row-actions">{!locked && <button type="button" aria-label="Remove break" onClick={() => remove(i)}>✕</button>}</span>
              </div>
            );
          }
          levelNo++;
          return (
            <div className={cls} role="row" key={i}>
              <span className="tn-level-no">{levelNo}</span>
              <label className="tn-cell">
                <span className="tn-cell-label">Small blind</span>
                <input type="number" min={0} disabled={locked} value={r.sb} onChange={(e) => update(i, { sb: num(e.target.value) })} />
              </label>
              <label className="tn-cell">
                <span className="tn-cell-label">Big blind</span>
                <input type="number" min={1} disabled={locked} value={r.bb} onChange={(e) => update(i, { bb: num(e.target.value) })} />
              </label>
              <label className="tn-cell tn-ante">
                <span className="tn-cell-label">Ante</span>
                <span className="tn-ante-inputs">
                  <select disabled={locked} value={r.anteType} onChange={(e) => setAnte(i, r, r.ante, e.target.value as AnteType)} aria-label="Ante type">
                    <option value="none">–</option>
                    <option value="per-player">Each</option>
                    <option value="big-blind">BB</option>
                  </select>
                  {r.anteType !== 'none' && (
                    <input type="number" min={1} disabled={locked} value={r.ante} onChange={(e) => setAnte(i, r, num(e.target.value), r.anteType)} aria-label="Ante" />
                  )}
                </span>
              </label>
              <label className="tn-cell">
                <span className="tn-cell-label">Minutes</span>
                <input type="number" min={1} max={240} disabled={locked} value={r.minutes} onChange={(e) => update(i, { minutes: num(e.target.value) })} />
              </label>
              <span className="tn-cell tn-extra">
                {maxRebuys > 0 && (
                  <label className="tn-check">
                    <input type="checkbox" disabled={locked} checked={!!r.rebuy} onChange={(e) => update(i, { rebuy: e.target.checked })} />
                    <span className="tn-cell-label-inline">Rebuys</span>
                  </label>
                )}
                {showGames && (
                  <select disabled={locked} value={r.gameId ?? ''} onChange={(e) => update(i, { gameId: e.target.value || undefined })} aria-label="Game">
                    <option value="">Rotation</option>
                    {GAMES.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                  </select>
                )}
              </span>
              <span className="tn-row-actions">
                {!locked && (
                  <>
                    <button type="button" title="Add a break after this level" onClick={() => insert(i + 1, { kind: 'break', minutes: 10 })}>
                      ☕
                    </button>
                    <button type="button" aria-label={`Remove level ${levelNo}`} onClick={() => remove(i)}>
                      ✕
                    </button>
                  </>
                )}
              </span>
            </div>
          );
        })}
      </div>
      <button type="button" onClick={addLevel}>
        + Add level
      </button>
      </details>
      {errors.map((e) => (
        <p className="error" key={e}>
          {e}
        </p>
      ))}
      {warnings.map((w) => (
        <p className="tn-warning" key={w}>
          {w}
        </p>
      ))}
      <p className="muted">Starting stack {chips(startingStack)} = {Math.round(startingStack / ((rows.find((r) => r.kind === 'level') as LevelRow | undefined)?.bb || 1))} big blinds at level 1.</p>
    </div>
  );
}

/** Read-only structure table with the current level highlighted. */
export function StructureTable({ rows, currentRow }: { rows: StructureRow[]; currentRow?: number }) {
  let levelNo = 0;
  return (
    <table className="tn-table">
      <thead>
        <tr>
          <th>Level</th>
          <th>Blinds</th>
          <th>Ante</th>
          <th>Min</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) =>
          r.kind === 'break' ? (
            <tr key={i} className={`tn-break ${i === currentRow ? 'tn-current' : ''}`}>
              <td colSpan={3}>Break{r.addOn ? ' · add-ons' : ''}</td>
              <td>{r.minutes}</td>
            </tr>
          ) : (
            <tr key={i} className={i === currentRow ? 'tn-current' : ''}>
              <td>
                {++levelNo}
                {r.rebuy ? <span className="tn-tag">R</span> : null}
              </td>
              <td>
                {chips(r.sb)} / {chips(r.bb)}
                {r.gameId ? <span className="muted"> · {r.gameId}</span> : null}
              </td>
              <td>{r.anteType === 'none' ? '–' : `${chips(r.ante)}${r.anteType === 'big-blind' ? ' BB' : ''}`}</td>
              <td>{i === rows.map((x) => x.kind).lastIndexOf('level') ? '∞' : r.minutes}</td>
            </tr>
          ),
        )}
      </tbody>
    </table>
  );
}

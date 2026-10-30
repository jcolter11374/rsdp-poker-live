import { useState } from 'react';
import { payoutPreset, placePrizes, validatePayoutStructure, type PayoutPresetName, type PayoutStructure } from '@rsdp/tournament';
import { money, ordinal } from './format';

const PRESETS: Record<PayoutPresetName, string> = {
  rsdp: 'RSDP (our payout table)',
  standard: 'Standard (about 15% paid)',
  flat: 'Flat (about 20% paid)',
  'top-three': 'Top 3',
  'top-two': 'Top 2',
  'winner-take-all': 'Winner takes all',
};

/** Payout ranges by entry count, with a tester. Percents are typed as "50, 30, 20". */
export function PayoutEditor({ value, onChange, maxEntrants, pool }: { value: PayoutStructure; onChange: (s: PayoutStructure) => void; maxEntrants: number; pool: number }) {
  const [entries, setEntries] = useState(Math.min(maxEntrants, 20));
  const [testPool, setTestPool] = useState(pool || 20_000);
  const errors = validatePayoutStructure(value, maxEntrants);
  // Typed text per range, so "50, 3" can be typed without being reformatted mid-edit.
  const [drafts, setDrafts] = useState<Record<number, string>>({});

  const setRange = (i: number, patch: Partial<PayoutStructure['ranges'][number]>) => {
    const ranges = value.ranges.map((r, j) => (j === i ? { ...r, ...patch } : r));
    // Keep ranges contiguous: each starts right after the previous one.
    for (let j = 1; j < ranges.length; j++) ranges[j] = { ...ranges[j], minEntries: ranges[j - 1].maxEntries + 1 };
    onChange({ ...value, name: 'custom', ranges });
  };

  const parse = (text: string) =>
    text
      .split(/[,\s]+/)
      .map((x) => Number(x))
      .filter((x) => x > 0);

  const prizes = placePrizes(testPool, value, entries);

  return (
    <div className="tn-payouts">
      <label>
        Preset
        <select
          value={value.name in PRESETS ? value.name : ''}
          onChange={(e) => {
            setDrafts({});
            onChange(payoutPreset(e.target.value as PayoutPresetName, maxEntrants));
          }}
        >
          <option value="" disabled>
            Custom
          </option>
          {(Object.keys(PRESETS) as PayoutPresetName[]).map((p) => (
            <option key={p} value={p}>
              {PRESETS[p]}
            </option>
          ))}
        </select>
      </label>
      <details className="tn-details">
        <summary>Edit ranges ({value.ranges.length})</summary>
        {value.ranges.map((r, i) => (
          <div className="tn-range" key={i}>
            <span className="tn-range-entries">
              {r.minEntries}–
              <input
                type="number"
                min={r.minEntries}
                value={r.maxEntries}
                aria-label="Up to entries"
                onChange={(e) => setRange(i, { maxEntries: Math.max(r.minEntries, Math.floor(Number(e.target.value) || 0)) })}
              />
              entries
            </span>
            <input
              className="tn-range-pct"
              value={drafts[i] ?? r.percents.join(', ')}
              aria-label="Percent per place"
              onChange={(e) => {
                setDrafts({ ...drafts, [i]: e.target.value });
                setRange(i, { percents: parse(e.target.value) });
              }}
            />
            <button type="button" aria-label="Remove range" disabled={value.ranges.length === 1} onClick={() => onChange({ ...value, name: 'custom', ranges: value.ranges.filter((_, j) => j !== i) })}>
              ✕
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => {
            const last = value.ranges[value.ranges.length - 1];
            onChange({ ...value, name: 'custom', ranges: [...value.ranges, { minEntries: last.maxEntries + 1, maxEntries: maxEntrants, percents: last.percents }] });
          }}
        >
          + Add range
        </button>
      </details>
      {value.roundTo ? <p className="muted">Prizes below 1st are rounded to the nearest {money(value.roundTo)}; anything left over goes to 1st.</p> : null}
      {errors.map((e) => (
        <p className="error" key={e}>
          {e}
        </p>
      ))}
      <div className="tn-tester">
        <b>Try it</b>
        <div className="row">
          <label>
            Entries
            <input type="number" min={2} max={maxEntrants} value={entries} onChange={(e) => setEntries(Math.floor(Number(e.target.value) || 2))} />
          </label>
          <label>
            Prize pool ($)
            <input type="number" min={0} value={testPool / 100} onChange={(e) => setTestPool(Math.round(Number(e.target.value) * 100))} />
          </label>
        </div>
        <PrizeList prizes={prizes} />
      </div>
    </div>
  );
}

export function PrizeList({ prizes }: { prizes: number[] }) {
  if (!prizes.length) return <p className="muted">No payout for this many entries.</p>;
  return (
    <ol className="tn-prizes">
      {prizes.map((p, i) => (
        <li key={i}>
          <span>{ordinal(i + 1)}</span>
          <b>{money(p)}</b>
        </li>
      ))}
    </ol>
  );
}

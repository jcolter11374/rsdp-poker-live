import type { ReactNode } from 'react';
import { fromInput, toInput } from '../../format';

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label>
      {label}
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

export function ChipsField(props: { label: string; value: number; cents: boolean; onChange: (v: number) => void; hint?: string; disabled?: boolean }) {
  const { label, value, cents, onChange, hint, disabled } = props;
  return (
    <Field label={label} hint={hint}>
      <input type="number" min={0} step={cents ? 0.01 : 1} disabled={disabled} value={toInput(cents, value)} onChange={(e) => onChange(fromInput(cents, +e.target.value))} />
    </Field>
  );
}

export function NumberField(props: { label: string; value: number; min: number; max: number; onChange: (v: number) => void; hint?: string; disabled?: boolean }) {
  const { label, value, min, max, onChange, hint, disabled } = props;
  return (
    <Field label={label} hint={hint}>
      <input type="number" min={min} max={max} disabled={disabled} value={value} onChange={(e) => onChange(Math.round(+e.target.value))} />
    </Field>
  );
}

export function Toggle({ label, checked, onChange, disabled = false }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

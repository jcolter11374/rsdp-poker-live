import { useState, type ReactNode } from 'react';
import { SETUP_NAME_MAX, type SavedSetup } from '@rsdp/engine/wire';
import type { SetupList } from '../savedSetups';

/** One saved setup: its name, the caller's buttons, and Rename and Delete. */
export function SavedSetupRow({
  setup,
  list,
  what,
  onMessage,
  children,
}: {
  setup: SavedSetup;
  list: SetupList;
  /** What to call it in messages, e.g. "preset". */
  what: string;
  onMessage: (text: string, error?: boolean) => void;
  children?: ReactNode;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const fail = (e: unknown) => onMessage(e instanceof Error ? e.message : String(e), true);

  if (editing !== null) {
    const save = () =>
      list.rename(setup.name, editing).then((name) => {
        setEditing(null);
        onMessage(`Renamed to “${name}”.`);
      }, fail);
    return (
      <div className="row setup-row">
        <input
          autoFocus
          aria-label={`New name for ${setup.name}`}
          value={editing}
          maxLength={SETUP_NAME_MAX}
          onChange={(e) => setEditing(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.preventDefault(), save();
            if (e.key === 'Escape') setEditing(null);
          }}
        />
        <button type="button" className="primary" disabled={!editing.trim()} onClick={save}>
          Save
        </button>
        <button type="button" onClick={() => setEditing(null)}>
          Cancel
        </button>
      </div>
    );
  }
  return (
    <div className="row setup-row">
      <span className="who" title={setup.name}>{setup.name}</span>
      {children}
      <button type="button" onClick={() => setEditing(setup.name)}>
        Rename
      </button>
      <button
        type="button"
        className="danger"
        title="Delete"
        aria-label={`Delete ${setup.name}`}
        onClick={() => confirm(`Delete the ${what} “${setup.name}”?`) && list.remove(setup.name).catch(fail)}
      >
        ✕
      </button>
    </div>
  );
}

import { useRef, useState } from 'react';
import type { TableSettings } from '@rsdp/engine/settings';
import { addPresetFile, presetSettings, savePreset, tablePresets, usePresets, type SavedPreset } from '../../presets';
import { download } from '../../records';
import { SavedSetupRow } from '../SavedSetupRow';

/** Puts a preset's setup on a table, keeping the table's own name and mode. */
export function withPreset(table: TableSettings, preset: TableSettings): TableSettings {
  return { ...structuredClone(preset), table: { ...preset.table, name: table.table.name, mode: table.table.mode } };
}

const fileName = (name: string) => `${name.replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '') || 'table'}.rsdp-preset.json`;

/** Saved table setups: save the settings being edited, load one into them, and share them as files. */
export function PresetsTab({ draft, onApply, tournament }: { draft: TableSettings; onApply: (next: TableSettings) => void; tournament: boolean }) {
  const presets = usePresets();
  const onAccount = tablePresets.useOnAccount();
  const [name, setName] = useState('');
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const file = useRef<HTMLInputElement>(null);
  if (tournament) return <p className="muted">Presets are for cash tables. Tournaments copy their setup from the lobby.</p>;

  const fail = (e: unknown) => setMsg({ text: e instanceof Error ? e.message : String(e), error: true });
  const save = () =>
    savePreset(name, draft).then((saved) => {
      setName('');
      setMsg({ text: `Saved “${saved}”.` });
    }, fail);
  const apply = (p: SavedPreset) => {
    try {
      onApply(withPreset(draft, presetSettings(p)));
      setMsg({ text: `Loaded “${p.name}”. Check the other tabs, then press Save.` });
    } catch (e) {
      fail(e);
    }
  };
  const importFile = async (f: File | undefined) => {
    if (!f) return;
    try {
      const saved = await addPresetFile(await f.text());
      setMsg({ text: `Added “${saved}”.` });
    } catch (e) {
      fail(e);
    } finally {
      if (file.current) file.current.value = '';
    }
  };

  return (
    <>
      <p className="hint">
        A preset is a whole table setup: game, stakes, clock, seats, rules, side games, chat and watching.{' '}
        {onAccount ? 'Presets are kept on your account, so they follow you to any device.' : 'Presets live in this browser; sign in to keep them on every device.'} Export one to
        send it to a friend.
      </p>
      <div className="row">
        <input value={name} maxLength={60} placeholder="Name, e.g. Friday PLO" onChange={(e) => setName(e.target.value)} />
        <button type="button" disabled={!name.trim()} onClick={save}>
          Save these settings
        </button>
      </div>
      {presets.length === 0 && <p className="muted">No presets yet.</p>}
      {presets.map((p) => (
        <SavedSetupRow key={p.name} setup={p} list={tablePresets} what="preset" onMessage={(text, error) => setMsg({ text, error })}>
          <button type="button" onClick={() => apply(p)}>
            Load
          </button>
          <button type="button" title="Download as a file" onClick={() => download(fileName(p.name), p.json, 'application/json')}>
            Export
          </button>
        </SavedSetupRow>
      ))}
      <div className="row">
        <button type="button" onClick={() => file.current?.click()}>
          Import a preset file
        </button>
        <input ref={file} type="file" accept=".json,application/json" hidden onChange={(e) => importFile(e.target.files?.[0])} />
      </div>
      {msg && <p className={msg.error ? 'error' : 'muted'}>{msg.text}</p>}
    </>
  );
}

import { useState } from 'react';
import { FELTS } from '@rsdp/engine/settings';
import type { TableView } from '@rsdp/engine/wire';
import { call } from '../socket';
import { BACKS, FELT_COLORS, setPrefs, usePrefs, type Back, type Felt } from '../prefs';
import { Modal } from './SeatDialog';
import { PlayingCard } from './PlayingCard';

const swatch = (f: Felt) => ({ background: `radial-gradient(circle, ${FELT_COLORS[f].light}, ${FELT_COLORS[f].edge})` });

/** Felt, deck and card backs. Your own picks stay in this browser; the host also sets the felt everyone starts with. */
export function LookDialog({ view, onClose }: { view: TableView; onClose: () => void }) {
  const prefs = usePrefs();
  const [error, setError] = useState('');
  const tableFelt = view.settings.table.felt ?? 'green';
  const setTableFelt = (felt: Felt) =>
    call('host:settings', { patch: { table: { felt } } })
      .then(() => setError(''))
      .catch((e: Error) => setError(e.message));

  return (
    <Modal title="Table look" onClose={onClose}>
      <div className="look">
        {view.isHost && (
          <>
            <h3>Felt for everyone</h3>
            <div className="swatches">
              {FELTS.map((f) => (
                <button key={f} className={`swatch ${tableFelt === f ? 'active' : ''}`} style={swatch(f)} onClick={() => setTableFelt(f)} aria-pressed={tableFelt === f}>
                  {FELT_COLORS[f].name}
                </button>
              ))}
            </div>
            {error && <p className="error">{error}</p>}
          </>
        )}
        <h3>Felt I see</h3>
        <div className="swatches">
          <button className={`swatch host ${prefs.felt === 'table' ? 'active' : ''}`} style={swatch(tableFelt)} onClick={() => setPrefs({ felt: 'table' })} aria-pressed={prefs.felt === 'table'}>
            Host’s pick
          </button>
          {FELTS.map((f) => (
            <button key={f} className={`swatch ${prefs.felt === f ? 'active' : ''}`} style={swatch(f)} onClick={() => setPrefs({ felt: f })} aria-pressed={prefs.felt === f}>
              {FELT_COLORS[f].name}
            </button>
          ))}
        </div>
        <h3>Deck</h3>
        <div className="row wrap">
          {(['two', 'four'] as const).map((d) => (
            <label key={d} className="toggle">
              <input type="radio" name="deck" checked={prefs.deck === d} onChange={() => setPrefs({ deck: d })} />
              {d === 'two' ? 'Two colours' : 'Four colours'}
            </label>
          ))}
        </div>
        <div className="look-sample">
          {['As', 'Kh', 'Qd', 'Jc'].map((c) => (
            <PlayingCard key={c} card={c} />
          ))}
        </div>
        <h3>Card backs</h3>
        <div className="row wrap look-backs">
          {(Object.keys(BACKS) as Back[]).map((b) => (
            <button key={b} className={`back-pick ${prefs.back === b ? 'active' : ''}`} data-back={b} onClick={() => setPrefs({ back: b })} aria-pressed={prefs.back === b} title={BACKS[b]}>
              <PlayingCard card={null} />
              <span>{BACKS[b]}</span>
            </button>
          ))}
        </div>
        <p className="muted">Your picks are saved in this browser and only you see them.</p>
        <div className="row">
          <button className="primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </Modal>
  );
}

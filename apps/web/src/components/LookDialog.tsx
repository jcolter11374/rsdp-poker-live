import { useState } from 'react';
import { FELTS } from '@rsdp/engine/settings';
import type { TableView } from '@rsdp/engine/wire';
import { call } from '../socket';
import { BACKS, FELT_COLORS, setPrefs, usePrefs, type Back, type Felt, type GestureMode } from '../prefs';
import { setVolume, sounds, useVolume, VOLUME_NAME, VOLUMES } from '../sound';
import { Modal } from './SeatDialog';
import { PlayingCard } from './PlayingCard';
import { MyProfile } from './table/Persona';

type LookTab = 'me' | 'table' | 'sound';
const LOOK_TABS: { id: LookTab; label: string }[] = [
  { id: 'me', label: 'Me' },
  { id: 'table', label: 'Table' },
  { id: 'sound', label: 'Sound & extras' },
];
const GESTURE_MODES: { id: GestureMode; label: string }[] = [
  { id: 'sound', label: 'Show with sound' },
  { id: 'silent', label: 'Show, no sound' },
  { id: 'off', label: 'Hide' },
];

const swatch = (f: Felt) => ({ background: FELT_COLORS[f].felt, boxShadow: `inset 0 0 0 5px ${FELT_COLORS[f].edge}` });

/**
 * My picture and mood; felt, deck, card backs and amounts; sounds and what
 * else shows at the table. Your own picks stay in this browser; the host also
 * sets the felt everyone starts with.
 */
export function LookDialog({ view, onClose, initialTab = 'table' }: { view: TableView; onClose: () => void; initialTab?: LookTab }) {
  const prefs = usePrefs();
  const volume = useVolume();
  const [tab, setTab] = useState<LookTab>(initialTab);
  const [error, setError] = useState('');
  const tableFelt = view.settings.table.felt ?? 'green';
  const setTableFelt = (felt: Felt) =>
    call('host:settings', { patch: { table: { felt } } })
      .then(() => setError(''))
      .catch((e: Error) => setError(e.message));

  return (
    <Modal title="Look and sound" onClose={onClose}>
      <div className="tabs">
        {LOOK_TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="look">
        {tab === 'me' && <MyProfile view={view} />}
        {tab === 'sound' && (
          <>
            <h3 id="look-volume">Volume</h3>
            <div className="row wrap" role="radiogroup" aria-labelledby="look-volume">
              {VOLUMES.map((v) => (
                <label key={v} className="toggle">
                  <input
                    type="radio"
                    name="volume"
                    checked={volume === v}
                    onChange={() => {
                      setVolume(v);
                      if (v > 0) sounds.turn();
                    }}
                  />
                  {VOLUME_NAME[v].replace('Sound ', '')}
                </label>
              ))}
            </div>
            <label className="toggle">
              <input type="checkbox" checked={prefs.tableSounds} onChange={(e) => setPrefs({ tableSounds: e.target.checked })} />
              Table sounds (cards, chips, checks and folds)
            </label>
            <label className="toggle">
              <input type="checkbox" checked={prefs.chatSound} onChange={(e) => setPrefs({ chatSound: e.target.checked })} />
              Beep for new chat messages
            </label>
            <p className="hint">Your turn and the low-time warning always sound unless the volume is off.</p>
            <h3 id="look-gestures">Gestures</h3>
            <div className="row wrap" role="radiogroup" aria-labelledby="look-gestures">
              {GESTURE_MODES.map((g) => (
                <label key={g.id} className="toggle">
                  <input type="radio" name="gestures" checked={prefs.gestures === g.id} onChange={() => setPrefs({ gestures: g.id })} />
                  {g.label}
                </label>
              ))}
            </div>
            <p className="hint">Tap another player's seat to throw one.</p>
            <h3>At the table</h3>
            <label className="toggle">
              <input type="checkbox" checked={prefs.avatars} onChange={(e) => setPrefs({ avatars: e.target.checked })} />
              Show players' pictures
            </label>
            {prefs.hiddenAvatars.length > 0 && <button onClick={() => setPrefs({ hiddenAvatars: [] })}>Show the {prefs.hiddenAvatars.length} I hid</button>}
            <label className="toggle">
              <input type="checkbox" checked={prefs.moods} onChange={(e) => setPrefs({ moods: e.target.checked })} />
              Show mood emoji
            </label>
            <label className="toggle">
              <input type="checkbox" checked={prefs.wakeLock} onChange={(e) => setPrefs({ wakeLock: e.target.checked })} />
              Keep the screen on while I'm seated
            </label>
          </>
        )}
        {tab === 'table' && view.isHost && view.mode !== 'tournament' && (
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
        {tab === 'table' && (
          <>
            <h3 id="look-units">Amounts on the table</h3>
            <div className="row wrap" role="radiogroup" aria-labelledby="look-units">
              <label className="toggle">
                <input type="radio" name="units" checked={prefs.units === 'chips'} onChange={() => setPrefs({ units: 'chips' })} />
                Chips
              </label>
              <label className="toggle">
                <input type="radio" name="units" checked={prefs.units === 'bb'} onChange={() => setPrefs({ units: 'bb' })} />
                Big blinds
              </label>
            </div>
            <p className="hint">Press B at the table to switch. Stud games always show chips.</p>
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
            <h3 id="look-deck">Deck</h3>
            <div className="row wrap" role="radiogroup" aria-labelledby="look-deck">
              {(['two', 'four'] as const).map((d) => (
                <label key={d} className="toggle">
                  <input type="radio" name="deck" checked={prefs.deck === d} onChange={() => setPrefs({ deck: d })} />
                  {d === 'two' ? 'Two colours' : 'Four colours'}
                </label>
              ))}
            </div>
            <div className="look-sample" aria-hidden="true">
              {['As', 'Kh', 'Qd', 'Jc'].map((c) => (
                <PlayingCard key={c} card={c} />
              ))}
            </div>
            <h3>Card backs</h3>
            <div className="row wrap look-backs">
              {(Object.keys(BACKS) as Back[]).map((b) => (
                <button key={b} className={`back-pick ${prefs.back === b ? 'active' : ''}`} data-back={b} onClick={() => setPrefs({ back: b })} aria-pressed={prefs.back === b} title={BACKS[b]}>
                  <span className="playing-card back" aria-hidden="true" />
                  <span>{BACKS[b]}</span>
                </button>
              ))}
            </div>
          </>
        )}
        <p className="muted">{tab === 'me' ? 'Everyone at your tables sees your picture and mood.' : 'Your picks are saved in this browser and only you see them.'}</p>
        <div className="row">
          <button className="primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </Modal>
  );
}

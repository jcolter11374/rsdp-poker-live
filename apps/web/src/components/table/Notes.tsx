import { useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { NOTE_COLORS, NOTE_MAX, type NoteColor, type PlayerNote, type SeatView } from '@rsdp/engine/wire';
import { call, socket } from '../../socket';
import { Modal } from '../SeatDialog';

/*
 * Private notes on other players, with a colour tag, like PokerNow's. They
 * follow your browser identity to every table, and nobody else ever sees them.
 */

let notes = new Map<string, PlayerNote>();
const listeners = new Set<() => void>();
const replace = (list: PlayerNote[]) => {
  notes = new Map(list.map((n) => [n.targetPlayerId, n]));
  listeners.forEach((cb) => cb());
};
socket.on('notes', replace);
const load = () => call<{ notes: PlayerNote[] }>('notes:list').then((r) => replace(r.notes), () => {});
socket.on('connect', load);
if (socket.connected) load();

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};
export const useNote = (playerId: string) => useSyncExternalStore(subscribe, () => notes.get(playerId));

const COLOR_HEX: Record<NoteColor, string> = {
  none: 'transparent',
  red: '#e5484d',
  orange: '#f76b15',
  yellow: '#ffc53d',
  green: '#30a46c',
  blue: '#3e63dd',
  purple: '#8e4ec6',
};

/** The note marker on someone else's nameplate; tap it to write or change the note. */
export function NoteBadge({ seat }: { seat: SeatView }) {
  const note = useNote(seat.playerId);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        className={`note-badge ${note ? 'has-note' : ''}`}
        style={note && note.color !== 'none' ? { background: COLOR_HEX[note.color] } : undefined}
        title={note?.text || `Add a private note on ${seat.name}`}
        aria-label={note ? `Your note on ${seat.name}` : `Add a note on ${seat.name}`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
      >
        {note?.text ? '✎' : '+'}
      </button>
      {open &&
        createPortal(
          // Portalled clicks still bubble through React to the nameplate (the host's seat menu).
          <div onClick={(e) => e.stopPropagation()}>
            <NoteEditor seat={seat} note={note} onClose={() => setOpen(false)} />
          </div>,
          document.body,
        )}
    </>
  );
}

/** "Add a private note" in the seat pop-up, for phones, where the badge on the nameplate is hidden. */
export function NoteButton({ seat }: { seat: SeatView }) {
  const note = useNote(seat.playerId);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="note-button" onClick={() => setOpen(true)}>
        {note ? '✎ Edit your private note' : '+ Add a private note'}
      </button>
      {open && createPortal(<NoteEditor seat={seat} note={note} onClose={() => setOpen(false)} />, document.body)}
    </>
  );
}

function NoteEditor({ seat, note, onClose }: { seat: SeatView; note: PlayerNote | undefined; onClose: () => void }) {
  const [text, setText] = useState(note?.text ?? '');
  const [color, setColor] = useState<NoteColor>(note?.color ?? 'none');
  const [error, setError] = useState('');
  const save = (value: PlayerNote) =>
    call('notes:set', value)
      .then(onClose)
      .catch((e: Error) => setError(e.message));
  return (
    <Modal title={`Note on ${seat.name}`} onClose={onClose}>
      <p className="muted">Only you can see this. It follows this player to every table.</p>
      <div className="note-colors" role="radiogroup" aria-label="Colour">
        {NOTE_COLORS.map((c) => (
          <button
            key={c}
            role="radio"
            aria-checked={color === c}
            aria-label={c === 'none' ? 'No colour' : c}
            className={`note-swatch ${color === c ? 'picked' : ''} ${c}`}
            style={{ background: COLOR_HEX[c] }}
            onClick={() => setColor(c)}
          />
        ))}
      </div>
      <textarea
        className="note-text"
        value={text}
        maxLength={NOTE_MAX}
        rows={4}
        placeholder="Plays every ace, folds to river bets..."
        onChange={(e) => setText(e.target.value)}
        autoFocus
      />
      {error && <p className="error">{error}</p>}
      <div className="row">
        <button className="primary" onClick={() => save({ targetPlayerId: seat.playerId, text, color })}>
          Save
        </button>
        {note && <button onClick={() => save({ targetPlayerId: seat.playerId, text: '', color: 'none' })}>Delete note</button>}
        <button onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}

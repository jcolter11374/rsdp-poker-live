import { useState } from 'react';
import type { TableView } from '@rsdp/engine/wire';
import { call } from '../socket';
import type { Fmt } from '../format';
import { Modal } from './SeatDialog';
import { setChatMuted, useChatMutes } from '../chatMutes';

/** Who is at the table: seated players and everyone watching. The host can hand the table over. */
export function PeopleDialog({ view, fmt, onClose }: { view: TableView; fmt: Fmt; onClose: () => void }) {
  const [error, setError] = useState('');
  const canHandOff = view.isHost && view.mode === 'cash';
  const handOff = (playerId: string, name: string) => {
    if (!confirm(`Make ${name} the host? You will lose host controls.`)) return;
    call('host:transfer', { playerId })
      .then(() => setError(''))
      .catch((e: Error) => setError(e.message));
  };
  const seated = view.seats.filter((s) => s !== null);
  const mine = useChatMutes();
  /** Chat mutes: mine (only I stop seeing them) and, for the host, the table's. */
  const mutes = (playerId: string) =>
    playerId === view.me.playerId ? null : (
      <>
        <button className="link" title={mine.includes(playerId) ? 'See their chat again' : 'Hide their chat from you'} onClick={() => setChatMuted(playerId, !mine.includes(playerId))}>
          {mine.includes(playerId) ? 'Unhide chat' : 'Hide chat'}
        </button>
        {view.isHost && (
          <button
            className="link"
            title={view.muted.includes(playerId) ? 'Let them chat again' : 'Stop them chatting at this table'}
            onClick={() =>
              call('host:mute', { playerId, value: !view.muted.includes(playerId) })
                .then(() => setError(''))
                .catch((e: Error) => setError(e.message))
            }
          >
            {view.muted.includes(playerId) ? 'Unmute' : 'Mute'}
          </button>
        )}
      </>
    );
  return (
    <Modal title="People" onClose={onClose}>
      <div className="people">
        <h3>Playing ({seated.length})</h3>
        {seated.map((s) => (
          <div className="person" key={s.playerId}>
            <span className={`dot ${s.online ? 'on' : 'off'}`} title={s.online ? 'Online' : 'Offline'} />
            <span className="who">
              {s.name}
              {s.playerId === view.hostId && <span className="tag">host</span>}
              {s.bot && <span className="muted"> · {s.bot.ownerName}&rsquo;s bot</span>}
              {s.playerId === view.me.playerId && <span className="muted"> (you)</span>}
            </span>
            <span className="muted">{s.sittingOut ? 'away' : fmt(s.stack)}</span>
            {!s.bot && mutes(s.playerId)}
            {canHandOff && s.online && !s.bot && s.playerId !== view.me.playerId && <button onClick={() => handOff(s.playerId, s.name)}>Make host</button>}
          </div>
        ))}
        <h3>Watching ({view.watchers.length})</h3>
        {view.watchers.length === 0 && <p className="muted">Nobody is watching.</p>}
        {view.watchers.map((w) => (
          <div className="person" key={w.playerId}>
            <span className="dot on" />
            <span className="who">
              {w.name}
              {w.playerId === view.hostId && <span className="tag">host</span>}
              {w.playerId === view.me.playerId && <span className="muted"> (you)</span>}
            </span>
            {mutes(w.playerId)}
            {canHandOff && w.playerId !== view.me.playerId && <button onClick={() => handOff(w.playerId, w.name)}>Make host</button>}
          </div>
        ))}
        {view.mode === 'cash' && <p className="hint">If the host is offline for 3 minutes, the table passes to a seated player so nobody gets stuck.</p>}
        {error && <p className="error">{error}</p>}
        <button onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}

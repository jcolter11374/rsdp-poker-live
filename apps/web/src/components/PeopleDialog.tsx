import { useState } from 'react';
import type { TableView } from '@rsdp/engine/wire';
import { HOST_POWERS, HOST_POWER_LABELS, type HostPower } from '@rsdp/engine/roles';
import { call } from '../socket';
import type { Fmt } from '../format';
import { Modal } from './SeatDialog';
import { setChatMuted, useChatMutes } from '../chatMutes';
import { botPlateLabel } from './table/BotLevels';

/** Who is at the table: seated players and everyone watching. The host can name co-hosts and hand the table over. */
export function PeopleDialog({ view, fmt, onClose }: { view: TableView; fmt: Fmt; onClose: () => void }) {
  const [error, setError] = useState('');
  const canHandOff = view.isHost && view.mode === 'cash';
  const run = (p: Promise<unknown>) => p.then(() => setError('')).catch((e: Error) => setError(e.message));
  const handOff = (playerId: string, name: string) => {
    if (!confirm(`Make ${name} the host? You stay on as a co-host with every power.`)) return;
    run(call('host:transfer', { playerId }));
  };
  const coHost = (playerId: string) => view.coHosts.find((c) => c.playerId === playerId);
  const toggle = (powers: HostPower[], p: HostPower) => (powers.includes(p) ? powers.filter((x) => x !== p) : [...powers, p]);
  /** The host's co-host button for one person. */
  const coHostButton = (playerId: string) =>
    canHandOff &&
    playerId !== view.me.playerId &&
    (coHost(playerId) ? (
      <button className="link" onClick={() => run(call('host:removeCoHost', { playerId }))}>
        Remove co-host
      </button>
    ) : (
      <button className="link" title="Let them help run the table" onClick={() => run(call('host:coHost', { playerId, powers: ['approve', 'run'] }))}>
        Make co-host
      </button>
    ));
  const tags = (playerId: string) => (
    <>
      {playerId === view.hostId && <span className="tag">host</span>}
      {coHost(playerId) && <span className="tag">co-host</span>}
      {playerId === view.me.playerId && <span className="muted"> (you)</span>}
    </>
  );
  const myCoHost = coHost(view.me.playerId);
  const seated = view.seats.filter((s) => s !== null);
  const mine = useChatMutes();
  /** Chat mutes: mine (only I stop seeing them) and, for the host, the table's. */
  const mutes = (playerId: string) =>
    playerId === view.me.playerId ? null : (
      <>
        <button
          className="link"
          title={mine.includes(playerId) ? 'See their chat again' : 'Hide their chat from you'}
          onClick={() => setChatMuted(playerId, !mine.includes(playerId))}
        >
          {mine.includes(playerId) ? 'Unhide chat' : 'Hide chat'}
        </button>
        {view.powers.includes('players') && (view.isHost || (playerId !== view.hostId && !coHost(playerId))) && (
          <button
            className="link"
            title={view.muted.includes(playerId) ? 'Let them chat again' : 'Stop them chatting at this table'}
            onClick={() => run(call('host:mute', { playerId, value: !view.muted.includes(playerId) }))}
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
              {tags(s.playerId)}
              {s.bot && <span className="muted"> · {botPlateLabel(s.bot)}</span>}
            </span>
            <span className="muted">{s.sittingOut ? 'away' : fmt(s.stack)}</span>
            {!s.bot && mutes(s.playerId)}
            {!s.bot && coHostButton(s.playerId)}
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
              {tags(w.playerId)}
            </span>
            {mutes(w.playerId)}
            {coHostButton(w.playerId)}
            {canHandOff && w.playerId !== view.me.playerId && <button onClick={() => handOff(w.playerId, w.name)}>Make host</button>}
          </div>
        ))}
        {canHandOff && view.coHosts.length > 0 && (
          <>
            <h3>Co-hosts</h3>
            <p className="hint">Co-hosts help run the table with the powers you tick. Only you can change co-hosts or hand over the table.</p>
            {view.coHosts.map((c) => (
              <div className="cohost" key={c.playerId}>
                <b>{c.name}</b>
                <div className="row wrap">
                  {HOST_POWERS.map((p) => (
                    <label key={p} className="check">
                      <input
                        type="checkbox"
                        checked={c.powers.includes(p)}
                        onChange={() => run(call('host:coHost', { playerId: c.playerId, powers: toggle(c.powers, p) }))}
                      />
                      {HOST_POWER_LABELS[p]}
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </>
        )}
        {myCoHost && (
          <p className="hint">
            You're a co-host. The host has let you:{' '}
            {myCoHost.powers.length ? myCoHost.powers.map((p) => HOST_POWER_LABELS[p].toLowerCase()).join('; ') : 'see the host tools'}.{' '}
            <button className="link" onClick={() => run(call('host:removeCoHost', { playerId: view.me.playerId }))}>
              Step down
            </button>
          </p>
        )}
        {view.mode === 'cash' && (
          <p className="hint">If the host is offline for 3 minutes, the table passes to an online co-host, or else a seated player, so nobody gets stuck.</p>
        )}
        {error && <p className="error">{error}</p>}
        <button onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}

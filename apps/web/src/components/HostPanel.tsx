import { useState } from 'react';
import type { RoomView } from '@rsdp/engine';
import { socket } from '../socket';

export function HostPanel({ view }: { view: RoomView }) {
  const [sb, setSb] = useState(view.config.smallBlind);
  const [bb, setBb] = useState(view.config.bigBlind);
  const [clock, setClock] = useState(view.turnSeconds);
  const [msg, setMsg] = useState('');

  const ack = (okText: string) => (res: { ok: boolean; error?: string }) =>
    setMsg(res.ok ? okText : (res.error ?? 'error'));

  return (
    <div className="panel host-panel">
      <h3>Host controls</h3>
      {view.requests.length > 0 && (
        <div className="requests">
          {view.requests.map((r) => (
            <div className="request" key={r.id}>
              <span>
                <b>{r.name}</b> wants seat {r.seat + 1} with {r.stack}
              </span>
              <button className="primary" onClick={() => socket.emit('host:approve', { requestId: r.id }, ack('Approved'))}>
                Approve
              </button>
              <button onClick={() => socket.emit('host:reject', { requestId: r.id })}>Reject</button>
            </div>
          ))}
        </div>
      )}
      <div className="row">
        {!view.running ? (
          <button className="primary" onClick={() => socket.emit('host:start', ack('Started'))}>
            Start game
          </button>
        ) : (
          <button onClick={() => socket.emit('host:pause', { value: !view.paused })}>
            {view.paused ? 'Resume' : 'Pause'}
          </button>
        )}
      </div>
      <form
        className="row settings"
        onSubmit={(e) => {
          e.preventDefault();
          socket.emit('host:settings', { smallBlind: sb, bigBlind: bb, turnSeconds: clock }, ack('Saved, applies next hand'));
        }}
      >
        <label>
          SB <input type="number" min={1} value={sb} onChange={(e) => setSb(+e.target.value)} />
        </label>
        <label>
          BB <input type="number" min={1} value={bb} onChange={(e) => setBb(+e.target.value)} />
        </label>
        <label>
          Clock <input type="number" min={0} value={clock} onChange={(e) => setClock(+e.target.value)} />
        </label>
        <button>Save</button>
      </form>
      {msg && <p className="muted">{msg}</p>}
    </div>
  );
}

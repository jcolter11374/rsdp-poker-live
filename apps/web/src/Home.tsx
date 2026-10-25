import { useState } from 'react';
import { saveName, savedName, socket } from './socket';

export function Home({ onCreated }: { onCreated: (roomId: string) => void }) {
  const [name, setName] = useState(savedName);
  const [smallBlind, setSmallBlind] = useState(1);
  const [bigBlind, setBigBlind] = useState(2);
  const [turnSeconds, setTurnSeconds] = useState(30);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const create = (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    saveName(name);
    socket.emit('room:create', { hostName: name, smallBlind, bigBlind, turnSeconds }, (res) => {
      setBusy(false);
      if (res.ok) onCreated(res.roomId);
      else setError(res.error);
    });
  };

  return (
    <main className="home">
      <h1 className="logo">
        RSDP Poker <span>Live!</span>
      </h1>
      <p className="tagline">Start a Texas Hold'em table, send the link, and play with friends. No sign-up.</p>
      <form className="card-panel" onSubmit={create}>
        <label>
          Your name
          <input value={name} maxLength={20} required onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="row">
          <label>
            Small blind
            <input type="number" min={1} value={smallBlind} onChange={(e) => setSmallBlind(+e.target.value)} />
          </label>
          <label>
            Big blind
            <input type="number" min={1} value={bigBlind} onChange={(e) => setBigBlind(+e.target.value)} />
          </label>
        </div>
        <label>
          Turn clock (seconds, 0 for none)
          <input type="number" min={0} max={600} value={turnSeconds} onChange={(e) => setTurnSeconds(+e.target.value)} />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="primary big" disabled={busy}>
          Create table
        </button>
      </form>
    </main>
  );
}

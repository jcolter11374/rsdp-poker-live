import { useState } from 'react';
import { saveName, savedName, socket } from '../socket';

export function SeatDialog({ seat, bigBlind, onClose }: { seat: number; bigBlind: number; onClose: () => void }) {
  const [name, setName] = useState(savedName);
  const [stack, setStack] = useState(bigBlind * 100);
  const [error, setError] = useState('');

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    saveName(name);
    socket.emit('seat:request', { seat, name, stack }, (res) => {
      if (res.ok) onClose();
      else setError(res.error);
    });
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="card-panel modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>Take seat {seat + 1}</h2>
        <label>
          Name
          <input value={name} maxLength={20} required autoFocus onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Stack
          <input type="number" min={1} value={stack} onChange={(e) => setStack(+e.target.value)} />
        </label>
        {error && <p className="error">{error}</p>}
        <div className="row">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary">Request seat</button>
        </div>
      </form>
    </div>
  );
}

import { useState, type ReactNode } from 'react';
import type { SeatView, TableView } from '@rsdp/engine/wire';
import { call, saveName, savedName } from '../socket';
import { fromInput, toInput, type Fmt } from '../format';

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="card-panel modal" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

/** A sensible starting stack: the table's minimum or maximum if set, else 100 big blinds. */
function defaultStack(view: TableView) {
  const { minBuyIn, maxBuyIn } = view.settings.seating;
  const stakes = view.hand?.stakes ?? view.upcoming?.stakes ?? view.settings.stakes;
  const base = Math.max(stakes.bigBlind, stakes.bigBet / 2, stakes.bringIn * 5, 1) * 100;
  if (maxBuyIn > 0) return Math.min(maxBuyIn, Math.max(base, minBuyIn));
  return Math.max(base, minBuyIn);
}

function buyInHint(view: TableView, fmt: Fmt) {
  const { minBuyIn, maxBuyIn } = view.settings.seating;
  if (minBuyIn > 0 && maxBuyIn > 0) return `Between ${fmt(minBuyIn)} and ${fmt(maxBuyIn)}.`;
  if (minBuyIn > 0) return `At least ${fmt(minBuyIn)}.`;
  if (maxBuyIn > 0) return `Up to ${fmt(maxBuyIn)}.`;
  return null;
}

export function SeatDialog({ view, seat, fmt, onClose }: { view: TableView; seat: number; fmt: Fmt; onClose: () => void }) {
  const cents = view.settings.stakes.centsMode;
  const [name, setName] = useState(savedName);
  const [stack, setStack] = useState(toInput(cents, defaultStack(view)));
  const [error, setError] = useState('');
  const hint = buyInHint(view, fmt);
  const approval = view.settings.seating.requireApproval && !view.isHost;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    saveName(name);
    call('seat:request', { seat, name, stack: fromInput(cents, stack) })
      .then(onClose)
      .catch((err: Error) => setError(err.message));
  };

  return (
    <Modal title={`Take seat ${seat + 1}`} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>
          Name
          <input value={name} maxLength={20} required autoFocus onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Chips
          <input type="number" min={0} step={cents ? 0.01 : 1} value={stack} onChange={(e) => setStack(+e.target.value)} />
        </label>
        {hint && <p className="muted">{hint}</p>}
        {approval && <p className="muted">The host approves new players.</p>}
        {error && <p className="error">{error}</p>}
        <div className="row">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary">{approval ? 'Ask to sit' : 'Sit down'}</button>
        </div>
      </form>
    </Modal>
  );
}

export function RebuyDialog({ view, fmt, onClose }: { view: TableView; fmt: Fmt; onClose: () => void }) {
  const cents = view.settings.stakes.centsMode;
  const [amount, setAmount] = useState(toInput(cents, defaultStack(view)));
  const [error, setError] = useState('');
  const approval = view.settings.seating.rebuyRequiresApproval && !view.isHost;
  const maxBuyIn = view.settings.seating.maxBuyIn;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    call('seat:rebuy', { amount: fromInput(cents, amount) })
      .then(onClose)
      .catch((err: Error) => setError(err.message));
  };

  return (
    <Modal title="Add chips" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>
          Chips to add
          <input type="number" min={0} step={cents ? 0.01 : 1} value={amount} autoFocus onChange={(e) => setAmount(+e.target.value)} />
        </label>
        {maxBuyIn > 0 && <p className="muted">You can have up to {fmt(maxBuyIn)} in front of you.</p>}
        <p className="muted">
          {approval ? 'The host approves rebuys. ' : ''}Chips added during a hand arrive when it ends.
        </p>
        {error && <p className="error">{error}</p>}
        <div className="row">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary">{approval ? 'Ask the host' : 'Add chips'}</button>
        </div>
      </form>
    </Modal>
  );
}

/** What the host can do to a seated player. */
export function PlayerDialog({ view, seat, fmt, onClose, children }: { view: TableView; seat: SeatView; fmt: Fmt; onClose: () => void; children?: ReactNode }) {
  const cents = view.settings.stakes.centsMode;
  const [stack, setStack] = useState(toInput(cents, seat.stack));
  const [error, setError] = useState('');
  const isMe = seat.playerId === view.me.playerId;
  const handLive = !!view.hand && view.hand.phase !== 'complete';
  const tournament = view.mode === 'tournament';
  const act = (p: Promise<unknown>) => p.then(onClose).catch((err: Error) => setError(err.message));

  return (
    <Modal title={seat.name} onClose={onClose}>
      <div className="form">
        <p className="muted">
          Seat {seat.seat + 1} · {fmt(seat.stack)} chips{seat.online ? '' : ' · offline'}
        </p>
        {!tournament && (
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              act(call('host:setStack', { playerId: seat.playerId, stack: fromInput(cents, stack) }));
            }}
          >
            <label>
              Stack
              <input type="number" min={0} step={cents ? 0.01 : 1} value={stack} onChange={(e) => setStack(+e.target.value)} />
            </label>
            <button>{handLive ? 'Set after this hand' : 'Set stack'}</button>
          </form>
        )}
        <div className="row wrap">
          {!seat.sittingOut && <button onClick={() => act(call('host:sitOut', { playerId: seat.playerId }))}>Sit out</button>}
          {!isMe && !tournament && <button onClick={() => act(call('host:transfer', { playerId: seat.playerId }))}>Make host</button>}
          {!isMe && !tournament && (
            <button className="danger" onClick={() => confirm(`Remove ${seat.name} from the table?`) && act(call('host:kick', { playerId: seat.playerId }))}>
              Remove
            </button>
          )}
        </div>
        {error && <p className="error">{error}</p>}
        {children}
        <button onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}

import { useEffect, useState } from 'react';
import type { Action, RoomView } from '@rsdp/engine';
import { socket } from '../socket';

export function ActionBar({ view }: { view: RoomView }) {
  const legal = view.you.legal;
  const hand = view.hand;
  const [amount, setAmount] = useState(0);
  const [error, setError] = useState('');

  useEffect(() => {
    if (legal) setAmount(legal.minRaiseTo);
    setError('');
  }, [legal?.minRaiseTo, hand?.number, hand?.street]);

  if (!legal || !hand) return <div className="action-bar idle" />;

  const send = (action: Action) =>
    socket.emit('player:action', action, (res) => {
      if (!res.ok) setError(res.error);
    });

  const me = view.seats[view.you.seat]!;
  const potWithBets = hand.pot + view.seats.reduce((s, x) => s + (x?.bet ?? 0), 0);
  const toCall = hand.currentBet - me.bet;
  const clamp = (x: number) => Math.max(legal.minRaiseTo, Math.min(legal.maxRaiseTo, Math.floor(x)));
  // A pot-sized raise: call first, then raise by the size of the pot after the call.
  const potRaise = (fraction: number) => clamp(hand.currentBet + (potWithBets + toCall) * fraction);
  const isBet = hand.currentBet === 0;

  return (
    <div className="action-bar">
      {error && <div className="error">{error}</div>}
      <div className="buttons">
        <button className="fold" onClick={() => send({ type: 'fold' })}>
          Fold
        </button>
        {legal.canCheck ? (
          <button onClick={() => send({ type: 'check' })}>Check</button>
        ) : (
          <button onClick={() => send({ type: 'call' })}>Call {legal.callAmount}</button>
        )}
        {legal.canRaise && (
          <button className="primary" onClick={() => send({ type: 'raise', amount })}>
            {amount === legal.maxRaiseTo ? 'All in' : isBet ? 'Bet' : 'Raise to'} {amount}
          </button>
        )}
      </div>
      {legal.canRaise && legal.maxRaiseTo > legal.minRaiseTo && (
        <div className="sizing">
          <button onClick={() => setAmount(potRaise(0.5))}>½ pot</button>
          <button onClick={() => setAmount(potRaise(0.75))}>¾ pot</button>
          <button onClick={() => setAmount(potRaise(1))}>Pot</button>
          <button onClick={() => setAmount(legal.maxRaiseTo)}>All in</button>
          <input
            type="range"
            min={legal.minRaiseTo}
            max={legal.maxRaiseTo}
            value={amount}
            onChange={(e) => setAmount(+e.target.value)}
          />
          <input
            type="number"
            min={legal.minRaiseTo}
            max={legal.maxRaiseTo}
            value={amount}
            onChange={(e) => setAmount(+e.target.value)}
          />
        </div>
      )}
    </div>
  );
}

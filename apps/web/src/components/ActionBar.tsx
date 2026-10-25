import { useEffect, useState } from 'react';
import { evaluate, type Action, type RoomView } from '@rsdp/engine';
import { socket } from '../socket';

type PreAction = { kind: 'checkFold' } | { kind: 'check' } | { kind: 'fold' } | { kind: 'call'; amount: number } | { kind: 'callAny' };

export function ActionBar({ view }: { view: RoomView }) {
  const legal = view.you.legal;
  const hand = view.hand;
  const me = view.you.seat !== -1 ? view.seats[view.you.seat] : null;
  const [amount, setAmount] = useState(0);
  const [error, setError] = useState('');
  const [queued, setQueued] = useState<{ key: string; action: PreAction } | null>(null);
  // Queued moves are for one street only.
  const streetKey = hand ? `${hand.number}:${hand.street}` : '';
  const pre = queued?.key === streetKey ? queued.action : null;
  const setPre = (action: PreAction | null) => setQueued(action && { key: streetKey, action });

  const send = (action: Action) =>
    socket.emit('player:action', action, (res) => {
      if (!res.ok) setError(res.error);
    });

  useEffect(() => {
    if (legal) setAmount(legal.minRaiseTo);
    setError('');
  }, [legal?.minRaiseTo, hand?.number, hand?.street]);

  // When it becomes your turn, play the queued move if it still applies.
  useEffect(() => {
    if (!legal || !pre) return;
    setPre(null);
    if (pre.kind === 'checkFold') send(legal.canCheck ? { type: 'check' } : { type: 'fold' });
    else if (pre.kind === 'fold') send({ type: 'fold' });
    else if (pre.kind === 'check' && legal.canCheck) send({ type: 'check' });
    else if (pre.kind === 'callAny') send(legal.canCheck ? { type: 'check' } : { type: 'call' });
    else if (pre.kind === 'call' && legal.canCheck) send({ type: 'check' });
    else if (pre.kind === 'call' && legal.callAmount === pre.amount) send({ type: 'call' });
    // A "call 20" that now faces a bigger bet is dropped so you can decide again.
  }, [legal]);

  const strength =
    me && hand && me.cards.length === 2 && me.cards[0] && hand.board.length >= 3
      ? evaluate([...(me.cards as string[]), ...hand.board]).description
      : null;

  if (!hand || !me || !me.inHand || hand.street === 'complete') {
    return <div className="action-bar idle">{strength && <div className="strength">{strength}</div>}</div>;
  }

  if (!legal) {
    if (me.folded || me.allIn) {
      return <div className="action-bar idle">{strength && <div className="strength">{strength}</div>}</div>;
    }
    const toCall = Math.min(hand.currentBet - me.bet, me.stack);
    const opts: { label: string; value: PreAction }[] =
      toCall === 0
        ? [
            { label: 'Check / Fold', value: { kind: 'checkFold' } },
            { label: 'Check', value: { kind: 'check' } },
            { label: 'Call any', value: { kind: 'callAny' } },
          ]
        : [
            { label: 'Fold', value: { kind: 'fold' } },
            { label: `Call ${toCall}`, value: { kind: 'call', amount: toCall } },
            { label: 'Call any', value: { kind: 'callAny' } },
          ];
    return (
      <div className="action-bar pre">
        {strength && <div className="strength">{strength}</div>}
        <div className="buttons">
          {opts.map((o) => {
            const on = pre && JSON.stringify(pre) === JSON.stringify(o.value);
            return (
              <button key={o.label} className={on ? 'queued' : ''} onClick={() => setPre(on ? null : o.value)}>
                <span className="box">{on ? '✓' : ''}</span> {o.label}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  const potWithBets = hand.pot + view.seats.reduce((s, x) => s + (x?.bet ?? 0), 0);
  const toCall = hand.currentBet - me.bet;
  const clamp = (x: number) => Math.max(legal.minRaiseTo, Math.min(legal.maxRaiseTo, Math.floor(x)));
  // A pot-sized raise: call first, then raise by the size of the pot after the call.
  const potRaise = (fraction: number) => clamp(hand.currentBet + (potWithBets + toCall) * fraction);
  const isBet = hand.currentBet === 0;

  return (
    <div className="action-bar my-turn">
      {strength && <div className="strength">{strength}</div>}
      {error && <div className="error">{error}</div>}
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
    </div>
  );
}

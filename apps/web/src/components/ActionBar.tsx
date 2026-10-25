import { useEffect, useRef, useState } from 'react';
import type { Action } from '@rsdp/engine/core';
import type { TableView } from '@rsdp/engine/wire';
import { call } from '../socket';
import { fromInput, toInput, type Fmt } from '../format';
import { handStrength } from '../strength';
import { suitSymbol } from './PlayingCard';
import { useNow } from './Table';

const cardName = (c: string | undefined) => (c ? `${c[0] === 'T' ? '10' : c[0]}${suitSymbol(c[1])}` : '');

type PreAction = { kind: 'checkFold' } | { kind: 'check' } | { kind: 'fold' } | { kind: 'call'; amount: number } | { kind: 'callAny' };

export function ActionBar({
  view,
  fmt,
  skew,
  discard,
  clearDiscard,
  onPreAction,
}: {
  view: TableView;
  fmt: Fmt;
  skew: number;
  discard: number[];
  clearDiscard: () => void;
  /** Tells the page whether a move is queued, so it can skip the your-turn sound. */
  onPreAction?: (queued: boolean) => void;
}) {
  const { legal, hand } = view;
  const centsMode = view.settings.stakes.centsMode;
  const me = view.me.seat !== null ? view.seats[view.me.seat] : null;
  const [amount, setAmount] = useState(0);
  const [error, setError] = useState('');
  const [queued, setQueued] = useState<{ key: string; action: PreAction } | null>(null);
  // Queued moves are for one betting round only.
  const streetKey = hand ? `${hand.handNumber}:${hand.street}` : '';
  const pre = queued?.key === streetKey ? queued.action : null;
  const setPre = (action: PreAction | null) => setQueued(action && { key: streetKey, action });
  const [confirmFold, setConfirmFold] = useState(false);
  const amountBox = useRef<HTMLInputElement>(null);
  useEffect(() => {
    onPreAction?.(!!pre);
  }, [!!pre]);
  const ritDeadline = view.canVoteRunItTwice ? hand?.runItTwice.deadline ?? null : null;
  const now = useNow(ritDeadline !== null, 500) + skew;

  const run = (p: Promise<unknown>) => p.then(() => setError('')).catch((e: Error) => setError(e.message));
  const send = (action: Action) => run(call('hand:act', action));

  useEffect(() => {
    if (legal) setAmount(legal.minTo);
    setError('');
    setConfirmFold(false);
  }, [legal?.minTo, hand?.handNumber, hand?.street]);

  // Folding when you could check for free asks once more.
  const fold = () => {
    if (legal?.canCheck && !confirmFold) return setConfirmFold(true);
    setConfirmFold(false);
    send({ type: 'fold' });
  };

  // Keyboard: F fold, K check, C call, R raise box (Enter sends it).
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  keys.current = (e) => {
    if (!legal || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    const typing = e.target instanceof HTMLElement && e.target.closest('input, textarea, select, [contenteditable]');
    // Keys never act behind an open dialog or sheet.
    if (typing || document.querySelector('.modal-backdrop, .sheet-backdrop, .replayer-backdrop')) return;
    const k = e.key.toLowerCase();
    if (k === 'f' && legal.canFold) fold();
    else if (k === 'k' && legal.canCheck) send({ type: 'check' });
    else if (k === 'c' && !legal.canCheck && !legal.canBringIn) send({ type: 'call' });
    else if (k === 'r' && amountBox.current) {
      e.preventDefault();
      amountBox.current.focus();
      amountBox.current.select();
    } else return;
  };

  // When it becomes your turn, play the queued move if it still applies.
  useEffect(() => {
    if (!legal || !pre) return;
    setPre(null);
    let move: Action | null = null;
    if (pre.kind === 'checkFold') move = legal.canCheck ? { type: 'check' } : { type: 'fold' };
    else if (pre.kind === 'fold') move = { type: 'fold' };
    else if (pre.kind === 'check' && legal.canCheck) move = { type: 'check' };
    else if (pre.kind === 'callAny') move = legal.canCheck ? { type: 'check' } : { type: 'call' };
    else if (pre.kind === 'call' && legal.canCheck) move = { type: 'check' };
    else if (pre.kind === 'call' && legal.callAmount === pre.amount) move = { type: 'call' };
    // A "check" that now faces a bet, or a "call 20" that faces a raise, is dropped so you can
    // decide again; say so now, before the page decides whether to call you with the turn sound.
    if (move) send(move);
    else onPreAction?.(false);
  }, [legal]);

  const myCards = me?.inHand ? me.cards.map((c) => c.card) : [];
  const strength = hand && myCards.length ? handStrength(hand.gameId, myCards, hand.boards[0]?.[0] ?? []) : null;
  const hint = strength && <div className="strength">{strength}</div>;
  const errorLine = error && <div className="error">{error}</div>;

  // After the hand: show cards you were not made to show.
  if (hand?.phase === 'complete' || !hand) {
    if (!view.canShow.length) return <div className="action-bar idle">{hint}</div>;
    return (
      <div className="action-bar idle">
        {hint}
        {errorLine}
        <div className="buttons small">
          <button onClick={() => run(call('hand:show', { cards: view.canShow }))}>Show cards</button>
          {view.canShow.length > 1 &&
            view.canShow.map((i) => (
              <button key={i} onClick={() => run(call('hand:show', { cards: [i] }))}>
                Show {cardName(myCards[i])}
              </button>
            ))}
        </div>
      </div>
    );
  }

  if (view.canVoteRunItTwice) {
    const left = ritDeadline ? Math.max(0, Math.ceil((ritDeadline - now) / 1000)) : null;
    return (
      <div className="action-bar my-turn">
        {hint}
        {errorLine}
        <div className="prompt">Everyone is all in. Run it twice?{left !== null && <span className="muted"> {left}s</span>}</div>
        <div className="buttons">
          <button onClick={() => run(call('hand:runItTwice', { yes: false }))}>Run it once</button>
          <button className="primary" onClick={() => run(call('hand:runItTwice', { yes: true }))}>
            Run it twice
          </button>
        </div>
      </div>
    );
  }

  if (view.canDraw) {
    const n = discard.length;
    return (
      <div className="action-bar my-turn">
        {hint}
        {errorLine}
        <div className="prompt">
          {hand.streetName}: click the cards you want to throw away{view.canDraw.max < myCards.length ? ` (up to ${view.canDraw.max})` : ''}.
        </div>
        <div className="buttons">
          <button disabled={n === 0} onClick={clearDiscard}>
            Clear
          </button>
          <button
            className="primary"
            disabled={n > view.canDraw.max}
            onClick={() => run(call('hand:draw', { discard }).then(clearDiscard))}
          >
            {n === 0 ? 'Stand pat' : `Draw ${n}`}
          </button>
        </div>
      </div>
    );
  }

  if (!me || !me.inHand || me.folded || me.allIn || hand.phase !== 'betting') {
    const waiting = hand.phase === 'drawing' && me?.inHand && !me.folded ? <div className="muted">Waiting for the draw…</div> : null;
    return (
      <div className="action-bar idle">
        {hint}
        {waiting}
      </div>
    );
  }

  if (!legal) {
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
            { label: `Call ${fmt(toCall)}`, value: { kind: 'call', amount: toCall } },
            { label: 'Call any', value: { kind: 'callAny' } },
          ];
    return (
      <div className="action-bar pre">
        {hint}
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

  const toCall = hand.currentBet - me.bet;
  const allInTo = me.stack + me.bet;
  const clamp = (x: number) => Math.max(legal.minTo, Math.min(legal.maxTo, Math.floor(x)));
  // A pot-sized raise: call first, then raise by the size of the pot after the call.
  const potRaise = (fraction: number) => clamp(hand.currentBet + (hand.potTotal + toCall) * fraction);
  const sized = legal.canRaise && legal.maxTo > legal.minTo;
  const raiseType = legal.raiseKind;
  const raiseLabel = (to: number) =>
    to >= allInTo ? `All in ${fmt(to)}` : legal.canBringIn ? `Complete to ${fmt(to)}` : raiseType === 'bet' ? `Bet ${fmt(to)}` : `Raise to ${fmt(to)}`;

  return (
    <div className="action-bar my-turn">
      {hint}
      {errorLine}
      {sized && (
        <div className="sizing">
          {hand.betting !== 'fixed-limit' && (
            <div className="presets">
              <button onClick={() => setAmount(potRaise(0.5))}>½ pot</button>
              <button onClick={() => setAmount(potRaise(0.75))}>¾ pot</button>
              <button onClick={() => setAmount(potRaise(1))}>Pot</button>
              <button onClick={() => setAmount(legal.maxTo)}>{legal.maxTo >= allInTo ? 'All in' : 'Max'}</button>
            </div>
          )}
          <div className="slider">
            <input type="range" min={legal.minTo} max={legal.maxTo} value={amount} onChange={(e) => setAmount(+e.target.value)} />
            <input
              ref={amountBox}
              type="number"
              inputMode="decimal"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && legal.canRaise) send({ type: raiseType, to: clamp(amount) });
              }}
              min={toInput(centsMode, legal.minTo)}
              max={toInput(centsMode, legal.maxTo)}
              step={centsMode ? 0.01 : 1}
              value={toInput(centsMode, amount)}
              onChange={(e) => setAmount(fromInput(centsMode, +e.target.value))}
            />
          </div>
        </div>
      )}
      <div className="buttons">
        {legal.canFold && (
          <button className={`fold ${confirmFold ? 'confirm' : ''}`} onClick={fold} title="F">
            {confirmFold ? 'Fold anyway?' : 'Fold'}
          </button>
        )}
        {legal.canBringIn ? (
          <button onClick={() => send({ type: 'bring-in' })}>Bring in {fmt(hand.stakes.bringIn)}</button>
        ) : legal.canCheck ? (
          <button onClick={() => send({ type: 'check' })} title="K">
            Check
          </button>
        ) : (
          <button onClick={() => send({ type: 'call' })} title="C">
            Call {fmt(legal.callAmount)}
            {legal.callAmount >= me.stack ? ' (all in)' : ''}
          </button>
        )}
        {legal.canRaise && (
          <button className="primary" onClick={() => send({ type: raiseType, to: sized ? clamp(amount) : legal.minTo })}>
            {raiseLabel(sized ? clamp(amount) : legal.minTo)}
          </button>
        )}
      </div>
    </div>
  );
}

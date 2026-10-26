import { useEffect, useRef, useState } from 'react';
import type { Action } from '@rsdp/engine/core';
import type { TableView } from '@rsdp/engine/wire';
import { call } from '../socket';
import './action-bar.css';
import { bbExactFormat, betFromInput, betToInput, type BetUnit, type Fmt } from '../format';
import { handStrength } from '../strength';
import { suitSymbol } from './PlayingCard';
import { useNow } from './Table';

const cardName = (c: string | undefined) => (c ? `${c[0] === 'T' ? '10' : c[0]}${suitSymbol(c[1])}` : '');

type PreAction = { kind: 'checkFold' } | { kind: 'check' } | { kind: 'fold' } | { kind: 'call'; amount: number } | { kind: 'callAny' };

/** How long a move waits for the server before the buttons come back. */
const SEND_TIMEOUT_MS = 8_000;

export function ActionBar({
  view,
  fmt: chipFmt,
  bigBlind = null,
  skew,
  discard,
  clearDiscard,
  onPreAction,
}: {
  view: TableView;
  fmt: Fmt;
  /** Set when the player has chosen to see amounts in big blinds: the buttons and the bet box then work in BB. */
  bigBlind?: number | null;
  skew: number;
  discard: number[];
  clearDiscard: () => void;
  /** Tells the page whether a move is queued, so it can skip the your-turn sound. */
  onPreAction?: (queued: boolean) => void;
}) {
  const { legal, hand } = view;
  const centsMode = view.settings.stakes.centsMode;
  const unit: BetUnit = bigBlind ? { bb: bigBlind } : { centsMode };
  const fmt = bigBlind ? bbExactFormat(bigBlind) : chipFmt;
  const me = view.me.seat !== null ? view.seats[view.me.seat] : null;
  const [amount, setAmountRaw] = useState(0);
  // What's typed in the bet box, kept as text while typing so "2." or "0.5" isn't rewritten mid-word.
  const [typed, setTyped] = useState<string | null>(null);
  const setAmount = (chips: number) => {
    setTyped(null);
    setAmountRaw(chips);
  };
  // Switching units (here or in another tab) redraws the box in the new unit.
  useEffect(() => setTyped(null), [bigBlind]);
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

  // Before your turn: the pre-moves on offer, or null when there is nothing to pre-click.
  const runningOut = !!hand?.events.some((e) => e.t === 'run-it');
  const waiting =
    !legal && !!hand && hand.phase === 'betting' && !runningOut && !view.canVoteRunItTwice && !view.canDraw && !!me && me.inHand && !me.folded && !me.allIn;
  const waitToCall = waiting ? Math.min(hand.currentBet - me.bet, me.stack) : 0;
  const preOpts: { label: string; key: string; value: PreAction }[] | null = !waiting
    ? null
    : waitToCall === 0
      ? [
          { label: 'Check / Fold', key: 'F', value: { kind: 'checkFold' } },
          { label: 'Check', key: 'K', value: { kind: 'check' } },
          { label: 'Call any', key: 'A', value: { kind: 'callAny' } },
        ]
      : [
          { label: 'Fold', key: 'F', value: { kind: 'fold' } },
          { label: `Call ${fmt(waitToCall)}`, key: 'C', value: { kind: 'call', amount: waitToCall } },
          { label: 'Call any', key: 'A', value: { kind: 'callAny' } },
        ];
  const isPre = (v: PreAction) => !!pre && JSON.stringify(pre) === JSON.stringify(v);
  const togglePre = (v: PreAction) => settled() && setPre(isPre(v) ? null : v);
  // A bet before your turn changes what a pre-move means, as on PokerNow: check/fold becomes fold, while a
  // check, or a call of an amount someone has since raised, is cleared so you decide again.
  useEffect(() => {
    if (!pre || !waiting) return;
    if (waitToCall > 0 && pre.kind === 'checkFold') setPre({ kind: 'fold' });
    else if (waitToCall > 0 && pre.kind === 'check') setPre(null);
    else if (pre.kind === 'call' && pre.amount !== waitToCall) setPre(null);
  }, [waitToCall, waiting]);
  const ritDeadline = view.canVoteRunItTwice ? hand?.runItTwice.deadline ?? null : null;
  const now = useNow(ritDeadline !== null, 500) + skew;

  // One move at a time: a double tap must not send a second move, which could land on the next street
  // (the big blind checking preflop and then first to act on the flop) or queue a pre-move.
  const inFlight = useRef(false);
  const lastSent = useRef(0);
  const [sending, setSending] = useState(false);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!sending) return setSlow(false);
    const t = setTimeout(() => setSlow(true), 2500);
    return () => clearTimeout(t);
  }, [sending]);
  const release = () => {
    inFlight.current = false;
    setSending(false);
  };
  const run = (p: () => Promise<unknown>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    lastSent.current = Date.now();
    setSending(true);
    // An answer lost to a dropped connection never comes: give the buttons back rather than lock them for good.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const noAnswer = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('No answer from the table. Check your connection and try again.')), SEND_TIMEOUT_MS);
    });
    Promise.race([p(), noAnswer])
      .then(() => setError(''))
      .catch((e: Error) => setError(e.message))
      .finally(() => {
        clearTimeout(timer);
        release();
      });
  };
  // A new turn (or hand) means the last move was dealt with, answered or not.
  useEffect(release, [legal, hand?.handNumber]);
  const send = (action: Action) => run(() => call('hand:act', action));
  /** Taps on pre-moves within half a second of a move are the second half of a double tap. */
  const settled = () => !inFlight.current && Date.now() - lastSent.current > 500;

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
    if ((!legal && !preOpts) || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    const typing = e.target instanceof HTMLElement && e.target.closest('input, textarea, select, [contenteditable]');
    // Keys never act behind an open dialog or sheet.
    if (typing || document.querySelector('.modal-backdrop, .sheet-backdrop, .replayer-backdrop')) return;
    const k = e.key.toLowerCase();
    // Before your turn the same keys tick (or untick) a pre-move.
    if (!legal) {
      const o = preOpts?.find((o) => o.key.toLowerCase() === k);
      if (o) togglePre(o.value);
      return;
    }
    if (k === 'f' && legal.canFold) fold();
    else if (k === 'k' && legal.canCheck) send({ type: 'check' });
    else if (k === 'c' && !legal.canCheck && !legal.canBringIn) send({ type: 'call' });
    else if (k === 'r' && amountBox.current) {
      e.preventDefault();
      amountBox.current.focus();
      amountBox.current.select();
    } else if (k === 'r' && hand?.betting === 'fixed-limit' && legal.canRaise) send({ type: legal.raiseKind, to: legal.minTo });
    else return;
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
  // On your turn (betting or drawing) the time bank sits on the bar's top line, so the bar is no taller for it.
  const canBank = !view.paused && !!me && !!view.turn && view.turn.seat === me.seat && !view.turn.usingBank && view.turn.deadline !== null && me.timeBank > 0;
  const head = canBank ? (
    <div className="bar-head">
      {hint}
      <button className="time-bank" onClick={() => call('hand:timeBank').catch((e: Error) => setError(e.message))}>
        Time bank +{me.timeBank}s
      </button>
    </div>
  ) : (
    hint
  );
  const errorLine = slow ? (
    <div className="muted sending-note">Sending… your connection seems slow.</div>
  ) : (
    error && <div className="error">{error}</div>
  );

  // After the hand: show cards you were not made to show.
  if (hand?.phase === 'complete' || !hand) {
    if (!view.canShow.length) return <div className="action-bar idle">{hint}</div>;
    return (
      <div className="action-bar idle">
        {hint}
        {errorLine}
        <div className="buttons small">
          <button onClick={() => run(() => call('hand:show', { cards: view.canShow }))}>Show cards</button>
          {view.canShow.length > 1 &&
            view.canShow.map((i) => (
              <button key={i} onClick={() => run(() => call('hand:show', { cards: [i] }))}>
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
      <div className={`action-bar my-turn${sending ? ' sending' : ''}`}>
        {hint}
        {errorLine}
        <div className="prompt">Everyone is all in. Run it twice?{left !== null && <span className="muted"> {left}s</span>}</div>
        <div className="buttons">
          <button onClick={() => run(() => call('hand:runItTwice', { yes: false }))}>Run it once</button>
          <button className="primary" onClick={() => run(() => call('hand:runItTwice', { yes: true }))}>
            Run it twice
          </button>
        </div>
      </div>
    );
  }

  if (view.canDraw) {
    const n = discard.length;
    return (
      <div className={`action-bar my-turn${sending ? ' sending' : ''}`}>
        {head}
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
            onClick={() => run(() => call('hand:draw', { discard }).then(clearDiscard))}
          >
            {n === 0 ? 'Stand pat' : `Draw ${n}`}
          </button>
        </div>
      </div>
    );
  }

  // Once the board is being run out (everyone all in) there is nothing left to bet.
  if (!me || !me.inHand || me.folded || me.allIn || hand.phase !== 'betting' || runningOut) {
    const waiting = hand.phase === 'drawing' && me?.inHand && !me.folded ? <div className="muted">Waiting for the draw…</div> : null;
    return (
      <div className="action-bar idle">
        {hint}
        {waiting}
      </div>
    );
  }

  if (!legal) {
    if (!preOpts) return <div className="action-bar idle">{hint}</div>;
    return (
      <div className="action-bar pre" data-street={streetKey}>
        {hint}
        <div className="buttons">
          {preOpts.map((o) => {
            const on = isPre(o.value);
            return (
              <button
                key={o.label}
                className={on ? 'queued' : ''}
                aria-pressed={on}
                title={`${on ? 'Click again to cancel' : 'Do this as soon as it is your turn'}. Shortcut: ${o.key}`}
                onClick={() => togglePre(o.value)}
              >
                <span className="box">{on ? '✓' : ''}</span> {o.label}
                <Key k={o.key} />
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
    <div className={`action-bar my-turn${sending ? ' sending' : ''}`} data-street={streetKey}>
      {head}
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
              min={betToInput(unit, legal.minTo)}
              max={betToInput(unit, legal.maxTo)}
              step={bigBlind ? 'any' : centsMode ? 0.01 : 1}
              value={typed ?? betToInput(unit, amount)}
              onChange={(e) => {
                setTyped(e.target.value);
                // Text the browser can't read as a number leaves the amount as it was.
                if (!e.target.validity.badInput) setAmountRaw(betFromInput(unit, e.target.value === '' ? NaN : +e.target.value));
              }}
              onBlur={() => setTyped(null)}
              aria-label={bigBlind ? 'Amount in big blinds' : 'Amount'}
            />
            {bigBlind && <span className="unit">BB</span>}
          </div>
        </div>
      )}
      <div className="buttons">
        {legal.canFold && (
          <button className={`fold ${confirmFold ? 'confirm' : ''}`} onClick={fold} title="Shortcut: F">
            {confirmFold ? 'Fold anyway?' : 'Fold'}
            <Key k="F" />
          </button>
        )}
        {legal.canBringIn ? (
          <button onClick={() => send({ type: 'bring-in' })}>Bring in {fmt(hand.stakes.bringIn)}</button>
        ) : legal.canCheck ? (
          <button className="call" onClick={() => send({ type: 'check' })} title="Shortcut: K">
            Check
            <Key k="K" />
          </button>
        ) : (
          <button className="call" onClick={() => send({ type: 'call' })} title="Shortcut: C">
            Call {fmt(legal.callAmount)}
            {legal.callAmount >= me.stack ? ' (all in)' : ''}
            <Key k="C" />
          </button>
        )}
        {legal.canRaise && (
          <button className="primary" onClick={() => send({ type: raiseType, to: sized ? clamp(amount) : legal.minTo })}>
            {raiseLabel(sized ? clamp(amount) : legal.minTo)}
            <Key k="R" />
          </button>
        )}
      </div>
    </div>
  );
}

/** A small keyboard hint on a button; hidden on touch screens. */
function Key({ k }: { k: string }) {
  return (
    <kbd className="key-hint" aria-hidden="true">
      {k}
    </kbd>
  );
}

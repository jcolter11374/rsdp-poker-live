import { useEffect, useRef } from 'react';
import type { TableView } from '@rsdp/engine/wire';
import type { Fmt } from '../../format';
import { useChatMutes } from '../../chatMutes';
import { PlayingCard } from '../PlayingCard';
import { ChatBox } from './Chat';
import './phone-chat.css';

/**
 * The chat on a phone standing up: a strip along the bottom of the screen with the last two lines. Tapping the
 * strip opens the chat in place, under the table, which stays in view with its buttons; tapping the open chat's
 * top edge shuts it again. There is no chat button.
 */
export function PhoneChat({ view, open, typing, onOpen, onClose }: { view: TableView; open: boolean; typing: boolean; onOpen: () => void; onClose: () => void }) {
  const mutes = useChatMutes();
  // Opening swaps the strip for the open chat's top edge, and shutting swaps it back: focus follows, so a keyboard
  // or screen reader stays where it was. (Not into the message box, which would bring a phone's keyboard up.)
  const edge = useRef<HTMLButtonElement>(null);
  const was = useRef(open);
  useEffect(() => {
    if (was.current === open) return;
    was.current = open;
    edge.current?.focus({ preventScroll: true });
  }, [open]);
  if (open)
    return (
      <section className={`phone-chat open${typing ? ' typing' : ''}`} aria-label="Chat">
        <button ref={edge} className="phone-chat-handle" onClick={onClose} aria-label="Close chat" aria-expanded="true">
          <span className="grip" />
          <span className="label">Chat</span>
          <span className="chev" aria-hidden="true">⌄</span>
        </button>
        <ChatBox view={view} />
      </section>
    );
  const lines = view.chat.filter((m) => m.playerId && !mutes.includes(m.playerId)).slice(-2);
  return (
    <button ref={edge} className="phone-chat chat-strip" onClick={onOpen} aria-expanded="false">
      {/* Its name is what it shows (the last lines), after these words for screen readers. */}
      <span className="sr-only">Open chat. </span>
      <span className="lines">
        {lines.length ? (
          lines.map((m, i) => (
            <span key={`${m.at}-${i}`} className={`line${m.playerId === view.me.playerId ? ' mine' : ''}`}>
              <b>{m.name}:</b> {m.text}
            </span>
          ))
        ) : (
          <span className="line hint">Tap here to chat with the table</span>
        )}
      </span>
      <span className="chev" aria-hidden="true">⌃</span>
    </button>
  );
}

/**
 * While you type on a phone the keyboard leaves no room for the table: this one line stands in for it, with your
 * cards, the board, the pot and whose turn it is. The buttons stay under it, so you can play without closing the chat.
 */
export function MiniTable({ view, fmt }: { view: TableView; fmt: Fmt }) {
  const hand = view.hand;
  const me = view.me.seat !== null ? view.seats[view.me.seat] : null;
  const live = hand && hand.phase !== 'complete';
  const board = hand?.boards[0]?.[0] ?? [];
  const mine = me?.inHand && !me.folded ? me.cards : [];
  const turnSeat = live && view.turn ? view.seats[view.turn.seat] : null;
  const yours = !!view.legal || !!view.canDraw;
  return (
    <div className={`mini-table${yours ? ' your-turn' : ''}`} role="status">
      <span className="mini-cards mine">
        {mine.map((c, i) => (
          <PlayingCard key={i} card={c.card} small />
        ))}
      </span>
      <span className="mini-cards">
        {board.map((c, i) => (
          <PlayingCard key={i} card={c} small />
        ))}
      </span>
      <span className="mini-words">
        {hand ? <b>Pot {fmt(hand.potTotal)}</b> : <b>Between hands</b>}
        <span className="who">{yours ? 'Your turn' : turnSeat ? `${turnSeat.name} to act` : live ? '' : hand ? 'Hand over' : ''}</span>
      </span>
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import type { TableView } from '@rsdp/engine/wire';
import { announcements } from '../../announce';
import type { Fmt } from '../../format';

/** Seconds left on your clock when a screen reader is told time is running out. */
const LOW_TIME_S = 10;
/** How many recent announcements stay in the page (a screen reader reads each once, as it arrives). */
const KEEP = 6;

let said = 0;

/**
 * The table read aloud for screen readers: a log region nobody sees, where each change to the table (the hand log's
 * new lines, your turn and what you can do, a pause) is added as it happens, and a warning when your clock is nearly
 * out. Screen readers read new lines out politely, after whatever they are saying; everyone else sees nothing.
 */
export function TableAnnouncer({ view, fmt, skew, preQueued }: { view: TableView; fmt: Fmt; skew: number; preQueued: { current: boolean } }) {
  const [lines, setLines] = useState<{ id: number; text: string }[]>([]);
  const prev = useRef<TableView | null>(null);
  const say = (text: string) => setLines((l) => [...l, { id: ++said, text }].slice(-KEEP));

  useEffect(() => {
    const before = prev.current;
    prev.current = view;
    const news = announcements(before, view, fmt, preQueued.current);
    if (news.length) say(news.map((t) => (/[.?!]$/.test(t) ? t : `${t}.`)).join(' '));
  }, [view]);

  // Ten seconds left on your own clock, said once a turn (the warning beep comes at five).
  const mine = view.turn && view.me.seat !== null && view.turn.seat === view.me.seat && !view.paused ? view.turn : null;
  const deadline = mine?.deadline ?? null;
  useEffect(() => {
    if (deadline === null) return;
    const ms = deadline - skew - LOW_TIME_S * 1000 - Date.now();
    if (ms < 0) return;
    const t = setTimeout(() => say(`${LOW_TIME_S} seconds left to act.`), ms);
    return () => clearTimeout(t);
  }, [deadline, skew]);

  return (
    <div className="sr-only" role="log" aria-live="polite" aria-label="What's happening at the table">
      {lines.map((l) => (
        <p key={l.id}>{l.text}</p>
      ))}
    </div>
  );
}

import { useLayoutEffect, useRef, type ReactNode } from 'react';

/**
 * The action bar and the options under the table. It keeps the tallest height
 * it has reached (as --held), so the table above doesn't grow and shrink as the
 * action bar comes and goes: every seat would move with it. It holds through the
 * whole session, not just a hand. It lets go only when the window changes width or
 * `reset` changes (a seat change or turning the phone). A seated player starts
 * with room for a full action bar (see .dock.seated), so even the first turn of
 * the session doesn't move the table.
 * At a practice table (coach tips on) it keeps the action bar at its foot, so a
 * tip opening above the buttons never moves them, and from the moment you sit
 * down it has room for the tip and for the bots' reasons button under the bar
 * (#476). Like the height, that room stays until `reset` changes.
 */
export function Dock({
  reset,
  seated,
  limit,
  tips = false,
  why = false,
  children,
}: {
  reset: unknown;
  /** A seated player starts with room for a full action bar on their turn (see .dock.seated). */
  seated: boolean;
  /** Fixed-limit games have no bet slider, so their full bar is shorter. */
  limit: boolean;
  /** Coach tips come with this table's hands (a practice table): room for the tip from the start (see .dock.tips). */
  tips?: boolean;
  /** A practice table: room from the start for the bots' reasons button under the action bar (see .dock.why). */
  why?: boolean;
  children: ReactNode;
}) {
  // Room made for coach tips or the bots' reasons stays until `reset` changes, like the held height: dropped when a
  // practice table becomes a real game (a friend dealt in), it would let the table grow back mid-session (#476).
  const kept = useRef({ reset, tips, why });
  kept.current = kept.current.reset === reset ? { reset, tips: kept.current.tips || tips, why: kept.current.why || why } : { reset, tips, why };
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const box = outer.current;
    const content = inner.current;
    if (!box || !content) return;
    let most = 0;
    const hold = () => {
      const h = content.offsetHeight;
      if (h > most) {
        most = h;
        box.style.setProperty('--held', `${h}px`);
      }
    };
    const release = () => {
      most = 0;
      box.style.removeProperty('--held');
      hold();
    };
    release();
    const watch = new ResizeObserver(hold);
    watch.observe(content);
    // Only a change of width lets go: a phone's address bar showing or hiding changes the height alone,
    // and the bar is no taller for it.
    let width = window.innerWidth;
    const resized = () => {
      if (window.innerWidth === width) return;
      width = window.innerWidth;
      release();
    };
    window.addEventListener('resize', resized);
    return () => {
      watch.disconnect();
      window.removeEventListener('resize', resized);
    };
  }, [reset]);
  return (
    <div className={['dock', seated && 'seated', limit && 'limit', kept.current.tips && 'tips', kept.current.why && 'why'].filter(Boolean).join(' ')} ref={outer}>
      <div className="dock-inner" ref={inner}>
        {children}
      </div>
    </div>
  );
}

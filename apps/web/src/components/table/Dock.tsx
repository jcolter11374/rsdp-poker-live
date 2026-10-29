import { useLayoutEffect, useRef, type ReactNode } from 'react';

/** The tallest the dock has been, per layout, remembered across hands, tables and reloads on this device. */
const HELD_KEY = 'rsdp.dockHeld';
function readHeld(): Record<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(HELD_KEY) ?? '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}
function saveHeld(key: string, h: number) {
  try {
    const all = readHeld();
    delete all[key];
    all[key] = h;
    // A desktop window dragged through many sizes keeps only its latest few.
    const keep = Object.entries(all).slice(-12);
    localStorage.setItem(HELD_KEY, JSON.stringify(Object.fromEntries(keep)));
  } catch {
    // Private windows: it is only a head start, so going without is fine.
  }
}

/**
 * The action bar and the options under the table. It keeps the tallest height
 * it has reached (as --held), so the table above doesn't grow and shrink as the
 * action bar comes and goes: every seat would move with it. It holds through the
 * whole session, not just a hand, and starts from the tallest it has been in the
 * same layout on this device before. It lets go only when the window resizes or
 * `reset` changes (a seat change or another kind of game). A seated player starts
 * with room for a full action bar (see .dock.seated), so even the first turn on a
 * new device doesn't move the table.
 * In a hand with coach tips it keeps the action bar at its foot, so a tip
 * opening above the buttons never moves them.
 */
export function Dock({
  reset,
  seated,
  limit,
  tips = false,
  children,
}: {
  reset: unknown;
  /** A seated player starts with room for a full action bar on their turn (see .dock.seated). */
  seated: boolean;
  /** Fixed-limit games have no bet slider, so their full bar is shorter. */
  limit: boolean;
  /** Coach tips are on for this hand: room for the tip from the deal (see .dock.tips). */
  tips?: boolean;
  children: ReactNode;
}) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const box = outer.current;
    const content = inner.current;
    if (!box || !content) return;
    let most = 0;
    // Remembered per window size too: a bigger phone's bar wraps less.
    const key = () => `${limit}:${tips}:${window.innerWidth}x${window.innerHeight}`;
    const hold = () => {
      const h = content.offsetHeight;
      if (h > most) {
        most = h;
        box.style.setProperty('--held', `${h}px`);
        if (seated) saveHeld(key(), h);
      }
    };
    const release = () => {
      // Never more than half the window, so one odd moment can't squeeze the table for good.
      const known = Number(readHeld()[key()]) || 0;
      most = seated ? Math.min(known, window.innerHeight / 2) : 0;
      if (most) box.style.setProperty('--held', `${most}px`);
      else box.style.removeProperty('--held');
      hold();
    };
    release();
    const watch = new ResizeObserver(hold);
    watch.observe(content);
    window.addEventListener('resize', release);
    return () => {
      watch.disconnect();
      window.removeEventListener('resize', release);
    };
  }, [reset, seated, limit, tips]);
  return (
    <div className={['dock', seated && 'seated', limit && 'limit', tips && 'tips'].filter(Boolean).join(' ')} ref={outer}>
      <div className="dock-inner" ref={inner}>
        {children}
      </div>
    </div>
  );
}

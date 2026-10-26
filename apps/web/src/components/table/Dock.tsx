import { useLayoutEffect, useRef, type ReactNode } from 'react';

/**
 * The action bar and the options under the table. It keeps the tallest height
 * it has reached (as --held), so the table above doesn't grow and shrink as the
 * action bar changes during a hand. It lets go when the window resizes or
 * `reset` changes (a new hand or a seat change, so something tall in one hand
 * doesn't shrink the next). A seated player starts with room for a full action bar
 * (see .dock.seated), so even the first turn of the session doesn't move the table.
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
    window.addEventListener('resize', release);
    return () => {
      watch.disconnect();
      window.removeEventListener('resize', release);
    };
  }, [reset]);
  return (
    <div className={['dock', seated && 'seated', limit && 'limit', tips && 'tips'].filter(Boolean).join(' ')} ref={outer}>
      <div className="dock-inner" ref={inner}>
        {children}
      </div>
    </div>
  );
}

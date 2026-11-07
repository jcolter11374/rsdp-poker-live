import { useLayoutEffect, useState, type RefObject } from 'react';

/**
 * For a box that may scroll (a code block or table wider than a phone, the table's log): while it does, Tab stops on it,
 * so the arrow keys can scroll it without a mouse (WCAG 2.1.1), and a screen reader hears `label`. When everything in it
 * fits, it stays out of the Tab order. Spread the result on the box.
 */
export function useScrollReach(ref: RefObject<HTMLElement>, label: string) {
  const [scrolls, setScrolls] = useState(false);
  // After every render, as the content may have grown; and when the box changes size.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) setScrolls(el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1);
  });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setScrolls(el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return scrolls ? { tabIndex: 0, role: 'region', 'aria-label': label } : {};
}

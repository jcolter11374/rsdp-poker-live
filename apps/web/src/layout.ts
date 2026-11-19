import { useEffect, useState } from 'react';

/** Phones (either way up), and windows taller than they are wide, get the one-column table. */
export function usePortrait() {
  const query = '(max-width: 700px), (max-aspect-ratio: 4/5), (max-height: 500px)';
  const [portrait, setPortrait] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const mq = matchMedia(query);
    const onChange = () => setPortrait(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return portrait;
}

/** Desktop windows at least this wide have room for chat beside the action bar, so the table drops its side column. */
export const WIDE_MIN = 1440;

/** True while the window is at least `px` wide. */
export function useMinWidth(px: number) {
  const query = `(min-width: ${px}px)`;
  const [match, setMatch] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const mq = matchMedia(query);
    const onChange = () => setMatch(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return match;
}

/** The wide desktop layout: chat in the bottom-left corner, the records behind the top bar's Log button. */
export function useWide(portrait: boolean) {
  return useMinWidth(WIDE_MIN) && !portrait;
}

/**
 * The slim phone table: a phone (or a narrow window) standing up. One row of buttons under the table and the chat
 * as a strip along the bottom, so the table gets the height. A phone on its side keeps its own layout.
 */
export function useSlim(portrait: boolean) {
  const query = '(max-height: 500px)';
  const [low, setLow] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const mq = matchMedia(query);
    const onChange = () => setLow(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return portrait && !low;
}

/**
 * The part of the page a phone's on-screen keyboard leaves in view, or null while no keyboard is up. Phones keep
 * the page its full height under the keyboard, so anything meant to stay in view has to be fitted to this box.
 */
export function useKeyboardBox(on: boolean) {
  const [box, setBox] = useState<{ top: number; height: number } | null>(null);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!on || !vv) {
      setBox(null);
      return;
    }
    const read = () => {
      // A pinch zoom shrinks the visual viewport too: only an unzoomed page is read as the keyboard coming up.
      const up = vv.scale <= 1.01 && window.innerHeight - vv.height > 120;
      setBox((old) => (up ? (old && old.top === vv.offsetTop && old.height === vv.height ? old : { top: vv.offsetTop, height: vv.height }) : null));
    };
    read();
    vv.addEventListener('resize', read);
    vv.addEventListener('scroll', read);
    return () => {
      vv.removeEventListener('resize', read);
      vv.removeEventListener('scroll', read);
    };
  }, [on]);
  return box;
}

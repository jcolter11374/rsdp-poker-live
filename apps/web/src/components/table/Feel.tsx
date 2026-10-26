import { useEffect, useRef, useState } from 'react';
import type { Fmt } from '../../format';
import { tableMotion } from '../../prefs';

/** A number that runs up (or down) to its new value instead of jumping, like a stack being counted. */
export function CountUp({ value, fmt, upMs = 900 }: { value: number; fmt: Fmt; /** How long a rise takes to count. */ upMs?: number }) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  const [dir, setDir] = useState<'' | 'up' | 'down'>('');
  useEffect(() => {
    const start = from.current;
    if (start === value || !tableMotion() || document.hidden) {
      from.current = value;
      setShown(value);
      setDir('');
      return;
    }
    // Winnings count up slowly enough to watch; chips going out tick down quickly.
    const ms = value > start ? upMs : 320;
    setDir(value > start ? 'up' : 'down');
    // The clock starts on the first frame: a frame's time can be from just before this effect ran,
    // and counting from performance.now() would make the first step run backwards for a moment.
    let t0 = -1;
    let raf = 0;
    const step = (t: number) => {
      if (t0 < 0) t0 = t;
      const k = Math.min(1, (t - t0) / ms);
      const eased = 1 - Math.pow(1 - k, 3);
      const v = Math.round(start + (value - start) * eased);
      from.current = v;
      setShown(v);
      if (k < 1) raf = requestAnimationFrame(step);
      else setDir('');
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      setDir('');
    };
  }, [value, upMs]);
  return <span className={`count${dir ? ` count-${dir}` : ''}`}>{fmt(shown)}</span>;
}

/**
 * A value that, when it rises, only takes the new amount once chips flying to it have landed,
 * so the pot's pile doesn't change shape (and nudge the number beside it) while the chips are in the air.
 */
export function useLanded(value: number, ms: number): number {
  const [shown, setShown] = useState(value);
  useEffect(() => {
    if (value <= shown || !tableMotion() || document.hidden) {
      setShown(value);
      return;
    }
    const t = setTimeout(() => setShown(value), ms);
    return () => clearTimeout(t);
  }, [value]);
  return value < shown ? value : shown;
}

/** The table's own mark, pressed into the middle of the felt. Original artwork. */
export function FeltEmblem() {
  return (
    <svg className="felt-emblem" viewBox="0 0 200 200" aria-hidden="true">
      <defs>
        <path id="emblem-top" d="M 30 100 A 70 70 0 0 1 170 100" />
        <path id="emblem-bottom" d="M 22 100 A 78 78 0 0 0 178 100" />
      </defs>
      <circle cx="100" cy="100" r="92" fill="none" stroke="currentColor" strokeWidth="2.5" />
      <circle cx="100" cy="100" r="84" fill="none" stroke="currentColor" strokeWidth="1" />
      <circle cx="100" cy="100" r="52" fill="none" stroke="currentColor" strokeWidth="1" />
      <text className="emblem-ring" fontSize="15" letterSpacing="5">
        <textPath href="#emblem-top" startOffset="50%" textAnchor="middle">
          RSDP POKER
        </textPath>
      </text>
      <text className="emblem-ring" fontSize="15" letterSpacing="5">
        <textPath href="#emblem-bottom" startOffset="50%" textAnchor="middle">
          LIVE
        </textPath>
      </text>
      {/* Suit pips at the four quarters of the ring. */}
      <g fill="currentColor">
        <path transform="translate(8 92) scale(0.66)" d="M12 2C9.2 5.6 4 8.8 4 13.2 4 15.9 6.1 18 8.7 18c1.3 0 2.5-.5 3.1-1.4-.2 2-1 3.6-2.6 4.6h5.6c-1.6-1-2.4-2.6-2.6-4.6.6.9 1.8 1.4 3.1 1.4 2.6 0 4.7-2.1 4.7-4.8C20 8.8 14.8 5.6 12 2z" />
        <path transform="translate(176 92) scale(0.66)" d="M12 21.2S3 15.4 3 9.3A4.8 4.8 0 0 1 12 6.6a4.8 4.8 0 0 1 9 2.7c0 6.1-9 11.9-9 11.9z" />
      </g>
      <text x="100" y="117" textAnchor="middle" className="emblem-mark" fontSize="50">
        R!
      </text>
    </svg>
  );
}

import { useCallback, useRef, useState } from 'react';
import { chipFormat } from '../format';

/** Analytics amounts come in cents (a chip counts as 100), so one format fits chip and cents tables alike. */
export const centsFmt = chipFormat(true);
export const signed = (n: number) => (n > 0 ? `+${centsFmt(n)}` : n < 0 ? `−${centsFmt(-n)}` : '0');

/** "Nice" round steps for a y axis, in whole cents. */
export function ticks(lo: number, hi: number, count = 4): number[] {
  const span = hi - lo || 1;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(1, Math.round([1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw));
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v));
  return out;
}

/** A box's width, measured whenever the box appears (charts come and go with list views and empty states). */
export function useWidth(initial = 520): [number, (el: HTMLDivElement | null) => void] {
  const [width, setWidth] = useState(initial);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) return;
    const measure = () => setWidth(Math.max(240, el.clientWidth));
    measure();
    observer.current = new ResizeObserver(measure);
    observer.current.observe(el);
  }, []);
  return [width, ref];
}

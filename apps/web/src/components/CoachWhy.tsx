import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { CoachTip, TableView } from '@rsdp/engine/wire';
import { tipText } from '../coach';
import { clock, type Fmt } from '../format';
import { usePortrait } from '../layout';
import { LogText } from './PlayingCard';
import { Modal } from './SeatDialog';
import { Sheet } from './Sheet';
import { useNow } from './Table';

/**
 * Why this tip: the maths, the chance and what it's based on, the ways to
 * draw, facts worth knowing and what the tip can't know. A sheet on phones,
 * a dialog on a computer. Your clock keeps running, so it shows here too.
 * Drawn on the page's body, clear of the action bar's own animation.
 */
export function CoachWhy({ tip, view, fmt, skew, onClose, onRules }: { tip: CoachTip; view: TableView; fmt: Fmt; skew: number; onClose: () => void; onRules?: () => void }) {
  const portrait = usePortrait();
  const turn = view.turn && view.turn.seat === view.me.seat ? view.turn : null;
  const deadline = turn && !view.paused ? turn.deadline : null;
  const now = useNow(deadline !== null, 500) + skew;
  const text = tipText(tip, view, fmt);
  // It opens beside the move buttons, mid-turn: focus moves in and stays in (Tab and Shift+Tab go round the sheet, never
  // to Fold or Call behind it), and goes back to whatever opened it when it closes.
  const root = useRef<HTMLDivElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = root.current?.closest<HTMLElement>('[role="dialog"]') ?? null;
    dialog?.setAttribute('aria-modal', 'true');
    back.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !dialog) return;
      const stops = [...dialog.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((el) => !el.hasAttribute('disabled'));
      if (!stops.length) return;
      const at = stops.indexOf(document.activeElement as HTMLElement);
      const next = e.shiftKey ? (at <= 0 ? stops.length - 1 : at - 1) : at < 0 || at === stops.length - 1 ? 0 : at + 1;
      e.preventDefault();
      stops[next].focus();
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  const body = (
    <div className="coach-why" ref={root}>
      {deadline !== null && (
        <p className="coach-why-clock" aria-live="off">
          Your turn: <b>{clock(deadline - now)}</b> left{turn?.usingBank ? ' (time bank)' : ''}
        </p>
      )}
      <p className="coach-why-verdict">
        <LogText text={text.verdict} />
      </p>
      {text.why.map((s) => (
        <section key={s.title}>
          <h3>{s.title}</h3>
          {s.lines.map((line, i) => (
            <p key={i}>
              <LogText text={line} />
            </p>
          ))}
        </section>
      ))}
      <div className="row wrap">
        {onRules && <button onClick={onRules}>How to play {view.hand?.gameName ?? 'this game'}</button>}
        <button className="primary" ref={back} onClick={onClose}>
          Back to the table
        </button>
      </div>
    </div>
  );
  return createPortal(
    portrait ? (
      <Sheet title="Why this tip" onClose={onClose}>
        {body}
      </Sheet>
    ) : (
      <Modal title="Why this tip" onClose={onClose}>
        {body}
      </Modal>
    ),
    document.body,
  );
}

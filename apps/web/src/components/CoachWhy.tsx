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
  const body = (
    <div className="coach-why">
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
        <button className="primary" onClick={onClose}>
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

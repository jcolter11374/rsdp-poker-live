import { useEffect, useRef, type ReactNode } from 'react';
import { useDialogFocus } from './dialogFocus';

/** A panel that slides up from the bottom of a phone screen, over the table. */
export function Sheet({ title, onClose, children, tall = false, className = '' }: { title: string; onClose: () => void; children: ReactNode; tall?: boolean; className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  useDialogFocus(box);
  useEffect(() => {
    // A dialog open over the sheet takes Escape first.
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('.modal-backdrop') && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div ref={box} className={`sheet ${tall ? 'tall' : ''} ${className}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2>{title}</h2>
          <button className="icon" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}

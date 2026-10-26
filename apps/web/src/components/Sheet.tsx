import { useEffect, type ReactNode } from 'react';

/** A panel that slides up from the bottom of a phone screen, over the table. */
export function Sheet({ title, onClose, children, tall = false }: { title: string; onClose: () => void; children: ReactNode; tall?: boolean }) {
  useEffect(() => {
    // A dialog open over the sheet takes Escape first.
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('.modal-backdrop') && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className={`sheet ${tall ? 'tall' : ''}`} role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
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

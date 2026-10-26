import { useEffect, useRef, useState, type ReactNode } from 'react';
import './menu.css';

export interface MenuItem {
  label: ReactNode;
  /** Shown on the right, like a keyboard shortcut or a count. */
  hint?: ReactNode;
  onClick: () => void;
  /** Leave the menu open after the click, for things you press more than once (sound level). */
  keepOpen?: boolean;
}

/**
 * The desktop top bar's "Menu" button: the table's less-used controls in one
 * drop-down, so the bar itself keeps only what matters mid-hand.
 */
export function TableMenu({ items }: { items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Escape closes the menu only, not a dialog or the action bar behind it.
      e.stopPropagation();
      setOpen(false);
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  return (
    <div className="table-menu" ref={box}>
      <button aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        Menu <span aria-hidden>▾</span>
      </button>
      {open && (
        <div className="table-menu-list" role="menu">
          {items.map((it, i) => (
            <button
              key={i}
              role="menuitem"
              onClick={() => {
                if (!it.keepOpen) setOpen(false);
                it.onClick();
              }}
            >
              <span>{it.label}</span>
              {it.hint !== undefined && <span className="table-menu-hint">{it.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

import { useEffect, useState, type RefObject } from 'react';

/** Everything inside `root` that Tab stops on, in order. */
export function tabStops(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])')].filter(
    (el) => !el.hasAttribute('disabled') && el.tabIndex >= 0 && !el.closest('[hidden], [inert]'),
  );
}

/** The dialog on top: the last one open in the page. Only it keeps focus. */
const topDialog = () => [...document.querySelectorAll<HTMLElement>('[aria-modal="true"]')].at(-1) ?? null;

/**
 * Keyboard and screen-reader manners for a dialog (Modal, Sheet, the replayer): focus moves in when it opens, Tab and
 * Shift+Tab go round inside it and never reach the page behind, and focus goes back to whatever opened it when it
 * closes. Something inside that already took focus (an autoFocus box) keeps it; otherwise the dialog box itself takes
 * it, so a screen reader starts reading at its title. The dialog element needs tabIndex={-1} and aria-modal.
 */
export function useDialogFocus(ref: RefObject<HTMLElement>) {
  // Read while rendering, before an autoFocus inside the dialog moves focus away from the opener.
  const [opener] = useState(() => (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null));
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!dialog.contains(document.activeElement)) dialog.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      // A dialog with its own Tab order inside (the coach's Why sheet) may have dealt with the key already.
      if (e.key !== 'Tab' || e.defaultPrevented || topDialog() !== dialog) return;
      const stops = tabStops(dialog);
      e.preventDefault();
      if (!stops.length) return dialog.focus({ preventScroll: true });
      const at = stops.indexOf(document.activeElement as HTMLElement);
      const step = e.shiftKey ? -1 : 1;
      let next = at < 0 ? (e.shiftKey ? stops.length - 1 : 0) : at + step;
      // A control that can't take focus (hidden by its styles) is passed over.
      for (let tries = 0; tries < stops.length; tries++, next += step) {
        const el = stops[(next + stops.length) % stops.length];
        el.focus();
        if (document.activeElement === el) return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      // Back to the opener, unless it has gone (a Sit button whose seat was just taken) or focus has already moved on
      // to something else outside, such as another dialog opened from this one.
      const lost = !document.activeElement || document.activeElement === document.body || dialog.contains(document.activeElement);
      if (lost && opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
}

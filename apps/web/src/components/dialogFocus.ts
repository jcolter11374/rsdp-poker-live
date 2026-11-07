import { useEffect, useState, type RefObject } from 'react';

/** Everything inside `root` that Tab stops on, in order. */
export function tabStops(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])')].filter(
    (el) => !el.hasAttribute('disabled') && el.tabIndex >= 0 && !el.closest('[hidden], [inert]'),
  );
}

/** The dialog on top: the last one open in the page, leaving out `closing`. Only it takes and keeps focus. */
const topDialog = (closing?: HTMLElement) => [...document.querySelectorAll<HTMLElement>('[aria-modal="true"]')].filter((d) => d !== closing).at(-1) ?? null;

/**
 * Where each open dialog gives focus back to, first choice first: what opened it; when that was inside another
 * dialog, that dialog, then where that one gives focus back to. A button in the phone's menu sheet closes the sheet
 * as it opens its own dialog, so when that dialog closes, focus goes back to the menu button that opened the sheet.
 */
const returnTo = new WeakMap<HTMLElement, HTMLElement[]>();

/** What has focus now, and if it is inside a dialog, that dialog and where it gives focus back to. */
function openerChain(): HTMLElement[] {
  if (typeof document === 'undefined' || !(document.activeElement instanceof HTMLElement)) return [];
  const opener = document.activeElement;
  const within = opener.closest<HTMLElement>('[aria-modal="true"]');
  return within ? [opener, ...(within === opener ? [] : [within]), ...(returnTo.get(within) ?? [])] : [opener];
}

/**
 * Keyboard and screen-reader manners for a dialog (Modal, Sheet, the replayer): focus moves in when it opens, Tab and
 * Shift+Tab go round inside it and never reach the page behind, and focus goes back to whatever opened it when it
 * closes. Something inside that already took focus (an autoFocus box) keeps it; otherwise the dialog box itself takes
 * it, so a screen reader starts reading at its title. The dialog element needs tabIndex={-1} and aria-modal.
 *
 * A dialog that opens by itself under another (Dealer's choice's picker, under Keyboard shortcuts) leaves focus in the
 * one on top, and gets it once that one closes, rather than the page behind both.
 */
export function useDialogFocus(ref: RefObject<HTMLElement>) {
  // Read while rendering, before an autoFocus inside the dialog moves focus away from the opener, and while a dialog
  // the same click closes is still in the page.
  const [openers] = useState(openerChain);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    returnTo.set(dialog, openers);
    if (topDialog() === dialog && !dialog.contains(document.activeElement)) dialog.focus({ preventScroll: true });
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
      // Back to the opener, or if it went with a dialog that closed, to where that dialog would have given it back.
      // Not when the opener has gone for good (a Sit button whose seat was just taken), or focus has already moved on
      // to something else outside, such as another dialog opened from this one. With a dialog still open underneath,
      // only somewhere inside it: else that dialog itself, not the page behind it.
      const lost = !document.activeElement || document.activeElement === document.body || dialog.contains(document.activeElement);
      if (!lost) return;
      const under = topDialog(dialog);
      const back = openers.find((el) => el.isConnected && (!under || under.contains(el))) ?? under;
      back?.focus({ preventScroll: true });
    };
  }, []);
}

import { useEffect, useRef, useState } from 'react';
import type { HandRecordView, TableView } from '@rsdp/engine/wire';
import type { Fmt } from '../../format';
import { cashRecap, recapOffered } from '../../recap';
import { Modal } from '../SeatDialog';

/*
 * Copy recap, in the ledger: a few plain lines about the game to paste into
 * the group chat (recap.ts writes them). Shown in a box first, so the person
 * sees exactly what they are about to paste.
 */

/** When this browser first saw each table with people playing each other (view.realGame), by its own clock. */
const realSeen = new Map<string, number>();

/** Whether to offer Copy recap to this viewer (recapOffered). For a spectator on a delay it turns on by itself once the delay is up. */
export function useRecapOffered(view: TableView): boolean {
  const [, wake] = useState(0);
  if (view.realGame && !realSeen.has(view.id)) realSeen.set(view.id, Date.now());
  const seen = realSeen.get(view.id);
  const offered = recapOffered(view, seen, Date.now());
  const delay = (view.spectator?.delaySeconds ?? 0) * 1000;
  const wakeAt = !offered && seen !== undefined && delay > 0 ? seen + delay : null;
  useEffect(() => {
    if (wakeAt === null) return;
    const t = setTimeout(() => wake((n) => n + 1), Math.max(0, wakeAt - Date.now()) + 50);
    return () => clearTimeout(t);
  }, [wakeAt]);
  return offered;
}

/**
 * Copies the text. Some phones refuse the clipboard: then the text in the box is selected, and the old copy
 * command is tried, so it can at least be copied by hand. True when it was copied.
 */
async function copyText(text: string, box: HTMLTextAreaElement | null): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    if (!box) return false;
    box.focus();
    box.setSelectionRange(0, box.value.length);
    try {
      return document.execCommand('copy');
    } catch {
      return false;
    }
  }
}

/**
 * The recap to check and copy. `hands` are the finished hands this viewer's Hands tab shows (null while they load);
 * `error` when they couldn't be loaded, and the recap goes without what comes from them.
 */
export function RecapDialog({
  view,
  fmt,
  hands,
  error,
  onRetry,
  onClose,
}: {
  view: TableView;
  fmt: Fmt;
  hands: HandRecordView[] | null;
  error: string;
  onRetry: () => void;
  onClose: () => void;
}) {
  const box = useRef<HTMLTextAreaElement>(null);
  const [copied, setCopied] = useState<'copied' | 'selected' | null>(null);
  // Nothing has finished that this viewer can see, so there is nothing to load.
  const shown = view.history.length ? (error ? null : hands) : [];
  const waiting = shown === null && !error;
  // Two people in their seats at a game that hasn't been stopped: the results may still change.
  const running = view.started && view.seats.filter((s) => s && !s.sittingOut).length >= 2;
  const text = cashRecap({ tableName: view.name, ledger: view.ledger, hands: shown, running, centsMode: view.settings.stakes.centsMode, fmt, now: Date.now() });
  // A new hand changes the text, so "Copied" would no longer be true.
  useEffect(() => setCopied(null), [text]);

  const copy = () =>
    void copyText(text, box.current).then((ok) => {
      setCopied(ok ? 'copied' : 'selected');
    });

  return (
    <Modal title="Recap for the group chat" onClose={onClose}>
      <div className="form recap">
        {waiting ? (
          <p className="muted">Getting the hands…</p>
        ) : (
          <>
            <textarea ref={box} readOnly value={text} rows={Math.min(text.split('\n').length, 16)} aria-label="Recap" />
            {error && (
              <p className="muted">
                Couldn't get the hands ({error}), so the games, hands and biggest pot are left out. <button onClick={onRetry}>Try again</button>
              </p>
            )}
            <button className="primary" onClick={copy}>
              {copied === 'copied' ? 'Copied' : 'Copy'}
            </button>
            {copied === 'selected' && <p className="hint">Your browser wouldn't copy it, so the text is selected: copy it from the menu.</p>}
            <p className="hint">
              The results are the ledger's, the same numbers settle-up uses, with chips still on the table counted as if cashed out now. There's no link to the
              table in it.
            </p>
          </>
        )}
        <button onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}

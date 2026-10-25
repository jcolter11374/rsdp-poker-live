// Browser notifications for when the tab is in the background: a tournament
// starting soon, being seated or moved, and your turn. Off until the player
// turns them on (the browser asks for permission then); the choice is kept
// per browser.

import { useSyncExternalStore } from 'react';

const KEY = 'rsdp.notify';
const ICON = '/favicon.svg';

export type NotifyState = 'unsupported' | 'denied' | 'off' | 'on';

const listeners = new Set<() => void>();
const changed = () => listeners.forEach((cb) => cb());

function stored(): boolean {
  try {
    return localStorage.getItem(KEY) === 'on';
  } catch {
    return false;
  }
}

function store(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {
    // Private windows may refuse; alerts stay as they were.
  }
}

/** Phone browsers that have Notification but refuse `new Notification()` outside a service worker (Android Chrome). */
const PAGE_ALERTS_REFUSED = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);

export function notifyState(): NotifyState {
  if (typeof Notification === 'undefined' || PAGE_ALERTS_REFUSED) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  return Notification.permission === 'granted' && stored() ? 'on' : 'off';
}

/** Asks the browser for permission if needed, then turns alerts on. */
export async function enableNotifications(): Promise<NotifyState> {
  if (notifyState() === 'unsupported') return 'unsupported';
  let permission = Notification.permission;
  if (permission === 'default') permission = await Notification.requestPermission();
  store(permission === 'granted');
  changed();
  return notifyState();
}

export function disableNotifications() {
  store(false);
  changed();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  // Permission can change in the browser's site settings, and alerts in another tab, while the page is open.
  document.addEventListener('visibilitychange', cb);
  window.addEventListener('storage', cb);
  return () => {
    listeners.delete(cb);
    document.removeEventListener('visibilitychange', cb);
    window.removeEventListener('storage', cb);
  };
}

export function useNotifyState(): NotifyState {
  return useSyncExternalStore(subscribe, notifyState);
}

/** Alerts still on screen, by tag, so they can be taken down once they are out of date. */
const shown = new Map<string, Notification>();

/** Takes down alerts whose tag starts with `prefix` (all of them for ''). */
export function closeNotifications(prefix = '') {
  for (const [tag, n] of shown) {
    if (!tag.startsWith(prefix)) continue;
    n.close();
    shown.delete(tag);
  }
}

// Back on the page: whatever the alerts said is on screen now.
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && closeNotifications());

export interface NotifyOptions {
  /** Alerts with the same tag replace each other, so several open tabs show one. */
  tag: string;
  /** Page to open when the alert is clicked. */
  url?: string;
  /** Show it even when this tab is in front (the default is only when it is hidden). */
  whenVisible?: boolean;
}

/** Shows an alert if the player turned them on and this tab is in the background. */
export function notify(title: string, body: string, opts: NotifyOptions) {
  if (notifyState() !== 'on') return;
  if (!document.hidden && !opts.whenVisible) return;
  try {
    // renotify: a new alert with the tag of one still in the tray sounds again instead of replacing it silently.
    const n = new Notification(title, { body, tag: opts.tag, icon: ICON, renotify: true } as NotificationOptions);
    shown.set(opts.tag, n);
    n.onclose = () => shown.get(opts.tag) === n && shown.delete(opts.tag);
    n.onclick = () => {
      window.focus();
      if (opts.url && location.pathname !== opts.url) {
        history.pushState(null, '', opts.url);
        dispatchEvent(new PopStateEvent('popstate'));
      }
      n.close();
    };
  } catch {
    // Some phone browsers only show notifications from an installed app.
  }
}

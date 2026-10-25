import { useEffect, useState } from 'react';

/*
 * Installing the site as a phone or desktop app: the service worker (sw.js)
 * the browsers want first, and an "Install" button where the browser offers
 * one, or the steps on iPhone where it doesn't.
 */

type InstallEvent = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };

let deferred: InstallEvent | null = null;
const listeners = new Set<() => void>();

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as InstallEvent;
    listeners.forEach((cb) => cb());
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    listeners.forEach((cb) => cb());
  });
}

/** Registers the service worker in the built site (never in the dev server, where it would only get in the way). */
export function registerServiceWorker() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* installing just won't be offered */
    });
  });
}

const standalone = () => window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
const iPhone = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/** "Install the app": the browser's own prompt, or how to add it on iPhone and iPad. Hidden once installed. */
export function InstallApp() {
  const [, bump] = useState(0);
  const [help, setHelp] = useState(false);
  useEffect(() => {
    const cb = () => bump((n) => n + 1);
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  }, []);
  if (standalone()) return null;
  if (deferred)
    return (
      <p className="tagline">
        <button
          onClick={() => {
            const e = deferred!;
            deferred = null;
            void e.prompt().finally(() => bump((n) => n + 1));
          }}
        >
          📲 Install the app
        </button>{' '}
        so the table opens full screen from your home screen.
      </p>
    );
  if (!iPhone()) return null;
  return (
    <p className="tagline">
      {help ? (
        <>
          In Safari, tap <b>Share</b> (the square with an arrow), then <b>Add to Home Screen</b>. The table then opens full screen like an app.
        </>
      ) : (
        <button onClick={() => setHelp(true)}>📲 Add to your home screen</button>
      )}
    </p>
  );
}

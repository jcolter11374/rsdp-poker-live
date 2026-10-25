import { useEffect } from 'react';

type Sentinel = { release(): Promise<void>; addEventListener(type: 'release', cb: () => void): void };

/**
 * Keeps the screen on while `active` (seated at a table), where the browser
 * allows it. The lock drops whenever the page is hidden, so it is taken again
 * each time the page comes back.
 */
export function useWakeLock(active: boolean) {
  useEffect(() => {
    const api = (navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<Sentinel> } }).wakeLock;
    if (!active || !api) return;
    let lock: Sentinel | null = null;
    let stopped = false;
    const take = () => {
      if (document.hidden || lock) return;
      api
        .request('screen')
        .then((l) => {
          if (stopped) return void l.release().catch(() => {});
          lock = l;
          l.addEventListener('release', () => {
            if (lock === l) lock = null;
          });
        })
        .catch(() => {
          /* refused (battery saver, no user gesture yet): try again on the next visit */
        });
    };
    take();
    document.addEventListener('visibilitychange', take);
    // Some browsers only grant it after a tap.
    window.addEventListener('pointerdown', take, { passive: true });
    return () => {
      stopped = true;
      document.removeEventListener('visibilitychange', take);
      window.removeEventListener('pointerdown', take);
      lock?.release().catch(() => {});
      lock = null;
    };
  }, [active]);
}

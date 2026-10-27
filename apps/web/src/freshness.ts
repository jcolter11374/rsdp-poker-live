import { socket } from './socket';

/**
 * A tab left open across a release keeps running the old app until it is
 * reloaded, so it misses every fix since. The server says which build it hands
 * out each time the socket connects (a release restarts it, so every tab
 * reconnects), and a tab on an older one reloads itself at the first quiet
 * moment: while it is hidden, on moving to another page, or at a table between
 * hands, never mid-hand or mid-runout.
 */

/** The entry script this page loaded, as index.html names it. Null in development, where it isn't hashed. */
function pageBuild(): string | null {
  const src = document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.getAttribute('src') ?? null;
  return src && /\/assets\//.test(src) ? src : null;
}

/** True when the server hands out a different build from the one this page runs. */
export function isStale(mine: string | null, served: string): boolean {
  return mine !== null && served !== mine;
}

/**
 * Whether a reload would cost nothing. A table mid-hand always waits. Otherwise a
 * hidden tab goes, and so does a table between hands unless something is being
 * typed; any other page waits until it is hidden or left.
 */
export function quietNow(at: 'busy-table' | 'table' | 'page', typing: boolean, hidden: boolean): boolean {
  if (at === 'busy-table') return false;
  if (hidden) return true;
  return at === 'table' && !typing;
}

let stale = false;
let tableBusy: (() => boolean) | null = null;

function typing() {
  const el = document.activeElement;
  return (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.value !== '';
}

/** Reloads now if a newer build is out and this is a quiet moment. */
export function reloadIfStale() {
  if (!stale) return;
  const at = !tableBusy ? 'page' : tableBusy() ? 'busy-table' : 'table';
  if (!quietNow(at, typing(), document.hidden)) return;
  stale = false;
  location.reload();
}

/**
 * A table page says while it is busy (dealt into a live hand, or a runout
 * still showing); it calls reloadIfStale when that ends. Returns the undo.
 */
export function holdReloadWhile(busy: () => boolean): () => void {
  tableBusy = busy;
  return () => {
    if (tableBusy === busy) tableBusy = null;
  };
}

export function watchForNewBuild() {
  const mine = pageBuild();
  socket.on('build', (served) => {
    if (!isStale(mine, served)) return;
    stale = true;
    reloadIfStale();
  });
  document.addEventListener('visibilitychange', reloadIfStale);
  // Moving to another page in the app: load the new one fresh instead (the address has already changed).
  addEventListener('popstate', () => stale && !tableBusy?.() && location.reload());
}

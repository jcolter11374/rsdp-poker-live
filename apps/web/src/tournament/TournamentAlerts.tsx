import { useEffect, useState } from 'react';
import type { TournamentListing } from '@rsdp/tournament';
import { disableNotifications, enableNotifications, notify, shownByPush, syncPush, useNotifyState, usePushAvailable } from '../notify';
import { socket } from '../socket';
import { tournamentClient } from './client';
import { tournamentOfTable } from './hooks';
import { eventOnPage, ON_SCREEN_FOR_MS, onScreenNow, startAlertsDue, startKey } from './startAlerts';

/** How often the list of the player's tournaments is fetched while alerts are on. */
const LIST_EVERY_MS = 60_000;
/** How often starts are checked against the clock. */
const CHECK_EVERY_MS = 15_000;
const FIRED_KEY = 'rsdp.notified';
const FIRED_MAX = 50;
/** Events a tab of the site has on screen now, so the other tabs hold their Starting soon back too. */
const ON_SCREEN_KEY = 'rsdp.notified.onScreen';
/** This tab, in those notes. */
const TAB = Math.random().toString(36).slice(2, 10);

/** Starting soon alerts a tab of the site is raising now, so another tab doesn't raise the same one meanwhile. */
const RAISING_KEY = 'rsdp.notified.raising';
/** A claim left by a tab that closed before its alert showed lapses after this, and another tab gives the alert. */
const RAISING_FOR_MS = 10_000;

/** A stored map of names to times, as these notes keep them. */
function loadStamps(storeKey: string): Record<string, number> {
  try {
    const v = JSON.parse(localStorage.getItem(storeKey) ?? '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? (Object.fromEntries(Object.entries(v).filter(([, at]) => typeof at === 'number')) as Record<string, number>) : {};
  } catch {
    return {};
  }
}
const loadOnScreen = () => loadStamps(ON_SCREEN_KEY);

/** Alerts some tab claimed to be raising in the last few seconds. */
function raisingNow(now: number): Set<string> {
  return new Set(Object.entries(loadStamps(RAISING_KEY)).flatMap(([key, at]) => (now - at < RAISING_FOR_MS && at <= now + 1000 ? [key] : [])));
}

/** Claims an alert as being raised by this tab, or gives the claim up; lapsed claims go. */
function setRaising(key: string, on: boolean) {
  try {
    const now = Date.now();
    const claims = Object.fromEntries(Object.entries(loadStamps(RAISING_KEY)).filter(([k, at]) => k !== key && now - at < RAISING_FOR_MS && at <= now + 1000));
    if (on) claims[key] = now;
    localStorage.setItem(RAISING_KEY, JSON.stringify(claims));
  } catch {
    /* ignore */
  }
}

/** Notes that this tab has `id` on screen (or nothing, with null), dropping its other notes and any too old to count. */
function noteOnScreen(id: string | null) {
  try {
    const now = Date.now();
    const notes = Object.fromEntries(Object.entries(loadOnScreen()).filter(([key, at]) => !key.startsWith(`${TAB}|`) && now - at < ON_SCREEN_FOR_MS));
    if (id) notes[`${TAB}|${id}`] = now;
    localStorage.setItem(ON_SCREEN_KEY, JSON.stringify(notes));
  } catch {
    /* ignore */
  }
}

function loadFired(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(FIRED_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function saveFired(keys: string[]) {
  try {
    localStorage.setItem(FIRED_KEY, JSON.stringify([...new Set(keys)].slice(-FIRED_MAX)));
  } catch {
    /* ignore */
  }
}

/**
 * Background alerts on every page: a registered tournament starting soon,
 * being seated when the cards are drawn, and being moved to another table.
 * (Your turn is raised by the table page.) With alerts on, it also keeps this
 * device's push subscription up to date, so the server's phone alerts reach
 * it with the site closed. The tags are the server's too
 * (apps/server/src/app.ts), so a device shows each alert once.
 */
export function TournamentAlerts() {
  const state = useNotifyState();
  const on = state === 'on';

  useEffect(() => {
    if (on) void syncPush().catch(() => {});
  }, [on]);

  useEffect(() => {
    if (!on) return;
    const onMoved = ({ from, to }: { from: string; to: string }) => {
      const tournament = tournamentOfTable(to);
      if (!tournament) return;
      // Every tab of the player hears this; the shared tag makes it one alert. It replaces the alert for the seat
      // before, so a tap never opens a table they've left.
      const seat = { tag: `seat:${tournament}:${to}`, url: `/t/${to}`, replaces: `seat:${tournament}:` };
      if (from === '') notify("You're seated", 'Your tournament table is ready. Cards are in the air soon.', seat);
      else notify("You've been moved", 'The tournament moved you to another table.', seat);
    };
    socket.on('table:moved', onMoved);
    return () => {
      socket.off('table:moved', onMoved);
    };
  }, [on]);

  useEffect(() => {
    if (!on) return;
    let list: TournamentListing[] = [];
    let skew = 0;
    let alive = true;
    const load = () =>
      tournamentClient()
        .list()
        .then((r) => {
          if (!alive) return;
          list = r.tournaments;
          skew = r.serverNow - Date.now();
          void check();
        })
        .catch(() => {});
    /** Alerts this tab is showing now, so a check that comes meanwhile doesn't raise one twice. */
    const showing = new Set<string>();
    const check = async () => {
      const now = Date.now();
      const fired = new Set(loadFired());
      // An event's lobby or table on screen, in this tab or another, already counts down, so its alert is held back
      // and comes if the player looks away before the start.
      const here = document.hidden ? null : eventOnPage(location.pathname, tournamentOfTable);
      noteOnScreen(here);
      const held = onScreenNow(loadOnScreen(), now, TAB);
      if (here) held.add(here);
      const raising = raisingNow(now);
      const all = startAlertsDue(list, now + skew, fired).filter((t) => !showing.has(startKey(t)) && !raising.has(startKey(t)));
      if (!all.length) return;
      // Claimed before the wait below: the player switching from the lobby's tab to another tab of the site has the
      // other tab check as this one does, and only one raises it.
      const due = all.filter((t) => !held.has(t.id)).map(startKey);
      for (const key of due) setRaising(key, true);
      // The server's Starting soon reaches a device with push whatever is on screen. One a push already showed here
      // has been had, and isn't given again (the service worker notes what it showed).
      const pushed = await shownByPush(all.map(startKey));
      if (pushed.size) saveFired([...loadFired(), ...pushed]);
      for (const t of all) {
        const key = startKey(t);
        if (!due.includes(key)) continue;
        if (!alive || pushed.has(key) || showing.has(key)) {
          setRaising(key, false);
          continue;
        }
        const minutes = Math.max(1, Math.round((t.startAt! - Date.now() - skew) / 60_000));
        showing.add(key);
        // Shown even with the tab in front: the player may be on another page of the site. It counts as had only once
        // it is shown: a tab that closes as it looks away never shows it, and another tab, or the next visit, gives it.
        void notify('Starting soon', `${t.name} starts in ${minutes} minute${minutes === 1 ? '' : 's'}.`, { tag: key, url: `/tn/${t.id}`, whenVisible: true }).then((ok) => {
          showing.delete(key);
          if (ok) saveFired([...loadFired(), key]);
          setRaising(key, false);
        });
      }
    };
    // Looking away (or closing the tab) ends this tab's note at once, and is checked straight away.
    const onVisibility = () => void check();
    const onHide = () => noteOnScreen(null);
    load();
    const a = setInterval(load, LIST_EVERY_MS);
    const b = setInterval(() => void check(), CHECK_EVERY_MS);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onHide);
    return () => {
      alive = false;
      clearInterval(a);
      clearInterval(b);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onHide);
      noteOnScreen(null);
    };
  }, [on]);

  return null;
}

/** Turns background alerts on or off for this browser. */
export function AlertsToggle({ className = '', quietWhenBlocked = false }: { className?: string; quietWhenBlocked?: boolean }) {
  const state = useNotifyState();
  const push = usePushAvailable();
  const [help, setHelp] = useState(false);
  if (state === 'unsupported') return null;
  // An iPhone or iPad offers alerts to the site only once it is on the home screen: say how, rather than fail.
  if (state === 'install')
    return help ? (
      <span className={`muted tn-alerts-help ${className}`} role="status">
        On iPhone and iPad, alerts work only once the site is on your home screen: in Safari tap <b>Share</b>, then <b>Add to Home Screen</b>, open the site
        from there, and turn alerts on.
      </span>
    ) : (
      <button className={`tn-alerts ${className}`} onClick={() => setHelp(true)}>
        🔕 Turn on alerts
      </button>
    );
  // On the home page a first-time visitor shouldn't open on a warning about their browser.
  if (state === 'denied' && quietWhenBlocked) return null;
  if (state === 'denied')
    return (
      <span className={`muted ${className}`} title="Allow notifications for this site in your browser's settings">
        🔕 Alerts blocked by the browser
      </span>
    );
  return (
    <button
      className={`tn-alerts ${state === 'on' ? 'on' : ''} ${className}`}
      aria-pressed={state === 'on'}
      title={push ? 'Starting soon, seated, moved, and your turn, on this device even with the site closed' : 'Starting soon, seated, moved, and your turn, while this tab is in the background'}
      onClick={() => (state === 'on' ? disableNotifications() : void enableNotifications())}
    >
      {state === 'on' ? '🔔 Alerts on' : '🔕 Turn on alerts'}
    </button>
  );
}

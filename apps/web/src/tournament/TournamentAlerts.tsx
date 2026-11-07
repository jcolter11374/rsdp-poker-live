import { useEffect, useState } from 'react';
import type { TournamentListing } from '@rsdp/tournament';
import { disableNotifications, enableNotifications, notify, syncPush, useNotifyState, usePushAvailable } from '../notify';
import { socket } from '../socket';
import { tournamentClient } from './client';
import { tournamentOfTable } from './hooks';
import { startAlertsDue, startKey } from './startAlerts';

/** How often the list of the player's tournaments is fetched while alerts are on. */
const LIST_EVERY_MS = 60_000;
/** How often starts are checked against the clock. */
const CHECK_EVERY_MS = 15_000;
const FIRED_KEY = 'rsdp.notified';
const FIRED_MAX = 50;

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
    localStorage.setItem(FIRED_KEY, JSON.stringify(keys.slice(-FIRED_MAX)));
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
          check();
        })
        .catch(() => {});
    const check = () => {
      const fired = loadFired();
      // The lobby on screen already counts down. Only alerts that went out count as fired.
      const inFront = document.hidden ? null : (/^\/tn\/([^/]+)$/.exec(location.pathname)?.[1] ?? null);
      const due = startAlertsDue(list, Date.now() + skew, new Set(fired), inFront);
      if (!due.length) return;
      for (const t of due) {
        const minutes = Math.max(1, Math.round((t.startAt! - Date.now() - skew) / 60_000));
        // Shown even with the tab in front: the player may be on another page of the site.
        notify('Starting soon', `${t.name} starts in ${minutes} minute${minutes === 1 ? '' : 's'}.`, { tag: startKey(t), url: `/tn/${t.id}`, whenVisible: true });
      }
      saveFired([...fired, ...due.map(startKey)]);
    };
    load();
    const a = setInterval(load, LIST_EVERY_MS);
    const b = setInterval(check, CHECK_EVERY_MS);
    return () => {
      alive = false;
      clearInterval(a);
      clearInterval(b);
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

import { useEffect } from 'react';
import type { TournamentListing } from '@rsdp/tournament';
import { disableNotifications, enableNotifications, notify, useNotifyState } from '../notify';
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
 * (Your turn is raised by the table page.)
 */
export function TournamentAlerts() {
  const state = useNotifyState();
  const on = state === 'on';

  useEffect(() => {
    if (!on) return;
    const onMoved = ({ from, to }: { from: string; to: string }) => {
      const tournament = tournamentOfTable(to);
      if (!tournament) return;
      // Every tab of the player hears this; the shared tag makes it one alert.
      if (from === '') notify("You're seated", 'Your tournament table is ready. Cards are in the air soon.', { tag: `seat:${tournament}`, url: `/t/${to}` });
      else notify("You've been moved", 'The tournament moved you to another table.', { tag: `seat:${tournament}`, url: `/t/${to}` });
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
      const due = startAlertsDue(list, Date.now() + skew, new Set(fired));
      if (!due.length) return;
      for (const t of due) {
        // The lobby on screen already counts down.
        if (!document.hidden && location.pathname === `/tn/${t.id}`) continue;
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
export function AlertsToggle({ className = '' }: { className?: string }) {
  const state = useNotifyState();
  if (state === 'unsupported') return null;
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
      title="Starting soon, seated, moved, and your turn, while this tab is in the background"
      onClick={() => (state === 'on' ? disableNotifications() : void enableNotifications())}
    >
      {state === 'on' ? '🔔 Alerts on' : '🔕 Turn on alerts'}
    </button>
  );
}

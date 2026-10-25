// Link previews: when a tournament or table link is pasted into a chat app,
// the app reads these meta tags from the page. Crawlers don't run the web app,
// so the server writes them into index.html for each link.

import type { BettingKind } from '@rsdp/engine/core';
import { gameTitle } from '@rsdp/engine/variants';
import { tournamentListing, type TournamentState } from '@rsdp/tournament';

export interface Preview {
  title: string;
  description: string;
}

const SITE = 'RSDP Poker Live!';

function gameNames(ids: string[], betting?: BettingKind): string {
  const names = ids.map((id) => gameTitle(id, betting));
  return names.length > 2 ? `${names.length}-game mix` : names.join(' / ');
}

/** "Thu, Oct 29, 7:30 PM PDT" in the tournament's own time zone (UTC when it has none). */
function when(ms: number, timeZone: string | undefined): string {
  const opts: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' };
  try {
    return new Date(ms).toLocaleString('en-US', { ...opts, timeZone: timeZone ?? 'UTC' });
  } catch {
    return new Date(ms).toLocaleString('en-US', { ...opts, timeZone: 'UTC' });
  }
}

export function tournamentPreview(s: TournamentState, now: number): Preview {
  const t = tournamentListing(s, null, now);
  const start = s.settings.start;
  const games = gameNames(t.games);
  const players = `${t.entrants} ${t.entrants === 1 ? 'player' : 'players'}`;
  let status: string;
  switch (t.status) {
    case 'running':
    case 'paused':
      status = `Running now · Level ${t.levelNumber ?? 1} · ${t.playersLeft} of ${t.entrants} left`;
      break;
    case 'seating':
      status = `Seats drawn · starting now · ${players}`;
      break;
    case 'finished':
      status = `${t.winner ? `Won by ${t.winner}` : 'Finished'} · ${players}`;
      break;
    case 'cancelled':
      status = 'Cancelled';
      break;
    default:
      if (start.kind === 'sng') status = `Sit & Go · ${t.entrants} of ${start.playersNeeded} seats taken · starts when full`;
      else if (start.kind === 'scheduled' && t.startAt !== null) status = `${when(t.startAt, start.schedule?.timeZone)} · ${players} registered · starts automatically`;
      else status = `${players} registered · starts when the host starts it`;
  }
  const invite = t.status === 'registering' ? ' Tap to open the lobby and register.' : '';
  return { title: `${s.settings.name} · ${SITE}`, description: `${games} tournament · ${status}.${invite}` };
}

export function tablePreview(name: string, gameIds: string[], stakes: string, betting?: BettingKind): Preview {
  return { title: `${name} · ${SITE}`, description: `${gameNames(gameIds, betting)} · ${stakes}. Tap to take a seat. No sign-up.` };
}

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** index.html with the preview's title and Open Graph / Twitter tags. `origin` is like https://example.com. */
export function withPreview(html: string, p: Preview, url: string, origin: string): string {
  const tags = [
    `<meta property="og:site_name" content="${escape(SITE)}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:title" content="${escape(p.title)}" />`,
    `<meta property="og:description" content="${escape(p.description)}" />`,
    `<meta property="og:url" content="${escape(url)}" />`,
    `<meta property="og:image" content="${escape(`${origin}/og.jpg`)}" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="description" content="${escape(p.description)}" />`,
  ].join('\n    ');
  // Replacer functions, so a `$&` in a tournament name is just text.
  return html.replace(/<title>[^<]*<\/title>/, () => `<title>${escape(p.title)}</title>`).replace('</head>', () => `    ${tags}\n  </head>`);
}

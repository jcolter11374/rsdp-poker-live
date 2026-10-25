import roadmap from './roadmap.json';
import { Suggestions } from './Suggestions';
import './roadmap.css';

export interface Roadmap {
  /** YYYY-MM-DD */
  lastUpdated: string;
  intro: string;
  sections: { id: string; title: string; blurb: string; items: { title: string; detail: string; /** Who suggested it, credited on the page. */ suggestedBy?: string }[] }[];
}

/** "October 25, 2026", read as a calendar date so no time zone shifts it a day. */
export function formatDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

/** What's live and what's coming, for friends following along. Edit roadmap.json to change it. */
export function RoadmapPage({ data = roadmap as Roadmap }: { data?: Roadmap }) {
  return (
    <main className="roadmap-page">
      <header>
        <a className="logo small" href="/">
          RSDP Poker <span>Live!</span>
        </a>
        <a href="/">Play now</a>
      </header>
      <h1>Roadmap</h1>
      <p className="roadmap-intro">{data.intro}</p>
      <p className="muted">
        Last updated {formatDay(data.lastUpdated)} · <a href="/whats-new">What's new</a> · <a href="#suggest">Suggest an idea</a>
      </p>
      {data.sections.map((s) => (
        <section key={s.id} className={`roadmap-section ${s.id}`}>
          <h2>{s.title}</h2>
          <p className="muted">{s.blurb}</p>
          <ul>
            {s.items.map((it) => (
              <li key={it.title}>
                <strong>{it.title}</strong>
                <span>{it.detail}</span>
                {it.suggestedBy && <em className="credit">Suggested by {it.suggestedBy}</em>}
              </li>
            ))}
          </ul>
        </section>
      ))}
      <Suggestions />
    </main>
  );
}

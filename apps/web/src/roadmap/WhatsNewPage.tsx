import { useEffect, useState } from 'react';
import { formatDay } from './RoadmapPage';
import { markSeen, releases, unseenRelease, type Release } from './whatsNew';
import './roadmap.css';
import { SiteFooter, SiteHeader } from '../components/SiteHeader';

/** /whats-new: what each release added, newest first. Edit whatsnew.json to change it. */
export function WhatsNewPage({ list = releases }: { list?: Release[] }) {
  useEffect(() => markSeen(list), [list]);
  return (
    <div className="site-page">
      <SiteHeader />
      <main className="roadmap-page">
        <h1>What's new</h1>
        <p className="roadmap-intro">
          Everything that's been added, newest first. See what's coming next on the <a href="/roadmap">roadmap</a>.
        </p>
        {list.map((r) => (
          <section key={r.id} className="roadmap-section release">
            <h2>{r.title}</h2>
            <p className="muted">{formatDay(r.date)}</p>
            <ul>
              {r.items.map((it) => (
                <li key={it.title}>
                  <strong>{it.title}</strong>
                  <span>{it.detail}</span>
                  {it.suggestedBy && <em className="credit">Suggested by {it.suggestedBy}</em>}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </main>
      <SiteFooter />
    </div>
  );
}

/** A small note on the home page after a new release, until it's opened or dismissed. */
export function WhatsNewBanner() {
  const [release, setRelease] = useState(unseenRelease);
  if (!release) return null;
  const dismiss = () => (markSeen(), setRelease(null));
  return (
    <div className="whats-new-banner" role="status">
      <span>
        <strong>New:</strong> {release.title}. <a href="/whats-new" onClick={() => markSeen()}>See what's new</a>
      </span>
      <button aria-label="Dismiss" onClick={dismiss}>
        ×
      </button>
    </div>
  );
}

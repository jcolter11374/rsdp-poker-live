import { formatDay } from './RoadmapPage';
import { changelog, releases, type ChangelogEntry, type Release } from './whatsNew';
import './roadmap.css';
import { SiteFooter, SiteHeader } from '../components/SiteHeader';

/** /changelog: every release with its small fixes, newest first. Edit changelog.json to change it. */
export function ChangelogPage({ list = changelog, features = releases }: { list?: ChangelogEntry[]; features?: Release[] }) {
  const titles = new Map(features.map((r) => [r.id, r.title]));
  return (
    <div className="site-page">
      <SiteHeader />
      <main className="roadmap-page">
        <h1>Changelog</h1>
        <p className="roadmap-intro">
          Every release and the small fixes in it, newest first. New features are on <a href="/whats-new">What's new</a>.
        </p>
        {list.map((r) => (
          <section key={r.id} className="roadmap-section release">
            <h2>{titles.get(r.id) ?? 'Fixes'}</h2>
            <p className="muted">{formatDay(r.date)}</p>
            {r.fixes.length > 0 ? (
              <ul className="changelog-list">
                {r.fixes.map((fix) => (
                  <li key={fix}>{fix}</li>
                ))}
              </ul>
            ) : (
              <p className="muted">No small fixes in this one, just the new features.</p>
            )}
          </section>
        ))}
      </main>
      <SiteFooter />
    </div>
  );
}

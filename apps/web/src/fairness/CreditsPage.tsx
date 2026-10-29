import { useEffect, useState } from 'react';
import doc from '../../../../docs/CREDITS.md?raw';
import { Markdown } from './markdown';
import { sourceLink } from './FairnessPage';
import './fairness.css';
import { SiteFooter, SiteHeader } from '../components/SiteHeader';

/** One package from /licenses.json, which the build makes from what's installed (apps/web/licenses.mjs). */
export type CreditedPackage = { name: string; version: string; license: string; homepage: string; parts: string[]; noticeFile: boolean };

const WHERE: Record<string, string> = { browser: 'your browser', server: 'the server' };

/** "your browser and the server", for the Used in column. */
export function whereText(parts: string[]): string {
  return parts.map((p) => WHERE[p] ?? p).join(' and ');
}

/** How many packages use each license, most first: "MIT 104, ISC 3". */
export function licenseCounts(list: CreditedPackage[]): [license: string, count: number][] {
  const counts = new Map<string, number>();
  for (const p of list) counts.set(p.license, (counts.get(p.license) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** /credits: the open-source software the site is built on and its licenses. The words are docs/CREDITS.md; the list is made at build time. */
export function CreditsPage() {
  const [list, setList] = useState<CreditedPackage[] | null | 'failed'>(null);

  useEffect(() => {
    fetch('/licenses.json')
      .then((r) => (r.ok ? (r.json() as Promise<CreditedPackage[]>) : Promise.reject(new Error(String(r.status)))))
      .then(setList, () => setList('failed'));
  }, []);

  return (
    <div className="site-page">
      <SiteHeader />
      <main className="fairness-page">
        <article>
          <Markdown source={doc} link={sourceLink} />
          <h2 id="all">Every package, with its license</h2>
          {list === null && <p className="muted">Loading the list…</p>}
          {list === 'failed' && (
            <p>
              The list didn't load. Every package and its license text is also in <a href="/third-party-licenses.txt">third-party-licenses.txt</a>.
            </p>
          )}
          {Array.isArray(list) && (
            <>
              <p>
                {list.length} packages: {licenseCounts(list).map(([l, n]) => `${l} ${n}`).join(', ')}. Their license texts in full are in <a href="/third-party-licenses.txt">third-party-licenses.txt</a>.
              </p>
              <div className="md-table">
                <table className="credits-table">
                  <thead>
                    <tr>
                      <th>Package</th>
                      <th>License</th>
                      <th>Used in</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((p) => (
                      <tr key={`${p.name}@${p.version}`}>
                        <td>
                          <a href={p.homepage} rel="noreferrer">
                            {p.name}
                          </a>{' '}
                          <span className="muted">{p.version}</span>
                        </td>
                        <td>{p.license}</td>
                        <td>{whereText(p.parts)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </article>
        <p className="muted">
          Source of this page: <a href="https://github.com/jcolter11374/rsdp-poker-live/blob/main/docs/CREDITS.md">docs/CREDITS.md</a> on GitHub, and the list from{' '}
          <a href="https://github.com/jcolter11374/rsdp-poker-live/blob/main/apps/web/licenses.mjs">apps/web/licenses.mjs</a>.
        </p>
      </main>
      <SiteFooter />
    </div>
  );
}

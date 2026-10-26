import doc from '../../../../docs/FAIRNESS.md?raw';
import { Markdown } from './markdown';
import './fairness.css';
import { SiteFooter, SiteHeader } from '../components/SiteHeader';

const REPO = 'https://github.com/jcolter11374/rsdp-poker-live/blob/main/';

/** Links in the doc point at files in the repo (../packages/...); on the site they open the source on GitHub. */
export function sourceLink(href: string): string {
  if (/^(https?:|mailto:|#|\/)/.test(href)) return href;
  return new URL(href, `${REPO}docs/`).href;
}

/** /fairness: how the cards are shuffled, the audit, the test results and how to check a hand. It is docs/FAIRNESS.md, so the two never drift apart. */
export function FairnessPage() {
  return (
    <div className="site-page">
      <SiteHeader />
      <main className="fairness-page">
        <article>
          <Markdown source={doc} link={sourceLink} />
        </article>
        <p className="muted">
          Source of this page: <a href={`${REPO}docs/FAIRNESS.md`}>docs/FAIRNESS.md</a> on GitHub, where every file mentioned here can be read.
        </p>
      </main>
      <SiteFooter />
    </div>
  );
}

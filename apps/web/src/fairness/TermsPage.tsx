import doc from '../../../../docs/TERMS.md?raw';
import { Markdown } from './markdown';
import { sourceLink } from './FairnessPage';
import './fairness.css';
import { SiteFooter, SiteHeader } from '../components/SiteHeader';

/** /terms: the terms of use and the no-warranty disclaimer. It is docs/TERMS.md, so the two never drift apart. */
export function TermsPage() {
  return (
    <div className="site-page">
      <SiteHeader />
      <main className="fairness-page">
        <article>
          <Markdown source={doc} link={sourceLink} />
        </article>
        <p className="muted">
          Source of this page: <a href="https://github.com/jcolter11374/rsdp-poker-live/blob/main/docs/TERMS.md">docs/TERMS.md</a> on GitHub.
        </p>
      </main>
      <SiteFooter />
    </div>
  );
}

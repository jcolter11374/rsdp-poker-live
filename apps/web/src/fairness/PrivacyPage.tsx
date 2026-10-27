import doc from '../../../../docs/PRIVACY.md?raw';
import { Markdown } from './markdown';
import { sourceLink } from './FairnessPage';
import './fairness.css';
import { SiteFooter, SiteHeader } from '../components/SiteHeader';

/** /privacy: what the site keeps about you and how to remove it. It is docs/PRIVACY.md, so the two never drift apart. */
export function PrivacyPage() {
  return (
    <div className="site-page">
      <SiteHeader />
      <main className="fairness-page">
        <article>
          <Markdown source={doc} link={sourceLink} />
        </article>
        <p className="muted">
          Source of this page: <a href="https://github.com/jcolter11374/rsdp-poker-live/blob/main/docs/PRIVACY.md">docs/PRIVACY.md</a> on GitHub.
        </p>
      </main>
      <SiteFooter />
    </div>
  );
}

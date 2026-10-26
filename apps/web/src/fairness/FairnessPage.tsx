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

/** The doc's title and opening paragraph; the explainer video sits between them and the rest. */
export function splitIntro(md: string): [string, string] {
  const at = md.indexOf('\n## ');
  return at < 0 ? [md, ''] : [md.slice(0, at), md.slice(at + 1)];
}

/** /fairness: how the cards are shuffled, the audit, the test results and how to check a hand. It is docs/FAIRNESS.md, so the two never drift apart. */
export function FairnessPage() {
  const [intro, rest] = splitIntro(doc);
  return (
    <div className="site-page">
      <SiteHeader />
      <main className="fairness-page">
        <article>
          <Markdown source={intro} link={sourceLink} />
          {/* Click to play: preload="none" so nothing downloads until someone presses play. */}
          <figure className="fairness-video">
            <video controls preload="none" playsInline poster="/media/fairness-explainer.jpg" aria-label="Video: how a hand is proven fair">
              <source src="/media/fairness-explainer.mp4" type="video/mp4" />
            </video>
            <figcaption>Watch: how a hand is proven fair (9 min)</figcaption>
          </figure>
          <Markdown source={rest} link={sourceLink} />
        </article>
        <p className="muted">
          Source of this page: <a href={`${REPO}docs/FAIRNESS.md`}>docs/FAIRNESS.md</a> on GitHub, where every file mentioned here can be read.
        </p>
      </main>
      <SiteFooter />
    </div>
  );
}

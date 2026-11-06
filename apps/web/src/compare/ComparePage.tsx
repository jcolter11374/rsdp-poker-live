import { CHECKED, GROUPS, MARKS, POKERNOW_PLANS, type Cell, type Mark } from './compare';
import './compare.css';
import { SiteFooter, SiteHeader } from '../components/SiteHeader';

function Badge({ mark }: { mark: Mark }) {
  return (
    <span className={`cmp-mark cmp-${mark}`} aria-hidden>
      {MARKS[mark].symbol}
    </span>
  );
}

function CellView({ cell, us }: { cell: Cell; us?: boolean }) {
  return (
    <td className={us ? 'cmp-us' : undefined}>
      <Badge mark={cell.mark} />
      <span className="cmp-label">{MARKS[cell.mark].label}</span>
      {cell.note && <span className="cmp-note">{cell.note}</span>}
    </td>
  );
}

/** /compare: this site next to PokerNow's free plan and PokerNow Plus (D28: the one page that names it). */
export function ComparePage() {
  return (
    <div className="site-page">
      <SiteHeader />
      <main className="compare-page">
        <h1>How we compare with PokerNow</h1>
        <p className="cmp-lede">
          Many of us played on PokerNow first, so here is what each one offers, side by side. Everything here is free for everyone, with no paid plans. PokerNow is the more mature site, and the rows where it's ahead are
          here too.
        </p>
        <p className="cmp-small">
          Checked on {CHECKED}. Our column is what's live on this site. PokerNow's columns come from its own <a href={POKERNOW_PLANS} rel="noreferrer">plans page</a> and blog, and its features change, so some of this may be
          out of date. PokerNow is a separate company, and this site isn't connected with it.
        </p>

        <ul className="cmp-legend" aria-label="What the marks mean">
          {(Object.keys(MARKS) as Mark[]).map((m) => (
            <li key={m}>
              <Badge mark={m} /> {MARKS[m].label}
            </li>
          ))}
        </ul>

        <div className="cmp-box">
          <table className="cmp-table">
            <thead>
              <tr>
                <th scope="col">Feature</th>
                <th scope="col" className="cmp-us">
                  RSDP Poker Live!
                </th>
                <th scope="col">PokerNow free</th>
                <th scope="col">
                  PokerNow Plus <span className="cmp-price">$9.99 a month</span>
                </th>
              </tr>
            </thead>
            {GROUPS.map((g) => (
              <tbody key={g.title}>
                <tr className="cmp-group">
                  <th colSpan={4} scope="colgroup">
                    {g.title}
                  </th>
                </tr>
                {g.rows.map((r) => (
                  <tr key={r.feature}>
                    <th scope="row">{r.feature}</th>
                    <CellView cell={r.us} us />
                    <CellView cell={r.free} />
                    <CellView cell={r.plus} />
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </div>

        <section className="cmp-more">
          <h2>In short</h2>
          <p>
            On features, we match or beat PokerNow Plus almost everywhere, for free, and we deal more games. PokerNow is ahead on voice and video, on alerts when your phone is locked, and on years of running busy nights. Voice,
            video and phone alerts are on our <a href="/roadmap">roadmap</a>.
          </p>
          <p>
            PokerNow Platinum ($49.99 a month) adds 20 themes, 600-player tournaments, games without promotions for everyone, and club tournaments. Clubs and AI game analysis are left out here on purpose.
          </p>
          <p>
            Spotted something wrong or out of date? <a href="/roadmap#suggest">Tell us</a>.
          </p>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}

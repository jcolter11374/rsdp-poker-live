import { FEATURES } from './features';
import './about.css';
import { SiteFooter, SiteHeader } from '../components/SiteHeader';

/** /about: what the site is and the main things it offers, in plain words for friends. */
export function AboutPage() {
  return (
    <div className="site-page">
      <SiteHeader />
      <main className="about-page">
        <section className="about-hero">
          <h1>
            About RSDP Poker <span>Live!</span>
          </h1>
          <p className="about-lede">
            A free home for our poker group. Start a table, send the link, and play from a computer or phone. There are no paid extras: every game and every option is free for everyone.
          </p>
          <div className="about-actions">
            <a className="about-button primary" href="/">
              Start playing
            </a>
            <a className="about-button" href="/rules">
              Learn the games
            </a>
          </div>
        </section>

        <h2 className="about-heading">What you can do here</h2>
        <ul className="about-grid">
          {FEATURES.map((f) => (
            <li key={f.title} className="about-card">
              <span className="about-icon" aria-hidden>
                {f.icon}
              </span>
              <h3>{f.title}</h3>
              <span>{f.detail}</span>
              {f.link && <a href={f.link.href}>{f.link.label} <span aria-hidden>→</span></a>}
            </li>
          ))}
        </ul>

        <section className="about-more">
          <h2>Always getting better</h2>
          <p>
            New things land all the time, and lots of them start as ideas from people who play here. See what's coming on the <a href="/roadmap">roadmap</a>, catch up on <a href="/whats-new">what's new</a>, or{' '}
            <a href="/roadmap#suggest">suggest an idea</a>.
          </p>
        </section>

        <section className="about-more">
          <h2>Your data</h2>
          <p>
            Nothing is sold or shared, and there are no ads or trackers. The <a href="/privacy">privacy page</a> says exactly what the site keeps about you, who can see it and how to delete it.
          </p>
        </section>

        <section className="about-more">
          <h2>How it's made</h2>
          <p>
            The poker is our own, written for this site from scratch, mostly with an AI coding assistant (Claude) with John steering. Underneath it are free, open-source building blocks such as React, Node.js and Socket.IO. The <a href="/credits">credits page</a> names them all, with their licenses.
          </p>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}

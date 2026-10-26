import { useEffect, useState, useSyncExternalStore } from 'react';
import { currentSession, onSession } from '../socket';

const LINKS: [href: string, label: string][] = [
  ['/tn/new', 'Host a tournament'],
  ['/leaderboard', 'Leaderboard'],
  ['/rules', 'Learn the games'],
  ['/whats-new', "What's new"],
  ['/about', 'About'],
];

/** Which link is the page you're on. */
function current(href: string, path: string): boolean {
  return path === href || path.startsWith(`${href}/`);
}

/**
 * The same top line on every page that isn't a table: the logo (always home),
 * the main links, and Sign in or your name. On a phone the links fold into a menu.
 */
export function SiteHeader() {
  const session = useSyncExternalStore(onSession, currentSession);
  const [open, setOpen] = useState(false);
  const path = location.pathname;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <header className={`site-header ${open ? 'open' : ''}`}>
      <a className="logo small" href="/" title="Home">
        RSDP Poker <span>Live!</span>
      </a>
      <button className="site-menu-button" aria-expanded={open} aria-controls="site-nav" aria-label="Menu" onClick={() => setOpen(!open)}>
        <span aria-hidden>{open ? '✕' : '☰'}</span>
      </button>
      <nav id="site-nav" className="site-nav">
        {LINKS.map(([href, label]) => (
          <a key={href} href={href} aria-current={current(href, path) ? 'page' : undefined}>
            {label}
          </a>
        ))}
        <span className="site-account">
          {session?.account ? (
            <a href="/profile" aria-current={path === '/profile' ? 'page' : undefined} title="Your profile">
              <span className="account-dot" aria-hidden /> {session.account.username}
            </a>
          ) : (
            <>
              <a href="/profile" aria-current={path === '/profile' ? 'page' : undefined}>
                Your history
              </a>
              <a href="/signin" className="site-signin" aria-current={path === '/signin' ? 'page' : undefined}>
                Sign in
              </a>
            </>
          )}
        </span>
      </nav>
    </header>
  );
}

/** The links at the bottom of the home page and the info pages. */
export function SiteFooter() {
  return (
    <footer className="site-footer">
      <a href="/about">About</a>
      <a href="/rules">How to play</a>
      <a href="/hands">Search your hands</a>
      <a href="/roadmap">Roadmap</a>
      <a href="/whats-new">What's new</a>
      <a href="/changelog">Changelog</a>
      <a href="/roadmap#suggest">Suggest an idea</a>
      <a href="/fairness">Fair dealing</a>
      <span className="muted">Play money only. Every game and option is free.</span>
    </footer>
  );
}

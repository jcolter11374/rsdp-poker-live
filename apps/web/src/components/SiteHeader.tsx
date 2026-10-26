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

let build: Promise<string | null> | null = null;
/** The commit the server says it runs (/api/version), asked once per page load. */
function useBuild() {
  const [commit, setCommit] = useState<string | null>(null);
  useEffect(() => {
    build ??= fetch('/api/version')
      .then((r) => (r.ok ? (r.json() as Promise<{ commit: string | null }>) : null))
      .then((v) => v?.commit ?? null)
      .catch(() => null);
    let live = true;
    void build.then((c) => live && setCommit(c));
    return () => {
      live = false;
    };
  }, []);
  return commit;
}

/** The links at the bottom of the home page and the info pages. */
export function SiteFooter() {
  const commit = useBuild();
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
      <a href="/transparency">Checking John</a>
      {commit && <a href={`https://github.com/jcolter11374/rsdp-poker-live/commit/${commit}`} title="The code this server says it runs; /transparency shows GitHub's check of it">Build {commit.slice(0, 7)}</a>}
    </footer>
  );
}

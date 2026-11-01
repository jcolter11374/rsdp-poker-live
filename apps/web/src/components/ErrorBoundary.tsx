import { Component, type ReactNode } from 'react';
import { pageBuild } from '../freshness';
import { buildName, reportError } from '../reportError';

/**
 * Catches a crash in what it wraps: React would otherwise take the whole page
 * away and leave a blank screen. It tells the server, and shows `fallback`.
 */
class Boundary extends Component<{ kind: 'crash' | 'part'; fallback: (retry: () => void) => ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    reportError(error, this.props.kind);
  }
  render() {
    return this.state.failed ? this.props.fallback(() => this.setState({ failed: false })) : this.props.children;
  }
}

/**
 * Around the whole app: a crash anywhere shows a short note and a Reload
 * button instead of a blank page. Plain markup and the site's own styles, so
 * it works whatever broke.
 */
export function PageBoundary({ children }: { children: ReactNode }) {
  return (
    <Boundary kind="crash" fallback={() => <CrashPage />}>
      {children}
    </Boundary>
  );
}

function CrashPage() {
  const build = buildName(pageBuild());
  return (
    <main className="home">
      <h1 className="logo">
        RSDP Poker <span>Live!</span>
      </h1>
      <p>Something broke on this page. Reloading it usually fixes it.</p>
      <button className="primary big" onClick={() => location.reload()}>
        Reload the page
      </button>
      <p>
        <a href="/">Go to the home page</a>
      </p>
      <p className="muted">If it keeps happening, tell John{build ? ` and mention build ${build}` : ''}.</p>
    </main>
  );
}

/**
 * Around one part of a page (a table's side panel or chat): if that part
 * crashes, the rest of the page carries on and the part offers to try again.
 */
export function PartBoundary({ name, children }: { name: string; children: ReactNode }) {
  return (
    <Boundary
      kind="part"
      fallback={(retry) => (
        <div className="panel">
          <p className="muted">The {name} broke. The rest of the table still works.</p>
          <button onClick={retry}>Try again</button>
        </div>
      )}
    >
      {children}
    </Boundary>
  );
}

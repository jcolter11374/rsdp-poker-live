import { useEffect, useState, type FormEvent } from 'react';
import { StatusPill } from './Suggestions';
import { ApiError, checkAdminKey, deleteSuggestion, fetchSuggestions, logOrder, shortDate, STATUS_LABEL, STATUSES, updateSuggestion, type Suggestion } from './suggestions';
import { issueResetCode } from '../account/api';
import './roadmap.css';

const KEY = 'rsdp.adminKey';

function savedKey(): string {
  try {
    return localStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
}

/** /roadmap/admin: the admin sets each suggestion's status and an optional public reply. */
export function RoadmapAdminPage() {
  const [key, setKey] = useState(savedKey);
  /** Bumped on every Open, so trying the same key again re-checks it. */
  const [attempt, setAttempt] = useState(0);
  const [entered, setEntered] = useState('');
  const [ok, setOk] = useState(false);
  const [error, setError] = useState('');
  const [list, setList] = useState<Suggestion[]>([]);

  useEffect(() => {
    if (!key) return;
    checkAdminKey(key)
      .then(() => fetchSuggestions())
      .then((l) => (setList(l), setOk(true), setError('')))
      .catch((e: Error) => {
        setOk(false);
        setError(e.message);
        // Forget a saved key only when it is wrong, not when the server is briefly unreachable.
        if (e instanceof ApiError && e.status === 401) {
          try {
            localStorage.removeItem(KEY);
          } catch {
            // ignore
          }
        }
      });
  }, [key, attempt]);

  function signIn(e: FormEvent) {
    e.preventDefault();
    try {
      localStorage.setItem(KEY, entered);
    } catch {
      // The key then lasts only for this visit.
    }
    setKey(entered);
    setAttempt((n) => n + 1);
  }

  function signOut() {
    try {
      localStorage.removeItem(KEY);
    } catch {
      // ignore
    }
    setKey('');
    setOk(false);
  }

  const replace = (s: Suggestion) => setList((l) => l.map((x) => (x.id === s.id ? s : x)));

  return (
    <main className="roadmap-page">
      <header>
        <a className="logo small" href="/">
          RSDP Poker <span>Live!</span>
        </a>
        <a href="/roadmap">Back to the roadmap</a>
      </header>
      <h1>Admin</h1>
      {!ok ? (
        <form className="suggest-form" onSubmit={signIn}>
          <label>
            Admin key
            <input type="password" value={entered} onChange={(e) => setEntered(e.target.value)} autoComplete="current-password" />
          </label>
          {error && <p className="error">{error}</p>}
          <button className="primary" disabled={!entered}>
            Open
          </button>
        </form>
      ) : (
        <>
          <p className="muted">
            Changes show on the public log right away. <button onClick={signOut}>Sign out</button>
          </p>
          <ResetCodeForm adminKey={key} />
          <h2>Suggestions</h2>
          {error && <p className="error">{error}</p>}
          {list.length === 0 && <p className="muted">No suggestions yet.</p>}
          <ul className="admin-list">
            {logOrder(list).map((s) => (
              <AdminRow key={s.id} s={s} adminKey={key} onSaved={replace} onDeleted={() => setList((l) => l.filter((x) => x.id !== s.id))} onError={setError} />
            ))}
          </ul>
        </>
      )}
    </main>
  );
}

function AdminRow(props: { s: Suggestion; adminKey: string; onSaved: (s: Suggestion) => void; onDeleted: () => void; onError: (m: string) => void }) {
  const { s, adminKey } = props;
  const [reply, setReply] = useState(s.reply);
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
      props.onError('');
    } catch (e) {
      props.onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li>
      <div className="suggest-head">
        <strong>{s.title}</strong>
        <StatusPill status={s.status} />
      </div>
      {s.detail && <span className="suggest-detail">{s.detail}</span>}
      <span className="suggest-meta">
        #{s.id} · {s.name} · {shortDate(s.createdAt)}
      </span>
      <div className="admin-controls">
        <label>
          Status
          <select value={s.status} disabled={busy} onChange={(e) => run(async () => props.onSaved(await updateSuggestion(adminKey, s.id, { status: e.target.value as Suggestion['status'] })))}>
            {STATUSES.map((st) => (
              <option key={st} value={st}>
                {STATUS_LABEL[st]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Public reply (optional)
          <input value={reply} maxLength={300} onChange={(e) => setReply(e.target.value)} />
        </label>
        <div className="admin-buttons">
          <button disabled={busy || reply === s.reply} onClick={() =>
              run(async () => {
                const saved = await updateSuggestion(adminKey, s.id, { reply });
                // The server tidies spacing; show what actually went public.
                setReply(saved.reply);
                props.onSaved(saved);
              })
            }>
            Save reply
          </button>
          <button
            disabled={busy}
            onClick={() => confirm(`Delete "${s.title}" for good? Use this for spam.`) && run(async () => (await deleteSuggestion(adminKey, s.id), props.onDeleted()))}
          >
            Delete
          </button>
        </div>
      </div>
    </li>
  );
}

/** Someone forgot their password: make them a one-time code to send in WhatsApp. */
function ResetCodeForm({ adminKey }: { adminKey: string }) {
  const [username, setUsername] = useState('');
  const [issued, setIssued] = useState<{ username: string; code: string; expiresAt: string } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setIssued(null);
    try {
      setIssued(await issueResetCode(adminKey, username.trim()));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="suggest-form" onSubmit={submit}>
      <strong>Password reset code</strong>
      <span className="muted">For a player who forgot their password. Send them the code; they enter it on the Forgot password page. It works once, for 24 hours.</span>
      <label>
        Their username
        <input value={username} maxLength={24} autoCapitalize="none" spellCheck={false} required onChange={(e) => setUsername(e.target.value)} />
      </label>
      {error && <p className="error">{error}</p>}
      {issued && (
        <p className="suggest-thanks">
          Code for {issued.username}: <strong className="reset-code">{issued.code}</strong> (until {new Date(issued.expiresAt).toLocaleString()}). They go to{' '}
          {location.origin}/reset.
        </p>
      )}
      <button disabled={busy || !username.trim()}>Make a code</button>
    </form>
  );
}

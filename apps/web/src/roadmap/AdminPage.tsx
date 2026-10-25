import { useEffect, useState, type FormEvent } from 'react';
import { StatusPill } from './Suggestions';
import { checkAdminKey, deleteSuggestion, fetchSuggestions, logOrder, shortDate, STATUS_LABEL, STATUSES, updateSuggestion, type Suggestion } from './suggestions';
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
        try {
          localStorage.removeItem(KEY);
        } catch {
          // ignore
        }
      });
  }, [key]);

  function signIn(e: FormEvent) {
    e.preventDefault();
    try {
      localStorage.setItem(KEY, entered);
    } catch {
      // The key then lasts only for this visit.
    }
    setKey(entered);
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
      <h1>Suggestions admin</h1>
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
          <button disabled={busy || reply === s.reply} onClick={() => run(async () => props.onSaved(await updateSuggestion(adminKey, s.id, { reply })))}>
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

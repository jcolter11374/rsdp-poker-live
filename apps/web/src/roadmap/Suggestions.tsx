import { useEffect, useState, type FormEvent } from 'react';
import { fetchSuggestions, logOrder, sendSuggestion, shortDate, STATUS_LABEL, type Suggestion } from './suggestions';

const NAME_KEY = 'rsdp.suggestName';

function savedName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

export function StatusPill({ status }: { status: Suggestion['status'] }) {
  return <span className={`suggest-status ${status}`}>{STATUS_LABEL[status]}</span>;
}

/** The form to send an idea, and the public log of every idea and where it stands. */
export function Suggestions() {
  const [list, setList] = useState<Suggestion[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [name, setName] = useState(savedName);
  const [title, setTitle] = useState('');
  const [detail, setDetail] = useState('');
  const [website, setWebsite] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [thanks, setThanks] = useState(false);

  useEffect(() => {
    fetchSuggestions().then(setList, (e: Error) => setLoadError(e.message));
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { suggestion } = await sendSuggestion({ name, title, detail, website });
      try {
        localStorage.setItem(NAME_KEY, name.trim());
      } catch {
        // Only a convenience.
      }
      if (suggestion) setList((l) => [...(l ?? []), suggestion]);
      setTitle('');
      setDetail('');
      setThanks(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="roadmap-section suggest" id="suggest">
        <h2>Suggest something</h2>
        <p className="muted">Got an idea? Send it in. Approved ideas get built, and you get the credit.</p>
        <form className="suggest-form" onSubmit={submit}>
          <label>
            Your name
            <input value={name} maxLength={30} required onChange={(e) => setName(e.target.value)} placeholder="So we can credit you" />
          </label>
          <label>
            Your idea
            <input value={title} maxLength={100} required onChange={(e) => (setTitle(e.target.value), setThanks(false))} placeholder="e.g. A high hand jackpot" />
          </label>
          <label>
            More detail (optional)
            <textarea value={detail} maxLength={1000} rows={3} onChange={(e) => setDetail(e.target.value)} />
          </label>
          {/* Hidden from people; bots fill it in. */}
          <input className="suggest-trap" tabIndex={-1} autoComplete="off" aria-hidden="true" value={website} onChange={(e) => setWebsite(e.target.value)} name="website" />
          {error && <p className="error">{error}</p>}
          {thanks && <p className="suggest-thanks">Thanks! Your idea is in the log below.</p>}
          <button className="primary" disabled={busy || !name.trim() || !title.trim()}>
            {busy ? 'Sending…' : 'Send idea'}
          </button>
        </form>
      </section>

      <section className="roadmap-section suggest-log">
        <h2>Suggestion log</h2>
        <p className="muted">Every idea sent in, and where it stands.</p>
        {loadError && <p className="error">{loadError}</p>}
        {list && list.length === 0 && <p className="muted">No ideas yet. Be the first!</p>}
        <ul>
          {logOrder(list ?? []).map((s) => (
            <li key={s.id}>
              <div className="suggest-head">
                <strong>{s.title}</strong>
                <StatusPill status={s.status} />
              </div>
              {s.detail && <span className="suggest-detail">{s.detail}</span>}
              {s.reply && <span className="suggest-reply">{s.reply}</span>}
              <span className="suggest-meta">
                {s.name} · {shortDate(s.createdAt)}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

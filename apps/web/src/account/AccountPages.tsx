import { useEffect, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import { currentSession, onSession, saveSessionToken, setName } from '../socket';
import { chipFormat } from '../format';
import { money } from '../tournament/format';
import { MyProfile } from '../components/table/Persona';
import { changePassword, deleteAccount, fetchAuthConfig, fetchProfile, reloadTo, resetPassword, signIn, signOut, signUp, startGoogle, unlinkGoogle, type Profile } from './api';
import '../components/table/extras.css';
import './account.css';

/** The session the server sent, or null before it arrives. */
export function useSession() {
  return useSyncExternalStore(onSession, currentSession);
}

/** The small "Sign in" or "Mike" link at the top of the home page. */
export function AccountLink() {
  const session = useSession();
  if (!session) return <nav className="account-link" />;
  return (
    <nav className="account-link">
      {session.account ? (
        <a href="/profile" title="Your profile">
          <span className="account-dot" aria-hidden /> {session.account.username}
        </a>
      ) : (
        <>
          <a href="/profile">Your history</a>
          <a href="/signin" className="account-signin">
            Sign in
          </a>
        </>
      )}
    </nav>
  );
}

function Shell({ title, children }: { title: string; children: ReactNode }) {
  useEffect(() => {
    document.title = `${title} · RSDP Poker Live!`;
  }, [title]);
  return (
    <main className="account-page">
      <header>
        <a className="logo small" href="/">
          RSDP Poker <span>Live!</span>
        </a>
        <a href="/">Back to the games</a>
      </header>
      <h1>{title}</h1>
      {children}
    </main>
  );
}

/** Runs a form action with a busy flag and the server's message on failure. */
function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run, setError };
}

/** True once the server says it offers Google sign-in. */
function useGoogle() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    fetchAuthConfig()
      .then((c) => setOn(c.google))
      .catch(() => {});
  }, []);
  return on;
}

function GoogleButton({ label, onClick, busy }: { label: string; onClick: () => void; busy: boolean }) {
  return (
    <button type="button" className="google-button" disabled={busy} onClick={onClick}>
      <svg viewBox="0 0 48 48" width="18" height="18" aria-hidden>
        <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.9 6.1C12.5 13.6 17.8 9.5 24 9.5z" />
        <path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.7c4.3-4 6.9-9.9 6.9-17.1z" />
        <path fill="#FBBC05" d="M10.6 28.6c-.5-1.4-.8-2.9-.8-4.6s.3-3.2.8-4.6l-7.9-6.1C1 16.6 0 20.2 0 24s1 7.4 2.7 10.7l7.9-6.1z" />
        <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.7c-2.1 1.4-4.8 2.3-8.5 2.3-6.2 0-11.5-4.1-13.4-9.9l-7.9 6.1C6.6 42.6 14.6 48 24 48z" />
      </svg>
      {label}
    </button>
  );
}

const USERNAME_HINT = '3 to 24 letters, numbers, dots, dashes or underscores.';

export function SignUpPage() {
  const session = useSession();
  const google = useGoogle();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const { busy, error, run, setError } = useAction();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (password !== again) return setError("The two passwords don't match.");
    void run(async () => {
      const res = await signUp(username.trim(), password);
      // A guest with no name yet takes their username at the table.
      if (!currentSession()?.displayName) await setName(res.username.slice(0, 20)).catch(() => {});
      reloadTo('/profile?welcome=1');
    });
  };

  if (session?.account) return <AlreadySignedIn username={session.account.username} />;
  return (
    <Shell title="Create an account">
      <p className="account-intro">
        Accounts are optional. You can keep playing as a guest. With an account, your name, picture, notes and history come with you to any phone or computer you sign in on.
      </p>
      <p className="account-intro">Everything you've played on this device so far stays yours.</p>
      {google && (
        <div className="account-google">
          <GoogleButton label="Sign up with Google" busy={busy} onClick={() => void run(() => startGoogle('signin'))} />
          <span className="muted">No password to remember. Or make one with a username below.</span>
        </div>
      )}
      <form className="account-form" onSubmit={submit}>
        <label>
          Username
          <input value={username} autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={24} required onChange={(e) => setUsername(e.target.value)} />
          <span className="hint">{USERNAME_HINT}</span>
        </label>
        <label>
          Password
          <input type="password" value={password} autoComplete="new-password" minLength={8} maxLength={200} required onChange={(e) => setPassword(e.target.value)} />
          <span className="hint">At least 8 characters.</span>
        </label>
        <label>
          Password again
          <input type="password" value={again} autoComplete="new-password" minLength={8} maxLength={200} required onChange={(e) => setAgain(e.target.value)} />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="primary" disabled={busy}>
          Create account
        </button>
        <p className="muted">
          There's no email, so remember your password. If you forget it, ask the site admin for a reset code{google ? ', or link Google on your profile' : ''}.
        </p>
      </form>
      <p className="account-alt">
        Already have one? <a href="/signin">Sign in</a>
      </p>
    </Shell>
  );
}

export function SignInPage() {
  const session = useSession();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [bringOver, setBringOver] = useState(true);
  const google = useGoogle();
  const { busy, error, run } = useAction();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const res = await signIn(username.trim(), password, bringOver);
      reloadTo(res.broughtOver ? '/profile?merged=1' : '/profile');
    });
  };

  if (session?.account) return <AlreadySignedIn username={session.account.username} />;
  return (
    <Shell title="Sign in">
      <p className="account-intro">Sign in to play as yourself on this device, with your name, picture, notes and history.</p>
      {google && (
        <div className="account-google">
          <GoogleButton label="Continue with Google" busy={busy} onClick={() => void run(() => startGoogle('signin', bringOver))} />
          <span className="muted">New here? This makes your account too.</span>
        </div>
      )}
      <form className="account-form" onSubmit={submit}>
        <label>
          Username
          <input value={username} autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={24} required onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label>
          Password
          <input type="password" value={password} autoComplete="current-password" maxLength={200} required onChange={(e) => setPassword(e.target.value)} />
        </label>
        <label className="account-check">
          <input type="checkbox" checked={bringOver} onChange={(e) => setBringOver(e.target.checked)} />
          <span>
            This is my device: move what I did here as a guest (notes, picture, tables and tournaments) into my account. Untick this on a friend's phone so their stuff stays theirs.
          </span>
        </label>
        {error && <p className="error">{error}</p>}
        <button className="primary" disabled={busy}>
          Sign in
        </button>
      </form>
      <p className="account-alt">
        New here? <a href="/signup">Create an account</a> · <a href="/reset">Forgot your password?</a>
      </p>
    </Shell>
  );
}

function AlreadySignedIn({ username }: { username: string }) {
  return (
    <Shell title="You're signed in">
      <p className="account-intro">
        You're signed in as <strong>{username}</strong>. <a href="/profile">Go to your profile</a> to sign out first.
      </p>
    </Shell>
  );
}

export function ResetPage() {
  const [username, setUsername] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [done, setDone] = useState(false);
  const { busy, error, run } = useAction();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await resetPassword(username.trim(), code.trim(), password);
      setDone(true);
    });
  };

  return (
    <Shell title="Reset your password">
      {done ? (
        <p className="account-intro">
          Done. Your new password works now, and every device was signed out. <a href="/signin">Sign in</a>.
        </p>
      ) : (
        <>
          <p className="account-intro">
            There's no email here, so ask the site admin for a reset code (send them your username in WhatsApp). The code works once, for 24 hours.
          </p>
          <form className="account-form" onSubmit={submit}>
            <label>
              Username
              <input value={username} autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={24} required onChange={(e) => setUsername(e.target.value)} />
            </label>
            <label>
              Reset code
              <input value={code} autoComplete="one-time-code" autoCapitalize="characters" spellCheck={false} maxLength={20} placeholder="XXXX-XXXX-XXXX" required onChange={(e) => setCode(e.target.value)} />
            </label>
            <label>
              New password
              <input type="password" value={password} autoComplete="new-password" minLength={8} maxLength={200} required onChange={(e) => setPassword(e.target.value)} />
              <span className="hint">At least 8 characters.</span>
            </label>
            {error && <p className="error">{error}</p>}
            <button className="primary" disabled={busy}>
              Set new password
            </button>
          </form>
        </>
      )}
    </Shell>
  );
}

const shortDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')}`;

export function ProfilePage() {
  const session = useSession();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loadError, setLoadError] = useState('');
  const params = new URLSearchParams(location.search);

  useEffect(() => {
    if (!session) return;
    fetchProfile()
      .then(setProfile)
      .catch((e: Error) => setLoadError(e.message));
    // Load again when the server's idea of me changes (a rename, a sign-in elsewhere).
  }, [session?.playerId, session?.account?.username]);

  const account = session?.account ?? null;
  return (
    <Shell title={account ? account.username : 'Your profile'}>
      {params.has('welcome') && <p className="account-note">Your account is ready. You're signed in on this device.</p>}
      {params.has('merged') && <p className="account-note">Signed in. What you did on this device as a guest is in your account now.</p>}
      {params.has('signedin') && <p className="account-note">Signed in.</p>}
      {params.has('linked') && <p className="account-note">Google is linked. You can sign in with it on any device now.</p>}
      {account ? (
        <p className="account-intro">
          Signed in as <strong>{account.username}</strong>
          {profile?.account && ` since ${shortDate(profile.account.createdAt)}`}. Sign in with the same username on any other device to play as you there.
        </p>
      ) : (
        <div className="account-guest">
          <p>
            You're playing as a guest, so this is only what you've played <strong>on this device</strong>. Create an account to keep your name, picture, notes and history on every device.
          </p>
          <div className="row">
            <a className="button primary" href="/signup">
              Create an account
            </a>
            <a className="button" href="/signin">
              Sign in
            </a>
          </div>
        </div>
      )}

      <section className="account-section">
        <h2>Name at the table</h2>
        <NameForm current={session?.displayName ?? ''} />
      </section>

      <section className="account-section">
        <MyProfile view={null} />
      </section>

      <section className="account-section">
        <h2>Cash games</h2>
        {loadError && <p className="error">{loadError}</p>}
        {!profile ? !loadError && <p className="muted">Loading…</p> : <TablesList profile={profile} />}
      </section>

      <section className="account-section">
        <h2>Tournaments</h2>
        {profile && <TournamentsList profile={profile} />}
      </section>

      {account && (
        <>
          <GoogleSection profile={profile} />
          <section className="account-section">
            <h2>{profile?.account && !profile.account.hasPassword ? 'Set a password' : 'Password'}</h2>
            <PasswordForm needsCurrent={profile?.account?.hasPassword ?? true} />
          </section>
          <section className="account-section">
            <h2>Sign out</h2>
            <p className="muted">This device goes back to being a new guest. Your account and history stay safe; sign in again any time.</p>
            <button onClick={() => void signOut().then(() => reloadTo('/'))}>Sign out</button>
          </section>
          <section className="account-section danger">
            <h2>Delete account</h2>
            <DeleteForm hasPassword={profile?.account?.hasPassword ?? true} username={account.username} />
          </section>
        </>
      )}
    </Shell>
  );
}

function NameForm({ current }: { current: string }) {
  const [name, setValue] = useState(current);
  const [saved, setSaved] = useState(false);
  const { busy, error, run } = useAction();
  useEffect(() => setValue(current), [current]);
  return (
    <form
      className="row account-inline"
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          await setName(name);
          setSaved(true);
        });
      }}
    >
      <input value={name} maxLength={20} required aria-label="Name at the table" onChange={(e) => (setValue(e.target.value), setSaved(false))} />
      <button disabled={busy || !name.trim() || name.trim() === current}>Save</button>
      {saved && <span className="good">Saved</span>}
      {error && <p className="error">{error}</p>}
    </form>
  );
}

function TablesList({ profile }: { profile: Profile }) {
  if (profile.tables.length === 0) return <p className="muted">No hands played yet.</p>;
  return (
    <ul className="account-list">
      {profile.tables.map((t) => {
        const fmt = chipFormat(t.centsMode);
        return (
          <li key={t.tableId}>
            <a href={`/t/${t.tableId}`}>{t.name || 'Table'}</a>
            <span className="muted">
              {shortDate(t.lastPlayedAt)} · {t.hands} {t.hands === 1 ? 'hand' : 'hands'}
              {t.practice && ' · practice'}
            </span>
            {t.net !== null && <span className={`account-net ${t.net > 0 ? 'up' : t.net < 0 ? 'down' : ''}`}>{t.net > 0 ? `+${fmt(t.net)}` : t.net < 0 ? `−${fmt(-t.net)}` : 'even'}</span>}
          </li>
        );
      })}
    </ul>
  );
}

function TournamentsList({ profile }: { profile: Profile }) {
  if (profile.tournaments.length === 0) return <p className="muted">No tournaments yet.</p>;
  return (
    <ul className="account-list">
      {profile.tournaments.map((t) => (
        <li key={t.id}>
          <a href={`/tn/${t.id}`}>{t.name || 'Tournament'}</a>
          <span className="muted">
            {shortDate(t.at)} · {t.entrants} {t.entrants === 1 ? 'player' : 'players'}
            {t.hosted && ' · you hosted'}
          </span>
          <span className="account-net">
            {t.status === 'cancelled'
              ? 'cancelled'
              : !t.entered
                ? ''
                : t.place
                  ? `${ordinal(t.place)}${t.prize > 0 ? ` · ${money(t.prize)}` : ''}`
                  : t.status === 'finished'
                    ? ''
                    : 'playing'}
          </span>
        </li>
      ))}
    </ul>
  );
}

function PasswordForm({ needsCurrent }: { needsCurrent: boolean }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [done, setDone] = useState(false);
  const { busy, error, run } = useAction();
  return (
    <form
      className="account-form"
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          await changePassword(current, next);
          setCurrent('');
          setNext('');
          setDone(true);
          // The page now shows "Change password" with the current one asked for.
          if (!needsCurrent) setTimeout(() => location.reload(), 1200);
        });
      }}
    >
      {needsCurrent ? (
        <label>
          Current password
          <input type="password" value={current} autoComplete="current-password" required onChange={(e) => setCurrent(e.target.value)} />
        </label>
      ) : (
        <p className="muted">You sign in with Google. Add a password too if you'd like to sign in with your username as well.</p>
      )}
      <label>
        New password
        <input type="password" value={next} autoComplete="new-password" minLength={8} maxLength={200} required onChange={(e) => (setNext(e.target.value), setDone(false))} />
      </label>
      {error && <p className="error">{error}</p>}
      {done && <p className="good">{needsCurrent ? 'Password changed. Your other devices need to sign in again.' : 'Password set.'}</p>}
      <button disabled={busy}>{needsCurrent ? 'Change password' : 'Set password'}</button>
    </form>
  );
}

function DeleteForm({ hasPassword, username }: { hasPassword: boolean; username: string }) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const { busy, error, run } = useAction();
  if (!open)
    return (
      <>
        <p className="muted">Removes your username, password, name, picture and notes for good. Hands you played stay in the other players' history and ledgers, under the name you used then.</p>
        <button className="danger" onClick={() => setOpen(true)}>
          Delete my account…
        </button>
      </>
    );
  return (
    <form
      className="account-form"
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          await deleteAccount(hasPassword ? { password } : { username: password });
          reloadTo('/');
        });
      }}
    >
      <p>This can't be undone. {hasPassword ? 'Type your password to confirm.' : `Type your username (${username}) to confirm.`}</p>
      <label>
        {hasPassword ? 'Password' : 'Username'}
        <input type={hasPassword ? 'password' : 'text'} value={password} autoComplete={hasPassword ? 'current-password' : 'off'} required onChange={(e) => setPassword(e.target.value)} />
      </label>
      {error && <p className="error">{error}</p>}
      <div className="row">
        <button type="submit" className="danger" disabled={busy}>
          Delete my account
        </button>
        <button type="button" onClick={() => setOpen(false)}>
          Keep it
        </button>
      </div>
    </form>
  );
}

function GoogleSection({ profile }: { profile: Profile | null }) {
  const google = useGoogle();
  const { busy, error, run } = useAction();
  const linked = !!profile?.account?.google;
  if (!profile?.account || (!google && !linked)) return null;
  return (
    <section className="account-section">
      <h2>Google</h2>
      {linked ? (
        <>
          <p className="muted">You can sign in with Google on any device.</p>
          {profile.account.hasPassword && (
            <button disabled={busy} onClick={() => void run(async () => (await unlinkGoogle(), reloadTo('/profile')))}>
              Stop using Google to sign in
            </button>
          )}
        </>
      ) : (
        <>
          <p className="muted">Link your Google account to sign in with one tap instead of your password.</p>
          <GoogleButton label="Link Google" busy={busy} onClick={() => void run(() => startGoogle('link'))} />
        </>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}

/** Where Google sends the browser back: keeps the session from the address fragment, then opens the profile. */
export function AuthDonePage() {
  const [error, setError] = useState('');
  useEffect(() => {
    const f = new URLSearchParams(location.hash.slice(1));
    // The token must not stay in the address bar or the history.
    history.replaceState(null, '', '/auth/done');
    if (f.get('error')) return setError(f.get('error')!);
    if (f.get('linked')) return reloadTo('/profile?linked=1');
    const session = f.get('session');
    if (!session) return setError('Sign-in did not finish. Try again.');
    saveSessionToken(session);
    reloadTo(f.get('welcome') ? '/profile?welcome=1' : f.get('merged') ? '/profile?merged=1' : '/profile?signedin=1');
  }, []);
  return (
    <Shell title={error ? 'Sign-in did not work' : 'Signing you in…'}>
      {error && (
        <>
          <p className="error">{error}</p>
          <p className="account-alt">
            <a href="/signin">Back to sign in</a>
          </p>
        </>
      )}
    </Shell>
  );
}

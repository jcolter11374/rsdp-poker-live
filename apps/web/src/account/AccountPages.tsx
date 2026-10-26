import { useEffect, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import { currentSession, onSession, saveSessionToken, setName } from '../socket';
import { chipFormat } from '../format';
import { money } from '../tournament/format';
import { MyProfile } from '../components/table/Persona';
import { changePassword, deleteAccount, fetchAuthConfig, fetchProfile, hideTable, reloadTo, resetPassword, signIn, signOut, signUp, startGoogle, finishGoogle, unlinkGoogle, type Profile, type TableRow } from './api';
import '../components/table/extras.css';
import { ProfitGraph } from './ProfitGraph';
import './account.css';
import { SiteHeader } from '../components/SiteHeader';

/** The session the server sent, or null before it arrives. */
export function useSession() {
  return useSyncExternalStore(onSession, currentSession);
}

export function Shell({ title, children, narrow = false }: { title: string; children: ReactNode; /** Sign-in style pages: a short centred column. */ narrow?: boolean }) {
  useEffect(() => {
    document.title = `${title} · RSDP Poker Live!`;
  }, [title]);
  return (
    <div className="site-page">
      <SiteHeader />
      <main className={`account-page ${narrow ? 'account-narrow' : ''}`}>
        <h1>{title}</h1>
        {children}
      </main>
    </div>
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
    <Shell title="Create an account" narrow>
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
    <Shell title="Sign in" narrow>
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
            Keep what I played here as a guest
            <span className="hint">Your notes, picture, tables and tournaments on this device move into your account. Untick this on a friend's phone so their things stay theirs.</span>
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
    <Shell title="You're signed in" narrow>
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
    <Shell title="Reset your password" narrow>
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

  const load = () =>
    fetchProfile()
      .then((p) => (setProfile(p), setLoadError('')))
      .catch((e: Error) => setLoadError(e.message));
  useEffect(() => {
    if (!session) return;
    void load();
    // Load again when the server's idea of me changes (a rename, a sign-in elsewhere).
  }, [session?.playerId, session?.account?.username]);

  const account = session?.account ?? null;
  return (
    <Shell title={account ? account.username : 'Your profile'}>
      {params.has('welcome') && <p className="account-note">Your account is ready. You're signed in on this device.</p>}
      {params.has('merged') && <p className="account-note">Signed in. What you did on this device as a guest is in your account now.</p>}
      {params.has('signedin') && <p className="account-note">Signed in.</p>}
      {params.has('linked') && <p className="account-note">Google is linked. You can sign in with it on any device now.</p>}
      {params.has('confirmed') && <p className="account-note">Confirmed. For the next few minutes you can set a password or delete your account.</p>}
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
        <h2>Profit graph</h2>
        {session && <ProfitGraph refreshKey={profile} practiceGames={profile?.tables.filter((t) => t.practice).length ?? 0} />}
        <p className="hint">
          See how everyone's doing on the <a href="/leaderboard">leaderboard</a>, or <a href="/hands">search your hands</a>.
        </p>
      </section>

      <section className="account-section">
        <h2>Cash games</h2>
        {loadError && <p className="error">{loadError}</p>}
        {!profile ? !loadError && <p className="muted">Loading…</p> : <TablesList profile={profile} onChanged={load} />}
      </section>

      <section className="account-section">
        <h2>Tournaments</h2>
        {profile && <TournamentsList profile={profile} />}
      </section>

      <section className="account-section">
        <h2>Name at the table</h2>
        <NameForm current={session?.displayName ?? ''} />
      </section>

      <section className="account-section">
        <MyProfile view={null} />
      </section>

      {account && (
        <>
          <GoogleSection profile={profile} />
          <section className="account-section">
            <h2>{profile?.account && !profile.account.hasPassword ? 'Set a password' : 'Password'}</h2>
            <PasswordForm needsCurrent={profile?.account?.hasPassword ?? true} confirmed={params.has('confirmed')} />
          </section>
          <section className="account-section">
            <h2>Sign out</h2>
            <p className="muted">This device goes back to being a new guest. Your account and history stay safe; sign in again any time.</p>
            <button onClick={() => void signOut().then(() => reloadTo('/'))}>Sign out</button>
          </section>
          <section className="account-section danger">
            <h2>Delete account</h2>
            <DeleteForm hasPassword={profile?.account?.hasPassword ?? true} username={account.username} confirmed={params.has('confirmed')} />
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

function TablesList({ profile, onChanged }: { profile: Profile; onChanged: () => Promise<unknown> }) {
  const { busy, error, run } = useAction();
  const toggle = (tableId: string, hidden: boolean) => run(() => hideTable(tableId, hidden).then(onChanged));
  const hidden = profile.hiddenTables ?? [];
  // Practice (bots, or on your own) is kept apart so it never mixes with results against real people.
  const real = profile.tables.filter((t) => !t.practice);
  const practice = profile.tables.filter((t) => t.practice);
  const hide = { action: 'Hide', title: 'Hide this table from your profile. It stays for everyone else.', busy, onAction: (id: string) => toggle(id, true) };
  return (
    <>
      {real.length === 0 ? (
        <p className="muted">{practice.length || hidden.length ? 'No real games with other people yet.' : 'No hands played yet.'}</p>
      ) : (
        <TableRows rows={real} {...hide} />
      )}
      {error && <p className="error">{error}</p>}
      {practice.length > 0 && (
        <details className="account-hidden">
          <summary>Practice games ({practice.length})</summary>
          <p className="hint">Games with bots, or where nobody else played. They don't count in your graph or on the leaderboard.</p>
          <TableRows rows={practice} {...hide} />
        </details>
      )}
      {hidden.length > 0 && (
        <details className="account-hidden">
          <summary>Hidden tables ({hidden.length})</summary>
          <TableRows rows={hidden} action="Show again" title="Put this table back on your profile" busy={busy} onAction={(id) => toggle(id, false)} />
        </details>
      )}
    </>
  );
}

function TableRows(props: { rows: TableRow[]; action: string; title: string; busy: boolean; onAction: (tableId: string) => void }) {
  return (
    <ul className="account-list">
      {props.rows.map((t) => {
        const fmt = chipFormat(t.centsMode);
        return (
          <li key={t.tableId}>
            <a href={`/t/${t.tableId}`}>{t.name || 'Table'}</a>
            <span className="muted">
              {shortDate(t.lastPlayedAt)} · {t.hands} {t.hands === 1 ? 'hand' : 'hands'}
              {' · '}
              {t.playingNow ? (
                <span className="account-live" title="People are at this table right now">
                  {t.playingNow === 1 ? '1 person there now' : `${t.playingNow} people there now`}
                </span>
              ) : (
                <span title="Nobody is at this table. Its link opens it again, with everything kept.">closed</span>
              )}
              {' · '}
              <button className="link" title={props.title} disabled={props.busy} onClick={() => props.onAction(t.tableId)}>
                {props.action}
              </button>
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

/** Accounts made with Google confirm with Google before setting a first password or being deleted. */
function ConfirmWithGoogle({ what }: { what: string }) {
  const { busy, error, run } = useAction();
  return (
    <div className="account-google">
      <span className="muted">You sign in with Google, so confirm it's you with Google first to {what}.</span>
      <GoogleButton label="Confirm with Google" busy={busy} onClick={() => void run(() => startGoogle('confirm'))} />
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function PasswordForm({ needsCurrent, confirmed }: { needsCurrent: boolean; confirmed: boolean }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [done, setDone] = useState(false);
  const { busy, error, run } = useAction();
  if (!needsCurrent && !confirmed) return <ConfirmWithGoogle what="add a password" />;
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
          if (!needsCurrent) setTimeout(() => reloadTo('/profile'), 1200);
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

function DeleteForm({ hasPassword, username, confirmed }: { hasPassword: boolean; username: string; confirmed: boolean }) {
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
  if (!hasPassword && !confirmed) return <ConfirmWithGoogle what="delete your account" />;
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
  const [password, setPassword] = useState('');
  const linked = !!profile?.account?.google;
  if (!profile?.account || (!google && !linked)) return null;
  const hasPassword = profile.account.hasPassword;
  // Linking or unlinking asks for the password, so someone who got hold of a signed-in device can't change how you sign in.
  const passwordField = hasPassword && (
    <label>
      Your password
      <input type="password" value={password} autoComplete="current-password" onChange={(e) => setPassword(e.target.value)} />
    </label>
  );
  return (
    <section className="account-section">
      <h2>Google</h2>
      {linked ? (
        <>
          <p className="muted">You can sign in with Google on any device.</p>
          {hasPassword && (
            <div className="account-form">
              {passwordField}
              <button disabled={busy || !password} onClick={() => void run(async () => (await unlinkGoogle(password), reloadTo('/profile')))}>
                Stop using Google to sign in
              </button>
            </div>
          )}
        </>
      ) : (
        <div className="account-form">
          <p className="muted">Link your Google account to sign in with one tap instead of your password.</p>
          {passwordField}
          <GoogleButton label="Link Google" busy={busy || (hasPassword && !password)} onClick={() => void run(() => startGoogle('link', true, password))} />
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}

/** The fixed words for each error code Google sign-in can come back with (never text from the address). */
const GOOGLE_ERRORS: Record<string, string> = {
  off: 'Sign in with Google is not set up on this server.',
  expired: 'That sign-in took too long or was already used. Try again.',
  cancelled: 'Google sign-in was cancelled.',
  'other-browser': 'That Google sign-in was started in another browser. Start it again here.',
};
// Errors from finishing (taken, not-yours, stale and so on) come back as the server's fixed message.

/** Where Google sends the browser back: finishes with the one-time ticket, then opens the profile. */
export function AuthDonePage() {
  const [error, setError] = useState('');
  useEffect(() => {
    const f = new URLSearchParams(location.hash.slice(1));
    // The ticket must not stay in the address bar or the history.
    history.replaceState(null, '', '/auth/done');
    const code = f.get('error');
    if (code) return setError(GOOGLE_ERRORS[code] ?? 'Google sign-in did not work. Try again.');
    const ticket = f.get('ticket');
    if (!ticket) return setError('Sign-in did not finish. Try again.');
    finishGoogle(ticket)
      .then((r) => {
        if (r.linked) return reloadTo('/profile?linked=1');
        if (r.confirmed) return reloadTo('/profile?confirmed=1');
        if (!r.session) return setError('Sign-in did not finish. Try again.');
        saveSessionToken(r.session);
        reloadTo(r.welcome ? '/profile?welcome=1' : r.merged ? '/profile?merged=1' : '/profile?signedin=1');
      })
      .catch((e: Error) => setError(e.message));
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

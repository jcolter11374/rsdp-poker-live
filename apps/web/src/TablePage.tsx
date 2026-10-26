import { useEffect, useMemo, useRef, useState } from 'react';
import { getVariant } from '@rsdp/engine/variants';
import type { SeatView, TableView } from '@rsdp/engine/wire';
import { call, socket } from './socket';
import { contributeSeed, liveSeedProblem } from './fair';
import { nextVolume, setVolume, sounds, useVolume, VOLUME_NAME } from './sound';
import { badgeFavicon, buzz } from './alerts';
import { closeNotifications, notify } from './notify';
import { usePortrait } from './layout';
import { bbFormat, chipFormat, clock, gameLabel, stakesLabel } from './format';
import { getPrefs, setPrefs, usePrefs } from './prefs';
import { useWakeLock } from './wakeLock';
import { Table, useNow } from './components/Table';
import { HandExtras } from './components/table/HandExtras';
import { PlayerExtras } from './components/table/Persona';
import { SeatingBanners } from './components/table/Seating';
import { ActionBar } from './components/ActionBar';
import { HostPanel } from './components/HostPanel';
import { SidePanel, type Tab } from './components/SidePanel';
import { Sheet } from './components/Sheet';
import { Modal, PlayerDialog, RebuyDialog, RemoveBot, SeatDialog } from './components/SeatDialog';
import { SettingsDialog } from './components/SettingsDialog';
import { RulesDialog } from './components/RulesDialog';
import { PeopleDialog } from './components/PeopleDialog';
import { LookDialog } from './components/LookDialog';
import { hasKeyboard, ShortcutsDialog } from './components/Shortcuts';
import { TableStrip } from './tournament/TableStrip';
import { navigate, tournamentOfTable, useFollowSeat } from './tournament/hooks';

/** Plays sounds, buzzes and badges the tab for what changed between two views. */
function useTableEffects(view: TableView | null, skew: number, preQueued: { current: boolean }) {
  const prev = useRef<TableView | null>(null);
  useEffect(() => {
    const before = prev.current;
    prev.current = view;
    if (!view || !before) return;
    if (view.chat.length > before.chat.length && view.chat.at(-1)?.playerId && view.chat.at(-1)?.playerId !== view.me.playerId) sounds.chat();
    if (view.powers.includes('approve') && view.requests.length > before.requests.length) sounds.request();
    const hand = view.hand;
    if (!hand) return;
    const fresh = hand.handNumber !== before.hand?.handNumber;
    const seen = fresh ? -1 : (before.hand?.events.at(-1)?.seq ?? -1);
    const events = hand.events.filter((e) => e.seq > seen);
    if (events.some((e) => e.t === 'deal' || e.t === 'board')) sounds.deal();
    for (const e of events) {
      if (e.t !== 'action') continue;
      if (e.allIn) sounds.allIn();
      else if (e.action === 'fold') sounds.fold();
      else if (e.action === 'check') sounds.check();
      else if (e.action === 'raise' || e.action === 'bet' || e.action === 'complete') sounds.raise();
      else sounds.chips();
    }
    const won = hand.phase === 'complete' && before.hand?.phase !== 'complete';
    if (won && view.me.seat !== null && hand.awards.some((a) => a.seat === view.me.seat)) sounds.win();
    else if (won && hand.awards.length) sounds.pot();
    const myTurn = !!view.legal || !!view.canDraw || view.canVoteRunItTwice;
    const wasMyTurn = !!before.legal || !!before.canDraw || before.canVoteRunItTwice;
    // A queued move (check/fold, call any) answers for you, so there is nothing to call you for.
    if (myTurn && !wasMyTurn && !preQueued.current) {
      sounds.turn();
      buzz();
      notify('Your turn', view.name, { tag: `turn:${view.id}`, url: `/t/${view.id}` });
    }
  }, [view]);

  const myTurn = !!view?.legal || !!view?.canDraw || !!view?.canVoteRunItTwice;

  // A warning beep a few seconds before your clock runs out.
  const deadline = myTurn && view?.turn?.seat === view?.me.seat ? (view?.turn?.deadline ?? null) : null;
  useEffect(() => {
    if (deadline === null) return;
    const ms = deadline - skew - HURRY_MS - Date.now();
    if (ms < 0) return;
    const t = setTimeout(() => {
      sounds.hurry();
      buzz(200);
    }, ms);
    return () => clearTimeout(t);
  }, [deadline, skew]);

  // Flash the tab title and badge its icon while it's your turn.
  useEffect(() => {
    if (!myTurn) return;
    const original = document.title;
    badgeFavicon(true);
    let on = false;
    const t = setInterval(() => {
      if (document.hidden) {
        on = !on;
        document.title = on ? '▶ Your turn!' : original;
      } else document.title = original;
    }, 800);
    return () => {
      clearInterval(t);
      document.title = original;
      badgeFavicon(false);
      // Acted (here or in another tab): the alert is out of date.
      closeNotifications('turn:');
    };
  }, [myTurn]);
}

const HURRY_MS = 5000;

type Dialog = { kind: 'seat'; seat: number; waitlist?: boolean } | { kind: 'player'; seat: SeatView } | { kind: 'rebuy' } | { kind: 'settings' } | { kind: 'rules' } | { kind: 'people' } | { kind: 'look' } | { kind: 'keys' } | null;

export function TablePage({ tableId }: { tableId: string }) {
  const [view, setView] = useState<TableView | null>(null);
  const [skew, setSkew] = useState(0);
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [sheet, setSheet] = useState<'menu' | Tab | null>(null);
  const [copied, setCopied] = useState(false);
  const [connected, setConnected] = useState(socket.connected);
  const volume = useVolume();
  const [discard, setDiscard] = useState<number[]>([]);
  const [chatSeen, setChatSeen] = useState(0);
  const preQueued = useRef(false);
  const portrait = usePortrait();
  useTableEffects(view, skew, preQueued);
  const readyTable = useFollowSeat(tableId, view?.me.seat != null);

  useEffect(() => {
    const join = () => call('table:join', { tableId }).catch((e: Error) => setError(e.message));
    let first = true;
    const onState = (v: TableView) => {
      if (v.id !== tableId) return;
      setView(v);
      contributeSeed(v);
      setSkew(v.serverNow - Date.now());
      // Chat from before you arrived is not news.
      if (first) setChatSeen(v.chat.length);
      first = false;
    };
    const onConnect = () => {
      setConnected(true);
      join();
    };
    const onDisconnect = () => setConnected(false);
    socket.on('table:state', onState);
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    // The socket may have connected after the first render but before this ran, so its connect event is gone.
    setConnected(socket.connected);
    if (socket.connected) join();
    return () => {
      socket.off('table:state', onState);
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.emit('table:leave');
    };
  }, [tableId]);

  // The discard pick is for one draw only.
  const drawKey = view?.canDraw ? `${view.hand?.handNumber}:${view.hand?.street}` : '';
  useEffect(() => setDiscard([]), [drawKey]);

  const fmt = useMemo(() => chipFormat(!!view?.settings.stakes.centsMode), [view?.settings.stakes.centsMode]);
  // The felt and the bet box can show amounts in big blinds; buy-ins and the ledger stay in chips.
  const prefs = usePrefs();
  const studNow = (view?.hand?.family ?? (view?.upcoming ? gameFamily(view.upcoming.gameId) : 'flop')) === 'stud';
  const bigBlind = studNow ? 0 : (view?.hand?.stakes.bigBlind ?? view?.upcoming?.stakes.bigBlind ?? view?.settings.stakes.bigBlind ?? 0);
  const bigBlindRef = useRef(bigBlind);
  bigBlindRef.current = bigBlind;
  const feltFmt = useMemo(() => (prefs.units === 'bb' && bigBlind > 0 ? bbFormat(bigBlind) : fmt), [prefs.units, bigBlind, fmt]);
  useWakeLock(prefs.wakeLock && view?.me.seat != null);
  // B switches between chips and big blinds; ? lists every shortcut.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      if (e.target instanceof HTMLElement && e.target.closest('input, textarea, select, [contenteditable]')) return;
      if (e.key === '?') {
        if (!document.querySelector('.modal-backdrop, .sheet-backdrop, .replayer-backdrop')) setDialog({ kind: 'keys' });
        return;
      }
      if (e.key.toLowerCase() !== 'b' || !bigBlindRef.current) return;
      setPrefs({ units: getPrefs().units === 'bb' ? 'chips' : 'bb' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // A one-time tip about the keyboard shortcuts, for seated players on a computer.
  const [keysTipSeen, setKeysTipSeen] = useState(() => {
    try {
      return localStorage.getItem('rsdp.tip.keys') === '1';
    } catch {
      return true;
    }
  });
  const dismissKeysTip = () => {
    setKeysTipSeen(true);
    try {
      localStorage.setItem('rsdp.tip.keys', '1');
    } catch {
      /* ignore */
    }
  };
  const keysTip = !keysTipSeen && !portrait && view?.me.seat != null && hasKeyboard();
  const now = useNow(!!view?.level?.endsAt, 1000) + skew;
  // Losing your seat without pressing Leave (the host removed you, or an offline seat was released) gets a word of explanation.
  const wasSeated = useRef(false);
  const leftByMe = useRef(false);
  const [unseated, setUnseated] = useState(false);
  useEffect(() => {
    const seated = view?.me.seat != null;
    if (wasSeated.current && !seated && !leftByMe.current && view?.mode === 'cash') setUnseated(true);
    if (seated) {
      leftByMe.current = false;
      setUnseated(false);
    }
    wasSeated.current = seated;
  }, [view?.me.seat]);

  if (error) {
    // A tournament table closes when it breaks; the lobby knows the new seat.
    const tournament = error === 'table not found' ? tournamentOfTable(tableId) : null;
    return (
      <main className="home">
        <h1 className="logo">
          RSDP Poker <span>Live!</span>
        </h1>
        <p className="error">{error === 'table not found' ? 'This table has closed or the link is wrong.' : error}</p>
        {tournament && (
          <p>
            <a href={`/tn/${tournament}`}>Back to the tournament lobby</a>
          </p>
        )}
        <a href="/">Start a new table</a>
      </main>
    );
  }
  if (!view) return <main className="home">Connecting…</main>;

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      prompt('Copy this link', location.href);
    }
  };

  const cash = view.mode === 'cash';
  const mySeat = view.me.seat !== null ? view.seats[view.me.seat] : null;
  const seatRequest = view.requests.find((r) => r.playerId === view.me.playerId && r.kind === 'seat');
  const rebuyRequest = view.requests.find((r) => r.playerId === view.me.playerId && r.kind === 'rebuy');
  const pending = view.powers.includes('approve') ? view.requests.length : 0;
  const handLive = !!view.hand && view.hand.phase !== 'complete';
  const inHand = !!mySeat?.inHand && handLive;
  const canRebuy = cash && !!mySeat && view.settings.seating.allowRebuys;
  // A player sees only their own bots' requests; the host sees everyone's and never has to ask.
  const myBotRequests = view.powers.includes('approve') ? [] : view.requests.filter((r) => r.bot);
  const myBots = view.seats.filter((s) => s?.bot?.ownerId === view.me.playerId).length + myBotRequests.length;
  const canAddBot = cash && (view.powers.includes('players') || (!!mySeat && view.settings.seating.allowPlayerBots !== false && myBots < 3));
  const addBot = (seat: number) =>
    call('bot:add', { seat })
      .then(() => {
        if (view.settings.seating.requireApproval && !view.powers.includes('approve')) alert('Your bot is waiting for the host to approve it.');
      })
      .catch((e: Error) => alert(e.message));
  const unread = sheet === 'chat' ? 0 : Math.max(0, view.chat.length - chatSeen);
  const close = () => setSheet(null);

  const game = view.hand
    ? { label: gameLabel(view.hand.gameId, view.hand.betting), stakes: stakesLabel(view.hand.stakes, view.hand.family, view.hand.betting, fmt) }
    : view.upcoming
      ? {
          label: gameLabel(view.upcoming.gameId, view.upcoming.betting),
          stakes: stakesLabel(view.upcoming.stakes, gameFamily(view.upcoming.gameId), view.upcoming.betting, fmt),
        }
      : null;
  const level = view.level;
  const levelText = level
    ? `Level ${level.index + 1}/${level.count}${level.endsAt ? ` · ${clock(level.endsAt - now)}` : level.handsLeft !== null ? ` · ${level.handsLeft} hands` : ''}`
    : null;
  // Straddles need blinds, so stud tables never offer them.
  const nextFamily = view.hand?.family ?? (view.upcoming ? gameFamily(view.upcoming.gameId) : 'flop');
  const straddleOn = cash && view.settings.play.straddle !== 'off' && nextFamily !== 'stud';

  const volumeButton = (
    <button
      title={VOLUME_NAME[volume]}
      aria-label={VOLUME_NAME[volume]}
      onClick={() => {
        const v = nextVolume(volume);
        setVolume(v);
        if (v > 0) sounds.chips();
      }}
    >
      {volume === 0 ? '🔇' : volume < 0.5 ? '🔈' : volume < 1 ? '🔉' : '🔊'}
      {portrait && <> {VOLUME_NAME[volume]}</>}
    </button>
  );
  const seatButtons = mySeat && (
    <>
      {canRebuy && <button onClick={() => setDialog({ kind: 'rebuy' })}>Add chips</button>}
      <button onClick={() => call('seat:sitOut', { value: !mySeat.sittingOut })}>{mySeat.sittingOut ? "I'm back" : 'Sit out'}</button>
      {cash && (
        <button
          onClick={() =>
            confirm(inHand ? 'Leave your seat when this hand ends? Your chips go back to the ledger.' : 'Leave your seat? Your chips go back to the ledger.') &&
            ((leftByMe.current = true), socket.emit('seat:stand', { afterHand: inHand }))
          }
        >
          {mySeat.leaving ? 'Leaving…' : 'Leave seat'}
        </button>
      )}
    </>
  );
  const seatOptions = mySeat && cash && (straddleOn || mySeat.waiting) && (
    <div className="seat-options">
      {straddleOn && (
        <label className="toggle">
          <input type="checkbox" checked={mySeat.straddle} onChange={(e) => call('seat:prefs', { straddle: e.target.checked })} />
          Straddle when I'm under the gun
        </label>
      )}
      {mySeat.waiting && (
        <label className="toggle">
          <input type="checkbox" checked={mySeat.waitForBigBlind} onChange={(e) => call('seat:prefs', { waitForBigBlind: e.target.checked })} />
          Wait for the big blind
        </label>
      )}
    </div>
  );
  const hostPanel = (view.isHost || view.coHosts.some((c) => c.playerId === view.me.playerId)) && cash && (
    <HostPanel
      view={view}
      fmt={fmt}
      onSettings={() => {
        close();
        setDialog({ kind: 'settings' });
      }}
    />
  );
  const sidePanel = (tab: Tab) => <SidePanel view={view} fmt={fmt} initialTab={tab} chatSeen={chatSeen} onChatSeen={setChatSeen} />;

  return (
    <div className={`table-page ${portrait ? 'portrait' : ''}`}>
      <header className="topbar">
        <a className="logo small" href="/">
          {portrait ? (
            <>
              R<span>!</span>
            </>
          ) : (
            <>
              RSDP Poker <span>Live!</span>
            </>
          )}
        </a>
        <span className="stakes">
          <b>{view.name}</b>
          {game && (
            <>
              {portrait ? <br /> : ' · '}
              {game.label} {game.stakes}
            </>
          )}
          {levelText && <> · {levelText}</>}
          {view.hand?.bombPot && view.hand.phase !== 'complete' && <b> · Bomb pot</b>}
          {view.paused && <b className="paused"> · Paused</b>}
        </span>
        {bigBlind > 0 && (
          <button
            className="units-toggle"
            aria-pressed={prefs.units === 'bb'}
            aria-label="Amounts in big blinds"
            onClick={() => setPrefs({ units: prefs.units === 'bb' ? 'chips' : 'bb' })}
            title={`Show amounts in ${prefs.units === 'bb' ? 'chips' : 'big blinds'} (B)`}
          >
            <span className={prefs.units === 'bb' ? '' : 'on'}>Chips</span>
            <span className={prefs.units === 'bb' ? 'on' : ''}>BB</span>
          </button>
        )}
        {portrait ? (
          <>
            <button onClick={() => setSheet('log')}>
              Log
              {unread > 0 && <span className="badge">{unread}</span>}
            </button>
            <button aria-label="Menu" onClick={() => setSheet('menu')}>
              ☰{pending > 0 && <span className="badge">{pending}</span>}
            </button>
          </>
        ) : (
          <>
            <button onClick={() => setDialog({ kind: 'people' })} title="Players and spectators">
              👁 {view.watchers.length}
            </button>
            <button onClick={() => setDialog({ kind: 'rules' })}>Rules</button>
            <button onClick={() => setDialog({ kind: 'keys' })} title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts">
              ⌨
            </button>
            <button onClick={() => setDialog({ kind: 'look' })} title="Felt, deck and card backs" aria-label="Table look">
              🎨
            </button>
            <button onClick={copyLink}>{copied ? 'Copied!' : 'Invite'}</button>
            {volumeButton}
            {seatButtons}
          </>
        )}
      </header>

      {!connected && <div className="banner warn">Connection lost. Reconnecting…</div>}

      <div className="layout">
        <section className="felt-area">
          {view.tournamentId && <TableStrip tournamentId={view.tournamentId} tableId={tableId} seatedHere={view.me.seat !== null} />}
          {keysTip && (
            <div className="banner tip">
              <span>
                Tip: play from the keyboard. <kbd>F</kbd> folds, <kbd>K</kbd> checks, <kbd>C</kbd> calls, <kbd>R</kbd> raises{bigBlind > 0 && <>, <kbd>B</kbd> switches chips and big blinds</>}.
              </span>
              <button onClick={() => setDialog({ kind: 'keys' })}>All shortcuts</button>
              <button onClick={dismissKeysTip}>Got it</button>
            </div>
          )}
          {readyTable && (
            <div className="banner attention">
              Your tournament table is ready.{' '}
              <a
                href={`/t/${readyTable}`}
                onClick={(e) => {
                  e.preventDefault();
                  navigate(`/t/${readyTable}`);
                }}
              >
                Go to it
              </a>
            </div>
          )}
          {unseated && (
            <div className="banner attention">
              You're no longer seated: the host removed you, or your seat was released while you were away. Your chips are counted in the ledger.{' '}
              <button onClick={() => setUnseated(false)}>OK</button>
            </div>
          )}
          {cash && !view.started && (
            <div className="banner">
              {view.history.length > 0
                ? view.powers.includes('run')
                  ? `The game is stopped. ${portrait ? 'Start it again from the ☰ menu' : 'Press Start game to deal again'}.`
                  : 'The game is stopped. Waiting for the host to start it again.'
                : view.powers.includes('run')
                  ? portrait
                    ? 'Take a seat and invite friends, then start the game from the ☰ menu.'
                    : 'Take a seat, send friends the invite link, then press Start game.'
                  : 'Waiting for the host to start the game.'}
            </div>
          )}
          {view.stopAfterHand && <div className="banner">The host is stopping the game after this hand.</div>}
          {pending > 0 && (
            <div className="banner attention" onClick={portrait ? () => setSheet('menu') : undefined}>
              {pending} {pending === 1 ? 'request is' : 'requests are'} waiting for you. {portrait ? 'Tap to see.' : 'See Host controls.'}
            </div>
          )}
          {seatRequest && (
            <div className="banner">
              Waiting for the host to let you sit…{' '}
              <button onClick={() => socket.emit('seat:cancel')}>Cancel</button>
            </div>
          )}
          {myBotRequests.map((r) => (
            <div className="banner" key={r.id}>
              Your bot {r.name} is waiting for the host to let it sit…{' '}
              <button onClick={() => call('bot:remove', { playerId: r.playerId }).catch((e: Error) => alert(e.message))}>Cancel</button>
            </div>
          ))}
          <SeatingBanners view={view} skew={skew} onTakeSeat={(seat) => setDialog({ kind: 'seat', seat })} onJoinWaitlist={() => setDialog({ kind: 'seat', seat: 0, waitlist: true })} />
          {liveSeedProblem(view) && <div className="banner warn">⚠ Fair dealing: {liveSeedProblem(view)}. Tell the table, and check this hand once it&rsquo;s revealed.</div>}
          {rebuyRequest && <div className="banner">Waiting for the host to approve your {fmt(rebuyRequest.amount)} rebuy…</div>}
          {mySeat?.sittingOut && (
            <div className="banner">
              {mySeat.sitOutReason === 'busted'
                ? "You're out of chips."
                : mySeat.sitOutReason === 'timeouts'
                  ? 'You were marked away after running out of time.'
                  : mySeat.sitOutReason === 'host'
                    ? 'The host sat you out.'
                    : "You're sitting out."}
              {mySeat.owesBlinds && ' You will post the blinds you missed when you come back.'}{' '}
              {mySeat.sitOutReason === 'busted' && canRebuy ? (
                <button className="primary" onClick={() => setDialog({ kind: 'rebuy' })}>
                  Add chips
                </button>
              ) : (
                mySeat.stack > 0 && (
                  <button className="primary" onClick={() => call('seat:sitOut', { value: false })}>
                    I'm back
                  </button>
                )
              )}
            </div>
          )}
          <Table
            view={view}
            skew={skew}
            fmt={feltFmt}
            compact={portrait}
            onPickSeat={cash && !mySeat && !seatRequest ? (seat) => setDialog({ kind: 'seat', seat }) : undefined}
            onAddBot={canAddBot ? addBot : undefined}
            onSeatClick={(seat) => setDialog({ kind: 'player', seat })}
            discard={view.canDraw ? { selected: discard, toggle: (i) => setDiscard((d) => (d.includes(i) ? d.filter((x) => x !== i) : [...d, i])) } : null}
          />
          <ActionBar
            view={view}
            fmt={fmt}
            bigBlind={prefs.units === 'bb' && bigBlind > 0 ? bigBlind : null}
            skew={skew}
            discard={discard}
            clearDiscard={() => setDiscard([])}
            onPreAction={(q) => {
              preQueued.current = q;
            }}
          />
          <HandExtras view={view} />
          {!portrait && seatOptions}
        </section>
        {!portrait && (
          <aside className="side">
            {hostPanel}
            {sidePanel('log')}
          </aside>
        )}
      </div>

      {portrait && sheet === 'menu' && (
        <Sheet title={view.name} onClose={close}>
          {hostPanel}
          <div className="menu-buttons">
            {seatButtons}
            <button onClick={copyLink}>{copied ? 'Link copied!' : 'Copy invite link'}</button>
            <button
              onClick={() => {
                close();
                setDialog({ kind: 'rules' });
              }}
            >
              How to play
            </button>
            <button
              onClick={() => {
                close();
                setDialog({ kind: 'people' });
              }}
            >
              People · {view.watchers.length} watching
            </button>
            <button
              onClick={() => {
                close();
                setDialog({ kind: 'look' });
              }}
            >
              🎨 Look, sound and me
            </button>
            {volumeButton}
          </div>
          {seatOptions}
        </Sheet>
      )}
      {portrait && sheet && sheet !== 'menu' && (
        <Sheet title="Table" onClose={close} tall>
          {sidePanel(sheet)}
        </Sheet>
      )}

      {dialog?.kind === 'seat' && <SeatDialog view={view} seat={dialog.seat} waitlist={dialog.waitlist} fmt={fmt} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'player' &&
        (view.powers.length > 0 && cash ? (
          <PlayerDialog view={view} seat={dialog.seat} fmt={fmt} onClose={() => setDialog(null)}>
            <PlayerExtras view={view} seat={dialog.seat} onDone={() => setDialog(null)} />
          </PlayerDialog>
        ) : (
          <Modal title={dialog.seat.playerId === view.me.playerId ? 'You' : dialog.seat.name} onClose={() => setDialog(null)}>
            {dialog.seat.bot && dialog.seat.bot.ownerId !== view.me.playerId && <p className="muted">{dialog.seat.bot.ownerName}&rsquo;s practice bot.</p>}
            <PlayerExtras view={view} seat={dialog.seat} onDone={() => setDialog(null)} />
            {dialog.seat.bot?.ownerId === view.me.playerId && <RemoveBot seat={dialog.seat} onDone={() => setDialog(null)} />}
            <div className="row">
              <button onClick={() => setDialog(null)}>Close</button>
            </div>
          </Modal>
        ))}
      {dialog?.kind === 'rebuy' && <RebuyDialog view={view} fmt={fmt} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'settings' && <SettingsDialog view={view} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'rules' && <RulesDialog view={view} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'people' && <PeopleDialog view={view} fmt={fmt} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'look' && <LookDialog view={view} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'keys' && <ShortcutsDialog onClose={() => setDialog(null)} />}
    </div>
  );
}

function gameFamily(gameId: string) {
  try {
    return getVariant(gameId).family;
  } catch {
    return 'flop';
  }
}

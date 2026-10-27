import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { SeatView, TableView } from '@rsdp/engine/wire';
import { call, saveName, savedName } from '../socket';
import { fromInput, toInput, type Fmt } from '../format';
import { delayText } from '@rsdp/engine/settings';
import { BotLevelControl, botOwnerLabel, lastBotLevel, LevelPicker, rememberBotLevel } from './table/BotLevels';
import { markCardsWatchedSeen } from './table/Seating';

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const backdrop = useRef<HTMLDivElement>(null);
  // Escape closes the topmost dialog only.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const all = document.querySelectorAll('.modal-backdrop');
      if (all[all.length - 1] !== backdrop.current) return;
      // Marks the key as used, so a sheet or another dialog underneath stays open.
      e.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" ref={backdrop} onClick={onClose}>
      <div className="card-panel modal" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

/** A sensible starting stack: the table's minimum or maximum if set, else 100 big blinds. */
function defaultStack(view: TableView) {
  const { minBuyIn, maxBuyIn } = view.settings.seating;
  const stakes = view.hand?.stakes ?? view.upcoming?.stakes ?? view.settings.stakes;
  const base = Math.max(stakes.bigBlind, stakes.bigBet / 2, stakes.bringIn * 5, 1) * 100;
  if (maxBuyIn > 0) return Math.min(maxBuyIn, Math.max(base, minBuyIn));
  return Math.max(base, minBuyIn);
}

function buyInHint(view: TableView, fmt: Fmt) {
  const { minBuyIn, maxBuyIn } = view.settings.seating;
  if (minBuyIn > 0 && maxBuyIn > 0) return `Between ${fmt(minBuyIn)} and ${fmt(maxBuyIn)}.`;
  if (minBuyIn > 0) return `At least ${fmt(minBuyIn)}.`;
  if (maxBuyIn > 0) return `Up to ${fmt(maxBuyIn)}.`;
  return null;
}

/** Sit down (or ask to) in a seat; with `waitlist`, queue for the next free seat instead. */
export function SeatDialog({ view, seat, fmt, onClose, waitlist = false }: { view: TableView; seat: number; fmt: Fmt; onClose: () => void; waitlist?: boolean }) {
  const cents = view.settings.stakes.centsMode;
  const [name, setName] = useState(savedName);
  const [stack, setStack] = useState(toInput(cents, defaultStack(view)));
  const [error, setError] = useState('');
  const hint = buyInHint(view, fmt);
  const approval = view.settings.seating.requireApproval && !view.powers.includes('approve');
  const random = !!view.settings.seating.randomSeats && !view.powers.includes('players') && !view.offers.some((o) => o.playerId === view.me.playerId);
  const watched = view.cardsWatched;
  const [consent, setConsent] = useState(false);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    saveName(name);
    const amount = fromInput(cents, stack);
    (waitlist ? call('waitlist:join', { name, stack: amount }) : call('seat:request', { seat, name, stack: amount, consent }))
      .then(() => {
        if (watched && consent) markCardsWatchedSeen(view.id, watched.at);
        onClose();
      })
      .catch((err: Error) => setError(err.message));
  };

  return (
    <Modal title={waitlist ? 'Join the waitlist' : random ? 'Take a seat' : `Take seat ${seat + 1}`} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>
          Name
          <input value={name} maxLength={20} required autoFocus onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          {cents ? 'Buy-in ($)' : 'Chips'}
          <input type="number" min={0} step={cents ? 0.01 : 1} inputMode={cents ? 'decimal' : 'numeric'} value={stack} onChange={(e) => setStack(+e.target.value)} />
        </label>
        {hint && <p className="muted">{hint}</p>}
        {waitlist && <p className="muted">When a seat comes free it is held for you for a minute. You'll see a Take it button.</p>}
        {random && !waitlist && <p className="muted">This table seats new players at random.</p>}
        {approval && <p className="muted">The host approves new players.</p>}
        {watched && (
          <div className="watched-consent">
            <p>
              <strong>👁 Spectators at this table see every player's hole cards</strong>, {watched.delaySeconds > 0 ? `${delayText(watched.delaySeconds)} behind the table` : 'live, with no delay'}.
              Someone watching could pass your cards on to another player.
            </p>
            <label className="check">
              <input type="checkbox" checked={consent} required onChange={(e) => setConsent(e.target.checked)} /> I understand and agree to spectators seeing my cards
            </label>
          </div>
        )}
        {error && <p className="error">{error}</p>}
        <div className="row">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary">{waitlist ? 'Join' : approval ? 'Ask to sit' : 'Sit down'}</button>
        </div>
      </form>
    </Modal>
  );
}

export function RebuyDialog({ view, fmt, onClose }: { view: TableView; fmt: Fmt; onClose: () => void }) {
  const cents = view.settings.stakes.centsMode;
  const [amount, setAmount] = useState(toInput(cents, defaultStack(view)));
  const [error, setError] = useState('');
  const approval = view.settings.seating.rebuyRequiresApproval && !view.powers.includes('approve');
  const maxBuyIn = view.settings.seating.maxBuyIn;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    call('seat:rebuy', { amount: fromInput(cents, amount) })
      .then(onClose)
      .catch((err: Error) => setError(err.message));
  };

  return (
    <Modal title="Add chips" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>
          {cents ? 'Amount to add ($)' : 'Chips to add'}
          <input type="number" min={0} step={cents ? 0.01 : 1} inputMode={cents ? 'decimal' : 'numeric'} value={amount} autoFocus onChange={(e) => setAmount(+e.target.value)} />
        </label>
        {maxBuyIn > 0 && <p className="muted">You can have up to {fmt(maxBuyIn)} in front of you.</p>}
        <p className="muted">
          {approval ? 'The host approves rebuys. ' : ''}Chips added during a hand arrive when it ends.
        </p>
        {error && <p className="error">{error}</p>}
        <div className="row">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary">{approval ? 'Ask the host' : 'Add chips'}</button>
        </div>
      </form>
    </Modal>
  );
}

/** What the host can do to a seated player. */
export function PlayerDialog({ view, seat, fmt, onClose, children }: { view: TableView; seat: SeatView; fmt: Fmt; onClose: () => void; children?: ReactNode }) {
  const cents = view.settings.stakes.centsMode;
  const [stack, setStack] = useState(toInput(cents, seat.stack));
  const [error, setError] = useState('');
  const isMe = seat.playerId === view.me.playerId;
  const handLive = !!view.hand && view.hand.phase !== 'complete';
  const tournament = view.mode === 'tournament';
  const act = (p: Promise<unknown>) => p.then(onClose).catch((err: Error) => setError(err.message));
  const held = new Set([...view.offers.map((o) => o.seat), ...view.requests.filter((r) => r.kind === 'seat').map((r) => r.seat)]);
  const empty = view.seats.flatMap((s, i) => (s || held.has(i) ? [] : [i]));
  const inHand = seat.inHand && handLive;
  const muted = view.muted.includes(seat.playerId);
  const can = (p: (typeof view.powers)[number]) => view.powers.includes(p);
  // Co-hosts act on players, not on the host or other co-hosts.
  const onHost = !view.isHost && !isMe && (seat.playerId === view.hostId || view.coHosts.some((c) => c.playerId === seat.playerId));
  const bot = !!seat.bot;
  // Its owner manages a bot; so does staff, except that only the host manages a bot the host or a co-host added.
  const myBot = seat.bot?.ownerId === view.me.playerId;
  const staffBot = !!seat.bot && (seat.bot.ownerId === view.hostId || view.coHosts.some((c) => c.playerId === seat.bot!.ownerId));
  const manageBot = bot && (myBot || (can('players') && (view.isHost || !staffBot)));

  return (
    <Modal title={seat.name} onClose={onClose}>
      <div className="form">
        <p className="muted">
          Seat {seat.seat + 1} · {cents ? `$${fmt(seat.stack)}` : `${fmt(seat.stack)} chips`}{seat.online ? '' : ' · offline'}
          {seat.bot && ` · ${botOwnerLabel(seat.bot, 'practice bot')}`}
        </p>
        {manageBot && !tournament && <BotLevelControl view={view} seat={seat} />}
        {!tournament && can('chips') && !onHost && (
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              act(call('host:setStack', { playerId: seat.playerId, stack: fromInput(cents, stack) }));
            }}
          >
            <label>
              Stack
              <input type="number" min={0} step={cents ? 0.01 : 1} value={stack} onChange={(e) => setStack(+e.target.value)} />
            </label>
            <button>{handLive ? 'Set after this hand' : 'Set stack'}</button>
          </form>
        )}
        {!tournament && can('players') && !onHost && empty.length > 0 && (
          <label>
            Move to
            <select
              value=""
              disabled={inHand}
              onChange={(e) => e.target.value !== '' && act(call('host:move', { playerId: seat.playerId, seat: Number(e.target.value) }))}
            >
              <option value="">{inHand ? 'After this hand…' : 'Pick an empty seat'}</option>
              {empty.map((i) => (
                <option key={i} value={i}>
                  Seat {i + 1}
                </option>
              ))}
            </select>
            {inHand && <span className="hint">Players can move once the hand they're in is over.</span>}
          </label>
        )}
        <div className="row wrap">
          {can('players') && !onHost && !seat.sittingOut && !bot && <button onClick={() => act(call('host:sitOut', { playerId: seat.playerId }))}>Sit out</button>}
          {can('players') && !onHost && !isMe && !bot && (
            <button onClick={() => act(call('host:mute', { playerId: seat.playerId, value: !muted }))}>{muted ? 'Unmute chat' : 'Mute chat'}</button>
          )}
          {view.isHost && !isMe && !tournament && !bot && <button onClick={() => act(call('host:transfer', { playerId: seat.playerId }))}>Make host</button>}
          {manageBot && (
            <button className="danger" onClick={() => act(call('bot:remove', { playerId: seat.playerId }))}>
              Remove bot
            </button>
          )}
          {can('players') && !onHost && !isMe && !tournament && !bot && (
            <button className="danger" onClick={() => confirm(`Remove ${seat.name} from the table?`) && act(call('host:kick', { playerId: seat.playerId }))}>
              Remove
            </button>
          )}
        </div>
        {error && <p className="error">{error}</p>}
        {children}
        <button onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}

/** A player's own practice bot: they can change its level or take it away. */
export function MyBot({ view, seat, onDone }: { view: TableView; seat: SeatView; onDone: () => void }) {
  const [error, setError] = useState('');
  return (
    <div className="form">
      <p className="muted">Your practice bot.{seat.inHand ? ' Removing it now folds its hand.' : ''}</p>
      <BotLevelControl view={view} seat={seat} />
      {error && <p className="error">{error}</p>}
      <button
        className="danger"
        onClick={() =>
          call('bot:remove', { playerId: seat.playerId })
            .then(onDone)
            .catch((err: Error) => setError(err.message))
        }
      >
        Remove bot
      </button>
    </div>
  );
}

/** "+ Bot" on an empty seat: pick how well it plays, then add it. */
export function AddBotDialog({ view, seat, onClose }: { view: TableView; seat: number; onClose: () => void }) {
  const [level, setLevel] = useState(lastBotLevel);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const add = () => {
    setBusy(true);
    setError('');
    rememberBotLevel(level);
    call('bot:add', { seat, level })
      .then(() => {
        onClose();
        if (view.settings.seating.requireApproval && !view.powers.includes('approve')) alert('Your bot is waiting for the host to approve it.');
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setBusy(false));
  };
  return (
    <Modal title={`Add a practice bot to seat ${seat + 1}`} onClose={onClose}>
      <div className="form">
        <LevelPicker name="add-bot-level" value={level} onPick={setLevel} disabled={busy} />
        {error && <p className="error">{error}</p>}
        <div className="row">
          <button className="primary" disabled={busy} onClick={add}>
            Add {level} bot
          </button>
          <button onClick={onClose}>Cancel</button>
        </div>
      </div>
    </Modal>
  );
}

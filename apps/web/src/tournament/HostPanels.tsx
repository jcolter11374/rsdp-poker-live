// Host tools beyond the basics: approving with a custom stack, changing
// stacks, moving players, co-hosts, and archiving. Each panel shows only what
// the viewer's powers allow; the server checks again.

import { useState } from 'react';
import { HOST_POWER_LABELS, HOST_POWERS, type HostPower } from '@rsdp/engine/roles';
import { tableAddress, type Command, type Entry, type PendingRequest, type TournamentState } from '@rsdp/tournament';
import { chips } from './format';
import { navigate } from './hooks';

type Send = (c: Command) => Promise<boolean>;

const alive = (e: Entry) => e.status === 'registered' || e.status === 'seated' || e.status === 'rebuy-offer';
const tableNumber = (s: TournamentState, tableId: string | null) => (tableId ? s.tables.findIndex((t) => t.id === tableId) + 1 : 0);

const KIND_LABEL: Record<PendingRequest['kind'], string> = { register: 'wants to register', rebuy: 'wants to rebuy', 'add-on': 'wants an add-on', 're-entry': 'wants to re-enter' };

/** One request, with a starting stack to approve registrations and re-entries with (a handicap). */
export function RequestRow({ state, r, by, send }: { state: TournamentState; r: PendingRequest; by: string; send: Send }) {
  const takesStack = r.kind === 'register' || r.kind === 're-entry';
  const [stack, setStack] = useState(state.settings.startingStack);
  return (
    <div className="tn-request">
      <span>
        <b>{r.displayName}</b> {KIND_LABEL[r.kind]}
      </span>
      {takesStack && (
        <label className="tn-inline">
          Stack
          <input type="number" min={1} value={stack} onChange={(e) => setStack(Math.max(1, Math.floor(Number(e.target.value) || 0)))} />
        </label>
      )}
      <button
        className="primary"
        onClick={() => send({ type: 'approve', by, requestId: r.id, ...(takesStack && stack !== state.settings.startingStack ? { stack } : {}) })}
      >
        Approve
      </button>
      <button onClick={() => send({ type: 'reject', by, requestId: r.id })}>Reject</button>
    </div>
  );
}

/** Change a stack, move a player to another seat (a taken seat swaps the two), or remove them. */
export function PlayerManager({ state, by, powers, send }: { state: TournamentState; by: string; powers: HostPower[]; send: Send }) {
  const players = state.entries.filter(alive);
  const [open, setOpen] = useState<string | null>(null);
  if (!players.length) return null;
  return (
    <details className="tn-details">
      <summary>Players: stacks, seats and removal</summary>
      <p className="muted">A stack change during a player's hand lands when the hand ends. It is not a rebuy. Moves happen between hands; pick a taken seat to swap two players.</p>
      {players.map((e) => (
        <div key={e.id} className="tn-player-tools">
          <button className="tn-player-name" aria-expanded={open === e.id} onClick={() => setOpen(open === e.id ? null : e.id)}>
            <b>{e.displayName}</b> · {chips(e.stack)}
            {e.pendingStack !== undefined && ` → ${chips(e.pendingStack)} after this hand`}
            {e.tableId && ` · Table ${tableNumber(state, e.tableId)}, seat ${e.seat! + 1}`}
          </button>
          {open === e.id && <PlayerTools state={state} e={e} by={by} powers={powers} send={send} />}
        </div>
      ))}
    </details>
  );
}

function PlayerTools({ state, e, by, powers, send }: { state: TournamentState; e: Entry; by: string; powers: HostPower[]; send: Send }) {
  const [stack, setStack] = useState(e.pendingStack ?? e.stack);
  const [tableId, setTableId] = useState(e.tableId ?? state.tables[0]?.id ?? '');
  const [seat, setSeat] = useState(0);
  const target = state.tables.find((t) => t.id === tableId);
  const nameAt = (id: string | null) => (id ? state.entries.find((x) => x.id === id)?.displayName : null);
  return (
    <div className="tn-request">
      {powers.includes('chips') && (
        <>
          <label className="tn-inline">
            Stack
            <input type="number" min={1} value={stack} onChange={(ev) => setStack(Math.max(1, Math.floor(Number(ev.target.value) || 0)))} />
          </label>
          <button onClick={() => send({ type: 'setStack', by, playerId: e.playerId, stack })}>Set stack</button>
        </>
      )}
      {powers.includes('players') && e.status === 'seated' && target && (
        <>
          <select aria-label="Table" value={tableId} onChange={(ev) => setTableId(ev.target.value)}>
            {state.tables.map((t, i) => (
              <option key={t.id} value={t.id}>
                Table {i + 1}
              </option>
            ))}
          </select>
          <select aria-label="Seat" value={seat} onChange={(ev) => setSeat(Number(ev.target.value))}>
            {target.seats.map((id, i) => (
              <option key={i} value={i}>
                Seat {i + 1}
                {id ? ` (${id === e.id ? 'here' : `swap with ${nameAt(id)}`})` : ''}
              </option>
            ))}
          </select>
          <button onClick={() => send({ type: 'movePlayer', by, playerId: e.playerId, tableId, seat })}>Move</button>
          <a className="tn-link" href={`/t/${tableAddress(e.tableId!)}`}>
            Open table
          </a>
        </>
      )}
      {powers.includes('players') && (
        <button
          onClick={() => {
            if (confirm(`Remove ${e.displayName}? Their chips leave play.`)) send({ type: 'remove', by, playerId: e.playerId });
          }}
        >
          Remove
        </button>
      )}
    </div>
  );
}

/** The host names co-hosts and picks what each may do; a co-host can step down. */
export function CoHostPanel({ state, me, send }: { state: TournamentState; me: string; send: Send }) {
  const isHost = me === state.hostId;
  const coHosts = state.coHosts ?? [];
  const candidates = [...new Map(state.entries.map((e) => [e.playerId, e.displayName])).entries()].filter(([id]) => id !== state.hostId && !coHosts.some((c) => c.playerId === id));
  const [pick, setPick] = useState('');
  const toggle = (powers: HostPower[], p: HostPower) => (powers.includes(p) ? powers.filter((x) => x !== p) : [...powers, p]);

  if (!isHost) {
    const mine = coHosts.find((c) => c.playerId === me);
    if (!mine) return null;
    return (
      <div className="tn-cohosts">
        <h3>Co-host</h3>
        <p className="muted">The host has let you: {mine.powers.length ? mine.powers.map((p) => HOST_POWER_LABELS[p].toLowerCase()).join('; ') : 'see the host tools'}.</p>
        <button onClick={() => send({ type: 'removeCoHost', by: me, playerId: me })}>Step down</button>
      </div>
    );
  }
  return (
    <div className="tn-cohosts">
      <h3>Co-hosts</h3>
      <p className="muted">Co-hosts help run the event with the powers you give them. Only you can change co-hosts, hand over hosting, or archive.</p>
      {coHosts.map((c) => (
        <div key={c.playerId} className="tn-cohost">
          <b>{c.name}</b>
          <div className="tn-toggles">
            {HOST_POWERS.map((p) => (
              <label key={p} className="tn-switch">
                <input type="checkbox" checked={c.powers.includes(p)} onChange={() => send({ type: 'setCoHost', by: me, playerId: c.playerId, powers: toggle(c.powers, p) })} />
                <span>{HOST_POWER_LABELS[p]}</span>
              </label>
            ))}
          </div>
          <div className="tn-actions">
            <button onClick={() => send({ type: 'removeCoHost', by: me, playerId: c.playerId })}>Remove co-host</button>
            <button
              onClick={() => {
                if (confirm(`Make ${c.name} the host? You stay on as a co-host with every power.`)) send({ type: 'transferHost', by: me, to: c.playerId });
              }}
            >
              Make host
            </button>
          </div>
        </div>
      ))}
      {candidates.length > 0 ? (
        <div className="tn-request">
          <select aria-label="Player to add as co-host" value={pick} onChange={(e) => setPick(e.target.value)}>
            <option value="">Add a co-host…</option>
            {candidates.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
          <button
            disabled={!pick}
            onClick={async () => {
              if (await send({ type: 'setCoHost', by: me, playerId: pick, powers: ['approve', 'run'] })) setPick('');
            }}
          >
            Add
          </button>
        </div>
      ) : (
        !coHosts.length && <p className="muted">Players who register can be made co-hosts.</p>
      )}
    </div>
  );
}

/** Copy settings for anyone; archive for the host. */
export function EventPanel({ state, me, send }: { state: TournamentState; me: string; send: Send }) {
  const isHost = me === state.hostId;
  const over = state.status === 'finished' || state.status === 'cancelled';
  const started = state.status === 'running' || state.status === 'paused';
  return (
    <div className="tn-actions">
      <button onClick={() => navigate(`/tn/new?from=${state.id}`)}>Duplicate settings</button>
      {isHost && !state.archivedAt && !started && (
        <button
          onClick={() => {
            const msg = over ? 'Archive this tournament? It leaves the lists; results stay at this link.' : 'Cancel and archive this tournament? This cannot be undone.';
            if (confirm(msg)) send({ type: 'archive', by: me });
          }}
        >
          {over ? 'Archive' : 'Cancel and archive'}
        </button>
      )}
      {state.archivedAt && <span className="muted">Archived</span>}
    </div>
  );
}

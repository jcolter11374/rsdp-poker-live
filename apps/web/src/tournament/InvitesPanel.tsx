import { useState } from 'react';
import type { Command, InviteCode, TournamentState } from '@rsdp/tournament';
import { localTime } from './format';

/** Link that fills in the code on the register form. */
export const inviteLink = (tournamentId: string, code: string) => `${location.origin}/tn/${tournamentId}?code=${encodeURIComponent(code)}`;

const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

function downloadCsv(state: TournamentState, codes: InviteCode[], name: string) {
  const rows = [['code', 'link', 'max uses', 'status', 'used by', 'used at']];
  for (const c of codes) {
    const status = c.cancelled ? 'cancelled' : c.maxUses !== null && c.usedBy.length >= c.maxUses ? 'used' : 'open';
    const base = [c.code, inviteLink(state.id, c.code), c.maxUses === null ? 'no limit' : String(c.maxUses), status];
    if (!c.usedBy.length) rows.push([...base, '', '']);
    for (const u of c.usedBy) rows.push([...base, u.displayName, new Date(u.at).toISOString()]);
  }
  const blob = new Blob([rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n'], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** The host's invite codes: make a batch, share or download them, see who used each, cancel any. */
export function InvitesPanel({ state, send }: { state: TournamentState; send: (c: Command) => Promise<boolean> }) {
  const by = state.hostId;
  const [count, setCount] = useState(10);
  const [shared, setShared] = useState(false);
  const [filter, setFilter] = useState<'all' | 'open' | 'used' | 'cancelled'>('all');
  const [q, setQ] = useState('');
  /** Where the codes made from this page start; new codes are added at the end. */
  const [batchStart, setBatchStart] = useState<number | null>(null);
  const [copied, setCopied] = useState('');
  const codes = state.invites ?? [];
  const s = state.settings.invites;

  const statusOf = (c: InviteCode) => (c.cancelled ? 'cancelled' : c.maxUses !== null && c.usedBy.length >= c.maxUses ? 'used' : 'open');
  const shown = codes.filter(
    (c) => (filter === 'all' || statusOf(c) === filter) && (!q || c.code.includes(q.toUpperCase()) || c.usedBy.some((u) => u.displayName.toLowerCase().includes(q.toLowerCase()))),
  );
  const copy = (text: string, what: string) => {
    navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(what);
        setTimeout(() => setCopied(''), 2000);
      },
      () => {},
    );
  };
  const make = async () => {
    const start = codes.length;
    if (await send({ type: 'createInvites', by, count: shared ? 1 : count, maxUses: shared ? null : 1 })) setBatchStart(start);
  };
  const batch = batchStart === null ? [] : codes.slice(batchStart);

  return (
    <div className="tn-invites">
      <h3>Invite codes</h3>
      <p className="muted">
        {s?.required ? 'Players need a code to register.' : 'Codes are optional.'} {s?.autoApprove ? 'A valid code skips your approval.' : ''} Each link below fills in its code.
      </p>
      <div className="tn-request">
        <label className="tn-check">
          <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
          One shared code anyone can use (for a group chat)
        </label>
        {!shared && (
          <label className="tn-inline">
            Codes
            <input type="number" min={1} max={200} value={count} onChange={(e) => setCount(Math.min(200, Math.max(1, Math.floor(Number(e.target.value) || 1))))} />
          </label>
        )}
        <button className="primary" onClick={make}>
          Make {shared ? 'a shared code' : `${count} single-use code${count === 1 ? '' : 's'}`}
        </button>
      </div>
      {codes.length > 0 && (
        <>
          <div className="tn-actions">
            {batch.length > 0 && <button onClick={() => downloadCsv(state, batch, `${state.settings.name} new codes.csv`)}>Download the new codes</button>}
            <button onClick={() => downloadCsv(state, codes, `${state.settings.name} codes.csv`)}>Download all codes (CSV)</button>
          </div>
          <div className="tn-request">
            <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)} aria-label="Show">
              <option value="all">All codes ({codes.length})</option>
              <option value="open">Not used yet</option>
              <option value="used">Used</option>
              <option value="cancelled">Cancelled</option>
            </select>
            <input className="tn-search" placeholder="Find a code or player" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <table className="tn-table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Used by</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map((c) => (
                <tr key={c.code} className={c.cancelled ? 'tn-out' : ''}>
                  <td>
                    <code>{c.code}</code>
                    {c.maxUses === null && <span className="tn-tag">shared</span>}
                    {c.cancelled && <span className="tn-tag">cancelled</span>}
                  </td>
                  <td>
                    {c.usedBy.length ? c.usedBy.map((u) => <span key={u.playerId + u.at} title={localTime(u.at)}>{u.displayName} </span>) : <span className="muted">–</span>}
                  </td>
                  <td className="num">
                    {!c.cancelled && (
                      <>
                        <button onClick={() => copy(inviteLink(state.id, c.code), c.code)}>{copied === c.code ? 'Copied' : 'Copy link'}</button>{' '}
                        <button
                          onClick={() => {
                            if (confirm(`Cancel code ${c.code}? Nobody can register with it after this.`)) send({ type: 'cancelInvite', by, code: c.code });
                          }}
                        >
                          Cancel
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

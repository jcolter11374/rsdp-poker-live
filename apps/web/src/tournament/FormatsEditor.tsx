import type { BountySettings, CheckInSettings, InviteSettings } from '@rsdp/tournament';

export interface Formats {
  bounty: BountySettings | null;
  invites: InviteSettings | null;
  checkIn: CheckInSettings | null;
}

export const NO_FORMATS: Formats = { bounty: null, invites: null, checkIn: null };

const int = (v: string, min = 0) => Math.max(min, Math.floor(Number(v) || 0));

/** Bounties, invite codes and check-in groups on the create form. */
export function FormatsEditor({ value, onChange, scheduled, sng }: { value: Formats; onChange: (f: Formats) => void; scheduled: boolean; sng: boolean }) {
  const { bounty, invites, checkIn } = value;
  const set = (patch: Partial<Formats>) => onChange({ ...value, ...patch });
  return (
    <>
      <div className="tn-option">
        <label className="tn-check">
          <input type="checkbox" checked={!!bounty} onChange={(e) => set({ bounty: e.target.checked ? { amount: 1000, progressivePercent: 0 } : null })} />
          Bounties: knock someone out to win the bounty on their head (for display only)
        </label>
        {bounty && (
          <div className="tn-grid3">
            <label>
              Bounty per entry ($)
              <input type="number" min={0} step="any" value={bounty.amount / 100} onChange={(e) => set({ bounty: { ...bounty, amount: Math.max(1, Math.round(Number(e.target.value) * 100)) } })} />
            </label>
            <label className="tn-check">
              <input
                type="checkbox"
                checked={bounty.progressivePercent > 0}
                onChange={(e) => set({ bounty: { ...bounty, progressivePercent: e.target.checked ? 50 : 0 } })}
              />
              Progressive knockout
            </label>
            {bounty.progressivePercent > 0 && (
              <label>
                Share added to the winner's own bounty (%)
                <input type="number" min={1} max={100} value={bounty.progressivePercent} onChange={(e) => set({ bounty: { ...bounty, progressivePercent: Math.min(100, int(e.target.value, 1)) } })} />
              </label>
            )}
          </div>
        )}
        {bounty && (
          <p className="muted">
            {bounty.progressivePercent > 0
              ? `Whoever busts a player gets ${100 - bounty.progressivePercent}% of their bounty now; the other ${bounty.progressivePercent}% goes onto the winner's own bounty. The winner keeps their own.`
              : 'Whoever busts a player gets their whole bounty. A split pot splits it. The winner keeps their own.'}
          </p>
        )}
      </div>

      <div className="tn-option">
        <label className="tn-check">
          <input type="checkbox" checked={!!invites} onChange={(e) => set({ invites: e.target.checked ? { required: true, autoApprove: true } : null })} />
          Invite codes (make them in the lobby once the tournament is created)
        </label>
        {invites && (
          <div className="tn-toggles">
            <label className="tn-check">
              <input type="checkbox" checked={invites.required} onChange={(e) => set({ invites: { ...invites, required: e.target.checked } })} />
              A code is needed to register
            </label>
            <label className="tn-check">
              <input type="checkbox" checked={invites.autoApprove} onChange={(e) => set({ invites: { ...invites, autoApprove: e.target.checked } })} />
              A valid code skips my approval
            </label>
          </div>
        )}
      </div>

      {!sng && (
        <div className="tn-option">
          <label className="tn-check">
            <input
              type="checkbox"
              checked={!!checkIn}
              onChange={(e) => set({ checkIn: e.target.checked ? { groups: [{ firstN: null, waitMinutes: 10 }], opensMinutesBefore: 30 } : null })}
            />
            Check-in: registered players must check in to keep their seat
          </label>
          {checkIn && <CheckInGroups value={checkIn} onChange={(c) => set({ checkIn: c })} scheduled={scheduled} />}
        </div>
      )}
    </>
  );
}

function CheckInGroups({ value, onChange, scheduled }: { value: CheckInSettings; onChange: (c: CheckInSettings) => void; scheduled: boolean }) {
  const setGroup = (i: number, patch: Partial<CheckInSettings['groups'][number]>) => onChange({ ...value, groups: value.groups.map((g, j) => (j === i ? { ...g, ...patch } : g)) });
  return (
    <>
      {scheduled ? (
        <label className="tn-inline">
          Check-in opens
          <input type="number" min={1} value={value.opensMinutesBefore} onChange={(e) => onChange({ ...value, opensMinutesBefore: int(e.target.value, 1) })} />
          minutes before the start
        </label>
      ) : (
        <p className="muted">You open check-in from the lobby.</p>
      )}
      <p className="muted">Groups open in order and stay open. Seats go to whoever checks in first; anyone not checked in when seats are drawn is dropped.</p>
      {value.groups.map((g, i) => (
        <div className="tn-request" key={i}>
          <span>Group {i + 1}</span>
          <label className="tn-inline">
            <select value={g.firstN === null ? 'all' : 'first'} onChange={(e) => setGroup(i, { firstN: e.target.value === 'all' ? null : 10 })}>
              <option value="all">Everyone registered</option>
              <option value="first">The first … registered</option>
            </select>
            {g.firstN !== null && <input type="number" min={1} value={g.firstN} aria-label="How many" onChange={(e) => setGroup(i, { firstN: int(e.target.value, 1) })} />}
          </label>
          {i < value.groups.length - 1 && (
            <label className="tn-inline">
              next group after
              <input type="number" min={1} max={599} value={g.waitMinutes} onChange={(e) => setGroup(i, { waitMinutes: int(e.target.value, 1) })} />
              min
            </label>
          )}
          {value.groups.length > 1 && (
            <button type="button" aria-label={`Remove group ${i + 1}`} onClick={() => onChange({ ...value, groups: value.groups.filter((_, j) => j !== i) })}>
              ✕
            </button>
          )}
        </div>
      ))}
      {value.groups.length < 15 && (
        <button type="button" onClick={() => onChange({ ...value, groups: [...value.groups, { firstN: null, waitMinutes: 10 }] })}>
          Add a group
        </button>
      )}
    </>
  );
}

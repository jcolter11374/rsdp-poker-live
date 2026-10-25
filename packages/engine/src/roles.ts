// Co-hosts, shared by cash tables and tournaments (HST-38, HST-39, TRN-36).
//
// One host owns a table or tournament. The host can name co-hosts and give
// each one some of the host's powers. Managing co-hosts and handing over the
// host role stay with the host. Plain JSON, so it sits in saved state as is.

export const HOST_POWERS = ['approve', 'chips', 'run', 'players', 'settings'] as const;
export type HostPower = (typeof HOST_POWERS)[number];

export const HOST_POWER_LABELS: Record<HostPower, string> = {
  approve: 'Approve seats, entries and rebuys',
  chips: 'Change stacks',
  run: 'Start, pause and end',
  players: 'Move and remove players',
  settings: 'Change settings and levels',
};

export interface CoHost {
  playerId: string;
  /** The name shown in lists; refreshed whenever the host edits the co-host. */
  name: string;
  powers: HostPower[];
}

export interface Staff {
  hostId: string;
  /** Missing in state saved before co-hosts existed. */
  coHosts?: CoHost[] | null;
}

export const MAX_CO_HOSTS = 10;

export class RoleError extends Error {}

const fail = (message: string): never => {
  throw new RoleError(message);
};

export const coHostOf = (staff: Staff, playerId: string): CoHost | null => staff.coHosts?.find((c) => c.playerId === playerId) ?? null;

/** The host, or a co-host with this power. */
export function hasPower(staff: Staff, playerId: string, power: HostPower): boolean {
  if (playerId === staff.hostId) return true;
  return !!coHostOf(staff, playerId)?.powers.includes(power);
}

/** The host or any co-host: someone who sees the host tools. */
export const isStaff = (staff: Staff, playerId: string | null | undefined): boolean =>
  !!playerId && (playerId === staff.hostId || coHostOf(staff, playerId) !== null);

/** Every power this player holds. */
export function powersOf(staff: Staff, playerId: string | null | undefined): HostPower[] {
  if (!playerId) return [];
  if (playerId === staff.hostId) return [...HOST_POWERS];
  return [...(coHostOf(staff, playerId)?.powers ?? [])];
}

/** Known powers only, each once, in a fixed order. Throws RoleError on anything else. */
export function cleanPowers(raw: unknown): HostPower[] {
  if (!Array.isArray(raw)) fail('powers must be a list');
  const list = raw as unknown[];
  for (const p of list) if (!(HOST_POWERS as readonly unknown[]).includes(p)) fail(`unknown power ${String(p)}`);
  return HOST_POWERS.filter((p) => list.includes(p));
}

/** Adds a co-host, or changes an existing one's powers and name. Returns the new list. */
export function withCoHost(staff: Staff, input: { playerId: string; name: string; powers: unknown }): CoHost[] {
  const list = staff.coHosts ?? [];
  if (typeof input.playerId !== 'string' || !input.playerId) fail('pick a player');
  if (input.playerId === staff.hostId) fail('the host already has every power');
  const powers = cleanPowers(input.powers);
  const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : 'Player';
  const existing = list.find((c) => c.playerId === input.playerId);
  if (!existing && list.length >= MAX_CO_HOSTS) fail(`at most ${MAX_CO_HOSTS} co-hosts`);
  const next = { playerId: input.playerId, name, powers };
  return existing ? list.map((c) => (c === existing ? next : c)) : [...list, next];
}

export function withoutCoHost(staff: Staff, playerId: string): CoHost[] {
  const list = staff.coHosts ?? [];
  if (!list.some((c) => c.playerId === playerId)) fail('not a co-host');
  return list.filter((c) => c.playerId !== playerId);
}

/**
 * Hands the host role to someone else. The old host stays on as a co-host with
 * every power, so the hand-over can be undone by the new host.
 */
export function handOver(staff: Staff, to: string, oldHostName: string): { hostId: string; coHosts: CoHost[] } {
  if (typeof to !== 'string' || !to) fail('pick a player');
  if (to === staff.hostId) fail('they are already the host');
  const rest = (staff.coHosts ?? []).filter((c) => c.playerId !== to);
  return { hostId: to, coHosts: [...rest, { playerId: staff.hostId, name: oldHostName || 'Player', powers: [...HOST_POWERS] }] };
}

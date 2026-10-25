// Who may send which tournament command: the host, and co-hosts with the
// matching power (see @rsdp/engine/roles). The server checks this before the
// director sees a command; the director trusts it.

import { hasPower, isStaff, powersOf, type HostPower } from '@rsdp/engine/roles';
import type { Command, PlayerId, TournamentState } from './types';

/** The power each staff command needs. 'host' means only the host. Commands not listed are a player's own. */
export const COMMAND_POWERS: Partial<Record<Command['type'], HostPower | 'host'>> = {
  approve: 'approve',
  reject: 'approve',
  setStack: 'chips',
  pause: 'run',
  resume: 'run',
  startNow: 'run',
  end: 'run',
  remove: 'players',
  movePlayer: 'players',
  editStructure: 'settings',
  updateSettings: 'settings',
  setCoHost: 'host',
  removeCoHost: 'host',
  transferHost: 'host',
  archive: 'host',
};

export const isStaffCommand = (type: Command['type']) => Object.hasOwn(COMMAND_POWERS, type);

/** May this player send this staff command? */
export function mayCommand(s: TournamentState, playerId: PlayerId, cmd: Command): boolean {
  const need = COMMAND_POWERS[cmd.type];
  if (!need) return false;
  // A co-host may always step down.
  if (cmd.type === 'removeCoHost' && cmd.playerId === playerId) return true;
  if (need === 'host') return playerId === s.hostId;
  if (!hasPower(s, playerId, need)) return false;
  if (playerId === s.hostId) return true;
  // A co-host never decides their own requests or chips, and choosing a starting stack is a chip power too.
  if (cmd.type === 'approve' || cmd.type === 'reject') {
    const r = s.requests.find((x) => x.id === cmd.requestId);
    if (r?.playerId === playerId) return false;
    if (cmd.type === 'approve' && cmd.stack !== undefined) return hasPower(s, playerId, 'chips');
  }
  if (cmd.type === 'setStack') return cmd.playerId !== playerId;
  return true;
}

/** Sees the host tools: the host or any co-host. */
export const isTournamentStaff = (s: TournamentState, playerId: PlayerId | null | undefined) => isStaff(s, playerId);

export const tournamentPowers = (s: TournamentState, playerId: PlayerId | null | undefined) => powersOf(s, playerId);

// The lobby's public record: director events turned into what everyone may
// read (names, not player ids; no approval requests), plus lobby chat.

import type { BettingKind } from '@rsdp/engine/core';
import type { AnteType } from './structure';
import type { DirectorEvent, PlayerId, TournamentSettings, TournamentState } from './types';

export type LogEvent =
  | { type: 'registered'; name: string; late: boolean; entryNo: number }
  | { type: 'unregistered'; name: string; notCheckedIn?: boolean }
  | { type: 'bountyWon'; name: string; from: string; cash: number }
  | { type: 'started' }
  | { type: 'startDelayed'; graceUntil: number }
  | { type: 'levelUp'; levelNumber: number; sb: number; bb: number; ante: number; anteType: AnteType; gameId: string; betting?: BettingKind }
  | { type: 'breakStarted'; minutes: number; addOn: boolean }
  | { type: 'breakEnded' }
  | { type: 'lateRegistrationClosed' }
  | { type: 'rebuysClosed' }
  | { type: 'reEntryClosed' }
  | { type: 'chipsAdded'; name: string; chips: number; reason: 'rebuy' | 'add-on' }
  | { type: 'eliminated'; name: string; place: number; by: string[]; reason: 'busted' | 'quit' | 'removed' }
  | { type: 'tableBroken' }
  | { type: 'handForHand'; active: boolean }
  | { type: 'paused' }
  | { type: 'resumed' }
  | { type: 'structureEdited' }
  /** The settings the host changed, by name; anyone can read their new values in the lobby. */
  | { type: 'settingsUpdated'; changed: (keyof TournamentSettings)[] }
  | { type: 'finished'; winner: string | null }
  | { type: 'cancelled'; reason: 'not-enough-players' | 'host' }
  /** Host tools: a stack edit once it lands, a swap, a seat move by the host, co-hosts, a new host, archive. */
  | { type: 'stackSet'; name: string; stack: number; previous: number }
  | { type: 'seatsSwapped'; names: string[] }
  | { type: 'seatMoved'; name: string }
  | { type: 'coHostsChanged' }
  | { type: 'hostChanged'; name: string }
  | { type: 'archived' };

export type LobbyItem =
  | { id: string; at: number; kind: 'chat'; playerId: PlayerId; name: string; text: string }
  | { id: string; at: number; kind: 'event'; event: LogEvent };

/** Longest lobby chat message. */
export const LOBBY_CHAT_MAX = 300;

/** Most people the host can have muted in one lobby chat at once. */
export const LOBBY_CHAT_MUTES_MAX = 100;

/** Why this player can't send to the lobby chat now, or null when they can. */
export function lobbyChatRefusal(s: TournamentState, playerId: PlayerId): string | null {
  if (s.lobbyChat?.off) return 'the host has turned chat off';
  if (s.lobbyChat?.muted?.includes(playerId)) return 'the host has muted you in this chat';
  return null;
}

/** A player's name in any of these states (an unregistered player is only in the one before). */
export function namesIn(...states: (TournamentState | null | undefined)[]) {
  return (playerId: PlayerId) => {
    for (const s of states) {
      const n =
        s?.entries.filter((x) => x.playerId === playerId).at(-1)?.displayName ??
        s?.requests.find((r) => r.playerId === playerId)?.displayName ??
        s?.coHosts?.find((c) => c.playerId === playerId)?.name;
      if (n) return n;
    }
    return 'A player';
  };
}

/** Takes only an event that no case names, which can't happen: a new kind of event fails to compile until it does. */
const unnamed = (_e: never): null => null;

/**
 * What the public log says about a director event, or null for one it leaves out. Every kind is named, the ones
 * left out included, so a new kind fails to compile until someone decides whether the lobby should see it.
 */
export function logEvent(e: DirectorEvent, name: (playerId: PlayerId) => string): LogEvent | null {
  switch (e.type) {
    case 'registered':
      return { type: 'registered', name: e.displayName, late: e.late, entryNo: e.entryNo };
    case 'unregistered':
      return e.reason === 'not-checked-in' ? { type: 'unregistered', name: name(e.playerId), notCheckedIn: true } : { type: 'unregistered', name: name(e.playerId) };
    case 'bountyWon':
      return { type: 'bountyWon', name: name(e.playerId), from: name(e.fromPlayerId), cash: e.cash };
    case 'started':
      return { type: 'started' };
    case 'startDelayed':
      return { type: 'startDelayed', graceUntil: e.graceUntil };
    case 'levelUp':
      return { type: 'levelUp', levelNumber: e.levelNumber, sb: e.sb, bb: e.bb, ante: e.ante, anteType: e.anteType, gameId: e.gameId, ...(e.betting ? { betting: e.betting } : {}) };
    case 'breakStarted':
      return { type: 'breakStarted', minutes: e.minutes, addOn: e.addOn };
    case 'breakEnded':
    case 'lateRegistrationClosed':
    case 'rebuysClosed':
    case 'reEntryClosed':
    case 'paused':
    case 'resumed':
    case 'structureEdited':
    case 'tableBroken':
      return { type: e.type };
    case 'stackAdded':
      return { type: 'chipsAdded', name: name(e.playerId), chips: e.chips, reason: e.reason };
    case 'eliminated':
      return { type: 'eliminated', name: name(e.playerId), place: e.place, by: e.by.map(name), reason: e.reason };
    case 'handForHand':
      return { type: 'handForHand', active: e.active };
    case 'finished':
      return { type: 'finished', winner: e.standings.find((x) => x.place === 1)?.displayName ?? null };
    case 'cancelled':
      return { type: 'cancelled', reason: e.reason };
    case 'stackSet':
      return e.applied ? { type: 'stackSet', name: name(e.playerId), stack: e.stack, previous: e.previous } : null;
    case 'seatsSwapped':
      return { type: 'seatsSwapped', names: e.moves.map((m) => name(m.playerId)) };
    case 'moveSeat':
      // Balancing moves are routine; a host's move is logged.
      return e.by ? { type: 'seatMoved', name: name(e.playerId) } : null;
    case 'coHostsChanged':
      return { type: 'coHostsChanged' };
    case 'hostChanged':
      return { type: 'hostChanged', name: name(e.hostId) };
    case 'archived':
      return { type: 'archived' };
    case 'settingsUpdated':
      // A save that changed nothing is not news.
      return e.changed.length ? { type: 'settingsUpdated', changed: [...e.changed] } : null;
    // Left out on purpose. Requests and invite codes are for the host's eyes, and a rebuy offer for the player's (the
    // rebuy itself is logged). Check-in shows in the lobby, and seating draws and late seats show at the tables. The
    // next event of a series and a fresh Sit & Go are work for the server, not news about this event.
    case 'requestPending':
    case 'requestRejected':
    case 'invitesCreated':
    case 'rebuyOffered':
    case 'checkInOpened':
    case 'checkedIn':
    case 'tablesCreated':
    case 'tableOpened':
    case 'seatPlayer':
    case 'scheduleNext':
    case 'spawnNext':
      return null;
  }
  return unnamed(e);
}

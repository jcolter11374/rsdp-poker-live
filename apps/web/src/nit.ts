import type { SeatView, TableView } from '@rsdp/engine/wire';
import { nitSchema } from '@rsdp/engine/modifiers';

/** What the Nit game row under the action bar says to one player. */
export interface NitStatus {
  /** The checkbox label: it always means "the next round". */
  label: string;
  /** One line on where things stand. */
  status: string;
  /** In the round now, so unticking can't take you out of it. */
  locked: boolean;
}

/**
 * The Nit game in words for `me` (null for someone watching). Unticking only
 * changes the next round, so a player in a round is told they're locked in.
 */
export function nitStatus(view: TableView, me: SeatView | null, fmt: (n: number) => string): NitStatus {
  const cfg = nitSchema.get(view.settings);
  const round = view.nit;
  const label = 'Play the Nit game';
  if (round) {
    const left = `${round.holders} of ${round.participants} still on the nit`;
    if (me?.nit === 'holder') {
      return {
        label: 'Play the next round too',
        status: `You're on the nit: win a pot by yourself to get off it. ${left}; the last one pays ${fmt(round.prize)} to each player.`,
        locked: true,
      };
    }
    if (me?.nit === 'clear') {
      return { label: 'Play the next round too', status: `You're off the nit ✓ ${left}; the last one pays you ${fmt(round.prize)}.`, locked: true };
    }
    const next = !me ? '' : me.nitOptIn ? " You're in the next one." : ' Tick to join the next one.';
    return { label, status: `A Nit round is on without you (${left}).${next}`, locked: false };
  }
  const ready = view.seats.filter((s) => s && s.nitOptIn && !s.sittingOut).length;
  const need = cfg.minPlayers - ready;
  const prize = fmt(cfg.prizeBigBlinds * view.settings.stakes.bigBlind);
  const status =
    need > 0
      ? `${ready} of ${cfg.minPlayers} players ticked. A round starts once ${need} more ${need === 1 ? 'joins' : 'join'}. Prize: ${prize} to each player.`
      : `${ready} players ticked: a round starts with the next hand. Prize: ${prize} to each player.`;
  return { label, status, locked: false };
}

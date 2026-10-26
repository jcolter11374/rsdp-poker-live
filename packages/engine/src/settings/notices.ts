import { diffSettings, isImmediateField } from './changes';
import type { TableSettings } from './schema';

/** A line for the table log; `loud` ones also go to chat, from the dealer, so nobody misses them. */
export interface SettingsNotice {
  text: string;
  loud: boolean;
}

/** Spectators actually see every hole card: watching is allowed and the host turned it on. */
export const spectatorsSeeCards = (s: TableSettings) => s.spectators.allowed && s.spectators.seeAllCards;

/** "2 minutes", "45 seconds", "1 min 30 s". */
export function delayText(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m === 0) return `${s} second${s === 1 ? '' : 's'}`;
  if (s === 0) return `${m} minute${m === 1 ? '' : 's'}`;
  return `${m} min ${s} s`;
}

/** How far behind spectators watch, as a phrase: "2 minutes behind the table" or "live, with no delay". */
export const behindText = (seconds: number) => (seconds > 0 ? `${delayText(seconds)} behind the table` : 'live, with no delay');

const SECTION_NAMES: Record<string, string> = {
  table: 'table',
  game: 'game',
  stakes: 'stakes',
  blindSchedule: 'blind schedule',
  timing: 'clocks',
  seating: 'seating',
  play: 'play options',
  chat: 'chat',
  spectators: 'spectators',
};

/** Paths described one by one below; the rest are summed up by section. */
const DESCRIBED = new Set([
  'spectators.allowed',
  'spectators.seeAllCards',
  'spectators.delaySeconds',
  'chat.guestChat',
  'play.rabbitHunt',
  'play.revealAllAtShowdown',
  'modifiers.rake.visibleTo',
]);

/**
 * What the table is told about a host edit, from the settings before it to
 * the settings it leads to. Anything that changes what someone can see (hole
 * cards, undealt cards, the rake, who can talk) gets its own line; the rest
 * are named by section, so no change is ever silent. `who` made the edit;
 * with `handLive`, fields that wait say they start with the next hand.
 */
export function settingsNotices(before: TableSettings, after: TableSettings, who: string, handLive: boolean): SettingsNotice[] {
  const diff = diffSettings(before, after);
  if (!diff.length) return [];
  const changed = (path: string) => diff.some((c) => c.path === path);
  const later = (path: string) => (handLive && !isImmediateField(path) ? ' from the next hand' : '');
  const out: SettingsNotice[] = [];

  const sawAll = spectatorsSeeCards(before);
  const seesAll = spectatorsSeeCards(after);
  const delay = after.spectators.delaySeconds;
  if (!sawAll && seesAll) {
    out.push({
      text:
        `⚠️ ${who} turned on spectators seeing hole cards. From the next hand, anyone watching sees every player's cards, ${behindText(delay)}. ` +
        "Someone watching could pass them on to a player. If you're not OK with that, say so or leave the table.",
      loud: true,
    });
  } else if (sawAll && !seesAll) {
    out.push({
      text: after.spectators.allowed
        ? `${who} turned off spectators seeing hole cards. Spectators see only what players show.`
        : `${who} turned watching off, so spectators no longer see hole cards or anything of the hand.`,
      loud: true,
    });
  } else if (changed('spectators.seeAllCards') && !after.spectators.allowed) {
    // Watching is off, so nobody sees anything yet; say what turning it back on would mean.
    out.push({
      text: after.spectators.seeAllCards
        ? `${who} set spectators to see every hole card if watching is turned back on.`
        : `${who} set spectators not to see hole cards if watching is turned back on.`,
      loud: false,
    });
  }
  if (changed('spectators.allowed') && sawAll === seesAll) {
    out.push({
      text: after.spectators.allowed ? `${who} turned watching on: anyone with the link can watch, without hole cards.` : `${who} turned watching off: only seated players see the game.`,
      loud: false,
    });
  }
  if (changed('spectators.delaySeconds') && !(!sawAll && seesAll)) {
    const was = before.spectators.delaySeconds;
    const shorter = delay < was;
    out.push({
      text: `${seesAll ? '⚠️ ' : ''}${who} set spectators to watch ${behindText(delay)}${later('spectators.delaySeconds')} (it was ${was > 0 ? `${delayText(was)} behind` : 'live'})${seesAll ? '. They see every hole card' : ''}.`,
      loud: seesAll && shorter,
    });
  }
  if (changed('chat.guestChat')) {
    out.push({
      text: after.chat.guestChat
        ? `${who} let people who aren't seated chat${seesAll ? ', and spectators here see every hole card' : ''}.`
        : `${who} turned off chat for people who aren't seated.`,
      loud: seesAll && after.chat.guestChat,
    });
  }
  if (changed('play.rabbitHunt')) {
    out.push({ text: `${who} turned rabbit hunting ${after.play.rabbitHunt ? 'on' : 'off'}${later('play.rabbitHunt')}: ${after.play.rabbitHunt ? 'when a hand ends early, anyone can look at the cards that would have come' : 'the undealt cards stay hidden'}.`, loud: false });
  }
  if (changed('play.revealAllAtShowdown')) {
    out.push({
      text: after.play.revealAllAtShowdown
        ? `${who} set every hand at showdown to be shown${later('play.revealAllAtShowdown')}.`
        : `${who} let losing hands at showdown be mucked${later('play.revealAllAtShowdown')}.`,
      loud: false,
    });
  }
  if (changed('modifiers.rake.visibleTo')) {
    const rake = after.modifiers.rake as { visibleTo?: string } | undefined;
    out.push({ text: `${who} made the rake total visible to ${rake?.visibleTo === 'everyone' ? 'everyone' : 'the host only'}.`, loud: false });
  }

  const sections: string[] = [];
  for (const c of diff) {
    if (DESCRIBED.has(c.path)) continue;
    const [head, id] = c.path.split(/[.[]/);
    const name = head === 'modifiers' ? (id ?? 'side games').replace(/-/g, ' ') : (SECTION_NAMES[head] ?? head);
    if (!sections.includes(name)) sections.push(name);
  }
  if (sections.length) {
    const immediate = diff.filter((c) => !DESCRIBED.has(c.path)).every((c) => isImmediateField(c.path));
    out.push({ text: `${who} changed the table settings: ${sections.join(', ')}${handLive && !immediate ? ' (from the next hand)' : ''}.`, loud: false });
  }
  return out;
}

import type { HandState, PlayerId, SeatIndex } from '@rsdp/engine/core';
import { BOT_NOTE_RULES, type BotLevel, type BotNote, type BotNoteRule } from '@rsdp/engine/wire';
import type { MoveWhy } from './strategy';

/**
 * What a practice bot says about a move it made. A note is built field by
 * field from the numbers the bot worked out (MoveWhy), so only the ones listed
 * here ever leave the server: rounded numbers and closed sets of words, never
 * a card, which cards it threw, or anything about another person. The browser
 * writes the sentences (apps/web/src/coach.ts).
 */

/** Chances are rough guesses, so they are given to the nearest 5%... */
const toShare = (x: number) => Math.min(1, Math.max(0, Math.round(x * 20) / 20));
/** ...and pot odds and coin flips to the nearest 1%. */
const toOdds = (x: number) => Math.min(1, Math.max(0, Math.round(x * 100) / 100));

/** Hard: how often an opponent folds to a bet for it to count as folding a lot, or as calling a lot. */
const FOLDS_OFTEN = 0.45;
const CALLS_OFTEN = 0.28;
/** The plays Hard makes because of how the person it is playing has played. */
const ABOUT_YOU: BotNoteRule[] = ['bluff', 'semi-bluff', 'steal', 'value'];

export function botNote(seq: number, seat: SeatIndex, level: BotLevel, why: MoveWhy, hand: HandState, person: PlayerId): BotNote {
  // A rule the wire doesn't know would say nothing to the browser, so it reads as a move the table made.
  const rule: BotNoteRule = BOT_NOTE_RULES.includes(why.rule) ? why.rule : 'fallback';
  const note: BotNote = { seq, seat, level, rule };
  if (Number.isFinite(why.equity)) note.share = toShare(why.equity!);
  if (why.split) note.split = true;
  // The bot's own number is against the players still in the hand, however many of them the deals could fit.
  if (Number.isFinite(why.opponents)) note.vs = Math.max(0, Math.round(why.opponents!));
  if (why.drawsLeft) note.drawsLeft = Math.max(0, Math.round(why.drawsLeft));
  if (Number.isFinite(why.cost)) note.cost = toOdds(why.cost!);
  if (Number.isFinite(why.need)) note.need = toOdds(why.need!);
  if (why.big) note.big = true;
  if (why.capped) note.capped = true;
  if (Number.isFinite(why.often)) note.often = toOdds(why.often!);
  if (Number.isFinite(why.thrown)) note.thrown = Math.max(0, Math.round(why.thrown!));
  if (why.alt) note.alt = { thrown: Math.max(0, Math.round(why.alt.thrown)), share: toShare(why.alt.equity) };
  if (level === 'hard') {
    if (why.inPosition) note.last = true;
    // How a player plays is kept only when it is about the one person in the hand, and only where it chose the play.
    if (why.foldFrom === person && why.foldRate !== undefined && ABOUT_YOU.includes(rule)) {
      if (why.foldRate >= FOLDS_OFTEN) note.you = 'folds-often';
      else if (why.foldRate <= CALLS_OFTEN) note.you = 'calls-often';
    }
    // Hard reads only the players still in the hand, so a person who has folded played no part in this move. The bot's
    // own move can't fold them, so the hand after it says the same as the hand before.
    const me = hand.seats.find((x) => x.playerId === person);
    const bets = me && !me.folded ? yourBets(hand, person) : 0;
    if (bets) note.yourBets = bets;
  }
  return note;
}

/** A note for a move the bot's own numbers never came into: the table voted or acted for it. */
export function plainNote(seq: number, seat: SeatIndex, level: BotLevel, rule: 'rit-yes' | 'fallback'): BotNote {
  return { seq, seat, level, rule };
}

/** How often the one person in the hand has bet, raised or completed, from the public events. */
function yourBets(hand: HandState, person: PlayerId): number {
  const seat = hand.seats.find((x) => x.playerId === person)?.seat;
  if (seat === undefined) return 0;
  return hand.events.filter((ev) => ev.t === 'action' && ev.seat === seat && !ev.auto && (ev.action === 'bet' || ev.action === 'raise' || ev.action === 'complete')).length;
}

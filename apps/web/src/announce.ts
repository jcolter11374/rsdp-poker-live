import type { TableView } from '@rsdp/engine/wire';
import { eventLines, stakesLabel, type Fmt } from './format';

/*
 * What the table says aloud to a screen reader (TableAnnouncer): each new line of the hand log as it happens (the
 * deal, every move, the board, the result), "Your turn" with what you can do, who is picking the next game in
 * Dealer's choice, and a pause. It reads only what this player's own view of the table already shows, so it can never
 * tell anyone more than their screen does.
 */

const RANK: Record<string, string> = { A: 'ace', K: 'king', Q: 'queen', J: 'jack', T: '10' };
const SUIT: Record<string, string> = { c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' };

/** Log text's [Ah] [Kd] cards in words: "ace of hearts, king of diamonds". */
export function spokenCards(text: string): string {
  return text.replace(/\] \[/g, '], [').replace(/\[([2-9TJQKA])([cdhs])\]/g, (_, r: string, s: string) => `${RANK[r] ?? r} of ${SUIT[s]}`);
}

/** A hand-log line as it is read: cards in words, and no rules or dots between its parts. */
export function spokenLine(line: string): string {
  return spokenCards(line)
    .replace(/^--- /, '')
    .replace(/^— (.*) —$/, '$1')
    .replace(/ · /g, ', ')
    .replace(/#(\d)/g, '$1');
}

/** "a, b or c". */
function either(parts: string[]): string {
  return parts.length < 2 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} or ${parts.at(-1)}`;
}

/** It's this player's turn: to bet, to draw, or to vote on running it twice. */
export const isMyTurn = (view: TableView | null) => !!view && (!!view.legal || !!view.canDraw || view.canVoteRunItTwice);

/**
 * Which turn of mine this is, or null when it isn't my turn. A turn to bet or draw is known by the hand's event count,
 * so a check on the flop followed straight away by my turn on the turn card is a new turn; the vote on running it twice
 * is one turn, however many others vote meanwhile.
 */
function myTurnKey(view: TableView): string | null {
  if (!isMyTurn(view)) return null;
  const hand = view.hand?.handNumber ?? '';
  return view.canVoteRunItTwice ? `rit:${hand}` : `${hand}:${view.hand?.events.length ?? 0}`;
}

/** "Your turn" and what can be done, as the action bar offers it. */
export function turnText(view: TableView, fmt: Fmt): string | null {
  const hand = view.hand;
  if (view.canVoteRunItTwice) return 'Your turn: everyone is all in. Run it once or run it twice?';
  if (view.canDraw) {
    const max = view.canDraw.max;
    return `Your turn to draw: pick ${max === 1 ? 'a card' : `up to ${max} cards`} to throw away, or stand pat.`;
  }
  const legal = view.legal;
  if (!legal || !hand) return null;
  const options: string[] = [];
  if (legal.canBringIn) options.push(`bring in for ${fmt(hand.stakes.bringIn)}`);
  else if (legal.canCheck) options.push('check');
  else options.push(`call ${fmt(legal.callAmount)}`);
  if (legal.canRaise) {
    const verb = legal.canBringIn ? 'complete to' : legal.raiseKind === 'bet' ? 'bet' : 'raise to';
    options.push(legal.maxTo > legal.minTo ? `${verb} ${fmt(legal.minTo)} up to ${fmt(legal.maxTo)}` : `${verb} ${fmt(legal.minTo)}`);
  }
  // Folding when you could check is allowed, but the bar asks twice; it isn't offered aloud.
  if (legal.canFold && !legal.canCheck) options.push('fold');
  const pot = Math.max(hand.potTotal, hand.pots[0]?.amount ?? 0);
  return `Your turn: ${either(options)}. Pot ${fmt(pot)}.`;
}

/**
 * Dealer's choice: who the table is waiting on to pick the next game, in the felt's words (ChoiceLine in Choice.tsx),
 * or null while it waits for nobody's pick. `key` is one pick: the hand it follows, and who is picking.
 */
export function pickWait(view: TableView): { key: string; text: string } | null {
  const c = view.choice;
  const live = !!view.hand && view.hand.phase !== 'complete';
  if (!c || live || !view.started || c.deadline === null || c.chip === null) return null;
  const who = view.seats[c.chip];
  if (!who) return null;
  return { key: `${view.hand?.handNumber ?? 0}:${who.playerId}`, text: who.playerId === view.me.playerId ? 'Your pick: choose the next game' : `${who.name} is picking the next game` };
}

/**
 * What to say for the change from `before` to `view`: the hand-log lines that are new since `before` (all of a hand
 * that has just been dealt), a pause or restart, a new ask to sit or rebuy for whoever can approve it, who has just
 * started picking the next game, then the turn when it has just become yours. The first view of a
 * table says nothing, so arriving mid-hand doesn't read out the whole hand. `preQueued`: a move ticked in advance will
 * answer the turn by itself, so it isn't called out.
 */
export function announcements(before: TableView | null, view: TableView, fmt: Fmt, preQueued = false): string[] {
  if (!before) return [];
  const out: string[] = [];
  const hand = view.hand;
  if (hand) {
    const fresh = hand.handNumber !== before.hand?.handNumber;
    const seen = fresh ? -1 : (before.hand?.events.at(-1)?.seq ?? -1);
    const name = (seat: number) => hand.names?.[seat] ?? view.seats[seat]?.name ?? `Seat ${seat + 1}`;
    // Lines come from the whole hand, so the flop, turn and river are named as the log names them.
    const all = eventLines(hand.events, name, fmt, view.me.seat);
    const had = fresh ? 0 : eventLines(hand.events.filter((e) => e.seq <= seen), name, fmt, view.me.seat).length;
    // The log's first line names the game by its short code (NLH); aloud it's the game's own name.
    const header = `Hand ${hand.handNumber} · ${hand.gameName} ${stakesLabel(hand.stakes, hand.family, hand.betting, fmt)}${hand.bombPot ? ' · bomb pot' : ''}`;
    out.push(...all.slice(had).map((line) => spokenLine(line.startsWith('--- Hand #') ? header : line)));
  }
  if (view.paused && !before.paused) out.push('The game is paused.');
  if (!view.paused && before.paused) out.push('The game is back on.');
  // Whoever can let people in hears each new ask; the note on screen only counts them.
  if (view.powers.includes('approve')) {
    const had = new Set(before.requests.map((r) => r.id));
    for (const r of view.requests) {
      if (had.has(r.id) || r.playerId === view.me.playerId || r.bot?.ownerId === view.me.playerId) continue;
      const who = r.bot ? `${r.name}, ${r.bot.ownerName}'s bot,` : r.name;
      out.push(r.kind === 'rebuy' ? `${who} asks for a ${fmt(r.amount)} rebuy` : `${who} asks to sit down`);
    }
  }
  const pick = pickWait(view);
  if (pick && pick.key !== pickWait(before)?.key) out.push(pick.text);
  const turn = myTurnKey(view);
  if (turn !== null && turn !== myTurnKey(before) && !preQueued) {
    const words = turnText(view, fmt);
    if (words) out.push(words);
  }
  return out.filter(Boolean);
}

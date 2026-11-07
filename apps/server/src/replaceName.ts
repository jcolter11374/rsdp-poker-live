/**
 * Replacing a player's name with "Deleted player" in old records (issue #233), as docs/PRIVACY.md ("Deleting your
 * data") promises someone who deleted their account or played as a guest. docs/RUNBOOK.md says how John runs it.
 *
 * Only names change: never an amount, an id, a card or a time. Hands are saved by player id and hold no names, so
 * they and the public record's fingerprints (packages/engine/src/audit.ts) stay exactly as they were, and so do the
 * ledger's numbers, the leaderboard and everyone's profit graph.
 *
 * Where names are kept beside the player's id (seats, ledger rows, chat, waitlists, co-hosts, tournament entries,
 * hand seeds in shared hands, feedback), the id decides. Lines with no id (the table log, the dealer's chat lines,
 * tournament lobby events) are matched by the names the player went by, and only at tables and tournaments where
 * the player's id is found, so someone else of the same name elsewhere is left alone. A name is looked for inside a
 * line of text only when it can't be mistaken for the server's own words there: it has a letter, at least two
 * characters and a word the server never writes itself, so a name like "100", "a" or "Game" never rewrites an amount
 * or "Game paused" (those names are counted, and still replaced wherever they sit beside the id). What people typed
 * in chat is left as they typed it: those messages are only counted.
 */

import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { schema, type Db } from './db';

const { players, tableSnapshots, tableLog, tournaments, tournamentLog, sharedHands, feedback, hands } = schema;

export const DELETED_NAME = 'Deleted player';

/** Names that stand for nobody in particular, so they are never taken for the player's, in a field or a line of text. */
const PLACEHOLDERS = new Set(['', 'Guest', 'A player', 'Dealer', DELETED_NAME]);

/**
 * Every word the server writes itself in a table's log and dealer lines (runtime/table.ts and the settings notices),
 * and in what it puts in them: game names, bot levels, side games and the reasons a hand couldn't be dealt. A name
 * made only of these words (in any case) is never looked for in a line of text, where it could match the line's own
 * wording. replace-name.test.ts reads those lines from the code and fails when one has a word missing here.
 */
export const SERVER_WORDS: ReadonlySet<string> = new Set(
  `a action add added after all already amount and anyone anything are aren as asked at away back badugi be been
  behind better betting blind blinds board bomb bot bought bounties bounty bring call can cancelled cannot card cards
  changed chat check clocks closed co collects come complete could couldn deal dealer deals dealt deck declined delay
  deleted didn discard double down draw each early easy em ended ends enough every everyone flop folded for free from
  game games given guest had hand hands hard has have here hi hidden hold holding hole host hunting if in into invalid
  is it its joined last least leave left let level limit link live lo longer look losing made min minute minutes
  modifiers most moved mucked muted need needs next nit no normal not nothing now of off offline ok omaha on one only
  options or others out pass paused pays people play player players post pot practice rabbit raise rake ran razz re
  rebuy released removed request result resumed right round run running s sat saved say schedule seat seated seating
  seats second see seeing sees server set settings seven show showdown shown shuffled side sitting so someone
  spectators stack stakes started stay stepped stopped stud such switching t table take taken that the their them they
  this time to took total triple turn turned twice two undealt unknown unmuted visible vote waiting waitlist was watch
  watching went what when who win wins with without would you your`.split(/\s+/),
);

/** The fewest characters a name needs to be looked for in a line of text. */
const SEARCH_MIN = 2;

/**
 * Whether a name can be looked for in a line of text (a log or dealer line, or a chat message) without matching
 * something that isn't a name: it has a letter, so it can't be an amount ("100", "5/10"), at least SEARCH_MIN
 * characters, and a word the server doesn't write itself ("a", "Game", "The host" can't be told from its wording).
 */
export function searchable(name: string): boolean {
  const n = name.trim();
  if (PLACEHOLDERS.has(n) || Array.from(n).length < SEARCH_MIN || !/\p{L}/u.test(n)) return false;
  const words = (n.match(/[\p{L}\p{N}\p{M}_]+/gu) ?? []).filter((w) => /\p{L}/u.test(w));
  return words.some((w) => !SERVER_WORDS.has(w.toLowerCase()));
}

/** Fields that hold the name of the player whose id is beside them in `playerId`. */
const NAME_KEYS = ['name', 'displayName'] as const;

/** Fields of a tournament lobby event that hold a name (packages/tournament/src/log.ts): a string or a list of them. */
const EVENT_NAME_KEYS = ['name', 'from', 'winner', 'by', 'names'] as const;

/** A letter, digit or underscore: a name found next to one is part of a longer word, not the name. */
const WORD = /[\p{L}\p{N}\p{M}_]/u;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Every object inside `value`, outermost first. */
function* objects(value: unknown): Generator<Obj> {
  if (Array.isArray(value)) for (const v of value) yield* objects(v);
  else if (isObj(value)) {
    yield value;
    for (const v of Object.values(value)) yield* objects(v);
  }
}

/**
 * The names a document gives people beside their ids, sorted into this player's and everyone else's: `name` or
 * `displayName` next to `playerId`, `ownerName` next to `ownerId` (practice bots), and a table's `handNames`.
 */
function idNames(doc: unknown, playerId: string, into: { mine: Set<string>; others: Set<string> }) {
  const add = (id: unknown, name: unknown) => {
    if (typeof id === 'string' && typeof name === 'string' && name) (id === playerId ? into.mine : into.others).add(name);
  };
  for (const o of objects(doc)) {
    if ('playerId' in o) for (const k of NAME_KEYS) add(o.playerId, o[k]);
    if ('ownerId' in o) add(o.ownerId, o.ownerName);
  }
  if (isObj(doc) && isObj(doc.handNames)) for (const [id, name] of Object.entries(doc.handNames)) add(id, name);
}

/** Puts DELETED_NAME in `o[key]` when it holds a name; 1 when it did. */
function put(o: Obj, key: string): number {
  const v = o[key];
  if (typeof v !== 'string' || v === '' || v === DELETED_NAME) return 0;
  o[key] = DELETED_NAME;
  return 1;
}

/** Replaces every name `doc` gives this player beside their id (as idNames finds them). Returns how many. */
function replaceById(doc: unknown, playerId: string): number {
  let n = 0;
  for (const o of objects(doc)) {
    if (o.playerId === playerId) for (const k of NAME_KEYS) n += put(o, k);
    if (o.ownerId === playerId) n += put(o, 'ownerName');
  }
  if (isObj(doc) && isObj(doc.handNames) && Object.hasOwn(doc.handNames, playerId)) n += put(doc.handNames, playerId);
  return n;
}

/**
 * `text` with each of `names` replaced where it stands as a whole word ("Al" leaves "Also" alone), except inside one
 * of `keep`: other people's names that contain it ("Big Al" stays when only "Al" goes), and inside a "Deleted player"
 * already there. Longer names are tried first.
 */
export function replaceInText(text: string, names: readonly string[], keep: Iterable<string> = []): { text: string; count: number } {
  if (!text || !names.length) return { text, count: 0 };
  const sorted = [...names].sort((a, b) => b.length - a.length);
  const kept: [number, number][] = [];
  for (const k of [...keep, DELETED_NAME]) {
    if (!sorted.some((n) => k.length > n.length && k.includes(n))) continue;
    for (let i = text.indexOf(k); i >= 0; i = text.indexOf(k, i + 1)) kept.push([i, i + k.length]);
  }
  const wordAt = (i: number) => i >= 0 && i < text.length && WORD.test(text[i]);
  let out = '';
  let from = 0;
  let count = 0;
  for (let i = 0; i < text.length; ) {
    const hit = sorted.find((n) => text.startsWith(n, i) && !wordAt(i - 1) && !wordAt(i + n.length) && !kept.some(([s, e]) => s <= i && i + n.length <= e));
    if (!hit) {
      i++;
      continue;
    }
    out += text.slice(from, i) + DELETED_NAME;
    i += hit.length;
    from = i;
    count++;
  }
  return count ? { text: out + text.slice(from), count } : { text, count: 0 };
}

/** Where a document is: whether the player's id is found at that table or tournament, and the others' names there. */
export interface Place {
  there: boolean;
  /** Other people's names there, kept whole when one of them contains a name being replaced. */
  keep: Set<string>;
  /** A practice bot's owner, by the bot's id, where the table still knows it. */
  botOwner?: (botId: unknown) => string | undefined;
}

/** What replacing came to in one document: names replaced, and chat messages others typed that name the player. */
export interface Tally {
  names: number;
  mentions: number;
}

/** The botOwner of a table's saved state: who added each practice bot it has now. */
export function botOwners(state: unknown): (botId: unknown) => string | undefined {
  const bots = isObj(state) && isObj(state.bots) ? state.bots : {};
  return (botId) => {
    const bot = typeof botId === 'string' && Object.hasOwn(bots, botId) ? bots[botId] : undefined;
    return isObj(bot) && typeof bot.ownerId === 'string' ? bot.ownerId : undefined;
  };
}

/** Replaces one player's names, document by document. Every method changes the document it is given. */
export class NameReplacer {
  /** Every name the player went by, apart from placeholders: replaced wherever a field holds one of them whole. */
  readonly names: string[];
  /** The ones also looked for inside lines of text with no id (see searchable). */
  readonly words: string[];

  constructor(
    readonly playerId: string,
    names: Iterable<string>,
  ) {
    this.names = [...new Set(names)].filter((n) => !PLACEHOLDERS.has(n.trim()));
    this.words = this.names.filter(searchable);
  }

  /** Whether some chat text names the player (`keep`: others' names there that contain one of theirs). */
  mentions(text: unknown, keep: Iterable<string> = []): boolean {
    return typeof text === 'string' && replaceInText(text, this.words, keep).count > 0;
  }

  /** Whether one of the player's names is also someone else's here. */
  shared(place: Place): boolean {
    return this.names.some((w) => place.keep.has(w));
  }

  private text(o: Obj, key: string, place: Place): number {
    const v = o[key];
    if (typeof v !== 'string') return 0;
    const r = replaceInText(v, this.words, place.keep);
    if (r.count) o[key] = r.text;
    return r.count;
  }

  /** A practice bot's owner's name: by the owner's id where the table knows it, otherwise by name where the player was. */
  private owner(o: Obj, key: string, ownerId: string | undefined, place: Place): number {
    const v = o[key];
    if (typeof v !== 'string') return 0;
    const mine = ownerId !== undefined ? ownerId === this.playerId : place.there && this.names.includes(v);
    return mine ? put(o, key) : 0;
  }

  /** A chat message: its name when it is the player's, counted as a mention when someone else's words name them. */
  private chat(o: Obj, tally: Tally, place: Place) {
    if (typeof o.playerId === 'string' && o.playerId !== this.playerId && this.mentions(o.text, place.keep)) tally.mentions++;
  }

  /** A table's saved state (RuntimeState in runtime/types.ts), or one held in memory. */
  table(state: unknown, place: Place): Tally {
    const tally = { names: 0, mentions: 0 };
    if (!isObj(state)) return tally;
    tally.names += replaceById(state, this.playerId);
    const botOwner = place.botOwner ?? botOwners(state);
    // A practice bot's ledger row keeps its owner's name, and outlasts the bot.
    if (isObj(state.ledger)) for (const row of Object.values(state.ledger)) if (isObj(row) && row.bot === true) tally.names += this.owner(row, 'owner', botOwner(row.playerId), place);
    // Chat others typed is counted by the caller, which knows which messages are also saved lines.
    if (place.there) {
      for (const line of list(state.log)) if (isObj(line)) tally.names += this.text(line, 'text', place);
      // The dealer's lines (no player id) repeat some log lines, such as a settings change and who made it.
      for (const m of list(state.chat)) if (isObj(m) && m.playerId === null) tally.names += this.text(m, 'text', place);
    }
    return tally;
  }

  /** One saved line of a table's log or chat (table_log.item). */
  tableLine(kind: string, item: unknown, place: Place): Tally {
    const tally = { names: 0, mentions: 0 };
    if (!isObj(item)) return tally;
    tally.names += replaceById(item, this.playerId);
    if (kind === 'chat') this.chat(item, tally, place);
    if (place.there && (kind === 'log' || (kind === 'chat' && item.playerId === null))) tally.names += this.text(item, 'text', place);
    return tally;
  }

  /** A tournament's saved state (TournamentState in packages/tournament): entries, requests, co-hosts, invite codes used. */
  tournament(state: unknown): Tally {
    return { names: replaceById(state, this.playerId), mentions: 0 };
  }

  /** One saved item of a tournament lobby (tournament_log.item): a chat message, or an event that names people. */
  lobbyItem(item: unknown, place: Place): Tally {
    const tally = { names: 0, mentions: 0 };
    if (!isObj(item)) return tally;
    tally.names += replaceById(item, this.playerId);
    if (item.kind === 'chat') this.chat(item, tally, place);
    const event = item.event;
    if (!place.there || !isObj(event)) return tally;
    const ours = (v: unknown) => typeof v === 'string' && this.names.includes(v);
    for (const key of EVENT_NAME_KEYS) {
      const v = event[key];
      if (ours(v)) tally.names += put(event, key);
      else if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) {
          if (!ours(v[i])) continue;
          v[i] = DELETED_NAME;
          tally.names++;
        }
      }
    }
    return tally;
  }

  /** A shared hand link's frozen view (SharedHandView in packages/engine/src/wire.ts). */
  sharedHand(snapshot: unknown, createdBy: string, place: Place): Tally {
    const tally = { names: 0, mentions: 0 };
    if (!isObj(snapshot)) return tally;
    tally.names += replaceById(snapshot, this.playerId);
    if (createdBy === this.playerId) tally.names += put(snapshot, 'sharedBy');
    const botOwner = place.botOwner ?? (() => undefined);
    const hand = isObj(snapshot.hand) ? snapshot.hand : {};
    for (const seat of list(hand.seats)) if (isObj(seat) && isObj(seat.bot)) tally.names += this.owner(seat.bot, 'ownerName', botOwner(seat.playerId), place);
    return tally;
  }
}

/** The names a table's or tournament's documents give everyone but this player. */
function othersIn(playerId: string, ...docs: unknown[]): Set<string> {
  const into = { mine: new Set<string>(), others: new Set<string>() };
  for (const d of docs) idNames(d, playerId, into);
  return into.others;
}

/** Whether a document holds this player's id anywhere (as a value or a key). */
export function holdsId(doc: unknown, playerId: string): boolean {
  return JSON.stringify(doc ?? null).includes(JSON.stringify(playerId));
}

export type Where = 'players' | 'table_snapshots' | 'table_log' | 'tournaments' | 'tournament_log' | 'shared_hands' | 'feedback';

export interface ReplaceReport {
  dryRun: boolean;
  /** How many different names the player went by: only the count, never the names. */
  names: number;
  /**
   * How many of those aren't looked for in lines of text with no id, because they could be mistaken for the server's
   * own words or an amount there (see searchable): log and dealer lines keep them, everything else is replaced.
   */
  namesNotSearched: number;
  /** Rows changed (in a dry run, the rows that would change), by database table. */
  rows: Record<Where, number>;
  /** Names replaced in all, across those rows. */
  replaced: number;
  /** Tables and tournaments where someone else went by one of the same names: their lines with no id there read "Deleted player" too. */
  sharedNames: number;
  /** Chat messages other people typed that name the player: left as they typed them. */
  chatMentions: number;
}

export interface ReplaceResult {
  /** What the change came to: counts only, so it can go in a public log. */
  report: ReplaceReport;
  /** The same change for each tournament lobby's items, for the copies held in memory (LobbyLog.rewrite). */
  lobbies: { id: string; change: (item: unknown) => void }[];
}

export class ReplaceNameError extends Error {
  constructor(
    readonly code: 'not-found' | 'account' | 'in-memory' | 'busy',
    message: string,
  ) {
    super(message);
  }
}

/** What the server holds in memory and would save over the database: asked once the change is worked out. */
export interface InMemoryCheck {
  /**
   * How many tables and tournaments held in memory the change would touch (`wouldTouch` says for one), or 'busy'
   * while a save from one no longer held is still to land.
   */
  (wouldTouch: { table(state: unknown): boolean; tournament(state: unknown): boolean }): { tables: number; tournaments: number } | 'busy';
}

/**
 * Replaces the name of the player with this id by DELETED_NAME everywhere past play keeps it, in one transaction.
 * A dry run works out the same change and writes nothing. Refused for a player whose account still exists (the
 * promise is to people who deleted theirs, and to guests), and while the server holds, in memory, a table or
 * tournament the change would touch: its next save would put the old names back.
 */
export async function replacePlayerName(db: Db, playerId: string, opts: { dryRun?: boolean; inMemory?: InMemoryCheck } = {}): Promise<ReplaceResult> {
  const dryRun = opts.dryRun ?? true;
  // The id as it is written inside the JSON of a document that holds it.
  const needle = JSON.stringify(playerId);
  const holds = (column: unknown) => sql`position(${needle} in ${column}::text) > 0`;
  return db.transaction(async (tx) => {
    const [player] = await tx.select({ accountId: players.accountId, displayName: players.displayName }).from(players).where(eq(players.id, playerId)).for('update');
    if (!player) throw new ReplaceNameError('not-found', 'No player has that id.');
    if (player.accountId) throw new ReplaceNameError('account', 'That player has an account. Only the name of a deleted account or a guest can be replaced: they can delete their account from their profile first.');

    // Every table where the player's id is found: in its saved state, in its chat, or dealt a hand.
    const snaps = await tx.select({ tableId: tableSnapshots.tableId, state: tableSnapshots.state }).from(tableSnapshots).where(holds(tableSnapshots.state)).for('update');
    const chatAt = await tx.selectDistinct({ tableId: tableLog.tableId }).from(tableLog).where(and(eq(tableLog.kind, 'chat'), sql`${tableLog.item} ->> 'playerId' = ${playerId}`));
    const dealtAt = await tx.selectDistinct({ tableId: hands.tableId }).from(hands).where(sql`${hands.header} -> 'seats' @> ${JSON.stringify([{ playerId }])}::jsonb`);
    const tablesThere = new Set([...snaps, ...chatAt, ...dealtAt].map((r) => r.tableId));
    const lines = tablesThere.size
      ? await tx.select({ n: tableLog.n, tableId: tableLog.tableId, kind: tableLog.kind, at: tableLog.at, item: tableLog.item }).from(tableLog).where(inArray(tableLog.tableId, [...tablesThere])).for('update')
      : [];

    // Every tournament where it is found: in its saved state or its lobby chat.
    const events = await tx.select({ id: tournaments.id, state: tournaments.state }).from(tournaments).where(holds(tournaments.state)).for('update');
    const lobbyChatIn = await tx.selectDistinct({ id: tournamentLog.tournamentId }).from(tournamentLog).where(sql`${tournamentLog.item} ->> 'playerId' = ${playerId}`);
    const tournamentsThere = new Set([...events, ...lobbyChatIn].map((r) => r.id));
    const lobby = tournamentsThere.size
      ? await tx.select({ n: tournamentLog.n, tournamentId: tournamentLog.tournamentId, item: tournamentLog.item }).from(tournamentLog).where(inArray(tournamentLog.tournamentId, [...tournamentsThere])).for('update')
      : [];

    const shared = await tx
      .select({ id: sharedHands.id, tableId: sharedHands.tableId, createdBy: sharedHands.createdBy, snapshot: sharedHands.snapshot })
      .from(sharedHands)
      .where(or(eq(sharedHands.createdBy, playerId), holds(sharedHands.snapshot)))
      .for('update');
    const sent = await tx.select({ id: feedback.id, name: feedback.name }).from(feedback).where(eq(feedback.playerId, playerId)).for('update');

    // Every name the player went by, from wherever one sits beside their id.
    const into = { mine: new Set<string>(), others: new Set<string>() };
    if (player.displayName) into.mine.add(player.displayName);
    for (const doc of [...snaps.map((s) => s.state), ...events.map((e) => e.state), ...shared.map((s) => s.snapshot)]) idNames(doc, playerId, into);
    for (const l of [...lines, ...lobby]) idNames(l.item, playerId, into);
    for (const s of shared) if (s.createdBy === playerId && isObj(s.snapshot) && typeof s.snapshot.sharedBy === 'string') into.mine.add(s.snapshot.sharedBy);
    for (const f of sent) if (f.name) into.mine.add(f.name);
    const names = new NameReplacer(playerId, into.mine);

    // Each table's and tournament's own others, and its practice bots' owners.
    const snapOf = new Map(snaps.map((s) => [s.tableId, s.state]));
    const linesOf = groupBy(lines, (l) => l.tableId);
    const lobbyOf = groupBy(lobby, (l) => l.tournamentId);
    const tablePlace = (tableId: string, state: unknown = snapOf.get(tableId)): Place => ({
      there: tablesThere.has(tableId) || holdsId(state, playerId),
      keep: othersIn(playerId, state, ...(linesOf.get(tableId) ?? []).map((l) => l.item)),
      botOwner: botOwners(state),
    });
    const tournamentPlace = (id: string, state: unknown): Place => ({
      there: tournamentsThere.has(id) || holdsId(state, playerId),
      keep: othersIn(playerId, state, ...(lobbyOf.get(id) ?? []).map((l) => l.item)),
    });

    // Anything held in memory would be saved over the change: refused rather than raced.
    if (opts.inMemory) {
      const held = opts.inMemory({
        table: (state) => isObj(state) && names.table(structuredClone(state), tablePlace(String(state.id), state)).names > 0,
        tournament: (state) => isObj(state) && names.tournament(structuredClone(state)).names > 0,
      });
      if (held === 'busy') throw new ReplaceNameError('busy', 'A table is being put away right now. Try again in a minute.');
      if (held.tables || held.tournaments) {
        throw new ReplaceNameError(
          'in-memory',
          `That player is in ${count(held.tables, 'table')} and ${count(held.tournaments, 'tournament')} the server has open right now, whose next save would put the name back. ` +
            'Try again once they are put away: a cash table nobody has open goes within the hour, a tournament within two hours of ending.',
        );
      }
    }

    const rows: Record<Where, number> = { players: 0, table_snapshots: 0, table_log: 0, tournaments: 0, tournament_log: 0, shared_hands: 0, feedback: 0 };
    let replaced = 0;
    let chatMentions = 0;
    const writes: (() => Promise<unknown>)[] = [];
    const tallied = (where: Where, t: Tally, write: () => Promise<unknown>) => {
      chatMentions += t.mentions;
      if (!t.names) return;
      rows[where]++;
      replaced += t.names;
      writes.push(write);
    };
    // A message in a snapshot's chat is also a saved chat line, unless it is from before every line was kept.
    const savedChat = new Set(lines.filter((l) => l.kind === 'chat' && isObj(l.item)).map((l) => chatKey({ ...(l.item as Obj), at: l.at.getTime() })));

    if (player.displayName) {
      rows.players++;
      replaced++;
      writes.push(() => tx.update(players).set({ displayName: '' }).where(eq(players.id, playerId)));
    }
    let sharedNames = 0;
    const placeOf = new Map<string, Place>();
    for (const id of tablesThere) {
      const place = tablePlace(id);
      placeOf.set(id, place);
      if (names.shared(place)) sharedNames++;
    }
    for (const s of snaps) {
      const state = s.state as Obj;
      const t = names.table(state, placeOf.get(s.tableId)!);
      // Only chat no saved line has, so a message isn't counted twice.
      const keep = placeOf.get(s.tableId)!.keep;
      t.mentions += list(state.chat).filter((m) => isObj(m) && !savedChat.has(chatKey(m)) && typeof m.playerId === 'string' && m.playerId !== playerId && names.mentions(m.text, keep)).length;
      tallied('table_snapshots', t, () => tx.update(tableSnapshots).set({ state }).where(eq(tableSnapshots.tableId, s.tableId)));
    }
    for (const l of lines) {
      const t = names.tableLine(l.kind, l.item, placeOf.get(l.tableId)!);
      tallied('table_log', t, () => tx.update(tableLog).set({ item: l.item }).where(eq(tableLog.n, l.n)));
    }
    const tPlaceOf = new Map<string, Place>();
    const stateOf = new Map(events.map((e) => [e.id, e.state]));
    for (const id of tournamentsThere) {
      const place = tournamentPlace(id, stateOf.get(id));
      tPlaceOf.set(id, place);
      if (names.shared(place)) sharedNames++;
    }
    for (const e of events) tallied('tournaments', names.tournament(e.state), () => tx.update(tournaments).set({ state: e.state }).where(eq(tournaments.id, e.id)));
    for (const l of lobby) tallied('tournament_log', names.lobbyItem(l.item, tPlaceOf.get(l.tournamentId)!), () => tx.update(tournamentLog).set({ item: l.item }).where(eq(tournamentLog.n, l.n)));
    for (const s of shared) {
      const place = placeOf.get(s.tableId) ?? { there: holdsId(s.snapshot, playerId), keep: new Set<string>() };
      tallied('shared_hands', names.sharedHand(s.snapshot, s.createdBy, place), () => tx.update(sharedHands).set({ snapshot: s.snapshot }).where(eq(sharedHands.id, s.id)));
    }
    for (const f of sent) if (f.name && f.name !== DELETED_NAME) tallied('feedback', { names: 1, mentions: 0 }, () => tx.update(feedback).set({ name: DELETED_NAME }).where(eq(feedback.id, f.id)));

    if (!dryRun) for (const write of writes) await write();
    return {
      report: { dryRun, names: names.names.length, namesNotSearched: names.names.length - names.words.length, rows, replaced, sharedNames, chatMentions },
      lobbies: [...tournamentsThere].map((id) => ({ id, change: (item: unknown) => void names.lobbyItem(item, tPlaceOf.get(id)!) })),
    };
  });
}

const count = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`;

/** A chat message as both a snapshot and a saved line have it. */
const chatKey = (m: unknown) => (isObj(m) ? JSON.stringify([m.at ?? null, m.playerId ?? null, m.text ?? null]) : '');

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const group = out.get(k);
    if (group) group.push(item);
    else out.set(k, [item]);
  }
  return out;
}

/**
 * Tables and tournaments are read from the database and taken into memory a few steps later. A change committed in
 * between would be undone by the first save of the copy read before it, so a load marks the gate before it reads and,
 * just before taking its copy in, reads again when a change has run (or is running) since.
 */
export class LoadGate {
  private done = 0;
  private running: Promise<void> | null = null;

  /** Taken by a load before it reads the database. */
  mark(): number {
    return this.done;
  }

  /** Whether a load marked at `mark` may hold what a change has replaced since. */
  stale(mark: number): boolean {
    return this.running !== null || mark !== this.done;
  }

  /** Resolves once no change is running. */
  async settled(): Promise<void> {
    while (this.running) await this.running;
  }

  get busy(): boolean {
    return this.running !== null;
  }

  /** Runs one change at a time; loads that read before it ends read again. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running) throw new ReplaceNameError('busy', 'Another name is being replaced. Try again in a minute.');
    let end!: () => void;
    this.running = new Promise<void>((resolve) => (end = resolve));
    try {
      return await fn();
    } finally {
      this.done++;
      this.running = null;
      end();
    }
  }
}

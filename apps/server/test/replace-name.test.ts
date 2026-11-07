// Replacing a deleted player's name with "Deleted player" in old records (#233, src/replaceName.ts, the admin route
// and .github/workflows/replace-name.yml). The name goes from everywhere past play keeps it; hands, amounts, ids, the
// public record, the leaderboard and the profit graph stay exactly as they were, and the record's own checkers still
// pass on the data.

import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { asc, eq, getTableName, is, sql } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { subjectRef, tableRef, type AuditEntry } from '@rsdp/engine';
import { variants } from '@rsdp/engine/core';
import '@rsdp/engine/modifiers';
import { BETTING_KINDS, listModifierSchemas } from '@rsdp/engine/settings';
import { gameTitle, registerAllVariants, VARIANT_LIST } from '@rsdp/engine/variants';
import { BOT_LEVELS, type TableView } from '@rsdp/engine/wire';
import { defaultSettings } from '@rsdp/tournament';
import { createApp, type TableStore } from '../src/app';
import { AuditLog, dbAuditStore } from '../src/audit';
import { closeDb, leaderboard, leaderData, profitSessions, queryRows, schema, type Db } from '../src/db';
import { createTestDb } from '../src/db/testing';
import { dbFeedback } from '../src/feedback';
import { DELETED_NAME, LoadGate, NameReplacer, replaceInText, SERVER_WORDS, type ReplaceReport } from '../src/replaceName';
import { dbSharedHands } from '../src/shared';
import { dbIdentity, dbStore, type SavedHeader } from '../src/storage';
import { dbLobbyStore } from '../src/tournament/lobby';
import type { TournamentStore } from '../src/tournament/manager';
import { dbTournamentStore } from '../src/tournament/store';
import { socketClient, type Client } from './socket-client';

beforeAll(() => registerAllVariants(variants));

// Loaded by Node itself: it's large, and only read here.
const ts = createRequire(import.meta.url)('typescript') as typeof import('typescript');
type Node = import('typescript').Node;
type SourceFile = import('typescript').SourceFile;

const run = promisify(execFile);
const root = path.resolve(__dirname, '../../..');
const node = (script: string, ...args: string[]) =>
  run(process.execPath, [path.join(root, script), ...args]).then(
    (r) => ({ code: 0, out: r.stdout + r.stderr }),
    (e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, out: e.stdout + e.stderr }),
  );

describe('finding a name in a line of text', () => {
  it('replaces whole words only, and leaves longer names that hold it', () => {
    expect(replaceInText('Al asked for seat 2', ['Al'])).toEqual({ text: 'Deleted player asked for seat 2', count: 1 });
    expect(replaceInText("Also Alan and Al's bot, then Al.", ['Al'])).toEqual({ text: "Also Alan and Deleted player's bot, then Deleted player.", count: 2 });
    expect(replaceInText('Big Al made Al a co-host', ['Al'], ['Big Al']).text).toBe('Big Al made Deleted player a co-host');
    // Longer names first, so a nickname inside a full name doesn't split it.
    expect(replaceInText('Al B is now Al', ['Al', 'Al B']).text).toBe('Deleted player is now Deleted player');
    expect(replaceInText('al_b and al', ['al']).text).toBe('al_b and Deleted player');
    expect(replaceInText('Zoë 🎲 left', ['Zoë 🎲']).text).toBe('Deleted player left');
    expect(replaceInText('nobody here', ['Al'])).toEqual({ text: 'nobody here', count: 0 });
  });

  it('never looks for placeholder names, and goes by ids where there are some', () => {
    const r = new NameReplacer('p1', ['Guest', 'Dealer', 'A player', 'Pat', '']);
    expect(r.words).toEqual(['Pat']);
    const state = {
      id: 't1',
      seats: [{ playerId: 'p1', name: 'Pat' }, { playerId: 'p2', name: 'Pat' }, null],
      ledger: { p1: { playerId: 'p1', name: 'Pat', buyIn: 100, cashOut: 0 }, b1: { playerId: 'b1', name: 'Robo', buyIn: 100, cashOut: 0, bot: true, owner: 'Pat' } },
      handNames: { p1: 'Pat', p2: 'Pat' },
      bots: { b1: { ownerId: 'p2', ownerName: 'Pat', buyIn: 100 } },
      chat: [
        { at: 1, playerId: 'p1', name: 'Pat', text: 'hi' },
        { at: 2, playerId: null, name: 'Dealer', text: 'Pat turned on run it twice' },
      ],
      log: [{ at: 1, text: 'Pat asked for seat 1' }],
    };
    const there = r.table(state, { there: true, keep: new Set(['Pat']) });
    // Seat, ledger row, hand name, own chat name, a log line and a dealer line; the other Pat and their bot stay.
    expect(there.names).toBe(6);
    expect(state.seats[1]).toEqual({ playerId: 'p2', name: 'Pat' });
    expect(state.handNames.p2).toBe('Pat');
    expect(state.ledger.b1.owner).toBe('Pat');
    expect(state.bots.b1.ownerName).toBe('Pat');
    expect(state.chat[0]).toEqual({ at: 1, playerId: 'p1', name: DELETED_NAME, text: 'hi' });
    expect(r.shared({ there: true, keep: new Set(['Pat']) })).toBe(true);
    // Somewhere the player never was, only what carries their id changes.
    const elsewhere = { id: 't2', seats: [{ playerId: 'p3', name: 'Pat' }], ledger: {}, chat: [], log: [{ at: 1, text: 'Pat sat down' }] };
    expect(r.table(elsewhere, { there: false, keep: new Set() }).names).toBe(0);
    expect(elsewhere.log[0].text).toBe('Pat sat down');
  });

  it('never looks in a line of text for a name that could be an amount or the server’s own words', () => {
    // Lines the server writes, with amounts and fixed wording, at a table the player was at.
    const lines = [
      'Bob sat down in seat 3 with 100',
      'Bob left the table with 2,000',
      'Blinds are now 5/10',
      'Ann made Bob a co-host',
      'Game paused',
      'Hand #4 had already ended when the server stopped, so it was closed with its saved result',
      'Seat 2 is free: Bob is next on the waitlist',
      'The host started the game',
      'Nit game: 3 players are in. The last one to win a pot pays 10 to each of the others.',
      "Couldn't deal: No-Limit Hold'em deals at most 10 players",
      'Deleted player left the table with 20',
    ];
    const place = { there: true, keep: new Set(['Ann', 'Bob']) };
    for (const name of ['100', '2', '5', '2,000', '#4', 'a', 'Z', '🎲', 'Game', 'game', 'Hand', 'Seat', 'Seat 2', 'Blinds', 'Nit', 'The', 'host', 'The host', 'Nit game', 'co-host', 'OK', 'player', 'Deleted']) {
      const r = new NameReplacer('p1', [name]);
      expect(r.names, name).toEqual([name]);
      expect(r.words, name).toEqual([]);
      const state = {
        id: 't1',
        seats: [{ playerId: 'p1', name }],
        ledger: { p1: { playerId: 'p1', name, buyIn: 2000, cashOut: 0 } },
        chat: [{ at: 1, playerId: null, name: 'Dealer', text: 'Game paused' }],
        log: lines.map((text, at) => ({ at, text })),
      };
      // Beside the id it still goes: the seat and the ledger row.
      expect(r.table(state, place).names, name).toBe(2);
      expect(state.seats[0].name).toBe(DELETED_NAME);
      expect(state.ledger.p1).toEqual({ playerId: 'p1', name: DELETED_NAME, buyIn: 2000, cashOut: 0 });
      expect(state.log.map((l) => l.text)).toEqual(lines);
      expect(state.chat[0].text).toBe('Game paused');
      for (const text of lines) expect(r.tableLine('log', { at: 1, text }, place).names, `${name}: ${text}`).toBe(0);
    }
    // Names are still looked for, even short ones and ones with a word the server uses.
    expect(new NameReplacer('p1', ['Al', 'Zoë', 'Big Game', 'Seat 2 Sam', '李雷']).words).toEqual(['Al', 'Zoë', 'Big Game', 'Seat 2 Sam', '李雷']);
    // A "Deleted player" already in a line is never taken apart.
    expect(replaceInText('Deleted player made Bob a co-host', ['Deleted', 'player'])).toEqual({ text: 'Deleted player made Bob a co-host', count: 0 });
  });

  it('replaces a lobby event’s names only where the player was', () => {
    const r = new NameReplacer('p1', ['Pat']);
    const item = { kind: 'event', event: { type: 'eliminated', name: 'Pat', place: 3, by: ['Sam', 'Pat'], reason: 'busted' } };
    expect(r.lobbyItem(item, { there: true, keep: new Set() }).names).toBe(2);
    expect(item.event).toEqual({ type: 'eliminated', name: DELETED_NAME, place: 3, by: ['Sam', DELETED_NAME], reason: 'busted' });
    const other = { kind: 'event', event: { type: 'registered', name: 'Pat' } };
    expect(r.lobbyItem(other, { there: false, keep: new Set() }).names).toBe(0);
    // Someone else's message that names them is counted, not changed.
    const said = { kind: 'chat', playerId: 'p2', name: 'Sam', text: 'gl Pat' };
    expect(r.lobbyItem(said, { there: true, keep: new Set() })).toEqual({ names: 0, mentions: 1 });
    expect(said.text).toBe('gl Pat');
    // Naming someone else whose name holds theirs isn't a mention.
    const cheer = { kind: 'chat', playerId: 'p2', name: 'Sam', text: 'go Big Pat' };
    expect(r.lobbyItem(cheer, { there: true, keep: new Set(['Big Pat']) })).toEqual({ names: 0, mentions: 0 });
    // A lobby event holds a name whole, so even a name never looked for in text is replaced there.
    const short = new NameReplacer('p1', ['5']);
    const joined = { kind: 'event', event: { type: 'registered', name: '5', late: false, entryNo: 5 } };
    expect(short.lobbyItem(joined, { there: true, keep: new Set() }).names).toBe(1);
    expect(joined.event).toEqual({ type: 'registered', name: DELETED_NAME, late: false, entryNo: 5 });
  });

  it('replaces a Dealer’s choice chooser’s name only where the player was', () => {
    const r = new NameReplacer('p1', ['Pat', '5']);
    const pick = (by: string | null, seat: number | null) => ({ gameId: 'razz', betting: 'fixed-limit', by, seat, how: by ? 'picked' : 'default' });
    const choiceOf = (current: ReturnType<typeof pick>, next: ReturnType<typeof pick> | null) => ({ chip: 1, firstButton: null, current, hands: 2, length: 3, next, deadline: null, clockFor: null, botAt: null });
    // The top bar's "Pat's pick" and the next game's chooser: names kept beside a seat, with no id.
    const state = { id: 't1', seats: [{ playerId: 'p1', name: 'Pat' }, { playerId: 'p2', name: 'Sam' }], ledger: {}, choice: choiceOf(pick('Pat', 0), pick('Sam', 1)) };
    expect(r.table(state, { there: true, keep: new Set(['Sam']) }).names).toBe(2);
    expect(state.choice.current).toEqual(pick(DELETED_NAME, 0));
    expect(state.choice.current.how).toBe('picked');
    expect(state.choice.next).toEqual(pick('Sam', 1));
    // A pick the player made for the next game, after leaving their seat; a name made of digits goes too, whole.
    const left = { id: 't2', seats: [null, { playerId: 'p2', name: 'Sam' }], ledger: { p1: { playerId: 'p1', name: '5', buyIn: 100, cashOut: 100 } }, choice: choiceOf(pick(null, null), pick('5', 0)) };
    expect(r.table(left, { there: true, keep: new Set(['Sam']) }).names).toBe(2);
    expect(left.choice.next).toEqual(pick(DELETED_NAME, 0));
    expect(left.choice.current).toEqual(pick(null, null));
    // At a table the player was never at, someone else's pick under the same name stays.
    const elsewhere = { id: 't3', seats: [{ playerId: 'p3', name: 'Pat' }], ledger: {}, choice: choiceOf(pick('Pat', 0), null) };
    expect(r.table(elsewhere, { there: false, keep: new Set() }).names).toBe(0);
    expect(elsewhere.choice.current.by).toBe('Pat');
    // Where they were: another Pat sitting in the chooser's seat made the pick, and a practice bot's pick is never theirs.
    const botPick = { ...pick('Pat', 2), how: 'bot' };
    const shared = { id: 't4', seats: [null, { playerId: 'p3', name: 'Pat' }, { playerId: 'b1', name: 'Pat 2' }], ledger: { p1: { playerId: 'p1', name: 'Pat', buyIn: 100, cashOut: 0 } }, choice: choiceOf(pick('Pat', 1), botPick) };
    expect(r.table(shared, { there: true, keep: new Set(['Pat', 'Pat 2']) }).names).toBe(1);
    expect(shared.choice.current).toEqual(pick('Pat', 1));
    expect(shared.choice.next).toEqual(botPick);
    // Picks saved since 2026.11.07.4 keep the chooser's id, which decides wherever anyone sits now: the player's own
    // pick goes though another Pat has their seat, and the other Pat's stays though the player now sits in theirs.
    const byId = (by: string, seat: number, id: string) => ({ ...pick(by, seat), byId: id });
    const moved = { id: 't5', seats: [{ playerId: 'p1', name: 'Pat' }, { playerId: 'p3', name: 'Pat' }], ledger: {}, choice: choiceOf(byId('Pat', 1, 'p1'), byId('Pat', 0, 'p3')) };
    expect(r.table(moved, { there: true, keep: new Set(['Pat']) }).names).toBe(2);
    expect(moved.choice.current).toEqual(byId(DELETED_NAME, 1, 'p1'));
    expect(moved.choice.next).toEqual(byId('Pat', 0, 'p3'));
    // A second run finds nothing left.
    expect(r.table(moved, { there: true, keep: new Set(['Pat']) }).names).toBe(0);
  });
});

describe('the server’s own words', () => {
  // The words of every line the server writes in a table's log and the dealer's chat, read from the code, with
  // what goes into those lines: game names, bot levels, side games and why a hand couldn't be dealt. A name made
  // only of these is never looked for in a line of text (replaceName.ts, SERVER_WORDS).
  const words = new Set<string>();
  const add = (text: string) => {
    for (const w of text.match(/[\p{L}\p{N}\p{M}_]+/gu) ?? []) if (/\p{L}/u.test(w)) words.add(w.toLowerCase());
  };
  const strings = (node: Node) => {
    // Settings paths ("spectators.delaySeconds") are compared, never shown.
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && !/^[\w-]+(\.[\w-]+)+$/.test(node.text)) add(node.text);
    else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) add(node.text);
    ts.forEachChild(node, strings);
  };
  const source = (file: string) => ts.createSourceFile(file, readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.Latest, true);
  const inside = (file: SourceFile, match: (n: Node) => boolean) => {
    const visit = (n: Node): void => (match(n) ? strings(n) : ts.forEachChild(n, visit));
    visit(file);
  };
  const thisCall = (names: string[]) => (n: Node) =>
    ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.expression.kind === ts.SyntaxKind.ThisKeyword && names.includes(n.expression.name.text);
  /** `this.host.log(...)`: Dealer's choice writes its lines in the table's log through its host (choice.ts). */
  const hostCall = (names: string[]) => (n: Node) =>
    ts.isCallExpression(n) &&
    ts.isPropertyAccessExpression(n.expression) &&
    names.includes(n.expression.name.text) &&
    ts.isPropertyAccessExpression(n.expression.expression) &&
    n.expression.expression.name.text === 'host' &&
    n.expression.expression.expression.kind === ts.SyntaxKind.ThisKeyword;

  it('include every word of the table log and the dealer’s lines', () => {
    inside(source('apps/server/src/runtime/table.ts'), thisCall(['log', 'dealerSays', 'nitPays']));
    inside(source('apps/server/src/runtime/choice.ts'), hostCall(['log']));
    source('packages/engine/src/settings/notices.ts').statements.filter((st) => !ts.isImportDeclaration(st)).forEach(strings);
    inside(source('packages/engine/src/core/hand.ts'), (n) => ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'ActionError');
    for (const v of VARIANT_LIST) for (const b of BETTING_KINDS) add(gameTitle(v.id, b));
    for (const level of BOT_LEVELS) add(level);
    for (const m of listModifierSchemas()) add(m.id);
    expect(words.size).toBeGreaterThan(150);
    // A new word in a log line needs adding to SERVER_WORDS, or a player of that name would rewrite the line.
    expect([...words].filter((w) => !SERVER_WORDS.has(w)).sort()).toEqual([]);
  });
});

describe('the load gate', () => {
  it('tells a load that read before or during a change to read again', async () => {
    const gate = new LoadGate();
    const before = gate.mark();
    expect(gate.stale(before)).toBe(false);
    let finish!: () => void;
    const change = gate.run(() => new Promise<void>((resolve) => (finish = resolve)));
    const during = gate.mark();
    expect(gate.stale(before)).toBe(true);
    expect(gate.stale(during)).toBe(true);
    await expect(gate.run(async () => {})).rejects.toThrow(/Another name/);
    const settled = gate.settled();
    finish();
    await change;
    await settled;
    expect(gate.stale(during)).toBe(true);
    expect(gate.stale(gate.mark())).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------- a real server

const KEY = 'replace-name-admin-key-0123';
const HANA = 'rn-hana-secret-000000000';
const ZEKE = 'rn-zeke-secret-000000000';
const BIG = 'rn-bigz-secret-000000000';
const GUS = 'rn-gus0-secret-000000000';
const PASSWORD = 'correct horse battery';

let db: Db | undefined;
let server: ReturnType<typeof createApp> | undefined;
let url = '';
const clients: Client[] = [];
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
type C = ReturnType<typeof socketClient>;

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await server?.close();
  if (db) await closeDb(db);
  server = db = undefined;
});

async function start(d: Db, store: TableStore = dbStore(d), tournaments: TournamentStore = dbTournamentStore(d)) {
  const audit = await AuditLog.open(dbAuditStore(d), { log: () => {} });
  server = createApp({
    identity: dbIdentity(d),
    store,
    tournaments,
    lobby: dbLobbyStore(d),
    shared: dbSharedHands(d),
    feedback: dbFeedback(d),
    accounts: d,
    audit,
    adminKey: KEY,
    log: () => {},
  });
  await new Promise<void>((resolve) => server!.http.listen(0, resolve));
  url = `http://localhost:${(server!.http.address() as AddressInfo).port}`;
}

async function restart(d: Db, store?: TableStore, tournaments?: TournamentStore) {
  for (const c of clients.splice(0)) c.close();
  await server!.close();
  await start(d, store, tournaments);
}

const client = (token: string) => socketClient(url, token, clients);
const post = (p: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${url}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const replaceName = (playerId: string, body: unknown = {}, key = KEY) => post(`/api/admin/players/${playerId}/replace-name`, body, { 'x-admin-key': key });
const adminEntries = async () => ((await (await fetch(`${url}/api/audit/entries?after=0&kind=admin`)).json()) as { entries: AuditEntry[] }).entries.map((e) => e.data);

/** Everyone folds to the big blind. */
async function foldAround(cs: C[], handNumber: number) {
  for (let i = 0; i < 20; i++) {
    const turn = await Promise.race(cs.map((c) => c.until((v) => v.hand?.handNumber === handNumber && (v.hand.phase === 'complete' || !!v.legal)).then((v) => ({ c, v }))));
    if (turn.v.hand!.phase === 'complete') return;
    await turn.c.call('hand:act', { type: 'fold' });
    await turn.c.until((v) => v !== turn.v);
  }
  throw new Error(`hand ${handNumber} didn't end`);
}

const TABLES = Object.values(schema)
  .filter((t) => is(t, PgTable))
  .map((t) => getTableName(t as PgTable));

/** Every row of every table, as JSON text, in a fixed order. */
async function dump(d: Db): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const t of TABLES) out[t] = (await queryRows<{ j: string }>(d, sql.raw(`select row_to_json(x)::text as j from ${t} x order by 1`))).map((r) => r.j);
  return out;
}

/** A dump with every string that holds one of the names (or "Deleted player") made the same, so only names can differ. */
const namesBlanked = (rows: Record<string, string[]>, names: RegExp) =>
  Object.fromEntries(
    Object.entries(rows).map(([t, list]) => [
      t,
      list.map((j) => JSON.stringify(JSON.parse(j), (_k, v: unknown) => (typeof v === 'string' && (names.test(v.replaceAll('Big Zeke', '')) || v.includes(DELETED_NAME)) ? '<a name>' : v))),
    ]),
  );

describe('replacing a deleted player’s name', () => {
  it('takes it out of everything past play keeps, and changes nothing else', { timeout: 60_000 }, async () => {
    db = await createTestDb();
    await start(db);
    const hana = client(HANA);
    const zeke = client(ZEKE);
    const big = client(BIG);
    const gus = client(GUS);
    const everyone = [hana, zeke, big, gus];
    for (const [c, name] of [[hana, 'Hana'], [zeke, 'Zeke'], [big, 'Big Zeke'], [gus, 'Gus']] as const) await c.call('session:name', { name });
    const signedUp = (await (await post('/api/account/signup', { username: 'zeke', password: PASSWORD }, { 'x-guest-token': ZEKE })).json()) as { session: string };

    // A cash game: two hands, chat, a shared hand, feedback, and Zeke cashing out.
    const { tableId } = await hana.call<{ tableId: string }>('table:create', {
      settings: { table: { name: 'Friday' }, seating: { requireApproval: false }, timing: { autoStartNextHand: false } },
    });
    for (const c of everyone) await c.call('table:join', { tableId });
    for (const [i, [c, name]] of ([[hana, 'Hana'], [zeke, 'Zeke'], [big, 'Big Zeke'], [gus, 'Gus']] as const).entries()) await c.call('seat:request', { seat: i, name, stack: 2000 });
    await hana.until((v) => v.seats.filter(Boolean).length === 4);
    await hana.call('host:start');
    await foldAround(everyone, 1);
    await hana.call('host:deal');
    await foldAround(everyone, 2);
    await zeke.call('chat:send', { text: 'gg all' });
    await big.call('chat:send', { text: 'well played Zeke' });
    await big.call('hand:share', { handNumber: 1 });
    await gus.call('feedback:send', { kind: 'idea', text: 'more tables please', screen: 'desktop' });
    const zekeId = zeke.view().me.playerId;
    const bigId = big.view().me.playerId;
    const gusId = gus.view().me.playerId;
    zeke.socket.emit('seat:stand', {});
    await hana.until((v) => !v.seats.some((s) => s?.playerId === zekeId));

    // A tournament Zeke entered under another name, which ends before it starts.
    await zeke.call('session:name', { name: 'Zekey' });
    const { id: tournamentId } = await hana.call<{ id: string }>('tournament:create', { settings: defaultSettings({ name: 'Cup', startingStack: 1000 }) });
    for (const c of [zeke, big]) {
      await c.call('tournament:subscribe', { id: tournamentId });
      await c.call('tournament:command', { id: tournamentId, command: { type: 'register' } });
    }
    await zeke.call('tournament:chat', { id: tournamentId, text: 'see you all there' });
    await big.call('tournament:chat', { id: tournamentId, text: 'good luck Zekey' });
    await pause(900);

    // Refused: without the key, for an account that still exists, and for nobody at all.
    expect((await replaceName(zekeId, {}, 'not-the-admin-key-000')).status).toBe(401);
    const live = await replaceName(zekeId);
    expect(live.status).toBe(409);
    expect(((await live.json()) as { code: string }).code).toBe('account');
    expect((await replaceName('no-such-player-000')).status).toBe(404);

    // Zeke deletes the account: the name stays in the hands, ledger, logs and tournament.
    const gone = await post('/api/account/delete', { password: PASSWORD }, { 'x-guest-token': ZEKE, 'x-session-token': signedUp.session });
    expect(gone.status).toBe(200);
    // Still refused while the table and the tournament are held in memory: their next save would put the name back.
    await hana.call('tournament:command', { id: tournamentId, command: { type: 'end' } });
    const held = await replaceName(zekeId);
    expect(held.status).toBe(409);
    const heldBody = (await held.json()) as { code: string; error: string };
    expect(heldBody.code).toBe('in-memory');
    expect(heldBody.error).toMatch(/1 table and 1 tournament/);
    expect(heldBody.error).not.toMatch(/Zeke/);

    // A restart puts the table away, and the ended tournament isn't taken back into memory.
    await restart(db);
    const mirror = mkdtempSync(path.join(tmpdir(), 'rsdp-copy-'));
    expect((await node('scripts/transparency/mirror.mjs', url, mirror)).code).toBe(0);
    const before = await dump(db);
    const boardBefore = await leaderboard(db, await leaderData(db));
    const graphsBefore = await Promise.all([zekeId, bigId, gusId].map((id) => profitSessions(db!, [id])));
    expect(before.table_snapshots.join()).toMatch(/Zeke/);
    expect(before.tournament_log.join()).toMatch(/Zekey/);

    // The dry run says what would change and changes nothing.
    const dry = await replaceName(zekeId);
    expect(dry.status).toBe(200);
    const preview = (await dry.json()) as ReplaceReport;
    expect(preview).toMatchObject({ dryRun: true, names: 2, namesNotSearched: 0, sharedNames: 0, chatMentions: 2 });
    expect(preview.rows).toMatchObject({ players: 0, table_snapshots: 1, tournaments: 1, shared_hands: 1, feedback: 0 });
    expect(preview.rows.table_log).toBeGreaterThanOrEqual(3);
    expect(preview.rows.tournament_log).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(preview)).not.toMatch(/Zeke/);
    expect(await dump(db)).toEqual(before);
    expect(await adminEntries()).toEqual([]);

    // The change itself: the same counts, and one entry in the public record, naming the player only by a fingerprint.
    const done = (await (await replaceName(zekeId, { dryRun: false })).json()) as ReplaceReport;
    expect(done).toEqual({ ...preview, dryRun: false });
    expect(await adminEntries()).toEqual([{ action: 'replace-name', target: subjectRef('player', zekeId) }]);

    // The name is gone from every table: what's left is Big Zeke's own name and the words Big Zeke typed.
    const after = await dump(db);
    const left = Object.values(after).flat().join('\n').replaceAll('Big Zeke', '').replaceAll('well played Zeke', '').replaceAll('good luck Zekey', '');
    expect(left).not.toMatch(/\bZekey?\b/);
    // Nothing but names changed: hands, the ledger's amounts, ids, cards and times are as they were.
    const { audit_log: auditBefore, ops_log: _opsBefore, ...restBefore } = before;
    const { audit_log: auditAfter, ops_log: _opsAfter, ...restAfter } = after;
    expect(after.hands).toEqual(before.hands);
    expect(namesBlanked(restAfter, /\bZekey?\b/)).toEqual(namesBlanked(restBefore, /\bZekey?\b/));
    expect(auditAfter).toEqual(expect.arrayContaining(auditBefore));
    expect(auditAfter).toHaveLength(auditBefore.length + 1);
    // The leaderboard and everyone's profit graph give the same numbers; only Zeke's name on the board changed.
    const boardAfter = await leaderboard(db, await leaderData(db));
    expect(boardAfter.map(({ name: _n, ...r }) => r)).toEqual(boardBefore.map(({ name: _n, ...r }) => r));
    expect(boardBefore.map((r) => r.name).sort()).toEqual(['Big Zeke', 'Gus', 'Hana', 'Zeke']);
    expect(boardAfter.map((r) => r.name).sort()).toEqual(['Big Zeke', DELETED_NAME, 'Gus', 'Hana']);
    expect(await Promise.all([zekeId, bigId, gusId].map((id) => profitSessions(db!, [id])))).toEqual(graphsBefore);

    // The public record's own checkers still pass, on the record and on a hand rebuilt from the saved data.
    const [row] = await db.select().from(schema.hands).where(eq(schema.hands.tableId, tableId)).orderBy(asc(schema.hands.number)).limit(1);
    const header = row.header as SavedHeader;
    const fair = header.input.fair!;
    const proof = {
      commit: fair.commit,
      serverSeed: fair.serverSeed,
      clientSeeds: fair.clientSeeds.map((c) => c.seed),
      handSeed: fair.handSeed,
      button: header.input.button,
      seats: header.seats.map((s) => s.seat),
      events: row.events,
      record: { handId: header.input.handId, table: tableRef(tableId), handNumber: row.number, seats: header.seats.map((s) => ({ seat: s.seat, playerId: s.playerId, stack: s.startStack })) },
    };
    const proofFile = path.join(mirror, 'hand-1-proof.json');
    writeFileSync(proofFile, JSON.stringify(proof));
    const hand = await node('scripts/verify-hand.mjs', proofFile);
    expect(hand.out).toContain('This hand checks out.');
    expect(hand.code).toBe(0);
    const record = await node('scripts/verify-audit.mjs', '--site', url, '--copy', mirror, '--proof', proofFile);
    expect(record.out).toMatch(/every entry GitHub copied is still on the site, unchanged/);
    expect(record.out).toMatch(/hand 1 is in the record as entry \d+, exactly as in this file/);
    expect(record.code).toBe(0);

    // The table opened again shows "Deleted player" in its ledger, log and chat; Big Zeke keeps his name.
    const back = client(HANA);
    await back.call('table:join', { tableId });
    const view = await back.until((v: TableView) => v.ledger.length === 4);
    expect(view.ledger.map((r) => r.name).sort()).toEqual(['Big Zeke', DELETED_NAME, 'Gus', 'Hana']);
    expect(view.log.some((l) => /^Deleted player left the table/.test(l.text))).toBe(true);
    expect(view.chat.map((c) => `${c.name}: ${c.text}`)).toEqual([`${DELETED_NAME}: gg all`, 'Big Zeke: well played Zeke']);
    expect(view.log.some((l) => /\bZeke\b/.test(l.text.replaceAll('Big Zeke', '')))).toBe(false);
    expect(view.log.some((l) => /^Big Zeke sat down/.test(l.text))).toBe(true);

    // Nothing is left to change, so running it again changes nothing.
    const again = (await (await replaceName(zekeId, { dryRun: false })).json()) as ReplaceReport;
    expect(again.replaced).toBe(0);

    // A guest who never had an account: their feedback and their name on file go too.
    for (const c of clients.splice(0)) c.close();
    await restart(db);
    const guest = (await (await replaceName(gusId, { dryRun: false })).json()) as ReplaceReport;
    expect(guest.rows).toMatchObject({ players: 1, feedback: 1, table_snapshots: 1 });
    const [gus2] = await db.select().from(schema.players).where(eq(schema.players.id, gusId));
    expect(gus2.displayName).toBe('');
    const sent = await db.select().from(schema.feedback).where(eq(schema.feedback.playerId, gusId));
    expect(sent.map((f) => [f.name, f.text])).toEqual([[DELETED_NAME, 'more tables please']]);
    expect((await dump(db)).table_snapshots.join()).not.toMatch(/\bGus\b/);
  });

  it('makes a table read before the change, and taken in after it, read again', { timeout: 30_000 }, async () => {
    db = await createTestDb();
    let hold: Promise<void> | null = null;
    let reached!: () => void;
    const inner = dbStore(db);
    // The first load of the table reads, then waits, as a slow load would.
    const store: TableStore = {
      ...inner,
      async loadTable(id) {
        const state = await inner.loadTable(id);
        const wait = hold;
        hold = null;
        if (wait) {
          reached();
          await wait;
        }
        return state;
      },
    };
    await start(db);
    const hana = client(HANA);
    const pat = client(ZEKE);
    const { tableId } = await hana.call<{ tableId: string }>('table:create', { settings: { table: { name: 'Slow' }, seating: { requireApproval: false } } });
    await pat.call('table:join', { tableId });
    await pat.call('seat:request', { seat: 1, name: 'Pat', stack: 2000 });
    const patId = pat.view().me.playerId;
    await pause(700);
    await restart(db, store);

    let release!: () => void;
    hold = new Promise<void>((resolve) => (release = resolve));
    const readIt = new Promise<void>((resolve) => (reached = resolve));
    const loading = server!.getTable(tableId);
    await readIt;
    const change = (await (await replaceName(patId, { dryRun: false })).json()) as ReplaceReport;
    expect(change.rows.table_snapshots).toBe(1);
    release();
    const rt = await loading;
    expect(rt!.state.seats.find((s) => s?.playerId === patId)?.name).toBe(DELETED_NAME);
    expect(rt!.state.ledger[patId].name).toBe(DELETED_NAME);
  });

  it('makes a tournament read before the change, and taken in after it, read again', { timeout: 30_000 }, async () => {
    db = await createTestDb();
    let hold: Promise<void> | null = null;
    let reached!: () => void;
    const inner = dbTournamentStore(db);
    // The first load of the tournament reads, then waits, as a slow load would.
    const slow: TournamentStore = {
      ...inner,
      async load(id) {
        const saved = await inner.load(id);
        const wait = hold;
        hold = null;
        if (wait) {
          reached();
          await wait;
        }
        return saved;
      },
    };
    await start(db);
    const hana = client(HANA);
    const pat = client(ZEKE);
    await pat.call('session:name', { name: 'Pat' });
    const { id } = await hana.call<{ id: string }>('tournament:create', { settings: defaultSettings({ name: 'Cup', startingStack: 1000 }) });
    await pat.call('tournament:subscribe', { id });
    await pat.call('tournament:command', { id, command: { type: 'register' } });
    const patId = server!.tournaments.held().find((t) => t.id === id)!.entries[0].playerId;
    await hana.call('tournament:command', { id, command: { type: 'end' } });
    await pause(900);
    await restart(db, undefined, slow);
    expect(server!.tournaments.held()).toEqual([]);

    let release!: () => void;
    hold = new Promise<void>((resolve) => (release = resolve));
    const readIt = new Promise<void>((resolve) => (reached = resolve));
    const loading = server!.tournaments.get(id);
    await readIt;
    const change = (await (await replaceName(patId, { dryRun: false })).json()) as ReplaceReport;
    expect(change.rows.tournaments).toBe(1);
    release();
    const live = await loading;
    expect(live!.state.entries.map((e) => [e.playerId, e.displayName])).toEqual([[patId, DELETED_NAME]]);
  });

  it('waits while a tournament let go of by the cleanup is still being saved', { timeout: 30_000 }, async () => {
    db = await createTestDb();
    await start(db);
    const hana = client(HANA);
    const pat = client(ZEKE);
    await pat.call('session:name', { name: 'Pat' });
    const { id } = await hana.call<{ id: string }>('tournament:create', { settings: defaultSettings({ name: 'Cup', startingStack: 1000 }) });
    await pat.call('tournament:subscribe', { id });
    await pat.call('tournament:command', { id, command: { type: 'register' } });
    const state = server!.tournaments.held().find((t) => t.id === id)!;
    const patId = state.entries[0].playerId;
    // Cancelled before anyone was seated, and over long enough ago for the cleanup to let it go.
    await hana.call('tournament:command', { id, command: { type: 'end' } });
    await pause(900);
    const over = server!.tournaments.held().find((t) => t.id === id)!;
    over.finishedAt = 1;
    over.createdAt = 1;
    // The cleanup runs after the route has waited for earlier saves, just as the change starts.
    const transaction = db.transaction.bind(db);
    db.transaction = ((...a: Parameters<typeof transaction>) => {
      server!.tournaments.sweep();
      return transaction(...a);
    }) as typeof db.transaction;
    const res = await replaceName(patId, { dryRun: false });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'busy' });
    db.transaction = transaction as typeof db.transaction;
    await server!.tournaments.settled();
    // Run again once the save is in, the change holds.
    const change = (await (await replaceName(patId, { dryRun: false })).json()) as ReplaceReport;
    expect(change.rows.tournaments).toBe(1);
    const live = await server!.tournaments.get(id);
    expect(live!.state.entries.map((e) => [e.playerId, e.displayName])).toEqual([[patId, DELETED_NAME]]);
  });

  it('leaves amounts and the log’s own words alone when the name could be mistaken for them', { timeout: 30_000 }, async () => {
    db = await createTestDb();
    await start(db);
    const hana = client(HANA);
    const two = client(ZEKE);
    await hana.call('session:name', { name: 'Hana' });
    await two.call('session:name', { name: '2' });
    const { tableId } = await hana.call<{ tableId: string }>('table:create', { settings: { table: { name: 'Twos' }, seating: { requireApproval: false } } });
    for (const c of [hana, two]) await c.call('table:join', { tableId });
    // $2 in seat 2, played as "2".
    await two.call('seat:request', { seat: 1, name: '2', stack: 200 });
    const twoId = two.view().me.playerId;
    await hana.until((v) => v.seats.some((s) => s?.playerId === twoId));
    two.socket.emit('seat:stand', {});
    await hana.until((v) => !v.seats.some((s) => s?.playerId === twoId));
    await pause(700);
    await restart(db);
    const logOf = async () =>
      (await db!.select().from(schema.tableLog).where(eq(schema.tableLog.tableId, tableId)).orderBy(asc(schema.tableLog.n))).filter((l) => l.kind === 'log').map((l) => (l.item as { text: string }).text);
    const logBefore = await logOf();
    expect(logBefore).toEqual(expect.arrayContaining(['2 sat down in seat 2 with 2', '2 left the table with 2']));

    const done = (await (await replaceName(twoId, { dryRun: false })).json()) as ReplaceReport;
    expect(done).toMatchObject({ names: 1, namesNotSearched: 1, rows: { players: 1, table_snapshots: 1, table_log: 0 } });
    // The log keeps every line as it was, amounts and all; the ledger and the name on file go.
    expect(await logOf()).toEqual(logBefore);
    const [snap] = await db.select().from(schema.tableSnapshots).where(eq(schema.tableSnapshots.tableId, tableId));
    const state = snap.state as { ledger: Record<string, { name: string; buyIn: number }> };
    expect(state.ledger[twoId]).toMatchObject({ name: DELETED_NAME, buyIn: 200 });
  });
});

describe('the workflow that runs it', () => {
  const file = readFileSync(path.join(root, '.github/workflows/replace-name.yml'), 'utf8');

  it('only runs by hand, from main, and never takes the player id through its logged settings', () => {
    const on = file.slice(file.indexOf('\non:'), file.indexOf('\npermissions:'));
    expect(on).toMatch(/workflow_dispatch:/);
    expect(on).not.toMatch(/\b(push|pull_request|pull_request_target|schedule|workflow_run):/);
    expect(file).toMatch(/if: github\.ref == 'refs\/heads\/main'/);
    expect(file).not.toMatch(/\$\{\{\s*(github\.event\.)?inputs\.player_id/);
    expect(file).toMatch(/::add-mask::\$PLAYER_ID/);
  });

  const hasTools = ['jq', 'curl'].every((tool) => {
    try {
      return execFileSync('sh', ['-c', `command -v ${tool}`]).length > 0;
    } catch {
      return false;
    }
  });

  it.skipIf(!hasTools)('prints counts and refusals, never a name', { timeout: 30_000 }, async () => {
    // The step's script, the last thing in the file, as GitHub runs it.
    const lines = file.split('\n');
    const at = lines.findIndex((l) => l.trim() === 'run: |');
    const indent = lines[at + 1].length - lines[at + 1].trimStart().length;
    const script = lines
      .slice(at + 1)
      .map((l) => l.slice(indent))
      .join('\n');
    db = await createTestDb();
    await start(db);
    const pat = client(ZEKE);
    await pat.call('session:name', { name: 'Zeke' });
    const { tableId } = await pat.call<{ tableId: string }>('table:create', { settings: { table: { name: 'Solo' }, seating: { requireApproval: false } } });
    await pat.call('table:join', { tableId });
    await pat.call('seat:request', { seat: 0, name: 'Zeke', stack: 2000 });
    const patId = pat.view().me.playerId;
    await pause(700);
    for (const c of clients.splice(0)) c.close();
    await restart(db);
    const dir = mkdtempSync(path.join(tmpdir(), 'rsdp-replace-name-'));
    const step = async (playerId: string, dryRun: string) => {
      writeFileSync(path.join(dir, 'event.json'), JSON.stringify({ inputs: { player_id: playerId, dry_run: dryRun === 'true' } }));
      const env = { ...process.env, SITE: url, ADMIN_KEY: KEY, DRY_RUN: dryRun, GITHUB_EVENT_PATH: path.join(dir, 'event.json'), GITHUB_STEP_SUMMARY: path.join(dir, 'summary.md') };
      return run('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], { cwd: dir, env }).then(
        (r) => ({ code: 0, out: r.stdout + r.stderr }),
        (e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, out: e.stdout + e.stderr }),
      );
    };
    const dry = await step(patId, 'true');
    expect(dry.code).toBe(0);
    expect(dry.out).toMatch(/Dry run: nothing was changed/);
    expect(dry.out).toMatch(/table_snapshots: 1/);
    expect(dry.out).toMatch(/names not looked for in log lines, .*: 0$/m);
    const done = await step(patId, 'false');
    expect(done.out).toMatch(/Done: the name was replaced/);
    expect(readFileSync(path.join(dir, 'summary.md'), 'utf8')).toMatch(/Rows, by place/);
    const refused = await step('no-such-player-000', 'true');
    expect(refused.code).toBe(1);
    expect(refused.out).toMatch(/The site answered 404: No player has that id\./);
    const bad = await step('not an id; rm -rf /', 'true');
    expect(bad.code).toBe(1);
    for (const out of [dry.out, done.out, refused.out, bad.out]) expect(out).not.toMatch(/Zeke/);
  });
});

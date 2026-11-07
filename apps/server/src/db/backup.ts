/**
 * Off-site backups (docs/DEPLOY.md, "Backups"). A backup is every row of every
 * table, as gzipped JSON lines, read in one transaction so it is a single
 * moment's copy. It works the same on PGlite and Postgres, and restores into a
 * fresh database of the same or a newer schema:
 *
 *   {"backup":"rsdp","version":1,"at":"…","migrations":13,"tables":["players",…]}
 *   {"t":"players","r":{…one row, as Postgres' row_to_json writes it…}}
 *   …
 *   {"end":true,"rows":{"players":12,…}}
 *
 * The last line is how a restore knows the copy wasn't cut short.
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import type { Readable } from 'node:stream';
import { sql } from 'drizzle-orm';
import { queryRows, type Db } from './client';
import { errorText } from './errors';

export const BACKUP_FORMAT = 'rsdp';
export const BACKUP_VERSION = 1;
/** Rows read per round trip at most, so a big table never sits in memory whole. */
const PAGE = 500;
/** Rows written per insert on restore, at most. */
const INSERT_BATCH = 200;
/**
 * The most row JSON one round trip carries either way (unless one row is bigger on its own). PGlite 0.2, which the
 * live site runs, fails on a result much over 16 MB, and a page of saved tables can get that big (#403).
 */
export const PAGE_BYTES = 4 * 1_048_576;
/**
 * Rows whose place and size are read per fetch in the first pass: SIZE_FIRST to begin with, then as many as hold
 * about PAGE_BYTES of JSON going by the last fetch (working out a row's size means making its JSON, and PGlite does
 * that on the server's own thread), at most twice as many as the last fetch and never more than SIZE_FETCH. The last
 * fetch can't see bigger rows coming (small saved tables first, then busy ones), so this is what bounds how long one
 * fetch takes: at most SIZE_FETCH of the biggest rows.
 */
const SIZE_FIRST = 16;
const SIZE_FETCH = 64;

export interface BackupHeader {
  backup: typeof BACKUP_FORMAT;
  version: number;
  at: string;
  /** Migrations applied to the database the backup came from. */
  migrations: number;
  tables: string[];
}

export interface BackupSummary {
  at: string;
  migrations: number;
  rows: Record<string, number>;
}

const ident = (name: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`unexpected table name ${name}`);
  return `"${name}"`;
};

/** The app's tables (drizzle keeps its own bookkeeping in another schema). */
async function tableNames(db: Db): Promise<string[]> {
  const rows = await queryRows<{ name: string }>(db, sql`select table_name as name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`);
  return rows.map((r) => r.name);
}

/** Counter columns (bigserial and identity), with the sequence behind each. */
async function counters(db: Db) {
  return queryRows<{ t: string; c: string; seq: string }>(
    db,
    sql`select table_name as t, column_name as c, pg_get_serial_sequence(quote_ident(table_name), column_name) as seq from information_schema.columns where table_schema = 'public' and (column_default like 'nextval(%' or is_identity = 'YES') order by 1, 2`,
  );
}

async function migrationCount(db: Db): Promise<number> {
  const [row] = await queryRows<{ n: string | number }>(db, sql`select count(*) as n from drizzle.__drizzle_migrations`);
  return Number(row?.n ?? 0);
}

/**
 * Writes a backup, line by line, to `write` (which may wait, for back
 * pressure). On PGlite the transaction holds the database for as long as the
 * copy takes, so table saves wait until it is done; a few seconds at most for
 * a home game's data.
 */
export async function writeBackup(db: Db, write: (line: string) => void | Promise<void>, now = new Date(), stopped: () => boolean = () => false): Promise<BackupSummary> {
  return db.transaction(
    async (tx) => {
      const tables = await tableNames(tx);
      const header: BackupHeader = { backup: BACKUP_FORMAT, version: BACKUP_VERSION, at: now.toISOString(), migrations: await migrationCount(tx), tables };
      await write(JSON.stringify(header) + '\n');
      const rows: Record<string, number> = {};
      for (const table of tables) {
        rows[table] = 0;
        // First where each row is and how big its JSON is, read in fetches of about PAGE_BYTES of JSON with a breath
        // between them. Then the rows, a page at a time: a run of neighbouring rows whose JSON fits in PAGE_BYTES,
        // read as a ctid range. All of it inside this one snapshot, where a row's ctid can't change. Nothing sorts
        // the rows' JSON, so a big table needs no temporary files, and no one query holds the server for long.
        const found: { block: number; item: number; size: number }[] = [];
        await tx.execute(sql.raw(`declare backup_sizes no scroll cursor for select ctid::text as c, octet_length(row_to_json(t)::text) as n from ${ident(table)} t`));
        for (let fetch = SIZE_FIRST; ; ) {
          const page = await queryRows<{ c: string; n: number }>(tx, sql.raw(`fetch ${fetch} from backup_sizes`));
          let bytes = 0;
          for (const { c, n } of page) {
            found.push({ ...parseTid(c), size: Number(n) });
            bytes += Number(n);
          }
          if (page.length < fetch) break;
          // A shutdown stops a backup here too: this pass writes nothing, so `write` can't stop it.
          if (stopped()) throw new Error('the backup was stopped');
          fetch = nextSizeFetch(page.length, bytes);
          await breathe();
        }
        await tx.execute(sql.raw('close backup_sizes'));
        found.sort((a, b) => a.block - b.block || a.item - b.item);
        let at = 0;
        for (const count of pageCounts(found.map((f) => f.size))) {
          const first = found[at]!;
          const last = found[at + count - 1]!;
          const page = await queryRows<{ j: string }>(
            tx,
            sql.raw(`select row_to_json(t)::text as j from ${ident(table)} t where ctid >= '(${first.block},${first.item})'::tid and ctid <= '(${last.block},${last.item})'::tid`),
          );
          if (page.length !== count) throw new Error(`${table} changed while it was being backed up`);
          for (const { j } of page) await write(`{"t":${JSON.stringify(table)},"r":${j}}\n`);
          rows[table] += count;
          at += count;
        }
      }
      // Where each counter had got to: ids of rows deleted before the backup must not be handed out again. A counter
      // that hasn't handed out last_value yet (as a restore leaves it, or a new one) has got to the id before it.
      const sequences: Record<string, number> = {};
      for (const { t, c, seq } of await counters(tx)) {
        const [row] = await queryRows<{ n: string | number | null }>(tx, sql.raw(`select case when is_called then last_value else last_value - 1 end as n from ${seq}`));
        if (row?.n != null && Number(row.n) > 0) sequences[`${t}.${c}`] = Number(row.n);
      }
      await write(JSON.stringify({ end: true, rows, sequences }) + '\n');
      return { at: header.at, migrations: header.migrations, rows };
    },
    // Postgres: one consistent moment, and nothing written by mistake. PGlite has one connection, so it is anyway.
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

/** A row's place, from `ctid::text`: "(block,item)". */
function parseTid(text: string): { block: number; item: number } {
  const m = /^\((\d+),(\d+)\)$/.exec(text);
  if (!m) throw new Error(`unexpected ctid ${text}`);
  return { block: Number(m[1]), item: Number(m[2]) };
}

/** Lets timers and sockets run between fetches: PGlite works on the server's own thread. */
const breathe = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * The first pass's next fetch, after one of `rows` rows with `bytes` of JSON: rows enough for about PAGE_BYTES at
 * those sizes, but at most twice `rows`, and 1 to SIZE_FETCH.
 */
export function nextSizeFetch(rows: number, bytes: number): number {
  return Math.max(1, Math.min(SIZE_FETCH, 2 * rows, Math.floor((rows * PAGE_BYTES) / Math.max(1, bytes))));
}

/** How many rows each fetch takes, in order: up to PAGE rows and PAGE_BYTES of JSON, and always at least one. */
export function pageCounts(sizes: number[]): number[] {
  const counts: number[] = [];
  let rows = 0;
  let bytes = 0;
  for (const size of sizes) {
    if (rows && (rows >= PAGE || bytes + size > PAGE_BYTES)) {
      counts.push(rows);
      rows = 0;
      bytes = 0;
    }
    rows++;
    bytes += size;
  }
  if (rows) counts.push(rows);
  return counts;
}

/**
 * The lines of a gzipped backup file or stream. Reading starts on the first
 * line asked for: readline drops lines that arrive before anyone iterates.
 */
export async function* backupLines(input: string | Readable): AsyncGenerator<string> {
  const source = typeof input === 'string' ? createReadStream(input) : input;
  yield* createInterface({ input: source.pipe(createGunzip()), crlfDelay: Infinity });
}

export class BackupError extends Error {}

/** The start of a row line, as writeBackup writes it; the rest, less the closing brace, is the row. */
const ROW_LINE = /^\{"t":"([a-z_][a-z0-9_]*)","r":/;

/**
 * Loads a backup into an empty database (createDb has applied the current
 * migrations). All in one transaction: a backup that is cut short or doesn't
 * fit restores nothing. Columns the backup doesn't have keep their defaults,
 * so an older backup restores into a newer schema. Rows go straight into the
 * newest tables: a future migration that rewrites data (not just adds columns)
 * would need its own step here for older backups.
 */
export async function restoreBackup(db: Db, lines: AsyncIterable<string>): Promise<BackupSummary> {
  return db.transaction(async (tx) => {
    // Rows go in table by table, but players and accounts point at each other, so check
    // foreign keys and run triggers (the append-only guards only refuse edits) as a replica does.
    await tx.execute(sql.raw('set local session_replication_role = replica')).catch((e: unknown) => {
      throw new BackupError(`Restoring needs a database role that may skip foreign key checks (a superuser, as on PGlite or your own Postgres): ${errorText(e)}`);
    });
    const tables = new Set(await tableNames(tx));
    let header: BackupHeader | null = null;
    let end: { rows: Record<string, number>; sequences?: Record<string, number> } | null = null;
    const counts: Record<string, number> = {};
    // Rows stay as the backup's own text: parsing them in JavaScript would round bigints past 2^53.
    let batch: { table: string; rows: string[]; bytes: number } | null = null;

    const flush = async () => {
      if (!batch || !batch.rows.length) return;
      const { table, rows } = batch;
      batch = null;
      // The backup's own column names (every row of a table has the same ones), so a column added since keeps its default.
      const columns = Object.keys(JSON.parse(rows[0]!)).map(ident).join(', ');
      // json_populate_recordset turns each JSON value back into its column's type (jsonb, timestamps, bigints).
      // Overriding: identity columns (the ledger's seq) take the backup's numbers.
      await tx.execute(sql`insert into ${sql.raw(ident(table))} (${sql.raw(columns)}) overriding system value select ${sql.raw(columns)} from json_populate_recordset(null::${sql.raw(ident(table))}, ${`[${rows.join(',')}]`}::json)`);
    };

    for await (const line of lines) {
      if (!line) continue;
      if (end) throw new BackupError('The backup has lines after its end.');
      if (!header) {
        const item = JSON.parse(line);
        if (item.backup !== BACKUP_FORMAT || item.version !== BACKUP_VERSION) throw new BackupError('This is not an RSDP Live! backup.');
        header = item as BackupHeader;
        const migrations = await migrationCount(tx);
        if (header.migrations > migrations) throw new BackupError(`The backup is from a newer version (${header.migrations} migrations; this code has ${migrations}). Restore it with newer code.`);
        for (const t of header.tables) {
          if (!tables.has(t)) throw new BackupError(`The backup has a table this code doesn't know: ${t}.`);
          counts[t] = 0;
          const [row] = await queryRows<{ n: string | number }>(tx, sql.raw(`select count(*) as n from ${ident(t)}`));
          if (Number(row?.n) > 0) throw new BackupError(`Restore into an empty database: ${t} already has rows.`);
        }
        continue;
      }
      const row = ROW_LINE.exec(line);
      if (!row) {
        const item = JSON.parse(line);
        if (!item.end) throw new BackupError('The backup has a line it can\'t read.');
        await flush();
        end = item;
        continue;
      }
      const table = row[1]!;
      if (!(table in counts)) throw new BackupError(`The backup has rows for a table it didn't list: ${table}.`);
      const json = line.slice(row[0].length, -1);
      if (batch && (batch.table !== table || batch.rows.length >= INSERT_BATCH || batch.bytes + json.length > PAGE_BYTES)) await flush();
      batch ??= { table, rows: [], bytes: 0 };
      batch.rows.push(json);
      batch.bytes += json.length;
      counts[table]++;
    }
    if (!header) throw new BackupError('The backup is empty.');
    if (!end) throw new BackupError('The backup was cut short (it has no end line).');
    for (const [t, n] of Object.entries(end.rows)) {
      if (counts[t] !== n) throw new BackupError(`The backup was cut short: ${t} should have ${n} rows, found ${counts[t] ?? 0}.`);
    }
    // Counters (bigserial and identity columns) carry on after the highest id ever handed out.
    for (const { t, c, seq } of await counters(tx)) {
      const used = Number(end.sequences?.[`${t}.${c}`] ?? 0);
      await tx.execute(sql.raw(`select setval('${seq.replace(/'/g, "''")}', greatest(coalesce(max(${ident(c)}), 0), ${used}) + 1, false) from ${ident(t)}`));
    }
    return { at: header.at, migrations: header.migrations, rows: counts };
  });
}

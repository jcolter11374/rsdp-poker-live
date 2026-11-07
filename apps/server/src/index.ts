import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { variants } from '@rsdp/engine/core';
import { registerAllVariants } from '@rsdp/engine/variants';
import { createApp } from './app';
import { AuditLog, dbAuditStore } from './audit';
import { sql } from 'drizzle-orm';
import { closeDb, createDb, dbCause } from './db';
import { restoreIfWaiting } from './db/restoreOnStart';
import { dbNotes } from './notes';
import { dbSetups } from './savedSetups';
import { dbAvatars } from './avatars';
import { dbSharedHands } from './shared';
import { dbSuggestions } from './suggestions';
import { dbFeedback } from './feedback';
import { dbIdentity, dbStore } from './storage';
import { googleFromEnv } from './google';
import { dbTournamentStore } from './tournament/store';
import { FAIR_LEAD_MS } from './runtime/table';
import { dbLobbyStore } from './tournament/lobby';
import { shutDown } from './shutdown';
import { dbPushStore, pushFromEnv } from './push/alerts';

const PORT = Number(process.env.PORT ?? 3001);
const here = path.dirname(fileURLToPath(import.meta.url));

registerAllVariants(variants);

// Postgres with DATABASE_URL; otherwise an on-disk PGlite under apps/server/.data so local tables survive a restart.
const pgliteDir = process.env.DATABASE_URL ? undefined : (process.env.PGLITE_DIR ?? path.resolve(here, '../.data/pglite'));
// A backup left beside the folder (restore.jsonl.gz) is restored before anything opens it.
if (pgliteDir) await restoreIfWaiting(pgliteDir);
const db = await createDb({ pgliteDir });
const webDist = path.resolve(here, '../../web/dist');
// The public record carries on from its last entry; a server start is its own entry.
// The record's own failures go through the server's log once it exists, so the game-night recap sees them too.
let serverLog = (m: string, e?: unknown) => console.error(m, dbCause(e) ?? '');
const audit = await AuditLog.open(dbAuditStore(db), { log: (m, e) => serverLog(m, e) });
const server = createApp({ audit, fairLeadMs: FAIR_LEAD_MS, webDist, identity: dbIdentity(db), store: dbStore(db), tournaments: dbTournamentStore(db), notes: dbNotes(db), setups: dbSetups(db), lobby: dbLobbyStore(db), avatars: dbAvatars(db), shared: dbSharedHands(db), suggestions: dbSuggestions(db), feedback: dbFeedback(db), accounts: db, google: googleFromEnv(), push: { config: pushFromEnv(), store: dbPushStore(db) }, checkDb: () => db.execute(sql`select 1`), dataDir: pgliteDir });
serverLog = server.log;
// Unfinished tournaments carry on, and scheduled ones keep their start time.
await server.resume();

server.http.listen(PORT, () => console.log(`RSDP Live! server on http://localhost:${PORT}`));

let stopping = false;
/**
 * Saves every table and tournament, then exits; gives up after 10 s so a host's restart never hangs. Each step's time
 * goes in the log, and so does the step it was stuck on if it gives up (shutdown.ts).
 */
function shutdown(code: number, crash?: unknown) {
  if (stopping) return;
  stopping = true;
  shutDown(code, {
    run: async (steps) => {
      await server.close(code ? { crash, steps } : { steps });
      steps.step('closing the database');
      await closeDb(db);
    },
    exit: (c) => process.exit(c),
    error: (line, e) => console.error(line, e === undefined ? '' : dbCause(e)),
  });
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => shutdown(0));
// One stray rejected promise must not end every game in progress.
process.on('unhandledRejection', (e) => server.log('unhandled rejection', e));
// Anything worse: save what we can and let the host restart us; tables and tournaments resume.
process.on('uncaughtException', (e) => {
  console.error('uncaught exception', dbCause(e));
  shutdown(1, e);
});

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { variants } from '@rsdp/engine/core';
import { registerAllVariants } from '@rsdp/engine/variants';
import { createApp } from './app';
import { closeDb, createDb } from './db';
import { dbIdentity, dbStore } from './storage';
import { dbTournamentStore } from './tournament/store';

const PORT = Number(process.env.PORT ?? 3001);
const here = path.dirname(fileURLToPath(import.meta.url));

registerAllVariants(variants);

// Postgres with DATABASE_URL; otherwise an on-disk PGlite under apps/server/.data so local tables survive a restart.
const db = await createDb({ pgliteDir: process.env.DATABASE_URL ? undefined : (process.env.PGLITE_DIR ?? path.resolve(here, '../.data/pglite')) });
const webDist = path.resolve(here, '../../web/dist');
const server = createApp({ webDist, identity: dbIdentity(db), store: dbStore(db), tournaments: dbTournamentStore(db) });
// Unfinished tournaments carry on, and scheduled ones keep their start time.
await server.resume();

server.http.listen(PORT, () => console.log(`RSDP Poker Live! server on http://localhost:${PORT}`));

let stopping = false;
/** Saves every table and tournament, then exits; gives up after 10 s so a host's restart never hangs. */
function shutdown(code: number) {
  if (stopping) return;
  stopping = true;
  setTimeout(() => process.exit(code), 10_000).unref();
  server
    .close()
    .then(() => closeDb(db))
    .catch((e) => console.error('shutdown failed', e))
    .finally(() => process.exit(code));
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => shutdown(0));
// One stray rejected promise must not end every game in progress.
process.on('unhandledRejection', (e) => console.error('unhandled rejection', e));
// Anything worse: save what we can and let the host restart us; tables and tournaments resume.
process.on('uncaughtException', (e) => {
  console.error('uncaught exception', e);
  shutdown(1);
});

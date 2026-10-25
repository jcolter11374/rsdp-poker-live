import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { variants } from '@rsdp/engine/core';
import { registerAllVariants } from '@rsdp/engine/variants';
import { createApp } from './app';
import { closeDb, createDb } from './db';
import { dbIdentity, dbStore } from './storage';

const PORT = Number(process.env.PORT ?? 3001);
const here = path.dirname(fileURLToPath(import.meta.url));

registerAllVariants(variants);

// Postgres with DATABASE_URL; otherwise an on-disk PGlite under apps/server/.data so local tables survive a restart.
const db = await createDb({ pgliteDir: process.env.DATABASE_URL ? undefined : (process.env.PGLITE_DIR ?? path.resolve(here, '../.data/pglite')) });
const webDist = path.resolve(here, '../../web/dist');
const server = createApp({ webDist, identity: dbIdentity(db), store: dbStore(db) });

server.http.listen(PORT, () => console.log(`RSDP Poker Live! server on http://localhost:${PORT}`));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server
      .close()
      .then(() => closeDb(db))
      .finally(() => process.exit(0));
  });
}

/**
 * Restores a backup from /api/admin/backup into a fresh database (docs/DEPLOY.md, "Backups"):
 *
 *   npx tsx apps/server/src/restore.ts rsdp-backup.jsonl.gz /data/pglite-restored   # a PGlite folder
 *   npx tsx apps/server/src/restore.ts rsdp-backup.jsonl.gz postgres://…            # an empty Postgres database
 *   npx tsx apps/server/src/restore.ts rsdp-backup.jsonl.gz --check                 # into memory, to test the file
 *
 * Prints the rows restored per table as JSON. Nothing is written unless the whole backup restores.
 */

import { existsSync, readdirSync } from 'node:fs';
import { closeDb, createDb, errorText } from './db';
import { backupLines, restoreBackup } from './db/backup';

const [file, target] = process.argv.slice(2);
if (!file || !target) {
  console.error('usage: restore.ts <backup.jsonl.gz> <pglite folder | postgres://url | --check>');
  process.exit(2);
}
const url = /^postgres(ql)?:\/\//.test(target) ? target : undefined;
const pgliteDir = url || target === '--check' ? undefined : target;
if (pgliteDir && existsSync(pgliteDir) && readdirSync(pgliteDir).length) {
  console.error(`${pgliteDir} isn't empty. Restore into a new folder.`);
  process.exit(2);
}

const db = await createDb({ ignoreEnv: true, url, pgliteDir, vacuumEveryMs: 2 ** 30 });
try {
  const summary = await restoreBackup(db, backupLines(file));
  console.log(JSON.stringify(summary));
} catch (e) {
  console.error(`Restore failed: ${errorText(e)}`);
  process.exitCode = 1;
} finally {
  await closeDb(db);
}

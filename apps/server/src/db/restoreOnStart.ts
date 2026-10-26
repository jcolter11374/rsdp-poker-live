/**
 * Restoring the live site (docs/DEPLOY.md, "Backups"): put a backup next to
 * the PGlite folder as restore.jsonl.gz and restart the server. Before it opens
 * the database, the server restores the file into a new folder and swaps it in,
 * keeping the old folder beside it. Swapping while a server has the folder open
 * would corrupt both, which is why it happens here and nowhere else.
 */

import { existsSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { backupLines, restoreBackup } from './backup';
import { closeDb, createDb } from './client';

export const RESTORE_FILE = 'restore.jsonl.gz';

/** Restores a waiting backup into `dataDir`, if there is one. A backup that fails to restore changes nothing but its own name. */
export async function restoreIfWaiting(dataDir: string, log: (message: string) => void = console.log): Promise<void> {
  const dir = path.resolve(dataDir);
  const file = path.join(path.dirname(dir), RESTORE_FILE);
  if (!existsSync(file)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fresh = `${dir}-restoring`;
  rmSync(fresh, { recursive: true, force: true });
  log(`restoring ${file}`);
  try {
    const db = await createDb({ ignoreEnv: true, pgliteDir: fresh, vacuumEveryMs: 2 ** 30 });
    try {
      const summary = await restoreBackup(db, backupLines(file));
      log(`restored ${Object.values(summary.rows).reduce((a, b) => a + b, 0)} rows from a backup taken ${summary.at}`);
    } finally {
      await closeDb(db);
    }
  } catch (e) {
    rmSync(fresh, { recursive: true, force: true });
    renameSync(file, `${file}.failed-${stamp}`);
    log(`restore failed, the data is as it was: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  if (existsSync(dir)) renameSync(dir, `${dir}-before-restore-${stamp}`);
  renameSync(fresh, dir);
  renameSync(file, `${file}.done-${stamp}`);
  log(`restored data is in place; the old data is in ${dir}-before-restore-${stamp}`);
}

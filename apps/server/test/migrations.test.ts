/**
 * The migration files.
 *
 * Why the journal must stay in order: Drizzle's migrator (the same code for
 * node-postgres and PGlite) reads only the newest row of
 * drizzle.__drizzle_migrations and runs the journal entries whose "when" is
 * newer than that row. An entry that is not newer is skipped for good, with
 * no error, on every database that already has the later one, while a fresh
 * database (every other test, a new install) still runs it. A migration from a
 * branch merged after a newer one would go missing only in production.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '../src/db/client';

interface Journal {
  entries: { idx: number; when: number; tag: string }[];
}

const journal = JSON.parse(readFileSync(path.join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8')) as Journal;
const { entries } = journal;

describe('migration journal', () => {
  it('numbers its entries 0, 1, 2… in order', () => {
    expect(entries.map((e) => e.idx)).toEqual(entries.map((_, i) => i));
  });

  it('has a .sql file for every entry and an entry for every .sql file', () => {
    // The migrator reads `<tag>.sql`; a file with no entry never runs.
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    expect(entries.map((e) => `${e.tag}.sql`)).toEqual(files);
  });

  it('names each file after its number', () => {
    for (const e of entries) expect(e.tag).toMatch(new RegExp(`^${String(e.idx).padStart(4, '0')}_[\\w-]+$`));
  });

  it('stamps every entry later than the one before it', () => {
    // See the top of this file: an entry that is not newer is skipped on existing databases.
    // After merging two branches that each added a migration, give the later file a "when" newer than every earlier one.
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i].when, `${entries[i].tag} must be newer than ${entries[i - 1].tag}`).toBeGreaterThan(entries[i - 1].when);
    }
  });

  it('stamps no entry in the future', () => {
    // drizzle-kit stamps a new migration with the time it is made, so after one stamped in the future it would come out older.
    expect(entries[entries.length - 1].when).toBeLessThanOrEqual(Date.now());
  });
});

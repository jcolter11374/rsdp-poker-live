import { existsSync } from 'node:fs';
import { defineConfig } from 'drizzle-kit';

// drizzle-kit resolves paths from the working directory; accept both the repo root and apps/server.
const base = existsSync('apps/server/src/db/schema.ts') ? 'apps/server/' : './';

/**
 * From the repo root: `npm run db:generate` writes a migration for changes to schema.ts, `npm run db:check` checks
 * the snapshots agree. drizzle-kit is installed at the root, so drizzle-orm is a root devDependency too (same version
 * as apps/server): drizzle-kit can only find drizzle-orm next to itself. Rules: docs/ARCHITECTURE.md.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: `${base}src/db/schema.ts`,
  out: `${base}drizzle`,
  strict: true,
  verbose: true,
});

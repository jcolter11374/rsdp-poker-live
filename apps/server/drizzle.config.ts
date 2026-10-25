import { existsSync } from 'node:fs';
import { defineConfig } from 'drizzle-kit';

// drizzle-kit resolves paths from the working directory; accept both the repo root and apps/server.
const base = existsSync('apps/server/src/db/schema.ts') ? 'apps/server/' : './';

/** Generate migrations with: npx drizzle-kit generate --config apps/server/drizzle.config.ts */
export default defineConfig({
  dialect: 'postgresql',
  schema: `${base}src/db/schema.ts`,
  out: `${base}drizzle`,
  strict: true,
  verbose: true,
});

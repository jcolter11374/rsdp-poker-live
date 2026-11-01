import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Opening a database on disk or hashing a password takes 3-5 s on its own, past vitest's default 5 s on a
    // machine doing other work. A test that really hangs still fails, after 20 s instead of 5.
    testTimeout: 20_000,
  },
});

/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { licensesPlugin } from './licenses.mjs';

export default defineConfig({
  plugins: [react(), licensesPlugin()],
  server: {
    port: 5173,
    proxy: {
      '/socket.io': { target: 'http://localhost:3001', ws: true },
      '/api': 'http://localhost:3001',
    },
  },
  // Tests run in node; a screen test asks for a page with "// @vitest-environment jsdom" at its top.
  test: { setupFiles: ['./src/test-setup.ts'] },
});

/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { licensesPlugin } from './licenses.mjs';

export default defineConfig({
  plugins: [react(), licensesPlugin()],
  build: {
    // The browsers Vite 5 built for by default: Safari 14, Chrome 87, Firefox 78 and Edge 88 (late 2020) or newer.
    // Vite 8's own default starts at 2023's browsers, so naming the old list keeps older phones working.
    target: ['es2020', 'edge88', 'firefox78', 'chrome87', 'safari14'],
  },
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

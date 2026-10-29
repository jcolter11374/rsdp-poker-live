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
});

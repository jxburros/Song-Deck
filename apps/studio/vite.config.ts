import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The local Song Deck server (apps/server) listens on 7788 by default and serves /api.
// In development the studio proxies /api to it so both share an origin (no CORS, cookies work).
const SERVER = process.env.SONGDECK_SERVER ?? 'http://localhost:7788';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: SERVER, changeOrigin: true, ws: true },
    },
  },
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 4000,
  },
});

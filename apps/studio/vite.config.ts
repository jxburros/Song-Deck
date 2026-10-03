import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The local Song Deck server (apps/server) listens on 7788 by default and serves /api.
// In development the studio proxies /api to it so both share an origin (no CORS, cookies work).
const SERVER = process.env.SONGDECK_SERVER ?? 'http://localhost:7788';
// End-to-end runs serve a frozen snapshot: no HMR or file watching, so edits elsewhere can't reload the page mid-test.
const E2E = !!process.env.E2E;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    hmr: E2E ? false : undefined,
    watch: E2E ? { ignored: ['**/*'] } : undefined,
    proxy: {
      '/api': { target: SERVER, changeOrigin: true, ws: true },
    },
  },
  // Scan every source file (lazy modes, workers, workspace packages) at startup so dependencies are
  // pre-bundled once — otherwise Vite discovers them on first navigation and force-reloads the page.
  optimizeDeps: {
    entries: ['index.html', 'src/**/*.{ts,tsx}'],
    include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'zustand', 'fflate', '@anthropic-ai/sdk', '@breezystack/lamejs'],
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

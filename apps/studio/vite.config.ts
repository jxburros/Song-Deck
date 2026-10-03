import type { ServerResponse } from 'node:http';
import { defineConfig, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';

// The local Song Deck server (apps/server) listens on 7788 by default and serves /api.
// In development the studio proxies /api to it so both share an origin (no CORS, cookies work).
const SERVER = process.env.SONGDECK_SERVER ?? 'http://localhost:7788';
// End-to-end runs serve a frozen snapshot: no HMR or file watching, so edits elsewhere can't reload the page mid-test.
const E2E = !!process.env.E2E;

/**
 * The local server is optional. While it is not running, answer proxied requests with a quiet
 * 503 (the studio shows "browser-only mode") instead of logging a proxy error for every status poll.
 */
const quietWhenServerIsDown: ProxyOptions['configure'] = (proxy) => {
  const emit = proxy.emit.bind(proxy);
  proxy.emit = ((event: string, ...args: unknown[]) => {
    const [err, , res] = args as [NodeJS.ErrnoException | undefined, unknown, ServerResponse | { destroy(): void } | undefined];
    if (event === 'error' && (err?.code === 'ECONNREFUSED' || err?.code === 'ECONNRESET')) {
      if (res && 'writeHead' in res) {
        if (!res.headersSent) res.writeHead(503, { 'content-type': 'application/json' });
        res.end('{"error":"The local Song Deck server is not running"}');
      } else res?.destroy();
      return true;
    }
    return emit(event, ...args);
  }) as typeof proxy.emit;
};

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    hmr: E2E ? false : undefined,
    watch: E2E ? { ignored: ['**/*'] } : undefined,
    proxy: {
      '/api': { target: SERVER, changeOrigin: true, ws: true, configure: quietWhenServerIsDown },
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

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const apiTarget = process.env.HOOTRADAR_API ?? 'http://localhost:8787';

/**
 * Dev server exposure is opt-in. By default it listens on localhost only, so the
 * /api proxy and the source tree are not reachable from the LAN (shared or public
 * Wi-Fi). To test on a real phone, start it with `VITE_HOST=0.0.0.0 npm run dev`
 * (or `npm run dev -- --host`).
 */
const devHost = process.env.VITE_HOST?.trim() || 'localhost';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@shared': fileURLToPath(new URL('../shared', import.meta.url)) },
  },
  server: {
    port: 5173,
    host: devHost,
    // Only what the app imports: web/ itself, the @shared alias and the hoisted
    // workspace node_modules (fonts). Never the whole repo: server/data/*.db and
    // other local files must not be readable through /@fs/.
    fs: { allow: ['.', '../shared', '../node_modules'] },
    proxy: { '/api': { target: apiTarget, changeOrigin: true } },
  },
  // assetsInlineLimit 0: fonts stay files — the server's CSP is font-src 'self' (no data: URIs)
  build: { outDir: 'dist', sourcemap: false, target: 'es2022', assetsInlineLimit: 0 },
});

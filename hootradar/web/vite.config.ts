import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const apiTarget = process.env.HOOTRADAR_API ?? 'http://localhost:8787';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@shared': fileURLToPath(new URL('../shared', import.meta.url)) },
  },
  server: {
    port: 5173,
    host: true,
    fs: { allow: ['..'] },
    proxy: { '/api': { target: apiTarget, changeOrigin: true } },
  },
  // assetsInlineLimit 0: fonts stay files — the server's CSP is font-src 'self' (no data: URIs)
  build: { outDir: 'dist', sourcemap: false, target: 'es2022', assetsInlineLimit: 0 },
});

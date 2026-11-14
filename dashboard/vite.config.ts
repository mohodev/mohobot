import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root,
  // The React control center is the primary console now: it is served from the
  // webui root, so assets resolve under `/assets/` on the same origin.
  base: '/',
  plugins: [react()],
  build: {
    outDir: path.resolve(root, '../webui'),
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:3210',
    },
  },
});

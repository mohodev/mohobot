import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root,
  base: '/dashboard/',
  plugins: [react()],
  build: {
    outDir: path.resolve(root, '../webui/dashboard'),
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

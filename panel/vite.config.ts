import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root,
  plugins: [react()],
  publicDir: false,
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:3001',
      '/display': 'http://127.0.0.1:3001',
      '/nowplaying': 'http://127.0.0.1:3001',
    },
  },
  build: {
    outDir: path.resolve(root, '../public'),
    emptyOutDir: false,
    sourcemap: true,
    rollupOptions: {
      input: path.resolve(root, 'index.html'),
    },
  },
});

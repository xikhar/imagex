import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import svgr from 'vite-plugin-svgr';

const daemonTarget = process.env.IMAGEX_DAEMON_URL || `http://127.0.0.1:${process.env.IMAGEX_DAEMON_PORT || '3847'}`;

export default defineConfig({
  root: 'src/web',
  plugins: [react(), tailwindcss(), svgr()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src/web'),
    },
  },
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': daemonTarget,
      '/outputs': daemonTarget,
    },
  },
});

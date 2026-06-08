import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import svgr from 'vite-plugin-svgr';

const daemonTarget = process.env.IMAGEX_DAEMON_URL || `http://127.0.0.1:${process.env.IMAGEX_DAEMON_PORT || '3847'}`;

function vendorChunkName(moduleId: string) {
  if (!moduleId.includes('/node_modules/')) return null;
  if (moduleId.includes('/node_modules/@xyflow/')) return 'vendor-flow';
  if (
    moduleId.includes('/node_modules/react/') ||
    moduleId.includes('/node_modules/react-dom/') ||
    moduleId.includes('/node_modules/scheduler/')
  ) {
    return 'vendor-react';
  }
  if (
    moduleId.includes('/node_modules/@radix-ui/') ||
    moduleId.includes('/node_modules/radix-ui/') ||
    moduleId.includes('/node_modules/lucide-react/') ||
    moduleId.includes('/node_modules/class-variance-authority/') ||
    moduleId.includes('/node_modules/clsx/') ||
    moduleId.includes('/node_modules/tailwind-merge/')
  ) {
    return 'vendor-ui';
  }
  if (
    moduleId.includes('/node_modules/color/') ||
    moduleId.includes('/node_modules/color-convert/') ||
    moduleId.includes('/node_modules/color-name/') ||
    moduleId.includes('/node_modules/color-string/') ||
    moduleId.includes('/node_modules/react-colorful/')
  ) {
    return 'vendor-color';
  }
  if (moduleId.includes('/node_modules/zustand/')) return 'vendor-state';
  return 'vendor';
}

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
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: vendorChunkName,
              test: /[\\/]node_modules[\\/]/,
              priority: 1,
            },
          ],
        },
      },
    },
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

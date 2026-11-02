import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
export default defineConfig({
  main: {
    build: {
      outDir: path.join(root, 'out/main'),
      rollupOptions: { input: path.join(root, 'src/main/index.ts') },
    },
  },
  preload: {
    build: {
      outDir: path.join(root, 'out/preload'),
      externalizeDeps: false,
      rollupOptions: {
        input: path.join(root, 'src/preload/index.ts'),
        output: { format: 'cjs', entryFileNames: 'index.js' },
      },
    },
  },
  renderer: {
    root: path.join(root, 'src/renderer'),
    plugins: [react()],
    build: {
      outDir: path.join(root, 'out/renderer'),
      rollupOptions: { input: path.join(root, 'src/renderer/index.html') },
    },
  },
});

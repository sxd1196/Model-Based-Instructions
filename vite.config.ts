/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const root = import.meta.dirname;

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(root, './src') },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
  // occt-import-js ships a wasm blob; keep it out of the dep optimizer.
  // occt-import-js is UMD and loads its own .wasm at runtime; let esbuild
  // pre-bundle it so the interop shape is stable, but keep the wasm external.
  optimizeDeps: { include: ['occt-import-js'] },
  assetsInclude: ['**/*.wasm'],
});

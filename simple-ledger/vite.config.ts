/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 個人カテゴリ origin (personal.snishi-code.com) のサブパスとして配信する。
// 例: https://personal.snishi-code.com/simple-ledger/
export default defineConfig({
  base: '/simple-ledger/',
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    css: true,
    // E2E (Playwright) は別ランナー。Vitest からは除外する。
    exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
  },
});

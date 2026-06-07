/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 個人カテゴリ origin (personal.snishi-code.com) のサブパスとして配信する。
// 例: https://personal.snishi-code.com/simple-ledger/
//
// 配信方針: このサイトは「リポジトリのファイルをそのまま静的配信」なので、
// ビルド成果物を配信パス（リポジトリ直下 simple-ledger/）へ出力してコミットする。
// ソースはこの simple-ledger-src/ に置く。
export default defineConfig({
  base: '/simple-ledger/',
  plugins: [react()],
  build: {
    // 配信される実体。リポジトリ直下 simple-ledger/ に出力し、git 管理する。
    outDir: '../simple-ledger',
    emptyOutDir: true,
    sourcemap: false,
    // modulepreload polyfill は同一オリジン fetch を含み no-exfil-guard を不必要に
    // 刺激するため無効化（対象ブラウザは modulepreload をネイティブ対応）。
    modulePreload: { polyfill: false },
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

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/dist-site/**',
      '**/node_modules/**',
      '**/.claude/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '**/*.d.ts',
      'docs/**',
      // 旧ローカル作業フォルダ（公開アプリのソースではない）は lint 対象外
      'simple-ledger/**',
      'simple-ledger-src/**',
      'site/site-links.js',
      // vendor 同梱ライブラリ(ライセンスヘッダ付き原文維持)は lint 対象外
      'packages/foundation/src/qr/vendor/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: { ...reactHooks.configs.recommended.rules },
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    files: ['**/sw.js', '**/public/**/*.js'],
    languageOptions: { globals: { ...globals.serviceworker, ...globals.browser } },
  },
);

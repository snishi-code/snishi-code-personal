import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'playwright-report', 'test-results', 'coverage'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // 外部送信プリミティブの禁止（憲法: 外部送信ゼロ）。
      // 機械ガード(tools/no-exfil-guard.sh)は .ts/.tsx を走査しないため、ここでも二重に塞ぐ。
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: '外部送信は禁止です（CLAUDE.md 憲法）。' },
        { name: 'XMLHttpRequest', message: '外部送信は禁止です（CLAUDE.md 憲法）。' },
        { name: 'WebSocket', message: '外部送信は禁止です（CLAUDE.md 憲法）。' },
        { name: 'EventSource', message: '外部送信は禁止です（CLAUDE.md 憲法）。' },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'navigator',
          property: 'sendBeacon',
          message: '外部送信は禁止です（CLAUDE.md 憲法）。',
        },
      ],
    },
  },
  // テスト/ツール系では Node グローバルとブラウザ両方を許可。
  {
    files: ['tests/**/*.{ts,tsx}', 'e2e/**/*.ts', '*.config.{ts,js}'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
);

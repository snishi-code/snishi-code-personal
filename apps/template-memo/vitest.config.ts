import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

const foundationSrc = fileURLToPath(new URL('../../packages/foundation/src', import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@snishi\/foundation$/, replacement: `${foundationSrc}/index.ts` },
      { find: /^@snishi\/foundation\/(.+)$/, replacement: `${foundationSrc}/$1` },
    ],
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['../../packages/foundation/src/test-setup.ts'],
    passWithNoTests: true,
    // e2e は Playwright 管轄 (vitest に拾わせない)
    exclude: [...configDefaults.exclude, 'e2e/**'],
  },
});

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const foundationSrc = fileURLToPath(new URL('../../packages/foundation/src', import.meta.url));

export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^@snishi\/foundation$/, replacement: `${foundationSrc}/index.ts` },
      { find: /^@snishi\/foundation\/(.+)$/, replacement: `${foundationSrc}/$1` },
    ],
  },
  build: { outDir: 'dist', emptyOutDir: true },
});

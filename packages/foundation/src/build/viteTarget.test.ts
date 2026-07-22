// @vitest-environment node
// viteTarget は Node 専用 build tooling (fileURLToPath/readFileSync を使う)。
// foundation 既定の jsdom では import.meta.url が file:// にならないため node 環境で実行する。
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createSnishiTargetViteConfig,
  getSnishiBuildTarget,
  transformIndexHtmlForSnishiTarget,
} from './viteTarget';

const SAMPLE_HTML = `<!doctype html>
<html>
  <head>
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'" />
    <title>x</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.pwa.tsx"></script>
  </body>
</html>`;

// テスト用 app-targets fixture。実 repo の config/app-targets.json には依存しない
// (foundation は medical/personal どちらの repo でも同一内容で動く必要がある。
//  実 config の中身検査は各 repo の verify-network-policy が担う)。
const FIXTURE_TARGETS = {
  'sample-app': {
    pwa: { target: 'pwa', features: { localLlm: false }, network: { mode: 'none' } },
    desktop: { target: 'desktop', features: { localLlm: false }, network: { mode: 'none' } },
  },
};
let fixtureDir = '';
let TARGETS_FROM_TEST = '';
beforeAll(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), 'snishi-app-targets-'));
  writeFileSync(join(fixtureDir, 'app-targets.json'), JSON.stringify(FIXTURE_TARGETS));
  // targetsPathFromApp は appConfigUrl (このテストファイル) からの相対パスで解決される。
  TARGETS_FROM_TEST = relative(
    dirname(fileURLToPath(import.meta.url)),
    join(fixtureDir, 'app-targets.json'),
  );
});
afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

describe('getSnishiBuildTarget', () => {
  it('未設定 (undefined) は pwa', () => {
    expect(getSnishiBuildTarget(undefined)).toBe('pwa');
  });

  it("'desktop' は desktop", () => {
    expect(getSnishiBuildTarget('desktop')).toBe('desktop');
  });

  it('不明な値は安全側の pwa に倒す', () => {
    expect(getSnishiBuildTarget('something-else')).toBe('pwa');
  });
});

describe('transformIndexHtmlForSnishiTarget', () => {
  it('pwa は入力 HTML をそのまま返す', () => {
    expect(transformIndexHtmlForSnishiTarget(SAMPLE_HTML, 'pwa')).toBe(SAMPLE_HTML);
  });

  it('desktop は entry を差し替え CSP meta を除去する', () => {
    const out = transformIndexHtmlForSnishiTarget(SAMPLE_HTML, 'desktop');
    expect(out).not.toContain('/src/main.pwa.tsx');
    expect(out).toContain('/src/main.desktop.tsx');
    expect(out).not.toContain('Content-Security-Policy');
  });
});

describe('createSnishiTargetViteConfig', () => {
  const ORIGINAL = process.env.SNISHI_TARGET;

  afterEach(() => {
    // SNISHI_TARGET を必ず元へ戻す (他テスト・後続 build へ漏らさない)。
    if (ORIGINAL === undefined) delete process.env.SNISHI_TARGET;
    else process.env.SNISHI_TARGET = ORIGINAL;
  });

  it('pwa (既定) は base ./ / outDir dist / __SNISHI_APP_TARGET__ を持つ', () => {
    delete process.env.SNISHI_TARGET;
    const config = createSnishiTargetViteConfig({
      appId: 'sample-app',
      appConfigUrl: import.meta.url,
      plugins: [],
      targetsPathFromApp: TARGETS_FROM_TEST,
    });
    expect(config.base).toBe('./');
    expect(config.build?.outDir).toBe('dist');
    expect(config.define).toHaveProperty('__SNISHI_APP_TARGET__');
  });

  it('desktop は outDir dist-desktop', () => {
    process.env.SNISHI_TARGET = 'desktop';
    const config = createSnishiTargetViteConfig({
      appId: 'sample-app',
      appConfigUrl: import.meta.url,
      plugins: [],
      targetsPathFromApp: TARGETS_FROM_TEST,
    });
    expect(config.build?.outDir).toBe('dist-desktop');
  });
});

// PWA / Desktop の Vite build 分岐を 1 箇所に集約する共通 helper。
// hospital-note-assist / hospital-rounds の vite.config.ts はこれを呼ぶだけにする
// (アプリ名以外ほぼ同一だった重複の解消)。
//
// 不変条件:
//   - PWA build / vite dev は index.html を一切変更しない (既定 main.pwa.tsx・PWA用CSP のまま)。
//   - desktop build のみ entry を main.desktop.tsx へ差し替え、PWA用CSP meta を除去する
//     (Tauri IPC ipc:/http://ipc.localhost を塞がないよう CSP は tauri.conf.json に委ねる)。
//   - HTML 差し替え plugin は order:'pre' 必須。Vite が <script src> を hash 済みパスへ
//     書き換える前に走らせる。既定 (post) フックだと本番 build で src 書き換え後に走るため
//     差し替えが no-op になり、desktop が PWA entry (browserHost + Service Worker 登録) を
//     取り込んでしまう (CSP meta 除去だけは効くため一見気付きにくい)。
//   - PWA/Desktop の機能差分は config/app-targets.json を正本にする (ここへベタ書きしない)。

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin, PluginOption, UserConfig } from 'vite';

export type SnishiBuildTarget = 'pwa' | 'desktop';

/** SNISHI_TARGET 環境変数から build target を求める (未設定/不明は安全側の pwa に倒す)。 */
export function getSnishiBuildTarget(
  value: string | undefined = process.env.SNISHI_TARGET,
): SnishiBuildTarget {
  return value === 'desktop' ? 'desktop' : 'pwa';
}

/** config/app-targets.json から 1 アプリ・1 ターゲット分の設定を読む (見つからなければ throw)。 */
export function readAppTargetConfigFile(
  targetsPath: string,
  appId: string,
  target: SnishiBuildTarget,
): unknown {
  const all = JSON.parse(readFileSync(targetsPath, 'utf8')) as Record<
    string,
    Record<string, unknown>
  >;
  const cfg = all?.[appId]?.[target];
  if (!cfg) throw new Error(`app-targets.json: "${appId}.${target}" が見つかりません`);
  return cfg;
}

export interface SnishiTargetEntries {
  pwaEntry: string;
  desktopEntry: string;
}

const DEFAULT_ENTRIES: SnishiTargetEntries = {
  pwaEntry: '/src/main.pwa.tsx',
  desktopEntry: '/src/main.desktop.tsx',
};

/**
 * index.html を build target に応じて変換する純関数 (plugin から呼ぶ。テストしやすいよう分離)。
 * - pwa: 変更しない。
 * - desktop: entry を desktop 用へ差し替え、PWA 用 CSP meta を除去する。
 * CSP 削除正規表現は移管前の vite.config.ts と同一 (検査範囲を変えない)。
 */
export function transformIndexHtmlForSnishiTarget(
  html: string,
  target: SnishiBuildTarget,
  entries: SnishiTargetEntries = DEFAULT_ENTRIES,
): string {
  if (target === 'pwa') return html; // PWA はそのまま
  return (
    html
      // desktop entry へ差し替え
      .replace(entries.pwaEntry, entries.desktopEntry)
      // PWA 用の厳格 CSP meta は Tauri IPC を塞ぐので除去 (CSP は tauri.conf.json の security.csp に委ねる)
      .replace(/<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>\s*/i, '')
  );
}

export interface CreateSnishiTargetViteConfigOptions {
  /** config/app-targets.json 内のアプリキー (例: 'hospital-note-assist')。 */
  appId: string;
  /** 呼び出し側 vite.config.ts の import.meta.url。targetsPath をここから解決する。 */
  appConfigUrl: string;
  /** 追加 plugin (例: react())。HTML entry plugin はこの後ろに足される。 */
  plugins?: PluginOption[];
  /** appConfig からの app-targets.json 相対パス。既定 '../../config/app-targets.json'。 */
  targetsPathFromApp?: string;
  pwaEntry?: string;
  desktopEntry?: string;
  pwaOutDir?: string;
  desktopOutDir?: string;
}

/**
 * snishi の PWA/Desktop 両対応 Vite 設定を生成する。
 * app 側 vite.config.ts は appId と import.meta.url を渡すだけにできる。
 */
export function createSnishiTargetViteConfig(
  options: CreateSnishiTargetViteConfigOptions,
): UserConfig {
  const {
    appId,
    appConfigUrl,
    plugins = [],
    targetsPathFromApp = '../../config/app-targets.json',
    pwaEntry = DEFAULT_ENTRIES.pwaEntry,
    desktopEntry = DEFAULT_ENTRIES.desktopEntry,
    pwaOutDir = 'dist',
    desktopOutDir = 'dist-desktop',
  } = options;

  // viteTarget.ts は packages/foundation/src/build/ にあるので '..' = packages/foundation/src。
  // 末尾スラッシュを除き、alias replacement が二重スラッシュにならないようにする。
  const foundationSrc = fileURLToPath(new URL('..', import.meta.url)).replace(/[/\\]$/, '');
  const appConfigDir = dirname(fileURLToPath(appConfigUrl));
  const targetsPath = resolve(appConfigDir, targetsPathFromApp);

  const target = getSnishiBuildTarget();
  const appTarget = readAppTargetConfigFile(targetsPath, appId, target);
  const entries: SnishiTargetEntries = { pwaEntry, desktopEntry };

  const htmlEntryPlugin: Plugin = {
    // 単一 index.html を保ち、desktop build のときだけ調整する。
    name: 'snishi-html-entry',
    // order:'pre' 必須 (理由はファイル冒頭の不変条件参照)。
    transformIndexHtml: {
      order: 'pre',
      handler(html: string) {
        return transformIndexHtmlForSnishiTarget(html, target, entries);
      },
    },
  };

  return {
    base: './',
    plugins: [...plugins, htmlEntryPlugin],
    define: {
      // React へ渡す build 時定数。app 内では host/targetConfig.ts 経由でのみ参照する。
      __SNISHI_APP_TARGET__: JSON.stringify(appTarget),
    },
    resolve: {
      alias: [
        { find: /^@snishi\/foundation$/, replacement: `${foundationSrc}/index.ts` },
        { find: /^@snishi\/foundation\/(.+)$/, replacement: `${foundationSrc}/$1` },
      ],
    },
    build: {
      // PWA は dist (従来どおり配信)。Desktop は dist-desktop (Tauri が束ねる)。
      outDir: target === 'desktop' ? desktopOutDir : pwaOutDir,
      emptyOutDir: true,
    },
  };
}

// @vitest-environment node
// SW 更新ポリシーの静的歩哨テスト (2026-07-07 改訂: 凍結 → 標準ライフサイクル)。
//   守るべき不変条件は「使用中乗っ取りの禁止」のみに絞った:
//     - skipWaiting / clients.claim を呼ばない = 起動中のページの版が実行中に切り替わらない。
//   更新チェックと次回起動時反映 (navigation network-first) は標準ライフサイクルとして許容する
//   (registration.update / updatefound の禁止は撤廃)。
//   - sw.template.js (正本テンプレート) と、アプリが出荷する public/sw.js (手コピー) の
//     両方を検査し、ポリシーが崩れていないことをソース文字列で監視する。
// 本ファイルは foundation 同期の除外対象 (medical 側はアプリ実出荷 sw.js の検査対象が
// medical 専用パスになるため。personal 側は simple-ledger の出荷 sw.js を検査するこの版を維持する)。
// node 環境で動かすのは import.meta.url が file: URL になり readFileSync でパス解決できるため。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function readSrc(relPath: string): string {
  return readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

// 「実行されるコード」のみを見る: 禁止 API 名は説明コメントには現れてよい。
function executableCode(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

// テンプレート + 出荷される各アプリ public/sw.js。すべて同じ不変条件を満たすこと。
// アプリ実体は手コピーなので、テンプレートだけでなく実出荷ファイルも歩哨対象にする。
const SW_SOURCES = [
  { label: 'sw.template.js (正本テンプレート)', rel: './sw.template.js' },
  {
    label: 'simple-ledger/public/sw.js',
    rel: '../../../../apps/simple-ledger/public/sw.js',
  },
];

describe.each(SW_SOURCES)('SW ポリシーの歩哨: $label', ({ rel }) => {
  const src = readSrc(rel);
  const code = executableCode(src);

  it('使用中乗っ取り系 API をコードに含まない (skipWaiting / clients.claim)', () => {
    expect(code).not.toMatch(/skipWaiting/);
    expect(code).not.toMatch(/clients\s*\.\s*claim/);
  });

  it('fetch 呼び出し行はすべて network-ok 注釈付き', () => {
    const fetchLines = src.split('\n').filter((line) => /(^|[^A-Za-z0-9_'"])fetch\s*\(/.test(line));
    expect(fetchLines.length).toBeGreaterThan(0);
    for (const line of fetchLines) {
      expect(line).toContain('network-ok:');
    }
  });

  it('fetch は同一オリジンに限定されている (origin チェックを保持)', () => {
    // 2026-07-09 改訂: startsWith 判定は https://example.com.evil.test を通すため URL origin 厳密一致へ。
    expect(code).toContain('new URL(e.request.url).origin !== self.location.origin');
    // 外部ドメインの直書きが無い。
    expect(code).not.toMatch(/https?:\/\//);
  });

  it('activate の削除条件が自アプリ prefix 限定 (他アプリ cache を消さない)', () => {
    // (a) prefix 限定の startsWith 条件が存在する
    expect(code).toContain('startsWith(CACHE_PREFIX)');
    // (b) prefix 条件なしの全削除パターン (k !== CACHE のみで filter) が存在しない
    //     "k !== CACHE" だけで filter していれば全 cache を消す旧バグ。
    expect(code).not.toMatch(/\.filter\s*\(\s*\([^)]*\)\s*=>\s*\w+\s*!==\s*CACHE\s*\)/);
  });

  it('オフライン時のキャッシュ fallback 構造を保持している', () => {
    expect(code).toContain('caches.match(e.request)');
    // fetch 失敗時にキャッシュへ倒れる catch が存在する (改行整形の揺れを許容)。
    expect(code).toMatch(/\.catch\(\(\) =>\s*caches\s*\.\s*match\(/);
  });
});

// テンプレート固有の検査 (アプリ実体は置換済みなので適用しない)。
describe('sw.template.js のテンプレート固有検査', () => {
  const src = readSrc('./sw.template.js');

  it('使用中乗っ取り禁止 (変更厳禁) コメントブロックを保持している', () => {
    expect(src).toContain('変更厳禁');
    // 禁止 API の列挙と狙いの説明が残っていること (コメントとして)。
    expect(src).toContain('skipWaiting');
    expect(src).toContain('clients.claim');
  });

  it('置換用プレースホルダを持つ', () => {
    expect(src).toContain("'__CACHE_PREFIX__'");
    expect(src).toContain("'__CACHE_NAME__'");
    expect(src).toContain('__PRECACHE_PATHS__');
  });
});

// 出荷 sw.js 固有の検査: キャッシュ識別子が app 定数と一致していること
// (sw.js は単体配信ファイルで import できないため、値の一致を歩哨で守る)。
describe('simple-ledger/public/sw.js の出荷固有検査', () => {
  const src = readSrc('../../../../apps/simple-ledger/public/sw.js');

  it('CACHE_PREFIX が constants.ts の CACHE_NAME_PREFIX と一致している', () => {
    const constants = readSrc('../../../../apps/simple-ledger/src/data/constants.ts');
    const m = constants.match(/CACHE_NAME_PREFIX = '([^']+)'/);
    expect(m).not.toBeNull();
    expect(src).toContain(`const CACHE_PREFIX = '${m![1]}';`);
    // キャッシュ名は PREFIX + 世代番号の形式。
    expect(src).toMatch(new RegExp(`const CACHE = '${m![1]}\\d+';`));
  });

  it('プレースホルダが置換済み', () => {
    expect(src).not.toContain('__CACHE_PREFIX__');
    expect(src).not.toContain('__CACHE_NAME__');
    expect(src).not.toContain('__PRECACHE_PATHS__');
  });
});

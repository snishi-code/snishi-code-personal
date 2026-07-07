// @vitest-environment node
// sw.template.js の静的歩哨テスト (2026-07-07 改訂: 凍結 → 標準ライフサイクル)。
//   守るべき不変条件は「使用中乗っ取りの禁止」のみに絞った:
//     - skipWaiting / clients.claim を呼ばない = 起動中のページの版が実行中に切り替わらない。
//   更新チェックと次回起動時反映 (navigation network-first) は標準ライフサイクルとして許容する
//   (registration.update / updatefound の禁止は撤廃)。
// 本ファイルは foundation 同期の除外対象 (正本 medical 側はアプリ実出荷 public/sw.js も
// 検査するため medical 専用パスを含む。personal 側はテンプレートのみ検査するこの版を維持する)。
// node 環境で動かすのは import.meta.url が file: URL になり readFileSync でパス解決できるため。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const src = readFileSync(new URL('./sw.template.js', import.meta.url), 'utf8');
// 「実行されるコード」のみを見る: 禁止 API 名は説明コメントには現れてよい。
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

describe('sw.template.js (SW ポリシーの歩哨)', () => {
  it('使用中乗っ取り系 API をコードに含まない (skipWaiting / clients.claim)', () => {
    expect(code).not.toMatch(/skipWaiting/);
    expect(code).not.toMatch(/clients\s*\.\s*claim/);
  });

  it('使用中乗っ取り禁止 (変更厳禁) コメントブロックを保持している', () => {
    expect(src).toContain('変更厳禁');
    // 禁止 API の列挙と狙いの説明が残っていること (コメントとして)。
    expect(src).toContain('skipWaiting');
    expect(src).toContain('clients.claim');
  });

  it('fetch 呼び出し行はすべて network-ok 注釈付き', () => {
    const fetchLines = src.split('\n').filter((line) => /(^|[^A-Za-z0-9_'"])fetch\s*\(/.test(line));
    expect(fetchLines.length).toBeGreaterThan(0);
    for (const line of fetchLines) {
      expect(line).toContain('network-ok:');
    }
  });

  it('fetch は同一オリジンに限定されている (origin チェックを保持)', () => {
    expect(code).toContain('startsWith(self.location.origin)');
    // 外部ドメインの直書きが無い。
    expect(code).not.toMatch(/https?:\/\//);
  });

  it('置換用プレースホルダを持つ', () => {
    expect(src).toContain("'__CACHE_PREFIX__'");
    expect(src).toContain("'__CACHE_NAME__'");
    expect(src).toContain('__PRECACHE_PATHS__');
  });

  it('activate の削除条件が自アプリ prefix 限定になっている (M1: 他アプリ cache を消さない)', () => {
    // (a) prefix 限定の startsWith 条件が存在する
    expect(code).toContain('startsWith(CACHE_PREFIX)');
    // (b) prefix 条件なしの全削除パターン (k !== CACHE のみで filter) が存在しない
    //     "k !== CACHE" だけで filter していれば全 cache を消す旧バグ。
    //     startsWith を伴わない単純な k !== CACHE フィルタが残っていないことを確認。
    expect(code).not.toMatch(/\.filter\s*\(\s*\([^)]*\)\s*=>\s*\w+\s*!==\s*CACHE\s*\)/);
  });

  it('オフライン時のキャッシュ fallback 構造を保持している', () => {
    expect(code).toContain('caches.match(e.request)');
    // fetch 失敗時にキャッシュへ倒れる catch が存在する (改行整形の揺れを許容)。
    expect(code).toMatch(/\.catch\(\(\) =>\s*caches\s*\.\s*match\(/);
  });
});

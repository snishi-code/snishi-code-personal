// @vitest-environment node
// sw.template.js の静的歩哨テスト: 凍結更新ポリシーが崩されていないことをソース文字列で監視する。
// node 環境で動かすのは import.meta.url が file: URL になり readFileSync でパス解決できるため。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const src = readFileSync(new URL('./sw.template.js', import.meta.url), 'utf8');
// 「実行されるコード」のみを見る: 禁止 API 名は不変性の説明コメントには現れてよい。
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

describe('sw.template.js (凍結 SW ポリシーの歩哨)', () => {
  it('更新系 API をコードに含まない (skipWaiting / clients.claim / registration.update)', () => {
    expect(code).not.toMatch(/skipWaiting/);
    expect(code).not.toMatch(/clients\s*\.\s*claim/);
    expect(code).not.toMatch(/registration\s*\.\s*update/);
    expect(code).not.toMatch(/updatefound/);
  });

  it('不変性 (変更厳禁) コメントブロックを保持している', () => {
    expect(src).toContain('変更厳禁');
    // 禁止 API の列挙と狙いの説明が残っていること (コメントとして)。
    expect(src).toContain('skipWaiting');
    expect(src).toContain('clients.claim');
    expect(src).toContain('registration.update');
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

  it('cache-first + SPA shell fallback の構造を保持している', () => {
    expect(code).toContain('caches.match(e.request)');
    expect(code).toMatch(/\.catch\(\(\) => caches\.match\(/);
  });
});

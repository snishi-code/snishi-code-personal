// 静的境界ガードのスキャナ (テスト専用・Node 環境)。
//
// 「ディレクトリ X 配下のソースは シンボル群 Y に触れない」という安全境界を、ソース文字列の
// 機械検査で強制するためのヘルパ。hospital-workspace の roundsSurfaceBoundary.test.ts
// (回診 surface は AI capability に到達しない) を一般化したもの (2026-07-06)。
//
// 意図的に素朴な grep 方式にする: コメント内の禁止語もヒットする (=「その語を書くこと自体を
// 議論させる」ガード)。AST は使わない。実行時バンドルから import しないこと (node:fs 依存)。

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface BoundaryScanOptions {
  /** 走査するルートディレクトリ (絶対パス)。 */
  dir: string;
  /** 禁止パターン。1 つでもヒットしたファイルは違反。 */
  forbidden: readonly RegExp[];
  /**
   * 除外するファイルの判定 (絶対パスを受ける)。既定はテストファイル
   * (.test.ts / .test.tsx) を除外する (ガードのリテラルを含むため)。
   */
  excludeFile?: (path: string) => boolean;
  /** 対象拡張子の判定。既定は .ts / .tsx。 */
  includeFile?: (path: string) => boolean;
}

function listFiles(dir: string, includeFile: (p: string) => boolean): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listFiles(full, includeFile));
    else if (includeFile(full)) out.push(full);
  }
  return out;
}

/**
 * dir 配下を走査し、禁止パターンにヒットした `"<file>: <pattern>"` の一覧を返す。
 * テスト側は `expect(scanBoundary(...)).toEqual([])` とだけ書けばよい。
 */
export function scanBoundary(opts: BoundaryScanOptions): string[] {
  const includeFile = opts.includeFile ?? ((p) => /\.tsx?$/.test(p));
  const excludeFile = opts.excludeFile ?? ((p) => /\.test\.tsx?$/.test(p));
  const offenders: string[] = [];
  for (const file of listFiles(opts.dir, includeFile)) {
    if (excludeFile(file)) continue;
    const src = readFileSync(file, 'utf8');
    for (const re of opts.forbidden) {
      if (re.test(src)) offenders.push(`${file}: ${re}`);
    }
  }
  return offenders;
}

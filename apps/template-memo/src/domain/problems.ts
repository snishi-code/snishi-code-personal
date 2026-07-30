// プロブレムリスト (患者ごとの独立データ) の純データロジック。
//
// 仕様:
//   - patient.problems = string[] (病名・問題名)。フォーマット/設定とは完全に別領域。
//   - `#1` 等の番号はユーザー入力でも保存値でもなく、配列順から表示時に自動付与する。
//     行を削除したら下の行が詰まり、番号は表示順で再採番される。
//   - 出力用の合成 (空行を出さず `#1 HF` の形にする) は domain/template.ts の
//     composeProblems が正本。ここは保存値の読み出し/判定だけを持つ。
//   - 将来構想: A 欄などから `#1 HF` の形で参照・挿入できるよう string[] のまま保持する
//     (単一の巨大 textarea にしない)。

import type { Patient } from './types';

/** 保存値から正規化したプロブレム配列を読む (不正値は除外)。 */
export function readProblems(patient: Patient | null | undefined): string[] {
  const arr = patient && Array.isArray(patient.problems) ? patient.problems : [];
  return arr.filter((x): x is string => typeof x === 'string');
}

/** 1 行でも実入力 (空白以外) があるか。空患者判定・QR 出力判定に使う。 */
export function problemsHaveInput(problems: readonly unknown[] | null | undefined): boolean {
  return Array.isArray(problems) && problems.some((x) => String(x ?? '').trim() !== '');
}

/*
 * 導出行（metadata.virtual = true）の「起票元」の単一正本。
 *
 * 導出行は保存されない計算値だが、画面ではタップできる＝どの宣言から生まれたかを解決する必要が
 * ある。この対応表を画面ごとに手書きすると、種類が増えたときに片方だけ更新され「一方は黙って
 * 行を捨て、もう一方は空 ID で誤遷移する」状態になる（実際に投資の利回り投影で起きた）。
 * 解決はこの純関数 1 本に集約し、消費側（仕訳一覧・タイムライン）は結果を分岐するだけにする。
 *
 * 種類を増やすときはここへ 1 つ足す。戻り値が union なので、消費側の分岐漏れは型で落ちる。
 */
import type { JournalEntry } from './types';

export type DerivedEntryOrigin =
  /** 定期ルールの未起票投影 → そのルール。 */
  | { kind: 'recurringRule'; recurringRuleId: string }
  /** 継続コストの月割り行 → その項目。 */
  | { kind: 'monthlyCost'; monthlyCostId: string }
  /** 投資の利回り投影 → その利回りを宣言した投資科目。 */
  | { kind: 'investmentAccount'; accountId: string }
  /** 残高補正の按分スライス → その差額を宣言した補正仕訳（stored・一覧には出ない）。 */
  | { kind: 'adjustmentEntry'; entryId: string };

/**
 * 導出行の起票元。実仕訳（virtual でない）と、由来を名乗らない導出行は undefined。
 * undefined は「開く先が無い」であって、既定の遷移先へ流してはいけない。
 */
export function derivedEntryOrigin(entry: JournalEntry): DerivedEntryOrigin | undefined {
  const metadata = entry.metadata;
  if (metadata?.virtual !== true) return undefined;
  if (metadata.recurringRuleId !== undefined) {
    return { kind: 'recurringRule', recurringRuleId: metadata.recurringRuleId };
  }
  if (metadata.continuousCostId !== undefined) {
    return { kind: 'monthlyCost', monthlyCostId: metadata.continuousCostId };
  }
  if (metadata.investmentProjectionOf !== undefined) {
    return { kind: 'investmentAccount', accountId: metadata.investmentProjectionOf };
  }
  if (metadata.adjustmentSliceOf !== undefined) {
    return { kind: 'adjustmentEntry', entryId: metadata.adjustmentSliceOf };
  }
  return undefined;
}

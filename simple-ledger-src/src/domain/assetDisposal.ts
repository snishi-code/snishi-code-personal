/*
 * 固定資産の売却・故障処分の純粋ロジック（残存額・損益計算）。
 *
 * 固定資産の月額化は永続仕訳ではなく MonthlyCostItem の formula で生活コストを見る分析レイヤ。
 * 処分時の損益は購入額そのものではなく、まだ生活コストとして認識していない残り（remainingAmount）を
 * 基準にする。詳細は docs/dev/fixed-asset-disposal.md を参照。
 *
 * ここは UI プレビューと repository（仕訳生成）の双方から使う純粋関数のみを置く。
 * 勘定科目 ID を引く処理（仕訳の組み立て）は repository 側に置く。
 */
import { monthlyAmounts, monthsBetween } from './allocation';
import type { MonthlyCostItem } from './types';

/** 処分時、認識済み残高の消し込み先（system-adjustment）。生活コストには含めない。 */
export const DISPOSAL_ADJUSTMENT_ACCOUNT_NAME = '月額化累計調整';
/** 売却益の既定計上先（income-category）。 */
export const DISPOSAL_GAIN_ACCOUNT_NAME = 'その他収入';
/** 売却損の既定計上先（expense-category）。生活コストに含める。 */
export const DISPOSAL_LOSS_ACCOUNT_NAME = 'その他支出';

/**
 * `startMonth` から処分月の前月までに formula で認識済みの合計。
 * status の影響を受けない（一時停止していても、その期間に「認識されていたはずの額」を基準にする）。
 * 固定資産は 1 回限り（repeat なし）を前提に、月割り配分の先頭から認識月数ぶんを合算する。
 */
export function computeRecognizedAmount(item: MonthlyCostItem, disposalMonth: string): number {
  const elapsed = monthsBetween(item.startMonth, disposalMonth); // 処分月までの経過月数
  const recognizedMonths = Math.max(0, Math.min(elapsed, item.costMonths));
  const amounts = monthlyAmounts(item.amount, item.costMonths);
  return amounts.slice(0, recognizedMonths).reduce((s, a) => s + a, 0);
}

export interface DisposalOutcome {
  recognizedAmount: number;
  remainingAmount: number;
  /** 売却益（proceeds > remaining のときのみ正）。 */
  gain: number;
  /** 売却損（proceeds < remaining のときのみ正）。故障・廃棄(proceeds=0)は remaining が損。 */
  loss: number;
}

/** 処分月と売却額から、認識済み・残存・損益を求める。 */
export function disposalOutcome(
  item: MonthlyCostItem,
  disposalMonth: string,
  proceedsAmount: number,
): DisposalOutcome {
  const recognizedAmount = computeRecognizedAmount(item, disposalMonth);
  const remainingAmount = Math.max(item.amount - recognizedAmount, 0);
  const gain = Math.max(proceedsAmount - remainingAmount, 0);
  const loss = Math.max(remainingAmount - proceedsAmount, 0);
  return { recognizedAmount, remainingAmount, gain, loss };
}

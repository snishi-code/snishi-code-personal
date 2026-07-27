/*
 * 継続コスト（資産経由モデル）の仮想展開エンジン — **実績動的償却**。
 *
 * 継続コスト台帳（MonthlyCostItem）を「ルール辞書」とみなし、100 年ぶんの実仕訳を作らず、
 * 必要範囲（upTo）だけ仮想仕訳を導出する。1 サイクルにつき:
 *  - funding（資産化）: `借方 対象資産 / 貸方 支払い元`（cycle 先頭月の 1 日・サイクル額の全額）
 *  - recognition（認識）: `借方 認識先 / 貸方 対象資産`（各認識月の月初）
 *
 * 認識のスケジュールは monthlyCost.ts の実績動的償却規則（単一正本）に従う:
 *  - 更新なし・使用中: 見込みを超えたら経過月数で全期間を再配分（過去に遡って月額が下がる）
 *  - 終了済み: 実使用月数で再配分し売却額を控除（売却損益の一括計上はしない）
 *  - 更新あり: 各サイクル固定。最終サイクルだけ解約時に切り詰め
 * 過去の再配分が仕訳の書き換えなしで成立するのは、仮想仕訳が**保存されない導出**だから。
 * `reportEntriesForAsOf` の結果だけに現れ、実仕訳・保存系・export には混ぜない。
 */
import { addMonths, monthlyAmounts, monthsBetween } from './allocation';
import { cycleSpreadMonths, cycleSpreadTotal } from './monthlyCost';
import type { Account, JournalEntry, MonthlyCostItem } from './types';

/** 仮想展開の暫定上限（無限ループ防止・極端な未来クエリの安全弁）。 */
export const CONTINUOUS_COST_HARD_CAP = '2100-12-31';

/** この item が資産経由の継続コスト対象か（recognitionCreditAccountId が continuing-cost-asset）。 */
export function isContinuingCostItem(
  item: MonthlyCostItem,
  accountsById: Map<string, Account>,
): boolean {
  if (!item.recognitionCreditAccountId) return false;
  return accountsById.get(item.recognitionCreditAccountId)?.role === 'continuing-cost-asset';
}

/**
 * 1 つの継続コスト対象 item を、upTo までの仮想仕訳列に展開する。
 * todayYm は動的償却の「いま」（未指定は upTo の月）。
 * 対象でない item・支払い元/対象資産が欠ける item は空配列。
 */
export function continuousCostEntriesForItem(
  item: MonthlyCostItem,
  accountsById: Map<string, Account>,
  upTo: string,
  todayYm: string = upTo.slice(0, 7),
): JournalEntry[] {
  // status だけで過去の資産化・認識を消さない（pause/ended は「未来を止める」＝ `endMonth` で表す）。
  if (!isContinuingCostItem(item, accountsById)) return [];
  const assetId = item.recognitionCreditAccountId;
  const payId = item.paymentSourceAccountId;
  if (!assetId || !payId) return [];

  const cap = upTo < CONTINUOUS_COST_HARD_CAP ? upTo : CONTINUOUS_COST_HARD_CAP;
  const repeat =
    item.repeatEveryMonths && item.repeatEveryMonths > 0 ? item.repeatEveryMonths : undefined;
  const out: JournalEntry[] = [];

  // サイクル: c=0,1,2,… funding 月 = startMonth + c*repeat（単発は c=0 のみ）。
  for (let c = 0; c < 6000; c++) {
    const cycleYm = repeat ? addMonths(item.startMonth, c * repeat) : item.startMonth;
    const fundingDate = `${cycleYm}-01`;
    if (fundingDate > cap) break;
    if (item.endMonth && cycleYm > item.endMonth) break;

    // funding: 借方 対象資産 / 貸方 支払い元（サイクル額の全額。売却額の控除は認識側で行い、
    // 台帳に残る売却額ぶんは処分時の実仕訳＝入金先への振替で相殺される）。
    out.push({
      id: `cc-fund-${item.id}-${cycleYm}`,
      date: fundingDate,
      description: item.name,
      kind: 'normal',
      managementScopeId: item.managementScopeId,
      lines: [
        { accountId: assetId, side: 'debit', amount: item.amount },
        { accountId: payId, side: 'credit', amount: item.amount },
      ],
      metadata: { virtual: true, continuousCostId: item.id, ccKind: 'funding' },
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    });

    // recognition: 借方 認識先 / 貸方 対象資産。認識月数・配分総額は実績動的償却の
    // 共通規則（monthlyCost.ts）で決まる。認識日は月初（当月分が現在の集計に反映される）。
    const spreadMonths = cycleSpreadMonths(item, cycleYm, todayYm);
    const amounts = monthlyAmounts(cycleSpreadTotal(item, cycleYm), spreadMonths);
    for (let k = 0; k < spreadMonths; k++) {
      const recogYm = addMonths(cycleYm, k);
      if (item.endMonth && recogYm > item.endMonth) break;
      const recogDate = `${recogYm}-01`;
      if (recogDate > cap) break;
      const amount = amounts[k] ?? 0;
      if (amount === 0) continue; // 売却額控除で 0 になった月は行を出さない
      out.push({
        id: `cc-recog-${item.id}-c${c}-${k}`,
        date: recogDate,
        description: item.name,
        kind: 'normal',
        managementScopeId: item.managementScopeId,
        lines: [
          { accountId: item.expenseAccountId, side: 'debit', amount },
          { accountId: assetId, side: 'credit', amount },
        ],
        metadata: { virtual: true, continuousCostId: item.id, ccKind: 'recognition' },
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      });
    }

    if (!repeat) break; // 単発（償却のみ）は 1 サイクル。
  }
  return out;
}

/** 全 item の仮想仕訳（funding/recognition）を upTo まで展開して連結する。 */
export function continuousCostEntries(
  items: MonthlyCostItem[],
  accounts: Account[],
  upTo: string,
  todayYm: string = upTo.slice(0, 7),
): JournalEntry[] {
  const byId = new Map(accounts.map((a) => [a.id, a] as const));
  return items.flatMap((it) => continuousCostEntriesForItem(it, byId, upTo, todayYm));
}

/** 実仕訳 + 継続コストの仮想仕訳（導出専用の単一正本）。 */
export function entriesWithContinuousCost(
  real: JournalEntry[],
  items: MonthlyCostItem[],
  accounts: Account[],
  upTo: string,
  todayYm: string = upTo.slice(0, 7),
): JournalEntry[] {
  return [...real, ...continuousCostEntries(items, accounts, upTo, todayYm)];
}

/* ── 売却・解約による終了（0円売却 = 解約・故障） ── */

/**
 * 処分時に項目へ立てる終了月。処分月まで使ったものとして数える（実績動的償却では
 * 「実際に使った期間」が配分の分母になるため）。既に endMonth がそれより前ならそちらを保つ。
 */
export function continuousCostDisposalEndMonth(
  item: MonthlyCostItem,
  disposalMonth: string,
): string {
  return item.endMonth !== undefined && item.endMonth < disposalMonth
    ? item.endMonth
    : disposalMonth;
}

export interface ContinuousCostDisposalOutcome {
  /** 処分までに資産化（funding）された総額（全サイクル）。 */
  fundedAmount: number;
  /** 最終サイクルの実使用月数（＝再配分の分母）。 */
  usedMonths: number;
  /** 再計算後の最終サイクル月あたり（先頭月額）。 */
  monthlyAfter: number;
  /** 台帳から入金先へ移る額 = min(売却額, 最終サイクル額)。 */
  inflow: number;
  /** 売却益 = 売却額が最終サイクル額を超えた分（超過時のみ実仕訳で計上）。 */
  gain: number;
}

/**
 * 継続コストの売却・解約時の精算プレビュー（実績動的償却）。
 * 損益の一括計上はせず、最終サイクルを「実使用月数・売却額控除」で再配分した月額を返す。
 */
export function continuousCostDisposalOutcome(
  item: MonthlyCostItem,
  _accountsById: Map<string, Account>,
  disposalMonth: string,
  proceedsAmount: number,
): ContinuousCostDisposalOutcome {
  const endMonth = continuousCostDisposalEndMonth(item, disposalMonth);
  const repeat =
    item.repeatEveryMonths && item.repeatEveryMonths > 0 ? item.repeatEveryMonths : undefined;
  const cycles = repeat ? Math.floor(monthsBetween(item.startMonth, endMonth) / repeat) + 1 : 1;
  const cycleYm = repeat ? addMonths(item.startMonth, (cycles - 1) * repeat) : item.startMonth;
  const inflow = Math.min(proceedsAmount, item.amount);
  const gain = Math.max(proceedsAmount - item.amount, 0);
  // 処分後の姿（status='ended'）で認識規則を評価する＝実使用月数への遡及再配分。
  const probe: MonthlyCostItem = {
    ...item,
    endMonth,
    status: 'ended',
    ...(inflow > 0 ? { disposalProceedsAmount: inflow } : {}),
  };
  const usedMonths = cycleSpreadMonths(probe, cycleYm, endMonth);
  const monthlyAfter =
    usedMonths > 0 ? (monthlyAmounts(cycleSpreadTotal(probe, cycleYm), usedMonths)[0] ?? 0) : 0;
  return {
    fundedAmount: Math.max(cycles, 0) * item.amount,
    usedMonths,
    monthlyAfter,
    inflow,
    gain,
  };
}

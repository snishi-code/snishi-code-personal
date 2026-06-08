/*
 * 継続コスト（資産経由モデル）の仮想展開エンジン。
 *
 * 継続コスト台帳（MonthlyCostItem）を「ルール辞書」とみなし、100 年ぶんの実仕訳を作らず、
 * 必要範囲（upTo）だけ仮想仕訳を導出する。1 サイクルにつき:
 *  - funding（資産化）: `借方 対象資産 / 貸方 支払い元`（cycle 先頭月の 1 日）
 *  - recognition（認識）×costMonths: `借方 費用カテゴリ / 貸方 対象資産`（各認識月の月末日）
 * funding が recognition より必ず先行するので、各時点 BS で対象資産残高 >= 0（= 未認識残高）。
 *
 * 仮想仕訳は `metadata.virtual` を持ち、**保存されない導出専用**。`Ledger.derivedEntries` だけに現れ、
 * 実仕訳(`journalEntries`)・保存系・export には混ぜない（型と生成箇所で分離）。
 */
import { addMonths, monthlyAmounts } from './allocation';
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
 * 対象でない item・active でない item・支払い元/対象資産が欠ける item は空配列。
 */
export function continuousCostEntriesForItem(
  item: MonthlyCostItem,
  accountsById: Map<string, Account>,
  upTo: string,
): JournalEntry[] {
  // status だけで過去の資産化・認識を消さない（pause/ended は「未来を止める」＝ `endMonth` で表す）。
  // 一時停止/終了は endMonth を立てて過去（<= endMonth）を保持し、未来サイクルだけ止める。
  if (!isContinuingCostItem(item, accountsById)) return [];
  const assetId = item.recognitionCreditAccountId;
  const payId = item.paymentSourceAccountId;
  if (!assetId || !payId) return [];

  const cap = upTo < CONTINUOUS_COST_HARD_CAP ? upTo : CONTINUOUS_COST_HARD_CAP;
  const repeat =
    item.repeatEveryMonths && item.repeatEveryMonths > 0 ? item.repeatEveryMonths : undefined;
  const amounts = monthlyAmounts(item.amount, item.costMonths);
  const out: JournalEntry[] = [];

  // サイクル: c=0,1,2,… funding 月 = startMonth + c*repeat（単発は c=0 のみ）。
  for (let c = 0; c < 6000; c++) {
    const cycleYm = repeat ? addMonths(item.startMonth, c * repeat) : item.startMonth;
    const fundingDate = `${cycleYm}-01`;
    if (fundingDate > cap) break;
    if (item.endMonth && cycleYm > item.endMonth) break;

    // funding: 借方 対象資産 / 貸方 支払い元。
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

    // recognition ×costMonths: 借方 費用カテゴリ / 貸方 対象資産。
    // 認識日は「その月が始まったら計上」する月初(YYYY-MM-01)。当月分が現在の集計に反映され、
    // 未来月は upTo(=今) で切れる（funding と同日でも資産は funding − recognition >= 0）。
    for (let k = 0; k < item.costMonths; k++) {
      const recogYm = addMonths(cycleYm, k);
      if (item.endMonth && recogYm > item.endMonth) break;
      const recogDate = `${recogYm}-01`;
      if (recogDate > cap) break;
      out.push({
        id: `cc-recog-${item.id}-${recogYm}`,
        date: recogDate,
        description: item.name,
        kind: 'normal',
        managementScopeId: item.managementScopeId,
        lines: [
          { accountId: item.expenseAccountId, side: 'debit', amount: amounts[k] ?? 0 },
          { accountId: assetId, side: 'credit', amount: amounts[k] ?? 0 },
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
): JournalEntry[] {
  const byId = new Map(accounts.map((a) => [a.id, a] as const));
  return items.flatMap((it) => continuousCostEntriesForItem(it, byId, upTo));
}

/** 実仕訳 + 継続コストの仮想仕訳（導出専用の単一正本）。 */
export function entriesWithContinuousCost(
  real: JournalEntry[],
  items: MonthlyCostItem[],
  accounts: Account[],
  upTo: string,
): JournalEntry[] {
  return [...real, ...continuousCostEntries(items, accounts, upTo)];
}

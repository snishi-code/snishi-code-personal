/*
 * 定期ルール（毎月の支出・収入・振替）の純関数。
 *
 * 方式 = 会計ソフト標準の「実仕訳の自動起票」（GnuCash の Since-Last-Run と同型）:
 *  - ルールは起票の道具で、正本は起票された実仕訳（明細照合・個別月の編集ができる）。
 *  - アプリ起動時に経過月ぶんをキャッチアップ起票する（idempotent）。
 *  - 起票済み管理はルール側のカーソル（postedThroughMonth）で行う。ユーザーが起票済み
 *    仕訳を削除しても再起票しない（「今月はスキップ」を尊重する）。
 *  - 停止中は起票しない。再開時は startMonth を現在月へ更新し、停止中の月を遡って起票しない。
 * 継続コスト（費用の月割り認識 = 導出レイヤ）とは別概念で、こちらは実際の資金移動を扱う。
 */
import { addMonths, monthOf, monthsBetween } from './allocation';
import { ACCOUNT_ROLES, isInternalRole, type AccountRole } from './accountRoles';
import type { Account, InputMode, JournalEntry, RecurringRule } from './types';

/** 表示用の種別（保存しない。勘定の役割から導出する）。 */
export type RecurringKind = 'expense' | 'income' | 'transfer';

/**
 * 定期ルールが毎月自動起票してよい科目の役割（「簿記編集」モードで任意ペアを許すときの正本）。
 * 内部集約（継続コスト台帳・目的別資金集約）と残高調整科目は除外する＝これらは導出エンジンや
 * 補正が所有しており、実仕訳を毎月ぶつけると残高の意味が壊れるため（fail-closed）。
 * 保存境界(repository)・import 検証(schema)・入力シートの科目候補が同じ正本を参照する。
 */
export const RECURRING_POSTABLE_ROLES: readonly AccountRole[] = ACCOUNT_ROLES.filter(
  (r) => !isInternalRole(r) && r !== 'system-adjustment',
);

/** この役割の科目を定期ルールの借方/貸方に使ってよいか。 */
export function isRecurringPostableRole(role: AccountRole | undefined): boolean {
  return role !== undefined && RECURRING_POSTABLE_ROLES.includes(role);
}

/**
 * 借方/貸方の役割から種別を導出する。許可されない組み合わせは null。
 *  - 支出: 貸方 資金(daily) or カード(payment-liability) → 借方 費用カテゴリ
 *  - 収入: 貸方 収入カテゴリ → 借方 資金(daily)
 *  - 振替: 貸方 資金(daily) → 借方 資金(daily) or 投資（積立）
 */
export function recurringKindOf(
  debitRole: AccountRole | undefined,
  creditRole: AccountRole | undefined,
): RecurringKind | null {
  if (!debitRole || !creditRole) return null;
  if (
    debitRole === 'expense-category' &&
    (creditRole === 'daily-asset' || creditRole === 'payment-liability')
  )
    return 'expense';
  if (creditRole === 'income-category' && debitRole === 'daily-asset') return 'income';
  if (
    creditRole === 'daily-asset' &&
    (debitRole === 'daily-asset' || debitRole === 'investment-asset')
  )
    return 'transfer';
  return null;
}

/** 「毎月 day 日」を月内へクランプした日付（31 → 2月なら月末）。 */
export function clampDayToMonth(ym: string, day: number): string {
  const [y, m] = ym.split('-');
  const lastDay = new Date(Number.parseInt(y ?? '0', 10), Number.parseInt(m ?? '0', 10), 0)
    .getDate();
  return `${ym}-${String(Math.min(day, lastDay)).padStart(2, '0')}`;
}

/** 暴走防止の上限（起票対象月数。100 年ぶんを超える範囲は扱わない）。 */
const CATCH_UP_HARD_CAP_MONTHS = 1200;

export interface RecurringPosting {
  month: string; // 'YYYY-MM'
  date: string; // 起票日（クランプ済み）
}

/**
 * 今日までに起票すべき月を列挙する。
 *  - 対象 = startMonth 〜 今日の月のうち、起票日がすでに到来していて（date <= today）、
 *    カーソル（postedThroughMonth）より後の月。
 *  - 停止中は空。まだ起票日が来ていない当月は含めない（到来した次回起動で起票される）。
 */
export function recurringPostingsDue(rule: RecurringRule, today: string): RecurringPosting[] {
  if (rule.paused) return [];
  const currentYm = monthOf(today);
  const span = monthsBetween(rule.startMonth, currentYm);
  if (span < 0) return [];
  const out: RecurringPosting[] = [];
  const count = Math.min(span + 1, CATCH_UP_HARD_CAP_MONTHS);
  for (let i = 0; i < count; i++) {
    const month = addMonths(rule.startMonth, i);
    if (rule.postedThroughMonth !== undefined && month <= rule.postedThroughMonth) continue;
    const date = clampDayToMonth(month, rule.dayOfMonth);
    if (date > today) break; // 起票日が未到来（以降の月も未来）
    out.push({ month, date });
  }
  return out;
}

/**
 * 選択した基準日までの、未起票分を表示専用の仮想仕訳として投影する。
 * 永続化とカーソル更新は行わず、postedThroughMonth より後だけを出すため実仕訳と二重計上しない。
 */
export function recurringProjectionEntries(
  rules: RecurringRule[],
  accounts: Account[],
  asOf: string,
): JournalEntry[] {
  const byId = new Map(accounts.map((account) => [account.id, account] as const));
  const projected: JournalEntry[] = [];
  for (const rule of rules) {
    const debit = byId.get(rule.debitAccountId);
    const credit = byId.get(rule.creditAccountId);
    if (!debit || !credit) continue;
    if (!isRecurringPostableRole(debit.role) || !isRecurringPostableRole(credit.role)) continue;
    const inputMode: InputMode = recurringKindOf(debit.role, credit.role) ?? 'manual';
    for (const posting of recurringPostingsDue(rule, asOf)) {
      projected.push({
        id: `rec-proj-${rule.id}-${posting.month}`,
        date: posting.date,
        description: rule.name,
        kind: 'normal',
        managementScopeId: rule.managementScopeId,
        lines: [
          { accountId: rule.debitAccountId, side: 'debit', amount: rule.amount },
          { accountId: rule.creditAccountId, side: 'credit', amount: rule.amount },
        ],
        metadata: {
          virtual: true,
          inputMode,
          recurringRuleId: rule.id,
          recurringMonth: posting.month,
        },
        createdAt: rule.createdAt,
        updatedAt: rule.updatedAt,
      });
    }
  }
  return projected;
}

/** キャッチアップ後にルールへ書き戻すカーソル（起票日が到来した最後の月）。 */
export function recurringCursorAfter(rule: RecurringRule, today: string): string | undefined {
  if (rule.paused) return rule.postedThroughMonth;
  const currentYm = monthOf(today);
  if (monthsBetween(rule.startMonth, currentYm) < 0) return rule.postedThroughMonth;
  // 当月の起票日が未到来なら前月まで、到来済みなら当月まで。
  const currentDue = clampDayToMonth(currentYm, rule.dayOfMonth) <= today;
  const through = currentDue ? currentYm : addMonths(currentYm, -1);
  if (through < rule.startMonth) return rule.postedThroughMonth;
  if (rule.postedThroughMonth !== undefined && through <= rule.postedThroughMonth) {
    return rule.postedThroughMonth;
  }
  return through;
}

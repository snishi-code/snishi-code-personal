/*
 * 定期ルール（くり返し記帳）の純関数。
 *
 * 方式 = 会計ソフト標準の「実仕訳の自動起票」（GnuCash の Since-Last-Run と同型）:
 *  - ルールは起票の道具で、正本は起票された実仕訳（明細照合・個別月の編集ができる）。
 *  - アプリ起動時に経過月ぶんをキャッチアップ起票する（idempotent）。
 *  - 起票済み管理はルール側のカーソル（postedThroughMonth）で行う。ユーザーが起票済み
 *    仕訳を削除しても再起票しない（「今月はスキップ」を尊重する）。
 *  - 停止中は起票しない。再開時は startMonth を書き換えず（周期の位相を保つ）、
 *    postedThroughMonth を前月に置いて停止中の月を遡って起票しない（repository 側）。
 *  - everyMonths（必須。1 = 毎月）で間引く。位相は startMonth 基点。
 *  - spreadExpenseAccountId を持つルールは**月割りするルール**（継続コスト化）:
 *    起票は `借方 継続コスト台帳 / 貸方 源泉` + item 自動生成（repository 側）。
 *    投影もここで購入行 + 費用行（cc-recogp）を両方出す＝未来断面で台帳が積み上がらない。
 */
import { addMonths, monthOf, monthsBetween } from './allocation';
import { ACCOUNT_ROLES, isInternalRole, type AccountRole } from './accountRoles';
import { CONTINUOUS_COST_LEDGER_ACCOUNT_ID } from './constants';
import { continuousCostEntriesForItem } from './continuousCost';
import type { Account, InputMode, JournalEntry, MonthlyCostItem, RecurringRule } from './types';

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
  const every = rule.everyMonths >= 1 ? rule.everyMonths : 1;
  for (let i = 0; i < count; i++) {
    if (i % every !== 0) continue; // startMonth 基点の位相で間引く
    const month = addMonths(rule.startMonth, i);
    if (rule.postedThroughMonth !== undefined && month <= rule.postedThroughMonth) continue;
    const date = clampDayToMonth(month, rule.dayOfMonth);
    if (date > today) break; // 起票日が未到来（以降の月も未来）
    out.push({ month, date });
  }
  return out;
}

/* ── 月割りするルール（spreadExpenseAccountId あり）が自動生成する item ── */

/** ルール生成 item の決定的 ID。由来メタは持たない（ID が由来を符号化する）。 */
export function ruleItemId(ruleId: string, month: string): string {
  return `ccr-${ruleId}-${month}`;
}

/**
 * ルール生成 item の終了日 = 周期がカバーする最終月の末日（厳密式）。
 * 「起票日 + 周期 − 1日」は day=1 のときしか一致しない（13ヶ月配分になる）ので使わない。
 */
export function ruleItemEndDate(postingMonth: string, everyMonths: number): string {
  return clampDayToMonth(addMonths(postingMonth, everyMonths - 1), 31);
}

/**
 * 月割りするルールの 1 起票ぶんの item を組み立てる。startDate = 起票日（購入の仕訳の日付）。
 * ルール生成 item の endDate は必ず埋まる（周期が分かっているので計算できる）。
 */
export function buildRuleItem(
  rule: RecurringRule,
  posting: RecurringPosting,
  ts: { createdAt: string; updatedAt: string },
): MonthlyCostItem | null {
  if (rule.spreadExpenseAccountId === undefined) return null;
  return {
    id: ruleItemId(rule.id, posting.month),
    name: rule.name,
    amount: rule.amount,
    startDate: posting.date,
    endDate: ruleItemEndDate(posting.month, rule.everyMonths),
    expenseAccountId: rule.spreadExpenseAccountId,
    createdAt: ts.createdAt,
    updatedAt: ts.updatedAt,
  };
}

/**
 * 選択した基準日までの、未起票分を表示専用の仮想仕訳として投影する。
 * 永続化とカーソル更新は行わず、postedThroughMonth より後だけを出すため実仕訳と二重計上しない。
 *
 * 月割りするルール（spreadExpenseAccountId あり）は購入行に加えて**費用行も投影する**
 * （`cc-recogp-{ruleId}-{postingMonth}-{YYYY-MM}`）。これを落とすと未来断面で
 * 継続コスト台帳が購入行ぶんだけ積み上がり、純資産が実在しない額まで膨らむ。
 * 二重展開はしない: 起票済み月は item 側（continuousCostEntries）が展開し、
 * ここはカーソルより後の月だけを出す。
 */
export function recurringProjectionEntries(
  rules: RecurringRule[],
  accounts: Account[],
  asOf: string,
): JournalEntry[] {
  const byId = new Map(accounts.map((account) => [account.id, account] as const));
  const projected: JournalEntry[] = [];
  for (const rule of rules) {
    const spread = rule.spreadExpenseAccountId !== undefined;
    const debit = byId.get(rule.debitAccountId);
    const credit = byId.get(rule.creditAccountId);
    if (!debit || !credit) continue;
    if (!isRecurringPostableRole(credit.role)) continue;
    // 月割りルールの借方は継続コスト台帳に固定（postable ではないので別枠で検証する）。
    if (spread) {
      if (rule.debitAccountId !== CONTINUOUS_COST_LEDGER_ACCOUNT_ID) continue;
    } else if (!isRecurringPostableRole(debit.role)) {
      continue;
    }
    // recurringKindOf(continuing-cost-asset, …) は null を返すため、月割りルールは 'expense' 直指定。
    const inputMode: InputMode = spread
      ? 'expense'
      : (recurringKindOf(debit.role, credit.role) ?? 'manual');
    for (const posting of recurringPostingsDue(rule, asOf)) {
      projected.push({
        id: `rec-proj-${rule.id}-${posting.month}`,
        date: posting.date,
        description: rule.name,
        kind: 'normal',
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
      if (spread) {
        const ephemeral = buildRuleItem(rule, posting, {
          createdAt: rule.createdAt,
          updatedAt: rule.updatedAt,
        });
        if (ephemeral) {
          // id を `{ruleId}-{postingMonth}` にすると費用行 ID が
          // `cc-recogp-{ruleId}-{postingMonth}-{YYYY-MM}` になる（item 由来の cc-recog と衝突しない）。
          // metadata に recurringRuleId を足す＝仕訳一覧のタップでルールへ飛べる（投影 item は実在しないため）。
          projected.push(
            ...continuousCostEntriesForItem(
              { ...ephemeral, id: `${rule.id}-${posting.month}` },
              asOf,
              ephemeral.amount,
              'cc-recogp',
            ).map((e) => ({
              ...e,
              metadata: { ...e.metadata, recurringRuleId: rule.id, recurringMonth: posting.month },
            })),
          );
        }
      }
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

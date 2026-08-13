/*
 * 定期ルール（くり返し記帳）の純関数。
 *
 * 方式 = 会計ソフト標準の「実仕訳の自動起票」（GnuCash の Since-Last-Run と同型）:
 *  - ルールは起票の道具で、正本は起票された実仕訳（明細照合・個別月の編集ができる）。
 *  - アプリ起動時に経過月ぶんをキャッチアップ起票する（idempotent）。
 *  - 起票済み管理はルール側のカーソル（postedThroughMonth）で行う。ユーザーが起票済み
 *    仕訳を削除しても再起票しない（「今月はスキップ」を尊重する）。
 *  - everyMonths（必須。1 = 毎月）で間引く。位相は startMonth 基点。
 *  - 行き先が費用科目または収入科目（差引形 = 給与から差し引く保険料など）のルールは
 *    **必ず継続コスト化**する:
 *    起票は `借方 継続コスト台帳 / 貸方 源泉` + item 自動生成（repository 側）。
 *    投影もここで購入行 + 月割り行（cc-allocp）を両方出す＝未来断面で台帳が積み上がらない。
 *  - spreadExpenseAccountId は正規化済みの計上先（費用/収入）の保存表現。それ以外の
 *    行き先は借方へ直接起票する。v7 はこの二形だけを受理する。
 */
import { addMonths, monthOf, monthsBetween } from './allocation';
import { ACCOUNT_ROLES, isInternalRole, type AccountRole } from './accountRoles';
import { CONTINUOUS_COST_LEDGER_ACCOUNT_ID } from './constants';
import { continuousCostEntriesForItem } from './continuousCost';
import { ruleItemId } from './recurringIds';
import { CATCH_UP_HARD_CAP_MONTHS } from './recurringLimits';
import {
  accountExistsAt,
  recurringRuleItemEndDate,
  recurringRuleLastExistingDate,
  recurringRuleReferenceStartDate,
  ruleExistsAt,
} from './accountLifetime';
import type { Account, InputMode, JournalEntry, MonthlyCostItem, RecurringRule } from './types';

/** repository/UI 向けの意味が明確な別名。判定の正本は accountLifetime.ruleExistsAt。 */
export const recurringRuleExistsAt = ruleExistsAt;
export { parseRuleEntryId, parseRuleItemId, ruleEntryId, ruleItemId } from './recurringIds';

/** 表示用の種別（保存しない。勘定の役割から導出する）。 */
export type RecurringKind = 'expense' | 'income' | 'transfer';

/**
 * 定期ルールが毎月自動起票してよい科目の役割（「簿記編集」モードで任意ペアを許すときの正本）。
 * 内部集約（継続コスト台帳）と残高調整科目は除外する＝これらは導出エンジンや
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
 * 画面・保存・起票で使うルールの論理的な行き先。
 *
 * 正規化済みの月割りルールは debitAccountId が内部台帳なので、利用者が指定した行き先は
 * spreadExpenseAccountId にある。それ以外の正規形は借方がそのまま行き先になる。
 */
export function recurringDestinationAccountId(
  rule: Pick<RecurringRule, 'debitAccountId' | 'spreadExpenseAccountId'>,
): string {
  return rule.spreadExpenseAccountId ?? rule.debitAccountId;
}

/**
 * 継続コスト化（台帳経由の起票）の対象になる行き先 role の正本。
 *  - expense-category: 費用ルール（従来どおり）。
 *  - income-category: 差引形ルール（借方=収入カテゴリ。給与から差し引く保険料など）。
 *    起票形は費用ルールと同一で、月割りが収入のマイナスとして出る。
 * 通常の収入ルール（貸方=income-category・借方=資金）の行き先は daily-asset なので
 * ここには該当しない＝従来どおり直接起票する。振替/積立ルールも同様。
 */
export const RECURRING_SPREAD_DESTINATION_ROLES: readonly AccountRole[] = [
  'expense-category',
  'income-category',
];

/** この役割の科目を行き先に持つルールを継続コスト化（台帳経由）するか。 */
export function isRecurringSpreadDestinationRole(role: AccountRole | undefined): boolean {
  return role !== undefined && RECURRING_SPREAD_DESTINATION_ROLES.includes(role);
}

/**
 * 行き先 role から継続コスト化を自動判定する（spread の有無は判定材料にしない）。
 * 戻り値 = 自動生成 item の計上先（MonthlyCostItem.expenseAccountId。収入科目も入る）。
 */
export function recurringExpenseAccountId(
  rule: Pick<RecurringRule, 'debitAccountId' | 'spreadExpenseAccountId'>,
  roleOf: (accountId: string) => AccountRole | undefined,
): string | undefined {
  const destinationAccountId = recurringDestinationAccountId(rule);
  return isRecurringSpreadDestinationRole(roleOf(destinationAccountId))
    ? destinationAccountId
    : undefined;
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
  const lastDay = new Date(
    Number.parseInt(y ?? '0', 10),
    Number.parseInt(m ?? '0', 10),
    0,
  ).getDate();
  return `${ym}-${String(Math.min(day, lastDay)).padStart(2, '0')}`;
}

/**
 * 指定日まで走査済みにしてよい最後の月。
 * その月の予定日が指定日より後なら前月に留め、未到来の発生を飛ばさない。
 */
export function recurringCursorThroughDate(rule: RecurringRule, date: string): string {
  const month = monthOf(date);
  return clampDayToMonth(month, rule.dayOfMonth) <= date ? month : addMonths(month, -1);
}

/** 暴走防止の上限（1 回の catch-up で走査する月数。超過分は次回の catch-up が続きを処理する）。 */
export { CATCH_UP_HARD_CAP_MONTHS } from './recurringLimits';

export interface RecurringPosting {
  month: string; // 'YYYY-MM'
  date: string; // 起票日（クランプ済み）
}

/**
 * 1 回の catch-up が走査する月 index の範囲 [first, last]（startMonth からの月数）。
 * カーソル（postedThroughMonth）の次の月から最大 CATCH_UP_HARD_CAP_MONTHS か月。
 * recurringPostingsDue と recurringCursorAfter が同じ窓を共有する＝カーソルは走査した
 * 最後の月より先へ進まない（上限を超えた月が「処理済み」になって永久に飛ばされない）。
 */
function catchUpWindow(rule: RecurringRule, today: string): { first: number; last: number } | null {
  // 終了済みルールは排他的終了日の月まで見れば十分。today までカーソル走査を伸ばさない。
  const ended = rule.endDate !== undefined && rule.endDate <= today;
  const horizon = ended ? (recurringRuleLastExistingDate(rule) ?? today) : today;
  const span = monthsBetween(rule.startMonth, monthOf(horizon));
  if (span < 0) return null;
  const first =
    rule.postedThroughMonth !== undefined && rule.postedThroughMonth >= rule.startMonth
      ? monthsBetween(rule.startMonth, rule.postedThroughMonth) + 1
      : 0;
  if (first > span) return null;
  return { first, last: Math.min(span, first + CATCH_UP_HARD_CAP_MONTHS - 1) };
}

/**
 * 今日までに起票すべき月を列挙する。
 *  - 対象 = startMonth 〜 今日の月のうち、起票日がすでに到来し（date <= today）、
 *    ルールの存在期間 [startDate, endDate) に含まれ、カーソルより後の月。
 *  - まだ起票日が来ていない当月は含めない（到来した次回起動で起票される）。
 *  - 1 回に走査するのはカーソルの次から CATCH_UP_HARD_CAP_MONTHS か月まで（catchUpWindow）。
 */
export function recurringPostingsDue(rule: RecurringRule, today: string): RecurringPosting[] {
  const window = catchUpWindow(rule, today);
  if (!window) return [];
  const out: RecurringPosting[] = [];
  const every = rule.everyMonths >= 1 ? rule.everyMonths : 1;
  for (let i = window.first; i <= window.last; i++) {
    if (i % every !== 0) continue; // startMonth 基点の位相で間引く
    const month = addMonths(rule.startMonth, i);
    if (rule.postedThroughMonth !== undefined && month <= rule.postedThroughMonth) continue;
    const date = clampDayToMonth(month, rule.dayOfMonth);
    if (date > today) break; // 起票日が未到来（以降の月も未来）
    if (!ruleExistsAt(rule, date)) continue;
    out.push({ month, date });
  }
  return out;
}

/**
 * ルールの設定（基準日=startMonth+dayOfMonth・周期・存在期間）だけから、最初に起票される
 * 日付を返す。編集シートのプレビュー用（DB・カーソル・today に依存しない）。
 * 規則は recurringPostingsDue と同一: startMonth 基点の位相（i % everyMonths）・
 * clampDayToMonth・存在期間は半開区間 [startDate, endDate)。期間内に起票日が無ければ null。
 */
export function firstRecurringPostingDate(rule: {
  startMonth: string;
  dayOfMonth: number;
  everyMonths: number;
  startDate: string;
  endDate?: string;
}): string | null {
  const every = rule.everyMonths >= 1 ? rule.everyMonths : 1;
  // startDate の月まで位相を保ったまま飛ぶ（1 月ずつ走査しない）。
  const span = monthsBetween(rule.startMonth, monthOf(rule.startDate));
  let i = span <= 0 ? 0 : Math.ceil(span / every) * every;
  // 最初の候補月の起票日が startDate より前のとき、次の候補は必ず翌月以降
  // = startDate の月より後なので、2 周期目で必ず確定する（無限走査しない）。
  for (let step = 0; step < 2; step++, i += every) {
    const date = clampDayToMonth(addMonths(rule.startMonth, i), rule.dayOfMonth);
    // 起票日は単調増加なので、終了点を越えたら以後の候補も全て期間外。
    if (rule.endDate !== undefined && date >= rule.endDate) return null;
    if (date >= rule.startDate) return date;
  }
  return null;
}

/* ── 費用行きルールが自動生成する item ── */

/**
 * ルール生成 item の終了日 = 周期がカバーする最終月の末日（厳密式）。
 * 「起票日 + 周期 − 1日」は day=1 のときしか一致しない（13ヶ月配分になる）ので使わない。
 */
export function ruleItemEndDate(postingMonth: string, everyMonths: number): string {
  return recurringRuleItemEndDate(postingMonth, everyMonths);
}

/**
 * 月割りするルールの 1 起票ぶんの item を組み立てる。startDate = 起票日（購入の仕訳の日付）。
 * ルール生成 item の endDate は必ず埋まる（周期が分かっているので計算できる）。
 */
export function buildRuleItem(
  rule: RecurringRule,
  posting: RecurringPosting,
  expenseAccountId: string,
  ts: { createdAt: string; updatedAt: string },
): MonthlyCostItem {
  return {
    id: ruleItemId(rule.id, posting.month),
    name: rule.name,
    amount: rule.amount,
    startDate: posting.date,
    endDate: ruleItemEndDate(posting.month, rule.everyMonths),
    expenseAccountId,
    createdAt: ts.createdAt,
    updatedAt: ts.updatedAt,
  };
}

/**
 * 選択した基準日までの、未起票分を表示専用の仮想仕訳として投影する。
 * 永続化とカーソル更新は行わず、postedThroughMonth より後だけを出すため実仕訳と二重計上しない。
 *
 * 行き先が費用/収入科目（差引形）のルールは購入行に加えて**月割り行も投影する**
 * （`cc-allocp-{ruleId}-{postingMonth}-{YYYY-MM}`）。これを落とすと未来断面で
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
    const destinationAccountId = recurringDestinationAccountId(rule);
    const destination = byId.get(destinationAccountId);
    const expenseAccountId = recurringExpenseAccountId(rule, (id) => byId.get(id)?.role);
    const spreadsExpense = expenseAccountId !== undefined;
    const debitAccountId = spreadsExpense
      ? CONTINUOUS_COST_LEDGER_ACCOUNT_ID
      : destinationAccountId;
    const debit = byId.get(debitAccountId);
    const credit = byId.get(rule.creditAccountId);
    if (!destination || !debit || !credit || destinationAccountId === rule.creditAccountId)
      continue;
    if (!isRecurringPostableRole(credit.role)) continue;
    if (!isRecurringPostableRole(destination.role)) continue;
    // 月割りルール（費用/差引形）の実際の借方は内部台帳。未来投影より前の catch-up が必要なら作成する。
    if (
      spreadsExpense &&
      (debit.id !== CONTINUOUS_COST_LEDGER_ACCOUNT_ID || debit.role !== 'continuing-cost-asset')
    )
      continue;
    const referenceStart = recurringRuleReferenceStartDate(rule);
    if (referenceStart === undefined) continue;
    // recurringKindOf(continuing-cost-asset, …) は null を返すため、月割りルールは起票形
    // （借方 台帳 / 貸方 源泉 = 費用ルールと同一）に合わせて 'expense' 直指定。
    const inputMode: InputMode = spreadsExpense
      ? 'expense'
      : (recurringKindOf(destination.role, credit.role) ?? 'manual');
    for (const posting of recurringPostingsDue(rule, asOf)) {
      if (posting.date < referenceStart) continue;
      if (
        !accountExistsAt(destination, posting.date) ||
        !accountExistsAt(credit, posting.date) ||
        !accountExistsAt(debit, posting.date)
      )
        continue;
      projected.push({
        id: `rec-proj-${rule.id}-${posting.month}`,
        date: posting.date,
        description: rule.name,
        kind: 'normal',
        lines: [
          { accountId: debitAccountId, side: 'debit', amount: rule.amount },
          { accountId: rule.creditAccountId, side: 'credit', amount: rule.amount },
        ],
        metadata: {
          virtual: true,
          inputMode,
          recurringRuleId: rule.id,
          recurringMonth: posting.month,
          // 月割りルールの投影購入行も、同じ投影から生まれる費用行と同じ
          // ephemeral item ID を持たせる。仕訳一覧では両方を「継続コスト」と表示する。
          // virtual 行だけの印であり、保存境界の continuousCostId 拒否は維持する。
          ...(spreadsExpense ? { continuousCostId: `${rule.id}-${posting.month}` } : {}),
        },
        createdAt: rule.createdAt,
        updatedAt: rule.updatedAt,
      });
      if (spreadsExpense) {
        const ephemeral = buildRuleItem(rule, posting, expenseAccountId, {
          createdAt: rule.createdAt,
          updatedAt: rule.updatedAt,
        });
        // id を `{ruleId}-{postingMonth}` にすると費用行 ID が
        // `cc-allocp-{ruleId}-{postingMonth}-{YYYY-MM}` になる（item 由来の cc-alloc と衝突しない）。
        // metadata に recurringRuleId を足す＝仕訳一覧のタップでルールへ飛べる（投影 item は実在しないため）。
        projected.push(
          ...continuousCostEntriesForItem(
            { ...ephemeral, id: `${rule.id}-${posting.month}` },
            asOf,
            ephemeral.amount,
            'cc-allocp',
          ).map((e) => ({
            ...e,
            metadata: { ...e.metadata, recurringRuleId: rule.id, recurringMonth: posting.month },
          })),
        );
      }
    }
  }
  return projected;
}

/** キャッチアップ後にルールへ書き戻すカーソル（起票日が到来した最後の月。走査した窓の中まで）。 */
export function recurringCursorAfter(rule: RecurringRule, today: string): string | undefined {
  const window = catchUpWindow(rule, today);
  if (!window) return rule.postedThroughMonth;
  const ended = rule.endDate !== undefined && rule.endDate <= today;
  const horizon = ended ? (recurringRuleLastExistingDate(rule) ?? today) : today;
  // 終了月も、起票日が実際の最終存在日までに来た場合だけ処理済みとする。
  // 存在期間外の予定日までカーソルを進めると、後から endDate を外して線分を
  // 再び伸ばしたときに、未起票の当月分を永久に飛ばしてしまう。
  let through = recurringCursorThroughDate(rule, horizon);
  // 走査していない月をカーソルが飛び越えない（recurringPostingsDue と同じ窓・監査 P1-9）。
  const scannedThrough = addMonths(rule.startMonth, window.last);
  if (through > scannedThrough) through = scannedThrough;
  if (through < rule.startMonth) return rule.postedThroughMonth;
  if (rule.postedThroughMonth !== undefined && through <= rule.postedThroughMonth) {
    return rule.postedThroughMonth;
  }
  return through;
}

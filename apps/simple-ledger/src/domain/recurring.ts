/*
 * 定期ルール（くり返し記帳）の純関数。
 *
 * 方式 = **完全導出**（v13・作者決定 2026-08-16）:
 *  - 保存するのはルール本体だけ。ルールが起票する仕訳（rec-）と継続コスト item（ccr-）は
 *    保存せず、存在期間 [startDate, endDate) と周期位相から任意の断面へ毎回導出する。
 *  - 「起票済みか」という概念・カーソル・キャッチアップ起票は存在しない。過去も未来も
 *    同じ規則で並ぶ（今日は挙動境界ではない）。
 *  - 生まれたものへの個別操作は無い。調整はルールの編集（全期間を引き直す）・
 *    切り替え（この日から別線分）・補正で行う。
 *  - everyMonths（必須。1 = 毎月）で間引く。位相は startMonth 基点。
 *  - 全ルールが継続コスト台帳を経由して月割りする（v13.1 の c 案・直接形の廃止。
 *    アプリはルールへ意味付けしない）。導出 = `借方 台帳 / 貸方 源泉` の購入行 + item。
 *    月割りの費用行は導出 item を continuousCostEntries に通して出す（実 item と同じ engine）。
 */
import { addMonths, monthOf, monthsBetween } from './allocation';
import { ACCOUNT_ROLES, isInternalRole, type AccountRole } from './accountRoles';
import { CONTINUOUS_COST_LEDGER_ACCOUNT_ID } from './constants';
import { ruleEntryId, ruleItemId } from './recurringIds';
import {
  accountExistsAt,
  recurringRuleItemEndDate,
  recurringRuleItemEndDateFor,
  recurringRuleLastExistingDate,
  recurringRuleReferenceStartDate,
  ruleExistsAt,
} from './accountLifetime';
import type { Account, InputMode, JournalEntry, MonthlyCostItem, RecurringRule } from './types';

/** repository/UI 向けの意味が明確な別名。判定の正本は accountLifetime.ruleExistsAt。 */
export const recurringRuleExistsAt = ruleExistsAt;
export {
  generatedEntryRuleId,
  generatedItemRuleId,
  parseRuleEntryId,
  parseRuleItemId,
  ruleEntryId,
  ruleItemId,
} from './recurringIds';

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
 * 全ルールが台帳経由（c 案）なので debitAccountId は常に内部台帳で、利用者が指定した
 * 行き先は spreadExpenseAccountId にある。
 */
export function recurringDestinationAccountId(
  rule: Pick<RecurringRule, 'spreadExpenseAccountId'>,
): string {
  return rule.spreadExpenseAccountId;
}

/**
 * ルールの計上先 = 自動生成 item の計上先（MonthlyCostItem.expenseAccountId。
 * 費用・収入に限らず postable な全 role）。**保存された正規形が唯一の真実**。
 */
export function recurringExpenseAccountId(
  rule: Pick<RecurringRule, 'spreadExpenseAccountId'>,
): string {
  return rule.spreadExpenseAccountId;
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

/** everyMonths・配分月数の上限（100 年）。ルールのパラメータ検証だけが使う。 */
export { CATCH_UP_HARD_CAP_MONTHS } from './recurringLimits';

export interface RecurringPosting {
  month: string; // 'YYYY-MM'
  date: string; // 起票日（クランプ済み）
}

/**
 * 基準日までの起票を列挙する（v13: ルールの唯一の真実 = 存在期間と位相）。
 *  - 対象 = startMonth 〜 基準日の月のうち、起票日が到来し（date <= today）、
 *    存在期間 [startDate, endDate) に含まれる月。
 *  - 列挙は span（startMonth〜基準日の月数）で自然に有界。走査上限は置かない
 *    （カーソル時代の「1 回 1,200 か月 + 続きから」は、上限が無言の恒久欠損へ
 *    意味変質するため撤去。everyMonths と配分月数の上限は schema が守る）。
 */
export function recurringPostingsDue(rule: RecurringRule, today: string): RecurringPosting[] {
  // 終了済みルールは排他的終了日の月まで見れば十分。
  const ended = rule.endDate !== undefined && rule.endDate <= today;
  const horizon = ended ? (recurringRuleLastExistingDate(rule) ?? today) : today;
  const span = monthsBetween(rule.startMonth, monthOf(horizon));
  if (span < 0) return [];
  const out: RecurringPosting[] = [];
  const every = rule.everyMonths >= 1 ? rule.everyMonths : 1;
  for (let i = 0; i <= span; i++) {
    if (i % every !== 0) continue; // startMonth 基点の位相で間引く
    const month = addMonths(rule.startMonth, i);
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
 * ルール生成 item の終了日 = **次回起票日と同日**（v12・同日刻み）。
 * 8/12 起票の毎月ルールなら [8/12, 9/12]・費用は 9/12 に 1 本（1 刻み遅れ・作者承認済み）。
 * 年払い 8/15 起票なら [8/15, 翌8/15]・刻み 12 本（旧「月末」式の 13 分割問題は構造的に消える）。
 */
export function ruleItemEndDate(
  postingMonth: string,
  everyMonths: number,
  dayOfMonth: number,
): string {
  return recurringRuleItemEndDate(postingMonth, everyMonths, dayOfMonth);
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
    endDate: ruleItemEndDate(posting.month, rule.everyMonths, rule.dayOfMonth),
    expenseAccountId,
    createdAt: ts.createdAt,
    updatedAt: ts.updatedAt,
  };
}

/**
 * 投影・導出カードが共有する 1 ルールぶんの文脈（科目解決 + fail-soft ガード）。
 * recurringProjectionEntries と projectedRuleItems が同じ判定を使う（二重実装禁止）。
 */
interface RuleProjectionContext {
  rule: RecurringRule;
  destination: Account;
  credit: Account;
  debit: Account;
  /** 保存上の借方（常に継続コスト台帳）。 */
  debitAccountId: string;
  /** 計上先（= 自動生成 item の expenseAccountId）。 */
  expenseAccountId: string;
  referenceStart: string;
  inputMode: InputMode;
}

function ruleProjectionContext(
  rule: RecurringRule,
  byId: ReadonlyMap<string, Account>,
): RuleProjectionContext | null {
  const destinationAccountId = recurringDestinationAccountId(rule);
  const destination = byId.get(destinationAccountId);
  const expenseAccountId = recurringExpenseAccountId(rule);
  const debitAccountId = CONTINUOUS_COST_LEDGER_ACCOUNT_ID;
  const debit = byId.get(debitAccountId);
  const credit = byId.get(rule.creditAccountId);
  if (!destination || !debit || !credit || destinationAccountId === rule.creditAccountId)
    return null;
  if (!isRecurringPostableRole(credit.role)) return null;
  if (!isRecurringPostableRole(destination.role)) return null;
  // 実際の借方は内部台帳（無い・別 role は導出しない = fail-soft）。
  if (debit.id !== CONTINUOUS_COST_LEDGER_ACCOUNT_ID || debit.role !== 'continuing-cost-asset')
    return null;
  const referenceStart = recurringRuleReferenceStartDate(rule);
  if (referenceStart === undefined) return null;
  // recurringKindOf(continuing-cost-asset, …) は null を返すため、起票形
  // （借方 台帳 / 貸方 源泉 = 費用ルールと同一）に合わせて 'expense' 直指定。
  const inputMode: InputMode = 'expense';
  return {
    rule,
    destination,
    credit,
    debit,
    debitAccountId,
    expenseAccountId,
    referenceStart,
    inputMode,
  };
}

/** 文脈のガードを通った、asOf までの未起票 posting（起票日ごとの科目存在も確認）。 */
function projectablePostings(ctx: RuleProjectionContext, asOf: string): RecurringPosting[] {
  return recurringPostingsDue(ctx.rule, asOf).filter(
    (posting) =>
      posting.date >= ctx.referenceStart &&
      accountExistsAt(ctx.destination, posting.date) &&
      accountExistsAt(ctx.credit, posting.date) &&
      accountExistsAt(ctx.debit, posting.date),
  );
}

/* ── 完全導出（v13）── */

export interface DerivedRecurringOutputs {
  /** 購入の仕訳（保存されない）。保存時代の rec- と同形・同 ID。 */
  entries: JournalEntry[];
  /** 継続コスト item（保存されない）。保存時代の ccr- と同形・同 ID。月割りルールのみ。 */
  items: MonthlyCostItem[];
}

/**
 * ルール集合から asOf までの購入仕訳と item を導出する（v13 の読み取り正本）。
 *
 * 保存時代（catch-up 起票）との差は 2 点だけ:
 *  - metadata.virtual: true（保存されない計算値の印。集計・表示は同じに扱う）
 *  - createdAt / updatedAt がルール由来（「起票した時刻」という概念が無い）
 * それ以外（ID・日付・金額・行・inputMode・monthlyCostId）は catch-up が書いた形と一致する。
 * 月割りの費用行はここでは出さない: 導出 item を continuousCostEntries へ渡すことで、
 * 実 item と同じ engine（cc-alloc ID・回収込みの spreadTotal）で展開される。
 */
export function deriveRecurringOutputs(
  rules: RecurringRule[],
  accounts: Account[],
  asOf: string,
): DerivedRecurringOutputs {
  const byId = new Map(accounts.map((account) => [account.id, account] as const));
  const entries: JournalEntry[] = [];
  const items: MonthlyCostItem[] = [];
  for (const rule of rules) {
    const ctx = ruleProjectionContext(rule, byId);
    if (!ctx) continue;
    for (const posting of projectablePostings(ctx, asOf)) {
      entries.push({
        id: ruleEntryId(rule.id, posting.month),
        date: posting.date,
        description: rule.name,
        kind: 'normal',
        lines: [
          { accountId: ctx.debitAccountId, side: 'debit', amount: rule.amount },
          { accountId: rule.creditAccountId, side: 'credit', amount: rule.amount },
        ],
        metadata: {
          virtual: true,
          inputMode: ctx.inputMode,
          recurringRuleId: rule.id,
          recurringMonth: posting.month,
          monthlyCostId: ruleItemId(rule.id, posting.month),
        },
        createdAt: rule.createdAt,
        updatedAt: rule.updatedAt,
      });
      const item = buildRuleItem(rule, posting, ctx.expenseAccountId, {
        createdAt: rule.createdAt,
        updatedAt: rule.updatedAt,
      });
      // 清算（settlements）: その月の item の endDate を既定（次回起票日）から上書きする。
      // 解約・切り替えの「切り替え日で終える」の導出面（回収の振替は実仕訳のまま）。
      // 上書き規則の正本は recurringRuleItemEndDateFor（参照区間・保存境界と同一・v13.9 項目 3）。
      const endDate = recurringRuleItemEndDateFor(rule, posting.month);
      items.push(endDate === item.endDate ? item : { ...item, endDate });
    }
  }
  return { entries, items };
}

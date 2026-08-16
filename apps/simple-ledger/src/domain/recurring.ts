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
 *  - 継続コスト台帳を経由して月割りするかは**登録時の明示トグル**で決まる（勘定科目の
 *    role で動作を変えない）。spreadExpenseAccountId の有無がトグルの状態そのもの
 *    （保存された正規形が唯一の真実）。ON の導出 = `借方 台帳 / 貸方 源泉` の購入行 + item。
 *    月割りの費用行は導出 item を continuousCostEntries に通して出す（実 item と同じ engine）。
 */
import { addMonths, monthOf, monthsBetween } from './allocation';
import { ACCOUNT_ROLES, isInternalRole, type AccountRole } from './accountRoles';
import { CONTINUOUS_COST_LEDGER_ACCOUNT_ID } from './constants';
import { ruleEntryId, ruleItemId } from './recurringIds';
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
 * 正規化済みの月割りルールは debitAccountId が内部台帳なので、利用者が指定した行き先は
 * spreadExpenseAccountId にある。それ以外の正規形は借方がそのまま行き先になる。
 */
export function recurringDestinationAccountId(
  rule: Pick<RecurringRule, 'debitAccountId' | 'spreadExpenseAccountId'>,
): string {
  return rule.spreadExpenseAccountId ?? rule.debitAccountId;
}

/**
 * 「継続コスト台帳を経由して月割りする」トグルの**既定が ON** になる行き先 role の正本。
 * 判定材料ではなく既定値の提案にすぎない（トグルはどの postable 科目でも ON/OFF できる）。
 *  - expense-category: 費用ルール（毎月の支払いは既定で月割り）。
 *  - income-category: 差引形ルール（借方=収入カテゴリ。給与から差し引く保険料など）。
 *    起票形は費用ルールと同一で、月割りが収入のマイナスとして出る。
 * 通常の収入ルール（貸方=income-category・借方=資金）の行き先は daily-asset なので
 * ここには該当しない＝既定は OFF。振替/積立ルールも同様（トグルで ON にはできる）。
 */
export const RECURRING_SPREAD_DESTINATION_ROLES: readonly AccountRole[] = [
  'expense-category',
  'income-category',
];

/** この役割の科目を行き先に選んだとき、月割りトグルの既定を ON にするか。 */
export function isRecurringSpreadDestinationRole(role: AccountRole | undefined): boolean {
  return role !== undefined && RECURRING_SPREAD_DESTINATION_ROLES.includes(role);
}

/**
 * 月割り（台帳経由）ルールの計上先。**保存された正規形が唯一の真実**で、role は見ない
 * （role は登録時のトグル既定を提案するだけ）。
 * 戻り値 = 自動生成 item の計上先（MonthlyCostItem.expenseAccountId。費用・収入に限らない）。
 */
export function recurringExpenseAccountId(
  rule: Pick<RecurringRule, 'spreadExpenseAccountId'>,
): string | undefined {
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

/** 暴走防止の上限（1 回の導出列挙で走査する月数）。 */
export { CATCH_UP_HARD_CAP_MONTHS } from './recurringLimits';

export interface RecurringPosting {
  month: string; // 'YYYY-MM'
  date: string; // 起票日（クランプ済み）
}

/**
 * 列挙する月 index の範囲 [first, last]（startMonth からの月数）。
 * v13: カーソルは存在しない前提（deriveRecurringOutputs は落としてから渡す）だが、
 * 版上げまでの過渡データが持つ postedThroughMonth も従来規則で respect する。
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
  debitAccountId: string;
  /** 台帳経由（月割り）ルールのときだけ計上先が入る。 */
  expenseAccountId: string | undefined;
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
  const spreadsExpense = expenseAccountId !== undefined;
  const debitAccountId = spreadsExpense ? CONTINUOUS_COST_LEDGER_ACCOUNT_ID : destinationAccountId;
  const debit = byId.get(debitAccountId);
  const credit = byId.get(rule.creditAccountId);
  if (!destination || !debit || !credit || destinationAccountId === rule.creditAccountId)
    return null;
  if (!isRecurringPostableRole(credit.role)) return null;
  if (!isRecurringPostableRole(destination.role)) return null;
  // 月割りルール（費用/差引形）の実際の借方は内部台帳。未来投影より前の catch-up が必要なら作成する。
  if (
    spreadsExpense &&
    (debit.id !== CONTINUOUS_COST_LEDGER_ACCOUNT_ID || debit.role !== 'continuing-cost-asset')
  )
    return null;
  const referenceStart = recurringRuleReferenceStartDate(rule);
  if (referenceStart === undefined) return null;
  // recurringKindOf(continuing-cost-asset, …) は null を返すため、月割りルールは起票形
  // （借方 台帳 / 貸方 源泉 = 費用ルールと同一）に合わせて 'expense' 直指定。
  const inputMode: InputMode = spreadsExpense
    ? 'expense'
    : (recurringKindOf(destination.role, credit.role) ?? 'manual');
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

/**
 * カーソル（postedThroughMonth）を落とした複製。完全導出はこれを入口にする。
 * 存在期間 [startDate, endDate) と周期位相（startMonth / everyMonths / dayOfMonth）だけを
 * 真実として、過去も未来も同じ規則で列挙する（「起票済みか」という概念を持たない）。
 */
function cursorlessRule(rule: RecurringRule): RecurringRule {
  const copy: RecurringRule = { ...rule };
  delete copy.postedThroughMonth;
  return copy;
}

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
  for (const original of rules) {
    const rule = cursorlessRule(original);
    const ctx = ruleProjectionContext(rule, byId);
    if (!ctx) continue;
    const spreadsExpense = ctx.expenseAccountId !== undefined;
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
          ...(spreadsExpense ? { monthlyCostId: ruleItemId(rule.id, posting.month) } : {}),
        },
        createdAt: rule.createdAt,
        updatedAt: rule.updatedAt,
      });
      if (ctx.expenseAccountId !== undefined) {
        items.push(
          buildRuleItem(rule, posting, ctx.expenseAccountId, {
            createdAt: rule.createdAt,
            updatedAt: rule.updatedAt,
          }),
        );
      }
    }
  }
  return { entries, items };
}

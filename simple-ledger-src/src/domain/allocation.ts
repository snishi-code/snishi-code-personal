/*
 * 按分支出（長期の生活コストを月割りで費用認識する）。
 *
 * 例: PC 240,000 円 / 48 か月
 *  - 原始仕訳: 借方 按分中資産(deferred) / 貸方 支払元(payment) … 240,000（費用にしない）
 *  - 月次認識仕訳 ×48: 借方 費用カテゴリ(expense) / 貸方 按分中資産 … 5,000/月
 *
 * 端数は「合計が必ず totalAmount に一致」するよう先頭月から 1 円ずつ配分する。
 * すべて 2 行仕訳（複合仕訳にしない）。生成・台帳作成は repository 側で単一 transaction。
 */
import { newId } from './ids';
import { nowIso } from '../util/time';
import { DEFAULT_MANAGEMENT_SCOPE_ID } from './constants';
import type { AllocationItem, JournalEntry } from './types';

/** total を months で割り、端数を先頭月から 1 ずつ配って合計を total に一致させる。 */
export function monthlyAmounts(total: number, months: number): number[] {
  const base = Math.floor(total / months);
  const remainder = total - base * months;
  return Array.from({ length: months }, (_, i) => base + (i < remainder ? 1 : 0));
}

/** ISO 日付 'YYYY-MM-DD' → 'YYYY-MM'。 */
export function monthOf(isoDate: string): string {
  return isoDate.slice(0, 7);
}

/** 'YYYY-MM' に n か月を加える。 */
export function addMonths(ym: string, n: number): string {
  const [y, m] = ym.split('-').map(Number);
  const total = (y ?? 0) * 12 + ((m ?? 1) - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, '0')}`;
}

function daysInMonth(year: number, month1to12: number): number {
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month1to12 - 1] ?? 30;
}

/** ISO 日付 'YYYY-MM-DD' に n か月加える（末日は月末へクランプ）。Date を使わず決定的に計算する。 */
export function addMonthsToDate(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const total = (y ?? 0) * 12 + ((m ?? 1) - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const day = Math.min(d ?? 1, daysInMonth(ny, nm));
  return `${ny}-${String(nm).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** toYm - fromYm（月数）。 */
export function monthsBetween(fromYm: string, toYm: string): number {
  const [fy, fm] = fromYm.split('-').map(Number);
  const [ty, tm] = toYm.split('-').map(Number);
  return (ty ?? 0) * 12 + ((tm ?? 1) - 1) - ((fy ?? 0) * 12 + ((fm ?? 1) - 1));
}

export interface AllocationInput {
  /** 購入日（原始仕訳の日付）。 */
  date: string;
  description: string;
  totalAmount: number;
  months: number;
  expenseAccountId: string;
  paymentAccountId: string;
  deferredAccountId: string;
  /** 生成仕訳に付く管理区分。未指定なら既定（個人用）。 */
  managementScopeId?: string;
}

export interface BuiltAllocation {
  item: AllocationItem;
  sourceEntry: JournalEntry;
  recognitionEntries: JournalEntry[];
}

/** 按分支出から、原始仕訳・月次認識仕訳・AllocationItem を組み立てる（保存は repository）。 */
export function buildAllocation(input: AllocationInput): BuiltAllocation {
  const ts = nowIso();
  const startMonth = monthOf(input.date);
  const amounts = monthlyAmounts(input.totalAmount, input.months);
  const allocationId = newId();
  const description = input.description.trim();
  const managementScopeId = input.managementScopeId ?? DEFAULT_MANAGEMENT_SCOPE_ID;

  const sourceEntry: JournalEntry = {
    id: newId(),
    date: input.date,
    description,
    kind: 'normal',
    managementScopeId,
    lines: [
      { accountId: input.deferredAccountId, side: 'debit', amount: input.totalAmount },
      { accountId: input.paymentAccountId, side: 'credit', amount: input.totalAmount },
    ],
    metadata: { allocationId, allocationRole: 'source' },
    createdAt: ts,
    updatedAt: ts,
  };

  const recognitionEntries: JournalEntry[] = amounts.map((amount, i) => ({
    id: newId(),
    date: `${addMonths(startMonth, i)}-01`,
    description: `${description}（按分 ${i + 1}/${input.months}）`,
    kind: 'normal',
    managementScopeId,
    lines: [
      { accountId: input.expenseAccountId, side: 'debit', amount },
      { accountId: input.deferredAccountId, side: 'credit', amount },
    ],
    metadata: { allocationId, allocationRole: 'recognition' },
    createdAt: ts,
    updatedAt: ts,
  }));

  const item: AllocationItem = {
    id: allocationId,
    name: description,
    totalAmount: input.totalAmount,
    months: input.months,
    startMonth,
    expenseAccountId: input.expenseAccountId,
    paymentAccountId: input.paymentAccountId,
    deferredAccountId: input.deferredAccountId,
    sourceEntryId: sourceEntry.id,
    recognitionEntryIds: recognitionEntries.map((e) => e.id),
    status: 'active',
    createdAt: ts,
    updatedAt: ts,
  };

  return { item, sourceEntry, recognitionEntries };
}

/* ── 導出（現在月から残月数・未認識残高などを計算。保存しない） ── */

export function recognizedMonths(item: AllocationItem, currentYm: string): number {
  const elapsed = monthsBetween(item.startMonth, currentYm) + 1; // 当月を含む
  return Math.max(0, Math.min(item.months, elapsed));
}

export function remainingMonths(item: AllocationItem, currentYm: string): number {
  return item.months - recognizedMonths(item, currentYm);
}

/** 全認識月が過ぎていれば完了（既定一覧から外す）。disposed/settled は別途 status で扱う。 */
export function isCompleted(item: AllocationItem, currentYm: string): boolean {
  return remainingMonths(item, currentYm) <= 0;
}

/** まだ費用認識されていない残高。 */
export function unrecognizedBalance(item: AllocationItem, currentYm: string): number {
  const amts = monthlyAmounts(item.totalAmount, item.months);
  const recognized = recognizedMonths(item, currentYm);
  return amts.slice(recognized).reduce((s, a) => s + a, 0);
}

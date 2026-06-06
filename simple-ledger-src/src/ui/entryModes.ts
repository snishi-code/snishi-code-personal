/*
 * 入力モード → フィールド役割の対応。
 *
 * 日常入力（収入/支出/振替）はユーザーに借方/貸方を意識させない。代わりに意味のある
 * フィールド（入金先・カテゴリ・支払元・振替元・振替先）で 2 科目を選ばせ、各フィールドが
 * どちらの side（debit/credit）に入るかをここで定義する。内部は常に複式。
 */
import { ACCOUNT_ROLES, type AccountRole } from '../domain/accountRoles';
import type { MessageKey } from '../i18n';

/** フォームとして扱う入力モード（reversal は manual フォームを使い回す）。 */
export type FormMode = 'income' | 'expense' | 'transfer' | 'manual';

export interface EntryRole {
  side: 'debit' | 'credit';
  labelKey: MessageKey;
  /**
   * このフィールドで選べる科目の役割(role)。type ではなく role で絞ることで、
   * 按分中資産・目的別資金・投資資産・残高調整科目を日常入力から外す。
   */
  allowedRoles: AccountRole[];
}

const ALL_ROLES: AccountRole[] = [...ACCOUNT_ROLES];

/**
 * 各モードの 2 フィールド（表示順）。日常入力は role で候補を絞る。
 *  - 収入: 入金先(daily-asset=debit) / カテゴリ(income-category=credit)
 *  - 支出: カテゴリ(expense-category=debit) / 支払元(daily-asset|payment-liability=credit)
 *  - 振替: 振替元(daily-asset=credit) / 振替先(daily-asset=debit)
 *  - manual(詳細/編集): 借方(any role) / 貸方(any role)
 */
export const MODE_ROLES: Record<FormMode, readonly [EntryRole, EntryRole]> = {
  income: [
    { side: 'debit', labelKey: 'entry.income.target', allowedRoles: ['daily-asset'] },
    { side: 'credit', labelKey: 'entry.income.category', allowedRoles: ['income-category'] },
  ],
  expense: [
    { side: 'debit', labelKey: 'entry.expense.category', allowedRoles: ['expense-category'] },
    {
      side: 'credit',
      labelKey: 'entry.expense.source',
      allowedRoles: ['daily-asset', 'payment-liability'],
    },
  ],
  transfer: [
    { side: 'credit', labelKey: 'entry.transfer.from', allowedRoles: ['daily-asset'] },
    { side: 'debit', labelKey: 'entry.transfer.to', allowedRoles: ['daily-asset'] },
  ],
  manual: [
    { side: 'debit', labelKey: 'entry.debitAccount', allowedRoles: ALL_ROLES },
    { side: 'credit', labelKey: 'entry.creditAccount', allowedRoles: ALL_ROLES },
  ],
};

export const FORM_MODE_TITLE: Record<FormMode, MessageKey> = {
  income: 'entry.income.title',
  expense: 'entry.expense.title',
  transfer: 'entry.transfer.title',
  manual: 'entry.manual.title',
};

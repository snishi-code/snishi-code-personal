/*
 * 入力モード → フィールド役割の対応。
 *
 * 日常入力（収入/支出/振替）はユーザーに借方/貸方を意識させない。代わりに意味のある
 * フィールド（入金先・カテゴリ・支払元・振替元・振替先）で 2 科目を選ばせ、各フィールドが
 * どちらの side（debit/credit）に入るかをここで定義する。内部は常に複式。
 */
import type { AccountType } from '../domain/types';
import type { MessageKey } from '../i18n';

/** フォームとして扱う入力モード（reversal は manual フォームを使い回す）。 */
export type FormMode = 'income' | 'expense' | 'transfer' | 'manual';

export interface EntryRole {
  side: 'debit' | 'credit';
  labelKey: MessageKey;
  /** このフィールドで選べる科目タイプ。 */
  allowedTypes: AccountType[];
}

const ALL_TYPES: AccountType[] = ['asset', 'liability', 'equity', 'revenue', 'expense'];

/**
 * 各モードの 2 フィールド（表示順）。
 *  - 収入: 入金先(asset=debit) / カテゴリ(revenue=credit)
 *  - 支出: カテゴリ(expense=debit) / 支払元(asset|liability=credit)
 *  - 振替: 振替元(asset|liability|equity=credit) / 振替先(asset|liability|equity=debit)
 *  - manual(詳細/編集): 借方(any) / 貸方(any)
 */
export const MODE_ROLES: Record<FormMode, readonly [EntryRole, EntryRole]> = {
  income: [
    { side: 'debit', labelKey: 'entry.income.target', allowedTypes: ['asset'] },
    { side: 'credit', labelKey: 'entry.income.category', allowedTypes: ['revenue'] },
  ],
  expense: [
    { side: 'debit', labelKey: 'entry.expense.category', allowedTypes: ['expense'] },
    { side: 'credit', labelKey: 'entry.expense.source', allowedTypes: ['asset', 'liability'] },
  ],
  transfer: [
    {
      side: 'credit',
      labelKey: 'entry.transfer.from',
      allowedTypes: ['asset', 'liability', 'equity'],
    },
    {
      side: 'debit',
      labelKey: 'entry.transfer.to',
      allowedTypes: ['asset', 'liability', 'equity'],
    },
  ],
  manual: [
    { side: 'debit', labelKey: 'entry.debitAccount', allowedTypes: ALL_TYPES },
    { side: 'credit', labelKey: 'entry.creditAccount', allowedTypes: ALL_TYPES },
  ],
};

export const FORM_MODE_TITLE: Record<FormMode, MessageKey> = {
  income: 'entry.income.title',
  expense: 'entry.expense.title',
  transfer: 'entry.transfer.title',
  manual: 'entry.manual.title',
};

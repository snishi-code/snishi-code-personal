/*
 * 入力モード → フィールド役割の対応。
 */
import { ACCOUNT_ROLES, type AccountRole } from '../domain/accountRoles';
import type { MessageKey } from '../i18n';

export type FormMode = 'income' | 'expense' | 'transfer' | 'manual';

export interface EntryRole {
  side: 'debit' | 'credit';
  labelKey: MessageKey;
  allowedRoles: AccountRole[];
}

/*
 * 簿記編集（manual）の候補。継続コスト台帳（continuing-cost-asset）は候補から外す —
 * 台帳に触れる保存仕訳は購入の仕訳・回収の振替の 2 種類だけで、どちらも専用導線が作る
 * （保存境界も monthlyCostId なしの台帳仕訳を拒否する）。
 */
const MANUAL_ROLES: AccountRole[] = ACCOUNT_ROLES.filter((r) => r !== 'continuing-cost-asset');

export const MODE_ROLES: Record<FormMode, readonly [EntryRole, EntryRole]> = {
  income: [
    { side: 'debit', labelKey: 'entry.income.target', allowedRoles: ['daily-asset'] },
    { side: 'credit', labelKey: 'entry.income.category', allowedRoles: ['income-category'] },
  ],
  expense: [
    {
      side: 'debit',
      labelKey: 'entry.expense.category',
      allowedRoles: ['expense-category'],
    },
    {
      side: 'credit',
      labelKey: 'entry.expense.source',
      allowedRoles: ['daily-asset', 'payment-liability'],
    },
  ],
  transfer: [
    {
      side: 'credit',
      labelKey: 'entry.transfer.from',
      allowedRoles: ['daily-asset', 'payment-liability', 'other-liability'],
    },
    {
      side: 'debit',
      labelKey: 'entry.transfer.to',
      allowedRoles: ['daily-asset', 'payment-liability', 'other-liability'],
    },
  ],
  manual: [
    { side: 'debit', labelKey: 'entry.debitAccount', allowedRoles: MANUAL_ROLES },
    { side: 'credit', labelKey: 'entry.creditAccount', allowedRoles: MANUAL_ROLES },
  ],
};

export type FlowMode = 'income' | 'expense' | 'transfer';

export interface FlowDef {
  source: EntryRole;
  destination: EntryRole;
  flowLabelKey: MessageKey;
}

export const MODE_FLOW: Record<FlowMode, FlowDef> = {
  income: {
    source: { side: 'credit', labelKey: 'entry.source.income', allowedRoles: ['income-category'] },
    destination: {
      side: 'debit',
      labelKey: 'entry.destination.income',
      allowedRoles: ['daily-asset'],
    },
    flowLabelKey: 'entry.flow.income',
  },
  expense: {
    source: {
      side: 'credit',
      labelKey: 'entry.source.expense',
      allowedRoles: ['daily-asset', 'payment-liability'],
    },
    destination: {
      side: 'debit',
      labelKey: 'entry.destination.expense',
      allowedRoles: ['expense-category'],
    },
    flowLabelKey: 'entry.flow.expense',
  },
  transfer: {
    source: {
      side: 'credit',
      labelKey: 'entry.transfer.from',
      allowedRoles: ['daily-asset'],
    },
    destination: {
      side: 'debit',
      labelKey: 'entry.transfer.to',
      allowedRoles: ['daily-asset'],
    },
    flowLabelKey: 'entry.flow.transfer',
  },
};

export const FORM_MODE_TITLE: Record<FormMode, MessageKey> = {
  income: 'entry.income.title',
  expense: 'entry.expense.title',
  transfer: 'entry.transfer.title',
  manual: 'entry.manual.title',
};

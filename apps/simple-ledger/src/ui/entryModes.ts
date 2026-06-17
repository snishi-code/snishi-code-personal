/*
 * 入力モード → フィールド役割の対応（v1 から移植）。
 */
import { ACCOUNT_ROLES, type AccountRole } from '../domain/accountRoles';
import type { MessageKey } from '../i18n';

export type FormMode = 'income' | 'expense' | 'transfer' | 'manual';

export interface EntryRole {
  side: 'debit' | 'credit';
  labelKey: MessageKey;
  allowedRoles: AccountRole[];
}

const ALL_ROLES: AccountRole[] = [...ACCOUNT_ROLES];

export const MODE_ROLES: Record<FormMode, readonly [EntryRole, EntryRole]> = {
  income: [
    { side: 'debit', labelKey: 'entry.income.target', allowedRoles: ['daily-asset'] },
    { side: 'credit', labelKey: 'entry.income.category', allowedRoles: ['income-category'] },
  ],
  expense: [
    {
      // 使い道に固定資産(fixed-asset)は出さない。PC・車などの取得は「継続コスト化」で
      // 継続コスト資産として扱う（入力時に会計分類を選ばせない）。
      side: 'debit',
      labelKey: 'entry.expense.category',
      allowedRoles: ['expense-category'],
    },
    {
      side: 'credit',
      labelKey: 'entry.expense.source',
      allowedRoles: ['daily-asset', 'reserve-asset', 'payment-liability'],
    },
  ],
  transfer: [
    {
      side: 'credit',
      labelKey: 'entry.transfer.from',
      allowedRoles: ['daily-asset', 'reserve-asset', 'payment-liability', 'other-liability'],
    },
    {
      side: 'debit',
      labelKey: 'entry.transfer.to',
      allowedRoles: ['daily-asset', 'reserve-asset', 'payment-liability', 'other-liability'],
    },
  ],
  manual: [
    { side: 'debit', labelKey: 'entry.debitAccount', allowedRoles: ALL_ROLES },
    { side: 'credit', labelKey: 'entry.creditAccount', allowedRoles: ALL_ROLES },
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
      // fixed-asset は出さない（上の MODE_ROLES.expense と同じ理由）。
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

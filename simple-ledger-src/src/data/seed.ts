/*
 * 初期データ（家計簿向けの既定勘定科目）。
 * 旧 GAS の命名は引きずらない。すべて会計科目として再設計したもの。
 */
import { SCHEMA_VERSION } from '../domain/constants';
import { newId } from '../domain/ids';
import type { AccountRole } from '../domain/accountRoles';
import type { Account, AccountType, LedgerMeta, Settings } from '../domain/types';
import { nowIso } from '../util/time';

interface SeedAccount {
  name: string;
  type: AccountType;
  role: AccountRole;
}

const SEED_ACCOUNTS: SeedAccount[] = [
  { name: '現金', type: 'asset', role: 'daily-asset' },
  { name: '普通預金', type: 'asset', role: 'daily-asset' },
  { name: 'クレジットカード（未払）', type: 'liability', role: 'payment-liability' },
  { name: '元入金', type: 'equity', role: 'equity' },
  { name: '給与収入', type: 'revenue', role: 'income-category' },
  { name: 'その他収入', type: 'revenue', role: 'income-category' },
  { name: '食費', type: 'expense', role: 'expense-category' },
  { name: '日用品', type: 'expense', role: 'expense-category' },
  { name: '住居費', type: 'expense', role: 'expense-category' },
  { name: '水道光熱費', type: 'expense', role: 'expense-category' },
  { name: '交通費', type: 'expense', role: 'expense-category' },
  { name: '通信費', type: 'expense', role: 'expense-category' },
  { name: '交際費', type: 'expense', role: 'expense-category' },
  { name: '医療費', type: 'expense', role: 'expense-category' },
  { name: '趣味・娯楽', type: 'expense', role: 'expense-category' },
  { name: 'その他支出', type: 'expense', role: 'expense-category' },
];

export function defaultAccounts(): Account[] {
  const ts = nowIso();
  return SEED_ACCOUNTS.map((a) => ({
    id: newId(),
    name: a.name,
    type: a.type,
    role: a.role,
    archived: false,
    createdAt: ts,
    updatedAt: ts,
  }));
}

export function defaultSettings(): Settings {
  return { ledgerName: '家計簿', currency: 'JPY', locale: 'ja' };
}

export function newMeta(): LedgerMeta {
  const ts = nowIso();
  return {
    id: 'ledger',
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    deviceId: newId(),
    createdAt: ts,
    updatedAt: ts,
  };
}

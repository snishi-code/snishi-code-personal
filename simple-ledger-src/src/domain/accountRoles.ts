/*
 * 勘定科目の「役割(role)」。
 *
 * Account.type は会計分類（asset/liability/equity/revenue/expense）であり、
 * 日常入力（収入/支出/振替）の選択肢制御に直接使うと粒度が粗すぎる
 * （例: 按分中資産・目的別資金・投資資産・残高調整科目はすべて asset/expense/revenue
 *  だが、通常入力に出してはいけない）。
 *
 * そこで UI 用の役割 AccountRole を type とは別に持つ。type とは整合させる
 * （roleAllowsType）。日常入力の候補は role で絞る。
 */
import { ADJUSTMENT_ACCOUNTS } from './adjustment';
import type { Account, AccountType } from './types';

export type AccountRole =
  | 'daily-asset'
  | 'reserve-asset'
  | 'deferred-asset'
  | 'investment-asset'
  | 'payment-liability'
  | 'other-liability'
  | 'equity'
  | 'income-category'
  | 'expense-category'
  | 'system-adjustment';

export const ACCOUNT_ROLES: readonly AccountRole[] = [
  'daily-asset',
  'reserve-asset',
  'deferred-asset',
  'investment-asset',
  'payment-liability',
  'other-liability',
  'equity',
  'income-category',
  'expense-category',
  'system-adjustment',
];

/** role が取りうる会計 type（複数可）。schema / 保存時の整合検証に使う。 */
export const ROLE_TYPES: Record<AccountRole, AccountType[]> = {
  'daily-asset': ['asset'],
  'reserve-asset': ['asset'],
  'deferred-asset': ['asset'],
  'investment-asset': ['asset'],
  'payment-liability': ['liability'],
  'other-liability': ['liability'],
  equity: ['equity'],
  'income-category': ['revenue'],
  'expense-category': ['expense'],
  'system-adjustment': ['expense', 'revenue'],
};

export function roleAllowsType(role: AccountRole, type: AccountType): boolean {
  return ROLE_TYPES[role].includes(type);
}

/** type に対する既定 role（type 変更時のリセット先・migration の既定）。 */
export function defaultRoleForType(type: AccountType): AccountRole {
  switch (type) {
    case 'asset':
      return 'daily-asset';
    case 'liability':
      return 'other-liability';
    case 'equity':
      return 'equity';
    case 'revenue':
      return 'income-category';
    case 'expense':
      return 'expense-category';
  }
}

/** その type で選べる role の一覧（科目編集 UI の選択肢）。 */
export function rolesForType(type: AccountType): AccountRole[] {
  return ACCOUNT_ROLES.filter((r) => roleAllowsType(r, type));
}

/** 自動生成・移行で残高調整科目とみなす既定名。 */
const ADJUSTMENT_NAMES = new Set<string>(Object.values(ADJUSTMENT_ACCOUNTS));

/** 按分中資産の既定名（accountRole 推定で使う）。repository の定義と一致させる。 */
export const DEFERRED_ACCOUNT_NAME = '按分中資産';

export interface RoleInferenceContext {
  /** allocations[].deferredAccountId の集合。 */
  deferredIds: Set<string>;
  /** reserves[].reserveAccountId の集合。 */
  reserveIds: Set<string>;
}

/**
 * 既存 Account から role を推定する（v5→v6 migration / 既存DB の補完で使う）。
 * 参照集合（按分中資産・目的別資金）と既定名から、安全側（通常入力に出さない側）へ寄せる。
 */
export function inferRole(account: Account, ctx: RoleInferenceContext): AccountRole {
  switch (account.type) {
    case 'asset':
      if (account.name === DEFERRED_ACCOUNT_NAME || ctx.deferredIds.has(account.id)) {
        return 'deferred-asset';
      }
      if (ctx.reserveIds.has(account.id)) return 'reserve-asset';
      return 'daily-asset';
    case 'liability':
      if (account.name.includes('クレジット')) return 'payment-liability';
      return 'other-liability';
    case 'equity':
      return 'equity';
    case 'revenue':
      if (ADJUSTMENT_NAMES.has(account.name)) return 'system-adjustment';
      return 'income-category';
    case 'expense':
      if (ADJUSTMENT_NAMES.has(account.name)) return 'system-adjustment';
      return 'expense-category';
  }
}

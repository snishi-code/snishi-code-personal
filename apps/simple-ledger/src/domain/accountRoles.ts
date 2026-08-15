/*
 * 勘定科目の「役割(role)」。
 *
 * Account.type は会計分類（asset/liability/equity/revenue/expense）であり、
 * 日常入力（収入/支出/振替）の選択肢制御に直接使うと粒度が粗すぎる
 * （例: 投資資産・残高調整科目はどちらも asset/expense/revenue だが、
 *  通常入力に出してはいけない）。
 *
 * そこで UI 用の役割 AccountRole を type とは別に持つ。type とは整合させる
 * （roleAllowsType）。日常入力の候補は role で絞る。
 */
import type { AccountType } from './types';

export type AccountRole =
  | 'daily-asset'
  | 'investment-asset'
  | 'continuing-cost-asset'
  | 'payment-liability'
  | 'other-liability'
  | 'equity'
  | 'income-category'
  | 'expense-category'
  | 'system-adjustment';

export const ACCOUNT_ROLES: readonly AccountRole[] = [
  'daily-asset',
  'investment-asset',
  'continuing-cost-asset',
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
  'investment-asset': ['asset'],
  // 継続コストの集約台帳口座（『継続コスト台帳』・内部集約・自動・ユーザー選択不可）。
  // 品目ごとに作らず単一口座へ残存価値を寄せる。支払いを資産化し、月割りで費消する。
  // 通常入力候補・勘定科目管理 UI に出さない・CF 総資金に含めない。
  'continuing-cost-asset': ['asset'],
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

/**
 * 内部・自動生成・聖域化のロール。ユーザーが勘定科目管理画面で手作成/編集する対象ではない。
 * 勘定科目管理一覧・ロール選択肢から除外する（BS / 資産内訳・CF には残高として現れてよい）。
 *  - continuing-cost-asset: 継続コストの集約台帳口座。
 */
export const INTERNAL_ACCOUNT_ROLES: readonly AccountRole[] = ['continuing-cost-asset'];

export function isInternalRole(role: AccountRole): boolean {
  return INTERNAL_ACCOUNT_ROLES.includes(role);
}

/** 残高補正の対象にできる会計 type（equity は対象外。初期残高は opening で直す）。 */
const ADJUSTABLE_ACCOUNT_TYPES: readonly AccountType[] = [
  'asset',
  'liability',
  'expense',
  'revenue',
];

/**
 * 残高補正の対象にできる役割（資産・負債・費用・収入のうち、内部集約と残高調整自身を除く）。
 * 継続コスト台帳(continuing-cost-asset)は集約口座であり、補正で直接動かすと
 * 残存価値の導出と矛盾するため対象外（fail-closed）。
 * 残高調整科目(system-adjustment)は補正の相手側であり、対象にすると自分自身を相手に
 * 取りうる（type が expense / revenue なので type 制限だけでは弾けない）ため明示除外する。
 * UI の補正対象ピッカーと repository の保存境界の双方がこの正本を使う。
 */
export const ADJUSTABLE_ACCOUNT_ROLES: readonly AccountRole[] = ACCOUNT_ROLES.filter(
  (r) =>
    ADJUSTABLE_ACCOUNT_TYPES.some((type) => roleAllowsType(r, type)) &&
    !isInternalRole(r) &&
    r !== 'system-adjustment',
);

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

/** その type で選べる role の一覧（科目編集 UI の選択肢）。内部集約ロールは除外する。 */
export function rolesForType(type: AccountType): AccountRole[] {
  return ACCOUNT_ROLES.filter((r) => roleAllowsType(r, type) && !isInternalRole(r));
}

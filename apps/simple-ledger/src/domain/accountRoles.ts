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
  | 'fixed-asset'
  | 'continuing-cost-asset'
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
  'fixed-asset',
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
  'reserve-asset': ['asset'],
  'deferred-asset': ['asset'],
  'investment-asset': ['asset'],
  // 固定資産（車・家財など）。現金ではない asset。CF 総資金には含めない。
  'fixed-asset': ['asset'],
  // 継続コストの集約台帳口座（『継続コスト台帳』・内部集約・自動・ユーザー選択不可）。
  // 品目ごとに作らず単一口座へ未消化残高を寄せる。支払いを資産化し、認識で費消する。
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
 *  - continuing-cost-asset: 継続コストの集約台帳口座（v14）。
 *  - reserve-asset: 取り置き資金（目的別に作るが勘定科目一覧を増やさない＝聖域化）。作成・管理は
 *    取り置き資金 UI / 振替の「取り置き資産を作る」導線で行う。
 */
export const INTERNAL_ACCOUNT_ROLES: readonly AccountRole[] = [
  'continuing-cost-asset',
  'reserve-asset',
];

export function isInternalRole(role: AccountRole): boolean {
  return INTERNAL_ACCOUNT_ROLES.includes(role);
}

/**
 * 残高補正の対象にできる役割（資産・負債のうち内部集約 role を除く）。
 * 取り置き資金(reserve-asset)・継続コスト台帳(continuing-cost-asset)は集約口座であり、
 * 補正で直接動かすと目的別残高・未消化残高の導出と矛盾するため対象外（fail-closed）。
 * UI の補正対象ピッカーと repository の保存境界の双方がこの正本を使う。
 */
export const ADJUSTABLE_ACCOUNT_ROLES: readonly AccountRole[] = ACCOUNT_ROLES.filter(
  (r) =>
    (roleAllowsType(r, 'asset') || roleAllowsType(r, 'liability')) && !isInternalRole(r),
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

/**
 * 支払い手段の細目（AccountInstrument）を持てる親科目の役割。
 * 日常の支払い元になり得る「流動資産（現金・預金・チャージ残高）」と
 * 「支払い負債（クレジットカード）」に限る。固定資産・投資・目的別資金・按分中資産・
 * その他負債・純資産・収支カテゴリは支払い手段の親にしない（残高/PL/BS の正本を濁さない）。
 */
export const INSTRUMENT_PARENT_ROLES: readonly AccountRole[] = ['daily-asset', 'payment-liability'];

export function isInstrumentParentRole(role: AccountRole): boolean {
  return INSTRUMENT_PARENT_ROLES.includes(role);
}

/** 自動生成・移行で残高調整科目とみなす既定名。 */
const ADJUSTMENT_NAMES = new Set<string>(Object.values(ADJUSTMENT_ACCOUNTS));

/** 按分中資産（繰延）科目の既定名。accountRole 推定・按分作成の正本（repository はこれを参照する）。 */
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

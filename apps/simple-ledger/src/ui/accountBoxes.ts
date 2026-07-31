/*
 * ユーザー向けの「大きな箱」（勘定科目の大分類）。
 *
 * 大きな箱はアプリ側が守る固定の分類で、ユーザーは箱そのものを追加・削除・移動できない。
 * ユーザーが編集できるのは箱の中の「内訳」（追加・名前変更・アーカイブ）だけ。
 * type / role は実装内部の分類であり、通常 UI ではユーザーに直接選ばせない——
 * 箱ごとの作成導線が role を固定する（rolesForType を UI に出さない）。
 *
 * 対応表（ユーザー向け大分類）:
 *  - 現預金・決済資産  = daily-asset
 *  - 投資             = investment-asset
 *  - カード・未払      = payment-liability（短期債務）
 *  - ローン           = other-liability（長期債務）
 *  - 収入カテゴリ      = income-category
 *  - 支出カテゴリ      = expense-category
 * equity / system-adjustment / 内部集約 role（continuing-cost-asset）は
 * 聖域として一覧・追加・編集候補から隠す。
 */
import type { AccountRole } from '../domain/accountRoles';
import { compareAccountOrder } from '../domain/accountOrder';
import { accountExistsAt } from '../domain/accountLifetime';
import type { Account, AccountType } from '../domain/types';
import type { MessageKey } from '../i18n';

export type AccountBoxKey =
  | 'cash'
  | 'investment'
  | 'shortTermDebt'
  | 'longTermDebt'
  | 'income'
  | 'expense';

/**
 * 科目の箱・内訳枠で共有する色の正本。
 * 色値そのものは app-theme.css に置き、UI はここで選ばれた CSS 変数だけを参照する。
 */
export const ACCOUNT_ACCENTS = {
  assetFree: 'var(--account-asset-free)',
  assetFixed: 'var(--account-asset-fixed)',
  investment: 'var(--account-investment)',
  continuingCost: 'var(--account-continuing-cost)',
  shortTermDebt: 'var(--account-liability-short)',
  longTermDebt: 'var(--account-liability-long)',
  income: 'var(--account-income)',
  expense: 'var(--account-expense)',
  equity: 'var(--account-equity)',
} as const;

export type AccountAccent = (typeof ACCOUNT_ACCENTS)[keyof typeof ACCOUNT_ACCENTS];

export interface AccountBox {
  key: AccountBoxKey;
  labelKey: MessageKey;
  /** 箱見出し・ピッカー見出し・内訳枠で共有するアクセント。 */
  accent: AccountAccent;
  /** この箱に属する role。 */
  roles: readonly AccountRole[];
  /** 箱に対応する会計 type（残高の符号・初期残高の向きに使う）。 */
  type: AccountType;
  /**
   * 「内訳を追加」で固定する role。
   */
  createRole?: AccountRole;
  /** 追加ボタンの文言。 */
  addLabelKey?: MessageKey;
  /** 新規作成時に任意の初期残高（opening）入力を出すか（資産・負債の箱のみ）。 */
  opening: boolean;
  /** 箱の説明・専用導線の案内。 */
  hintKey?: MessageKey;
}

export const ACCOUNT_BOXES: readonly AccountBox[] = [
  {
    key: 'cash',
    labelKey: 'box.cash',
    accent: ACCOUNT_ACCENTS.assetFree,
    roles: ['daily-asset'],
    type: 'asset',
    createRole: 'daily-asset',
    addLabelKey: 'box.addSubdivision',
    opening: true,
  },
  {
    key: 'investment',
    labelKey: 'box.investment',
    accent: ACCOUNT_ACCENTS.investment,
    roles: ['investment-asset'],
    type: 'asset',
    createRole: 'investment-asset',
    addLabelKey: 'box.addSubdivision',
    opening: true,
  },
  {
    key: 'shortTermDebt',
    labelKey: 'box.shortTermDebt',
    accent: ACCOUNT_ACCENTS.shortTermDebt,
    roles: ['payment-liability'],
    type: 'liability',
    createRole: 'payment-liability',
    addLabelKey: 'box.addSubdivision',
    opening: true,
  },
  {
    key: 'longTermDebt',
    labelKey: 'box.longTermDebt',
    accent: ACCOUNT_ACCENTS.longTermDebt,
    roles: ['other-liability'],
    type: 'liability',
    createRole: 'other-liability',
    addLabelKey: 'box.addLoan',
    opening: true,
    hintKey: 'box.longTermDebtHint',
  },
  {
    key: 'income',
    labelKey: 'box.income',
    accent: ACCOUNT_ACCENTS.income,
    roles: ['income-category'],
    type: 'revenue',
    createRole: 'income-category',
    addLabelKey: 'box.addCategory',
    opening: false,
  },
  {
    key: 'expense',
    labelKey: 'box.expense',
    accent: ACCOUNT_ACCENTS.expense,
    roles: ['expense-category'],
    type: 'expense',
    createRole: 'expense-category',
    addLabelKey: 'box.addCategory',
    opening: false,
  },
];

const BOX_BY_ROLE: ReadonlyMap<AccountRole, AccountBox> = new Map(
  ACCOUNT_BOXES.flatMap((box) => box.roles.map((role) => [role, box] as const)),
);

/** role が属する箱。聖域 role（equity / system-adjustment / 内部集約）は undefined。 */
export function boxForRole(role: AccountRole): AccountBox | undefined {
  return BOX_BY_ROLE.get(role);
}

export function boxByKey(key: AccountBoxKey): AccountBox {
  const box = ACCOUNT_BOXES.find((b) => b.key === key);
  if (!box) throw new Error(`unknown account box: ${key}`);
  return box;
}

/**
 * ピッカー等で内部科目も含めて色を付けるためのフォールバック。
 * 日常資産の movable は行/内訳枠で表すため、科目種別グループの見出しは同じ青系に揃える。
 */
export function accountAccent(account: Account): AccountAccent {
  const box = boxForRole(account.role);
  if (box) return box.accent;
  if (account.role === 'continuing-cost-asset') return ACCOUNT_ACCENTS.continuingCost;
  if (account.type === 'asset') return ACCOUNT_ACCENTS.assetFree;
  if (account.type === 'liability') return ACCOUNT_ACCENTS.shortTermDebt;
  if (account.type === 'revenue') return ACCOUNT_ACCENTS.income;
  if (account.type === 'expense') return ACCOUNT_ACCENTS.expense;
  return ACCOUNT_ACCENTS.equity;
}

/**
 * 科目を箱ごとにグループ化する（勘定科目画面用）。
 * 聖域 role の科目は含めない。showArchived=false ならアーカイブ済みを除く。
 */
export function groupAccountsByBox(
  accounts: Account[],
  showArchived: boolean,
  atDate?: string,
): { box: AccountBox; accounts: Account[] }[] {
  return ACCOUNT_BOXES.map((box) => ({
    box,
    accounts: accounts
      .filter(
        (a) =>
          box.roles.includes(a.role) &&
          (showArchived || (atDate === undefined ? !a.archived : accountExistsAt(a, atDate))),
      )
      .sort(compareAccountOrder),
  }));
}

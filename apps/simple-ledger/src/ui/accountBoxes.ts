/*
 * ユーザー向けの「大きな箱」（勘定科目の大分類）。
 *
 * 大きな箱はアプリ側が守る固定の分類で、ユーザーは箱そのものを追加・削除・移動できない。
 * ユーザーが編集できるのは箱の中の「内訳」（追加・名前変更・アーカイブ）だけ。
 * type / role は実装内部の分類であり、通常 UI ではユーザーに直接選ばせない——
 * 箱ごとの作成導線が role を固定する（rolesForType を UI に出さない）。
 *
 * 対応表（_workspace-management/simple-ledger-v2.md「ユーザー向け大分類」）:
 *  - 現預金・決済資産  = daily-asset
 *  - 投資             = investment-asset
 *  - 継続コスト資産    = fixed-asset / deferred-asset（追加は継続コスト化の導線のみ・終了は売却）
 *  - カード・未払      = payment-liability（短期債務）
 *  - ローン           = other-liability（長期債務）
 *  - 収入カテゴリ      = income-category
 *  - 支出カテゴリ      = expense-category
 * equity / system-adjustment / 内部集約 role（continuing-cost-asset, reserve-asset）は
 * 聖域として一覧・追加・編集候補から隠す。
 */
import type { AccountRole } from '../domain/accountRoles';
import type { Account, AccountType } from '../domain/types';
import type { MessageKey } from '../i18n';

export type AccountBoxKey =
  | 'cash'
  | 'investment'
  | 'continuingCost'
  | 'shortTermDebt'
  | 'longTermDebt'
  | 'income'
  | 'expense';

export interface AccountBox {
  key: AccountBoxKey;
  labelKey: MessageKey;
  /** この箱に属する role。 */
  roles: readonly AccountRole[];
  /** 箱に対応する会計 type（残高の符号・初期残高の向きに使う）。 */
  type: AccountType;
  /**
   * 「内訳を追加」で固定する role。undefined の箱は通常 UI から追加できない
   * （継続コスト資産は継続コスト化の導線でだけ増える）。
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
    roles: ['daily-asset'],
    type: 'asset',
    createRole: 'daily-asset',
    addLabelKey: 'box.addSubdivision',
    opening: true,
  },
  {
    key: 'investment',
    labelKey: 'box.investment',
    roles: ['investment-asset'],
    type: 'asset',
    createRole: 'investment-asset',
    addLabelKey: 'box.addSubdivision',
    opening: true,
  },
  {
    key: 'continuingCost',
    labelKey: 'box.continuingCost',
    roles: ['fixed-asset', 'deferred-asset'],
    type: 'asset',
    opening: false,
    hintKey: 'box.continuingCostHint',
  },
  {
    key: 'shortTermDebt',
    labelKey: 'box.shortTermDebt',
    roles: ['payment-liability'],
    type: 'liability',
    createRole: 'payment-liability',
    addLabelKey: 'box.addSubdivision',
    opening: true,
  },
  {
    key: 'longTermDebt',
    labelKey: 'box.longTermDebt',
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
    roles: ['income-category'],
    type: 'revenue',
    createRole: 'income-category',
    addLabelKey: 'box.addCategory',
    opening: false,
  },
  {
    key: 'expense',
    labelKey: 'box.expense',
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
 * 科目を箱ごとにグループ化する（勘定科目画面用）。
 * 聖域 role の科目は含めない。showArchived=false ならアーカイブ済みを除く。
 */
export function groupAccountsByBox(
  accounts: Account[],
  showArchived: boolean,
): { box: AccountBox; accounts: Account[] }[] {
  return ACCOUNT_BOXES.map((box) => ({
    box,
    accounts: accounts
      .filter((a) => box.roles.includes(a.role) && (showArchived || !a.archived))
      .sort((a, b) => a.name.localeCompare(b.name, 'ja')),
  }));
}

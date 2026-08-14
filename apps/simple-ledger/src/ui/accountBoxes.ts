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
 * equity / 内部集約 role（continuing-cost-asset）は聖域として一覧・追加・編集候補から隠す。
 * system-adjustment（残高調整）は type に基づき収入・費用の箱へ「表示だけ」所属させる
 * （boxIncludesAccount）。管理操作（追加・名前変更・並び替え・アーカイブ）と
 * 行き先ピッカーからは引き続き除外する＝科目管理としては聖域のまま。
 */
import type { AccountRole } from '../domain/accountRoles';
import { compareAccountOrder } from '../domain/accountOrder';
import { accountExistsAt } from '../domain/accountLifetime';
import type { Account, AccountType } from '../domain/types';
import type { MessageKey } from '../i18n';

export type AccountBoxKey =
  | 'cash'
  | 'cashFixed'
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

/**
 * タイムラインで使う 9 個の大きな箱。
 *
 * 勘定科目管理の 6 箱に、資産内訳で既に使っている「自由に動かせる / 動かせない」
 * の分割、内部の継続コスト台帳、純資産を合わせたもの。順序も両画面の既存順に揃える。
 * 残高調整科目は type に基づき収入・費用の箱へ通常の内訳として所属させる（表示だけ普通に）。
 */
export type TimelineAccountBoxKey =
  | 'assetFree'
  | 'assetFixed'
  | 'investment'
  | 'continuingCost'
  | 'shortTermDebt'
  | 'longTermDebt'
  | 'income'
  | 'expense'
  | 'equity';

export interface TimelineAccountBox {
  key: TimelineAccountBoxKey;
  labelKey: MessageKey;
  accent: AccountAccent;
  includes: (account: Account) => boolean;
}

export const TIMELINE_ACCOUNT_BOXES: readonly TimelineAccountBox[] = [
  {
    key: 'assetFree',
    labelKey: 'assets.frame.free',
    accent: ACCOUNT_ACCENTS.assetFree,
    includes: (account) => account.role === 'daily-asset' && account.movable !== false,
  },
  {
    key: 'assetFixed',
    labelKey: 'assets.frame.fixed',
    accent: ACCOUNT_ACCENTS.assetFixed,
    includes: (account) => account.role === 'daily-asset' && account.movable === false,
  },
  {
    key: 'investment',
    labelKey: 'assets.frame.investment',
    accent: ACCOUNT_ACCENTS.investment,
    includes: (account) => account.role === 'investment-asset',
  },
  {
    key: 'continuingCost',
    labelKey: 'assets.frame.ledger',
    accent: ACCOUNT_ACCENTS.continuingCost,
    includes: (account) => account.role === 'continuing-cost-asset',
  },
  {
    key: 'shortTermDebt',
    labelKey: 'box.shortTermDebt',
    accent: ACCOUNT_ACCENTS.shortTermDebt,
    includes: (account) => account.role === 'payment-liability',
  },
  {
    key: 'longTermDebt',
    labelKey: 'box.longTermDebt',
    accent: ACCOUNT_ACCENTS.longTermDebt,
    includes: (account) => account.role === 'other-liability',
  },
  {
    key: 'income',
    labelKey: 'box.income',
    accent: ACCOUNT_ACCENTS.income,
    includes: (account) =>
      account.role === 'income-category' ||
      (account.role === 'system-adjustment' && account.type === 'revenue'),
  },
  {
    key: 'expense',
    labelKey: 'box.expense',
    accent: ACCOUNT_ACCENTS.expense,
    includes: (account) =>
      account.role === 'expense-category' ||
      (account.role === 'system-adjustment' && account.type === 'expense'),
  },
  {
    key: 'equity',
    labelKey: 'accounts.type.equity',
    accent: ACCOUNT_ACCENTS.equity,
    includes: (account) => account.role === 'equity',
  },
];

export function timelineBoxForAccount(account: Account): TimelineAccountBox | undefined {
  return TIMELINE_ACCOUNT_BOXES.find((box) => box.includes(account));
}

export interface AccountBox {
  key: AccountBoxKey;
  labelKey: MessageKey;
  /** 箱見出し・ピッカー見出し・内訳枠で共有するアクセント。 */
  accent: AccountAccent;
  /** この箱に属する role。 */
  roles: readonly AccountRole[];
  /**
   * role の中での所属の絞り込み（現預金の movable 分割用）。未指定 = role だけで所属。
   * 箱は保存形式を持たない表示の骨格なので、ここは Account の導出であって新しい保存項目ではない。
   */
  matches?: (account: Account) => boolean;
  /** この箱で新規作成した内訳の movable 既定（cashFixed だけ false）。 */
  defaultMovable?: false;
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
  // 現預金は「自由に動かせるか」で 2 箱に分ける（作者決定 2026-08-14）。
  // 資産の内訳・タイムラインが既に使っている分割と同じ言葉・同じ判定
  // （movable フラグの導出・保存形式は変えない）。箱間の移動 = 編集シートのチェック切替。
  {
    key: 'cash',
    labelKey: 'assets.frame.free',
    accent: ACCOUNT_ACCENTS.assetFree,
    roles: ['daily-asset'],
    matches: (account) => account.movable !== false,
    type: 'asset',
    createRole: 'daily-asset',
    addLabelKey: 'box.addSubdivision',
    opening: true,
  },
  {
    key: 'cashFixed',
    labelKey: 'assets.frame.fixed',
    accent: ACCOUNT_ACCENTS.assetFixed,
    roles: ['daily-asset'],
    matches: (account) => account.movable === false,
    type: 'asset',
    createRole: 'daily-asset',
    addLabelKey: 'box.addSubdivision',
    opening: true,
    defaultMovable: false,
    hintKey: 'box.cashFixedHint',
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

/**
 * role が属する箱（作成・管理導線の正本）。聖域 role
 * （equity / system-adjustment / 内部集約）は undefined のまま＝管理操作を出さない。
 * system-adjustment の「表示だけ」の所属は boxIncludesAccount が持つ。
 */
export function boxForRole(role: AccountRole): AccountBox | undefined {
  return BOX_BY_ROLE.get(role);
}

/**
 * 科目一覧の表示上の所属。roles（管理対象）に加えて、残高調整科目を type で
 * 収入・費用の箱へ含める（作者決定: 収入・費用項目の 1 つとして表示。科目管理は聖域のまま）。
 */
export function boxIncludesAccount(box: AccountBox, account: Account): boolean {
  if (box.roles.includes(account.role)) return box.matches?.(account) ?? true;
  return account.role === 'system-adjustment' && box.type === account.type;
}

/**
 * 科目そのものが属する箱（編集シートの見出し・アクセント用）。
 * boxForRole は role → 最初の箱しか引けないため、movable で分かれた現預金は
 * こちらで解決する。管理外（聖域）は undefined。
 */
export function boxForAccount(account: Account): AccountBox | undefined {
  return ACCOUNT_BOXES.find(
    (box) => box.roles.includes(account.role) && boxIncludesAccount(box, account),
  );
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
 * 聖域 role のうち残高調整だけは type で収入・費用の箱へ表示する（boxIncludesAccount）。
 * equity / 内部集約は含めない。showArchived=false ならアーカイブ済みを除く。
 *
 * 費用・収入（残高調整含む）は、期間途中で終了して期間末（atDate）に存在しなくても、
 * 期間内の発生額が 0 でなければ表示する（hasPeriodActivity。ホームの支出には出るのに
 * 一覧から消える不一致を防ぐ・監査 P1-3）。資産・負債はスライス時点の存在で絞る従来のまま。
 */
export function groupAccountsByBox(
  accounts: Account[],
  showArchived: boolean,
  atDate?: string,
  hasPeriodActivity?: (account: Account) => boolean,
): { box: AccountBox; accounts: Account[] }[] {
  return ACCOUNT_BOXES.map((box) => {
    const isFlowBox = box.type === 'revenue' || box.type === 'expense';
    return {
      box,
      accounts: accounts
        .filter(
          (a) =>
            boxIncludesAccount(box, a) &&
            (showArchived ||
              (atDate === undefined
                ? !a.archived
                : accountExistsAt(a, atDate) ||
                  (isFlowBox && hasPeriodActivity !== undefined && hasPeriodActivity(a)))),
        )
        .sort(compareAccountOrder),
    };
  });
}

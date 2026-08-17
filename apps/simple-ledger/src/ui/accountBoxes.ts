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
 *
 * **並びと所属は `domain/displayOrder` が正本**。このファイルは箱の見た目（ラベル・
 * アクセント）と作成導線のメタデータだけを持ち、配列の順序も所属条件も自前で書かない。
 */
import type { AccountRole } from '../domain/accountRoles';
import {
  DISPLAY_BOX_KEYS,
  accountsInDisplayBox,
  displayBoxIncludes,
  sortByDisplayBox,
  type DisplayBoxKey,
} from '../domain/displayOrder';
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
 * タイムラインで使う 9 個の大きな箱の見た目。
 *
 * 勘定科目管理の 6 箱に、資産内訳で既に使っている「自由に動かせる / 動かせない」
 * の分割、内部の継続コスト台帳、純資産を合わせたもの。
 * **並びと所属は `domain/displayOrder` が正本**で、ここはラベルと色だけを足す。
 * 残高調整科目は type に基づき収入・費用の箱へ通常の内訳として所属させる（表示だけ普通に）。
 */
export type TimelineAccountBoxKey = DisplayBoxKey;

export interface TimelineAccountBox {
  key: DisplayBoxKey;
  labelKey: MessageKey;
  accent: AccountAccent;
  includes: (account: Account) => boolean;
}

/** 箱ごとのラベルとアクセント（並びは持たない。順序は DISPLAY_BOX_KEYS）。 */
const BOX_LOOK: Record<DisplayBoxKey, { labelKey: MessageKey; accent: AccountAccent }> = {
  assetFree: { labelKey: 'assets.frame.free', accent: ACCOUNT_ACCENTS.assetFree },
  assetFixed: { labelKey: 'assets.frame.fixed', accent: ACCOUNT_ACCENTS.assetFixed },
  investment: { labelKey: 'assets.frame.investment', accent: ACCOUNT_ACCENTS.investment },
  continuingCost: { labelKey: 'assets.frame.ledger', accent: ACCOUNT_ACCENTS.continuingCost },
  shortTermDebt: { labelKey: 'box.shortTermDebt', accent: ACCOUNT_ACCENTS.shortTermDebt },
  longTermDebt: { labelKey: 'box.longTermDebt', accent: ACCOUNT_ACCENTS.longTermDebt },
  income: { labelKey: 'box.income', accent: ACCOUNT_ACCENTS.income },
  expense: { labelKey: 'box.expense', accent: ACCOUNT_ACCENTS.expense },
  equity: { labelKey: 'accounts.type.equity', accent: ACCOUNT_ACCENTS.equity },
};

/** 箱の見た目（ラベル・色）。並びは持たないので、列挙は TIMELINE_ACCOUNT_BOXES を使う。 */
export function displayBoxLook(key: DisplayBoxKey): {
  labelKey: MessageKey;
  accent: AccountAccent;
} {
  return BOX_LOOK[key];
}

export const TIMELINE_ACCOUNT_BOXES: readonly TimelineAccountBox[] = DISPLAY_BOX_KEYS.map(
  (key) => ({
    key,
    ...BOX_LOOK[key],
    includes: (account: Account) => displayBoxIncludes(key, account),
  }),
);

export function timelineBoxForAccount(account: Account): TimelineAccountBox | undefined {
  return TIMELINE_ACCOUNT_BOXES.find((box) => box.includes(account));
}

export interface AccountBox {
  key: AccountBoxKey;
  /** 表示順マスタ上の箱（並びと所属はこのキーで displayOrder に問い合わせる）。 */
  box: DisplayBoxKey;
  labelKey: MessageKey;
  /** 箱見出し・ピッカー見出し・内訳枠で共有するアクセント。 */
  accent: AccountAccent;
  /** この箱が**管理**する role（追加・編集導線の対象。表示上の所属は displayOrder が決める）。 */
  roles: readonly AccountRole[];
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
  /**
   * 新規作成時に任意の初期残高（opening）入力を出すか（資産・負債の箱のみ）。
   * 履歴ゼロの科目の「補正」導線を初期残高登録へ回してよいかの判定にも使う
   * （費用・収入は opening を持てないので、履歴ゼロでも補正シートを開く）。
   */
  opening: boolean;
  /** 箱の説明・専用導線の案内。 */
  hintKey?: MessageKey;
}

/**
 * 勘定科目画面の 7 箱。**並びはここでは決めない**（下の sortByDisplayBox が
 * 表示順マスタの並びへ揃える）。9 箱のうち聖域（継続コスト台帳・純資産）を持たないぶんだけ
 * 少ない部分集合で、残りの相対順はマスタと必ず一致する。
 */
const ACCOUNT_BOX_DEFS: readonly AccountBox[] = [
  // 現預金は「自由に動かせるか」で 2 箱に分ける（作者決定 2026-08-14）。
  // 資産の内訳・タイムラインが既に使っている分割と同じ言葉・同じ判定
  // （movable フラグの導出・保存形式は変えない）。箱間の移動 = 編集シートのチェック切替。
  {
    key: 'cash',
    box: 'assetFree',
    labelKey: 'assets.frame.free',
    accent: ACCOUNT_ACCENTS.assetFree,
    roles: ['daily-asset'],
    type: 'asset',
    createRole: 'daily-asset',
    addLabelKey: 'box.addSubdivision',
    opening: true,
  },
  {
    key: 'cashFixed',
    box: 'assetFixed',
    labelKey: 'assets.frame.fixed',
    accent: ACCOUNT_ACCENTS.assetFixed,
    roles: ['daily-asset'],
    type: 'asset',
    createRole: 'daily-asset',
    addLabelKey: 'box.addSubdivision',
    opening: true,
    defaultMovable: false,
    hintKey: 'box.cashFixedHint',
  },
  {
    key: 'investment',
    box: 'investment',
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
    box: 'shortTermDebt',
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
    box: 'longTermDebt',
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
    box: 'income',
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
    box: 'expense',
    labelKey: 'box.expense',
    accent: ACCOUNT_ACCENTS.expense,
    roles: ['expense-category'],
    type: 'expense',
    createRole: 'expense-category',
    addLabelKey: 'box.addCategory',
    opening: false,
  },
];

export const ACCOUNT_BOXES: readonly AccountBox[] = sortByDisplayBox(
  ACCOUNT_BOX_DEFS,
  (box) => box.box,
);

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
 * 科目一覧の表示上の所属。判定は表示順マスタ（`displayBoxIncludes`）が単一正本で、
 * 残高調整科目が type で収入・費用の箱へ入るのもそちらの定義に含まれる
 * （作者決定: 収入・費用項目の 1 つとして表示。科目管理は聖域のまま）。
 */
export function boxIncludesAccount(box: AccountBox, account: Account): boolean {
  return displayBoxIncludes(box.box, account);
}

/**
 * 科目そのものが属する箱（編集シートの見出し・アクセント用）。
 * boxForRole は role → 最初の箱しか引けないため、movable で分かれた現預金は
 * こちらで解決する。管理外（聖域・残高調整）は undefined。
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
      // 所属も並びも表示順マスタ（accountsInDisplayBox = 箱の所属 + 科目の正本順）。
      accounts: accountsInDisplayBox(
        box.box,
        accounts.filter(
          (a) =>
            showArchived ||
            (atDate === undefined
              ? !a.archived
              : accountExistsAt(a, atDate) ||
                (isFlowBox && hasPeriodActivity !== undefined && hasPeriodActivity(a))),
        ),
      ),
    };
  });
}

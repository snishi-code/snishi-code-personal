/*
 * 表示順の正本（v13.6 H1）。
 *
 * 「何がどの順で並ぶか」をアプリで**ここ 1 か所**に集める。ホームのカード・タイムラインの箱・
 * 数値レンズの木・グラフの系列・台帳のソート既定・勘定科目画面・内訳画面は、独自の配列や
 * 並べ替え比較を持たず、このモジュールが返す順序だけを参照する。
 *
 * 3 つの並びを持つ:
 *
 *  1. **箱の並び**（`DISPLAY_BOX_KEYS`）— 勘定科目画面の区分・タイムラインの箱・内訳の枠。
 *     ユーザーは並び替えられない（アプリが守る固定の骨格）。順序はコード定数。
 *  2. **科目の並び**（`compareAccountOrder` / `sortAccounts`）— 箱の中や平坦な一覧の並び。
 *     ユーザーが並び替えた順（`sortIndex`）を含み、**保存済みデータを読むだけ**。
 *  3. **6 分類の並び**（`DISPLAY_SECTION_KEYS`）— ホームのカード = 数値レンズの行。
 *     収支・純資産は「恒等式の行」で、箱ではないので並べ替え対象にしない（後述）。
 *
 * **箱の並びと科目の並びは別物**であり、片方から他方を導出しない。
 * 例: 科目の並びでは投資資産が継続コスト台帳の後ろ（`ROLE_ORDER`）だが、箱の並びでは
 * 投資が継続コスト台帳の前に来る。前者は平坦な一覧（ピッカー等）の見え方、後者は
 * 箱という枠の並びで、由来が違う。
 *
 * **分類（どの箱に属するか）と並び（どの順で出るか）の役割分担**:
 * 資産 4 箱の分類は `domain/assetGroups` が正本（`assetGroupOf`）。ここはそれを 1:1 で
 * 箱へ写すだけで、role / movable の条件を書き直さない。資産以外の箱の分類はここにしかない。
 *
 * wire / schema / 保存データには一切触れない（並びは保存しない。科目の `sortIndex` だけが
 * 既存の保存項目で、その読み方も従来どおり）。
 */
import { assetGroupOf, type AssetGroupKey } from './assetGroups';
import type { Account } from './types';

/* ------------------------------------------------------------------ *
 * 1. 科目の並び
 * ------------------------------------------------------------------ */

/**
 * 会計区分の表示優先順。平坦な一覧（ピッカー・チップ・資金繰りの原資など）の見え方を決める。
 * 箱の並び（`DISPLAY_BOX_KEYS`）とは別軸なので、片方を変えても他方は動かない。
 */
const TYPE_ORDER: Record<Account['type'], number> = {
  asset: 0,
  liability: 1,
  equity: 2,
  revenue: 3,
  expense: 4,
};

const ROLE_ORDER: Partial<Record<Account['role'], number>> = {
  'daily-asset': 0,
  'continuing-cost-asset': 2,
  'investment-asset': 3,
  'payment-liability': 0,
  'other-liability': 1,
  equity: 0,
  'income-category': 0,
  'expense-category': 0,
  // type が revenue/expense のどちらでも、そのセクションの末尾に置く。
  'system-adjustment': 1,
};

/**
 * 勘定科目の表示順。
 * role の表示優先順を最優先し、同じ role の中ではユーザーが並び替えた順
 * （sortIndex 昇順）→名前順で並べる。
 * 科目を列挙する場所はすべてこの比較関数を使う（単一正本）。
 */
export function compareAccountOrder(a: Account, b: Account): number {
  const typeDiff = TYPE_ORDER[a.type] - TYPE_ORDER[b.type];
  if (typeDiff !== 0) return typeDiff;
  const roleDiff =
    (ROLE_ORDER[a.role] ?? Number.MAX_SAFE_INTEGER) -
    (ROLE_ORDER[b.role] ?? Number.MAX_SAFE_INTEGER);
  if (roleDiff !== 0) return roleDiff;
  const ai = a.sortIndex ?? Number.MAX_SAFE_INTEGER;
  const bi = b.sortIndex ?? Number.MAX_SAFE_INTEGER;
  if (ai !== bi) return ai - bi;
  return a.name.localeCompare(b.name, 'ja');
}

export function sortAccounts(accounts: readonly Account[]): Account[] {
  return [...accounts].sort(compareAccountOrder);
}

/* ------------------------------------------------------------------ *
 * 2. 箱の並び
 * ------------------------------------------------------------------ */

/**
 * 大きな箱の識別子。勘定科目画面の区分・タイムラインの箱・内訳の枠が共有する。
 * ユーザーは箱を追加・削除・並び替えできない。
 */
export type DisplayBoxKey =
  | 'assetFree'
  | 'assetFixed'
  | 'investment'
  | 'continuingCost'
  | 'shortTermDebt'
  | 'longTermDebt'
  | 'income'
  | 'expense'
  | 'equity';

/**
 * 箱の並び（コード定数・単一正本）。**現状の並びをそのまま固定したもの**で、
 * 資産（自由 → 動かせない → 投資 → 月割り台帳）→ 負債（短期 → 長期）→ 収入 → 費用 → 純資産。
 * 箱の部分集合を使う画面（勘定科目画面は 7 箱・内訳の負債は 2 箱）は
 * `orderedDisplayBoxes` でこの並びから切り出す。
 */
export const DISPLAY_BOX_KEYS: readonly DisplayBoxKey[] = [
  'assetFree',
  'assetFixed',
  'investment',
  'continuingCost',
  'shortTermDebt',
  'longTermDebt',
  'income',
  'expense',
  'equity',
];

/**
 * 資産の 4 箱 ↔ `assetGroups` の 4 グループ（1:1）。
 * 分類そのものは `assetGroupOf` が正本で、ここでは role / movable を書き直さない。
 */
const ASSET_GROUP_BY_BOX: Partial<Record<DisplayBoxKey, AssetGroupKey>> = {
  assetFree: 'free',
  assetFixed: 'fixed',
  investment: 'investment',
  continuingCost: 'ledger',
};

/**
 * 資産以外の箱の所属。ここが唯一の定義（画面側で role を直接見て絞り込まない）。
 * 残高調整科目（system-adjustment）は type に基づき収入・費用の箱へ「表示だけ」所属する。
 */
const NON_ASSET_BOX_INCLUDES: Partial<Record<DisplayBoxKey, (account: Account) => boolean>> = {
  shortTermDebt: (account) => account.role === 'payment-liability',
  longTermDebt: (account) => account.role === 'other-liability',
  income: (account) =>
    account.role === 'income-category' ||
    (account.role === 'system-adjustment' && account.type === 'revenue'),
  expense: (account) =>
    account.role === 'expense-category' ||
    (account.role === 'system-adjustment' && account.type === 'expense'),
  equity: (account) => account.role === 'equity',
};

/** 科目がその箱に属するか。 */
export function displayBoxIncludes(key: DisplayBoxKey, account: Account): boolean {
  const group = ASSET_GROUP_BY_BOX[key];
  if (group !== undefined) return assetGroupOf(account) === group;
  return NON_ASSET_BOX_INCLUDES[key]?.(account) ?? false;
}

/**
 * 科目が属する箱。資産は `assetGroupOf` が全域関数なので必ず 1 つに入る
 * （どの箱にも入らない資産を作らない = 箱の合計 = 総資産を壊さないため）。
 */
export function displayBoxOf(account: Account): DisplayBoxKey | undefined {
  return DISPLAY_BOX_KEYS.find((key) => displayBoxIncludes(key, account));
}

/** 箱の並びでの位置。未知のキーは末尾（並びから黙って消さない）。 */
export function displayBoxIndex(key: DisplayBoxKey): number {
  const index = DISPLAY_BOX_KEYS.indexOf(key);
  return index === -1 ? DISPLAY_BOX_KEYS.length : index;
}

/** 箱に紐づく UI 定義などを箱の並びへ揃える（呼び出し側で配列の順を書かないため）。 */
export function sortByDisplayBox<T>(items: readonly T[], keyOf: (item: T) => DisplayBoxKey): T[] {
  return [...items].sort((a, b) => displayBoxIndex(keyOf(a)) - displayBoxIndex(keyOf(b)));
}

/** 箱の部分集合を正本順で切り出す（重複は畳む）。 */
export function orderedDisplayBoxes<K extends DisplayBoxKey>(keys: readonly K[]): K[] {
  const wanted = new Set<DisplayBoxKey>(keys);
  return DISPLAY_BOX_KEYS.filter((key): key is K => wanted.has(key));
}

/** 箱に属する科目を、科目の正本順で返す。 */
export function accountsInDisplayBox(key: DisplayBoxKey, accounts: readonly Account[]): Account[] {
  return sortAccounts(accounts.filter((account) => displayBoxIncludes(key, account)));
}

/**
 * 資産 4 グループの並び（箱の並びから導出）。
 * 内訳画面の枠と数値レンズの資産行の展開が同じ順で開く。
 */
export const ASSET_GROUP_KEYS: readonly AssetGroupKey[] = DISPLAY_BOX_KEYS.map(
  (key) => ASSET_GROUP_BY_BOX[key],
).filter((group): group is AssetGroupKey => group !== undefined);

/* ------------------------------------------------------------------ *
 * 3. 6 分類（ホームのカード = 数値レンズの行）
 * ------------------------------------------------------------------ */

export type DisplaySectionKey =
  | 'revenue'
  | 'expense'
  | 'net'
  | 'totalAssets'
  | 'totalLiabilities'
  | 'netAssets';

/** ホームの 1 段 = 数値レンズのフロー / ストックの区切り。 */
export type DisplaySectionGroupKey = 'flow' | 'stock';

/**
 * 箱ではない集計行。ホームの 1 段（stat-grid）ごとにまとめる。
 * 恒等式の行はここに書かず、`IDENTITY_SECTIONS` が自動で差し込む。
 */
const SECTION_GROUP_BASE: readonly {
  key: DisplaySectionGroupKey;
  sections: readonly DisplaySectionKey[];
}[] = [
  { key: 'flow', sections: ['revenue', 'expense'] },
  { key: 'stock', sections: ['totalAssets', 'totalLiabilities'] },
];

/**
 * 恒等式の行。並べ替えの対象ではなく、式の右辺の最後の行の**直後**へ自動で入る
 * （収支 = 収入 − 支出 → 支出の後 / 純資産 = 資産 − 負債 → 負債の後）。
 */
const IDENTITY_SECTIONS: readonly { key: DisplaySectionKey; after: DisplaySectionKey }[] = [
  { key: 'net', after: 'expense' },
  { key: 'netAssets', after: 'totalLiabilities' },
];

function withIdentitySections(sections: readonly DisplaySectionKey[]): DisplaySectionKey[] {
  return sections.flatMap((key) => [
    key,
    ...IDENTITY_SECTIONS.filter((row) => row.after === key).map((row) => row.key),
  ]);
}

export interface DisplaySectionGroup {
  key: DisplaySectionGroupKey;
  sections: DisplaySectionKey[];
}

/** ホームのカードの段（各段の中は恒等行込みの並び）。 */
export const DISPLAY_SECTION_GROUPS: readonly DisplaySectionGroup[] = SECTION_GROUP_BASE.map(
  (group) => ({ key: group.key, sections: withIdentitySections(group.sections) }),
);

/** 6 分類の並び（ホームのカード = 数値レンズの行を平坦にしたもの）。 */
export const DISPLAY_SECTION_KEYS: readonly DisplaySectionKey[] = DISPLAY_SECTION_GROUPS.flatMap(
  (group) => group.sections,
);

/** 恒等式の行か（並べ替え対象ではない・葉として扱う）。 */
export function isIdentitySection(key: DisplaySectionKey): boolean {
  return IDENTITY_SECTIONS.some((row) => row.key === key);
}

/** その分類が属する段（フロー = 期間の発生額 / ストック = 断面の残高）。 */
export function displaySectionGroupOf(key: DisplaySectionKey): DisplaySectionGroupKey {
  return DISPLAY_SECTION_GROUPS.find((group) => group.sections.includes(key))?.key ?? 'stock';
}

/**
 * その分類を右辺の最後の項に持つ恒等行（`net` は支出の後・`netAssets` は負債の後）。
 * 恒等行を「どの行の直後へ差し込むか」を知りたい側は、並びを自前で書かずにこれを引く。
 */
export function identitySectionsAfter(key: DisplaySectionKey): DisplaySectionKey[] {
  return IDENTITY_SECTIONS.filter((row) => row.after === key).map((row) => row.key);
}

/* ------------------------------------------------------------------ *
 * 4. 箱 → 6 分類（レンズ共通ラベル列の恒等行の自動配置）
 * ------------------------------------------------------------------ */

/**
 * 箱が集計上どの分類（6 分類）の内訳になるか。
 * 恒等行（収支・純資産）を「その式の右辺の最後の箱の直後」へ自動で置くためだけの対応表で、
 * **並びは持たない**（並びは `DISPLAY_BOX_KEYS` / `DISPLAY_SECTION_KEYS` が正本）。
 * 純資産の箱（equity 科目そのもの）は 6 分類のどれの内訳でもないので undefined
 * （恒等行の `netAssets` = 資産 − 負債 とは別物なので、ここで結び付けない）。
 */
const SECTION_BY_BOX: Record<DisplayBoxKey, DisplaySectionKey | undefined> = {
  assetFree: 'totalAssets',
  assetFixed: 'totalAssets',
  investment: 'totalAssets',
  continuingCost: 'totalAssets',
  shortTermDebt: 'totalLiabilities',
  longTermDebt: 'totalLiabilities',
  income: 'revenue',
  expense: 'expense',
  equity: undefined,
};

/** 箱が属する 6 分類（無い箱は undefined）。 */
export function displaySectionOfBox(key: DisplayBoxKey): DisplaySectionKey | undefined {
  return SECTION_BY_BOX[key];
}

/**
 * その分類が段の切り替わりか（数値レンズがフローとストックの間に引く区切り線）。
 * 最初の段の先頭には引かない。
 */
export function isDisplaySectionGroupStart(key: DisplaySectionKey): boolean {
  return DISPLAY_SECTION_GROUPS.some((group, index) => index > 0 && group.sections[0] === key);
}

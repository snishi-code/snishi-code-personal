/*
 * 時間平面の**共通ラベル列の木**（v13.6 H3・作者確定 2026-08-18）。
 *
 * レンズ（線分 / 数値 / グラフ）は**右ペインの描画を交換するだけ**のもので、左のラベル列は
 * 3 つで同じものを共有する。その「行が何本・どの順で並ぶか」をここ 1 か所で決める。
 *
 * 木の形（線分レンズの UI が正）:
 *   箱（`DISPLAY_BOX_KEYS` の並び） → 科目（`compareAccountOrder` の並び）
 * これに**恒等行**（収支・純資産）が自動で差し込まれる。恒等行は箱ではないので並べ替えの
 * 対象ではなく、子も持たない。差し込み位置は表示順マスタから導出する
 * （`identitySectionsAfter` = 式の右辺の最後の項の直後 → その分類の**最後の箱**の直後）。
 *
 * 並び・所属・段（フロー / ストック）はすべて `domain/displayOrder` から引く。
 * このモジュールは独自の配列を持たない（持つと「レンズごとの独自木」が復活する）。
 */
import {
  DISPLAY_BOX_KEYS,
  accountsInDisplayBox,
  displaySectionGroupOf,
  displaySectionOfBox,
  identitySectionsAfter,
  type DisplayBoxKey,
  type DisplaySectionKey,
} from './displayOrder';
import type { Account } from './types';

/**
 * 行の実体。`rule` / `item`（定期ルール・月割り項目）は科目ではないので**線分レンズだけ**が
 * 足す子で、値を持つレンズには現れない（`extraChildren`）。
 */
export type LensRowKind = 'box' | 'account' | 'identity' | 'rule' | 'item';

/**
 * ラベル列の 1 行。
 *
 * `id` は 3 レンズで共有するチェック状態・値の対応づけの鍵で、**行の実体が同じなら同じ**
 * （窓を送っても、レンズを変えても変わらない）。
 */
export interface LensRowNode {
  id: string;
  kind: LensRowKind;
  /**
   * ストック性（= 断面の残高を持つ行）。グラフレンズが描けるのはこの行だけで、
   * フロー行（収入・支出・収支）は描画形式が決まるまで対象外。
   */
  stock: boolean;
  /** 箱の行・科目の行が属する箱。 */
  boxKey?: DisplayBoxKey;
  /** 科目の行の科目 id。 */
  accountId?: string;
  /** 恒等行の分類。 */
  sectionKey?: DisplaySectionKey;
  /** ユーザーが付けた名前（科目・定期ルール・月割り項目）。箱と恒等行は i18n で名乗る。 */
  name?: string;
  children: LensRowNode[];
}

/** 行 id の作り方（文字列の組み立てを 1 か所に集める）。 */
export const lensRowId = {
  box: (key: DisplayBoxKey): string => `box:${key}`,
  account: (accountId: string): string => `account:${accountId}`,
  identity: (key: DisplaySectionKey): string => `identity:${key}`,
} as const;

/**
 * 科目へ展開しない箱。継続コスト台帳は**内部集約**（聖域 role）で、ユーザーに見せる内訳は
 * 科目ではなく月割り項目・定期ルールのほう。線分レンズだけがその部分木を足す
 * （`extraChildren`）。数値・グラフでは葉のまま = 内訳画面と同じ 1 行の見せ方。
 */
const BOXES_WITHOUT_ACCOUNT_CHILDREN: readonly DisplayBoxKey[] = ['continuingCost'];

/** 箱がストック性か（属する 6 分類の段で決まる。分類を持たない純資産の箱はストック）。 */
export function isStockBox(key: DisplayBoxKey): boolean {
  const section = displaySectionOfBox(key);
  return section === undefined || displaySectionGroupOf(section) === 'stock';
}

/** 箱がその分類の**最後の箱**か（恒等行を差し込む位置）。 */
function isLastBoxOfSection(key: DisplayBoxKey, section: DisplaySectionKey): boolean {
  const boxes = DISPLAY_BOX_KEYS.filter((box) => displaySectionOfBox(box) === section);
  return boxes.at(-1) === key;
}

export interface BuildLensRowTreeOptions {
  /**
   * 箱に足す**レンズ固有の子**（線分レンズの継続コスト台帳 = 定期ルール → 月割り項目）。
   * ここで返した子は科目の子の**後ろ**に付く。省略 = マスタの木そのまま。
   */
  extraChildren?: (boxKey: DisplayBoxKey) => readonly LensRowNode[];
}

/**
 * 共通ラベル列の木を組み立てる。
 *
 * @param accounts 行に出す科目（アーカイブ・存在期間の絞り込みは呼び出し側で済ませておく。
 *   ここで絞ると「レンズによって行が違う」が戻ってくるため、絞り込みは画面が 1 回だけ行う）。
 */
export function buildLensRowTree(
  accounts: readonly Account[],
  options: BuildLensRowTreeOptions = {},
): LensRowNode[] {
  const rows: LensRowNode[] = [];
  for (const boxKey of DISPLAY_BOX_KEYS) {
    const stock = isStockBox(boxKey);
    const accountChildren = BOXES_WITHOUT_ACCOUNT_CHILDREN.includes(boxKey)
      ? []
      : accountsInDisplayBox(boxKey, accounts).map<LensRowNode>((account) => ({
          id: lensRowId.account(account.id),
          kind: 'account',
          stock,
          boxKey,
          accountId: account.id,
          name: account.name,
          children: [],
        }));
    rows.push({
      id: lensRowId.box(boxKey),
      kind: 'box',
      stock,
      boxKey,
      children: [...accountChildren, ...(options.extraChildren?.(boxKey) ?? [])],
    });

    const section = displaySectionOfBox(boxKey);
    if (section === undefined || !isLastBoxOfSection(boxKey, section)) continue;
    for (const identity of identitySectionsAfter(section)) {
      rows.push({
        id: lensRowId.identity(identity),
        kind: 'identity',
        stock: displaySectionGroupOf(identity) === 'stock',
        sectionKey: identity,
        children: [],
      });
    }
  }
  return rows;
}

/** 木を深さ優先で平坦化する（展開されている行の子だけを続ける）。 */
export function flattenLensRows(
  tree: readonly LensRowNode[],
  expanded: ReadonlySet<string>,
): { node: LensRowNode; depth: number }[] {
  const flat: { node: LensRowNode; depth: number }[] = [];
  const walk = (nodes: readonly LensRowNode[], depth: number) => {
    for (const node of nodes) {
      flat.push({ node, depth });
      if (node.children.length > 0 && expanded.has(node.id)) walk(node.children, depth + 1);
    }
  };
  walk(tree, 0);
  return flat;
}

/** 木に含まれるすべての行 id（子も含む）。 */
export function lensRowIds(tree: readonly LensRowNode[]): string[] {
  return tree.flatMap((node) => [node.id, ...lensRowIds(node.children)]);
}

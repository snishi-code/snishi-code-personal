/*
 * カードタップ = 編集（src/ui/cardTap.ts）のタップ対象を引く共通クエリ。
 * 行/カードそのものが role="button" 属性を持つので、その中に残る操作ボタン（<button> 要素・
 * 暗黙 role）とはセレクタで区別できる。行の編集アイコンは存在しない（タップが編集の入口）。
 */
import { UI } from '../src/ui-contract';

/** くり返し記帳のルール行（表示順）。タップ = そのルールの編集シート。 */
export function ruleRows(): HTMLElement[] {
  return [
    ...document.querySelectorAll<HTMLElement>(
      `[data-ui="${UI.allocations.recurringList}"] [role="button"]`,
    ),
  ];
}

/** 先頭のルール行（撤去した編集アイコンの querySelector と同じ「最初の 1 件」）。 */
export function firstRuleRow(): HTMLElement | null {
  return ruleRows()[0] ?? null;
}

/** 継続コスト item のカード（表示順）。タップ = 実 item は編集シート・導出カードは由来ルール。 */
export function itemCards(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(`[data-ui="${UI.allocations.item}"]`)];
}

/** 先頭の item カード。 */
export function firstItemCard(): HTMLElement | null {
  return itemCards()[0] ?? null;
}

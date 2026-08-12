// 個人タグの色の意味 = 「ラウンド開始で外れるか」。
//
// 規則: KEEP_TAG_COLOR ('blue') 以外の色のタグは、ラウンド開始 (記録クリア) で対象から外れる。
// 青だけが残る。判定を否定形 (color !== KEEP_TAG_COLOR) で書いてあるのは意図的で、
// あとから色を足したときにその色が自動で「外れる側」に入る (残る色を増やすには
// ここを明示的に直す必要がある = 黙って残り続ける色が増えない)。
//
// 色リテラルの直書き比較を UI へ散らさない。色の意味を読むコードは必ずこのモジュールを通す。

import { TAG_COLORS, type TagColor, type TagDef } from './types';

/** ラウンド開始で「残る」色。 */
export const KEEP_TAG_COLOR: TagColor = 'blue';

/**
 * 新規タグの既定色 = 残る側 (青)。
 * 色を付け忘れたタグがラウンド開始で黙って消えるのを防ぐ安全側の既定。
 */
export const DEFAULT_TAG_COLOR: TagColor = KEEP_TAG_COLOR;

/** 未知値を弾く型ガード (取り込み・保存値の正規化用)。 */
export function isTagColor(v: unknown): v is TagColor {
  return typeof v === 'string' && (TAG_COLORS as readonly string[]).includes(v);
}

/** その色のタグがラウンド開始で対象から外れるか。 */
export function tagClearsOnRoundStart(color: TagColor): boolean {
  return color !== KEEP_TAG_COLOR;
}

/**
 * ラウンド開始で外すタグ名の集合を settings.tags (定義の正本) から作る。
 *
 * 定義に無い孤児タグ名は集合に入らない = 対象に残る (安全側)。
 * 色が未知値の定義も残す側へ倒す (fail-safe)。
 */
export function roundStartClearTagNames(tags: readonly TagDef[] | undefined): Set<string> {
  const out = new Set<string>();
  if (!Array.isArray(tags)) return out;
  for (const t of tags) {
    if (!t || typeof t.name !== 'string' || !t.name) continue;
    if (isTagColor(t.color) && tagClearsOnRoundStart(t.color)) out.add(t.name);
  }
  return out;
}

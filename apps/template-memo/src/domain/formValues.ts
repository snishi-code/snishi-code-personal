/*
 * フォーム入力値（subject.formValues）の純データロジック（DOM 非依存）。
 * 移植元: medical 側 hospital-rounds/src/domain/formatValues.ts（実運用で固まった
 * provenance 設計を継承し、キーを配列 index → 安定 itemId に変更した）。
 *
 * 各 item の保存形:
 *   text     : { value, source }  (source ∈ "preset" | "manual") / legacy 文字列
 *   number   : { value: "96", note: "O2 2L" } / legacy 文字列
 *   fraction : { value: "120/53", note: "…" } / legacy 文字列
 *
 * note は「テンプレート定義」ではなく「対象ごとの入力値」(SpO2 の酸素投与量など短文注記)。
 */

import type { TextEntry, NumericEntry } from './types';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// ============================
// text item の provenance
//
// text item の保存値は「正常文由来 (preset)」か「手入力由来 (manual)」かを区別する。
// これにより、ワンタップ正常チェックが手入力した本文を誤って上書き/消去しない。
// 正常文の基準は「呼び出し側が渡す現在のテンプレートの normal」= template が正本。
// 合成 (composeGroup) は value だけを出すので source は出力に出ない。
// ============================

export type TextSource = 'empty' | 'preset' | 'manual';

/** text 保存値から「現在の値文字列」を取り出す（object なら .value、文字列ならそのまま）。 */
export function readTextValue(stored: unknown): string {
  if (isPlainObject(stored)) return String(stored.value ?? '');
  return String(stored ?? '');
}

/**
 * text 保存値を { value, source } に正規化する。明示 source を持つ object は信頼し、
 * legacy 文字列は現在の正常文と比較して source を推論する（空→empty / =normal→preset /
 * それ以外→manual）。
 */
export function normalizeTextEntry(
  stored: unknown,
  currentNormal: unknown,
): { value: string; source: TextSource } {
  const normal = String(currentNormal ?? '');
  if (isPlainObject(stored)) {
    const value = String(stored.value ?? '');
    const src = stored.source;
    if (src === 'preset' || src === 'manual') {
      return { value, source: value === '' ? 'empty' : src };
    }
    // source 欠落の object は legacy 同様に推論
    return { value, source: value === '' ? 'empty' : value === normal ? 'preset' : 'manual' };
  }
  const value = String(stored ?? '');
  return { value, source: value === '' ? 'empty' : value === normal ? 'preset' : 'manual' };
}

export type PresetToggleDecision =
  | { action: 'write'; value: TextEntry }
  | { action: 'clear'; value: '' }
  | { action: 'openEditor' };

/**
 * ワンタップ正常チェックの判定（純関数・ミューテーションしない）。
 *   empty  → 正常文を preset として書く
 *   preset → クリアする（トグル）
 *   manual → 手入力を守り、エディタを開いて人間に委ねる
 * normal が空のテンプレートではワンタップは成立しない（openEditor に倒す）。
 */
export function decidePresetToggle(stored: unknown, currentNormal: unknown): PresetToggleDecision {
  const normal = String(currentNormal ?? '');
  const { source } = normalizeTextEntry(stored, normal);
  if (normal === '') return { action: 'openEditor' };
  if (source === 'empty') return { action: 'write', value: { value: normal, source: 'preset' } };
  if (source === 'preset') return { action: 'clear', value: '' };
  return { action: 'openEditor' };
}

/** 手入力保存用の TextEntry を作る（空文字は空のまま保存し provenance を持たせない）。 */
export function manualTextEntry(value: string): TextEntry | '' {
  return value === '' ? '' : { value, source: 'manual' };
}

// ============================
// number / fraction item
// ============================

/** number/fraction 保存値を { value, note } に正規化する（legacy 文字列は note="" 扱い）。 */
export function readNumericEntry(stored: unknown): { value: string; note: string } {
  if (isPlainObject(stored)) {
    return { value: String(stored.value ?? ''), note: String(stored.note ?? '') };
  }
  return { value: String(stored ?? ''), note: '' };
}

/** number/fraction 保存用の NumericEntry を作る（両方空なら空文字 = 未入力）。 */
export function numericEntry(value: string, note: string): NumericEntry | '' {
  if (value === '' && note === '') return '';
  return note === '' ? { value } : { value, note };
}

// ============================
// 群 (group) 単位のユーティリティ
// ============================

/** group の値レコード（formValues[groupId]）を安全に読む。 */
export function readGroupValues(formValues: unknown, groupId: string): Record<string, unknown> {
  if (!isPlainObject(formValues)) return {};
  const rec = formValues[groupId];
  return isPlainObject(rec) ? rec : {};
}

/** item 1 つでも実入力（空白以外）があるか。 */
export function groupHasInput(values: Record<string, unknown>): boolean {
  for (const key of Object.keys(values)) {
    const raw = values[key];
    if (isPlainObject(raw)) {
      if (String(raw.value ?? '').trim() !== '') return true;
      if (String(raw.note ?? '').trim() !== '') return true;
    } else if (String(raw ?? '').trim() !== '') {
      return true;
    }
  }
  return false;
}

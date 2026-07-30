/*
 * フォーム入力値（subject.formValues）の純データロジック（DOM 非依存）。
 * 移植元: medical 側 hospital-rounds/src/domain/formatValues.ts（実運用で固まった
 * provenance 設計を継承し、キーを配列 index → 安定 itemId に変更した）。
 *
 * 各 item の保存形（未入力は '' で保存する）:
 *   text     : { value, source }  (source ∈ "preset" | "manual")
 *   number   : { value: "96", note: "O2 2L" }
 *   fraction : { value: "120/53", note: "…" }
 *
 * note は「テンプレート定義」ではなく「対象ごとの入力値」(SpO2 の酸素投与量など短文注記)。
 * object 以外（未入力の '' や壊れた import JSON）は fail-safe に「未入力」へ倒す。
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

type TextSource = 'empty' | 'preset' | 'manual';

/** text 保存値から現在値を取り出す。source の無い数値形などは kind 変更の残骸として落とす。 */
export function readTextValue(stored: unknown): string {
  if (!isPlainObject(stored)) return '';
  if (stored.source !== 'preset' && stored.source !== 'manual') return '';
  return String(stored.value ?? '');
}

/** select は TextEntry 形に加え、現在の options に存在する値だけを採用する。 */
export function readSelectValue(stored: unknown, options: readonly string[]): string {
  const value = readTextValue(stored);
  return options.includes(value) ? value : '';
}

/**
 * text 保存値を { value, source } に正規化する。明示 source を持つ object は信頼し、
 * source 欠落の object は現在の正常文と比較して推論する（=normal→preset / それ以外→manual）。
 * object 以外・値が空なら empty。
 */
export function normalizeTextEntry(
  stored: unknown,
  currentNormal: unknown,
): { value: string; source: TextSource } {
  if (!isPlainObject(stored)) return { value: '', source: 'empty' };
  const value = String(stored.value ?? '');
  if (value === '') return { value, source: 'empty' };
  const src = stored.source;
  if (src === 'preset' || src === 'manual') return { value, source: src };
  return { value, source: value === String(currentNormal ?? '') ? 'preset' : 'manual' };
}

type PresetToggleDecision =
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

/** number/fraction 保存値を { value, note } に正規化する（object 以外は未入力）。 */
export function readNumericEntry(stored: unknown): { value: string; note: string } {
  if (!isPlainObject(stored)) return { value: '', note: '' };
  if ('source' in stored) return { value: '', note: '' };
  return { value: String(stored.value ?? ''), note: String(stored.note ?? '') };
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
    if (!isPlainObject(raw)) continue; // 未入力の '' / 壊れ値
    if (String(raw.value ?? '').trim() !== '') return true;
    if (String(raw.note ?? '').trim() !== '') return true;
  }
  return false;
}

/*
 * フォーム入力値（subject.formValues）の純データロジック（DOM 非依存）。
 * 移植元: medical 側 hospital-rounds/src/domain/formatValues.ts（実運用で固まった
 * provenance 設計を継承し、キーを配列 index → 安定 itemId に変更した）。
 *
 * 各 item の保存形（未入力は '' で保存する）:
 *   text / select : { value, source }  (source ∈ "preset" | "manual")
 *
 * 旧 number / fraction の保存形 { value, note? }（source を持たない）も、同じ経路で
 * 手入力値として読み取る。種類を text へ畳んだときに、端末内の既存値・取り込み JSON の
 * 値が黙って消えないようにするための引き取りであり、書き戻しは一切しない（read-side 移行）。
 *
 * note は「テンプレート定義」ではなく「対象ごとの入力値」(SpO2 の酸素投与量など短文注記)。
 * 入力 UI は当初から無く新規には作られないが、既存値の出力を落とさないよう読み書きは通す。
 * object 以外（未入力の '' や壊れた import JSON）は fail-safe に「未入力」へ倒す。
 */

import type { TextEntry } from './types';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// ============================
// text item の provenance
//
// text item の保存値は「正常文由来 (preset)」か「手入力由来 (manual)」かを区別する。
// これにより、正常チェックが手入力した本文を誤って上書き/消去しない。
// 正常文の基準は「呼び出し側が渡す現在のテンプレートの normal」= template が正本。
// 合成 (composePlacedFormat) は value だけを出すので source は出力に出ない。
// ============================

type TextSource = 'empty' | 'preset' | 'manual';

/**
 * 保存値から現在値を取り出す。source を持たない object（旧 number / fraction の保存形）も
 * 手入力値として引き取る — 種類を畳んだ後に既存の入力が消えないようにするため。
 */
export function readTextValue(stored: unknown): string {
  if (!isPlainObject(stored)) return '';
  return String(stored.value ?? '');
}

/**
 * 保存値に付随する注記を読む（旧 number / fraction 由来。入力 UI は無い）。
 * 合成では値+単位の後ろに付く。新規入力では常に '' になる。
 */
export function readEntryNote(stored: unknown): string {
  if (!isPlainObject(stored)) return '';
  return String(stored.note ?? '');
}

/** select は TextEntry 形に加え、現在の options に存在する値だけを採用する。 */
export function readSelectValue(stored: unknown, options: readonly string[]): string {
  const value = readTextValue(stored);
  return options.includes(value) ? value : '';
}

/**
 * 保存値を { value, source } に正規化する。明示 source を持つ object は信頼し、
 * source 欠落の object（旧 number / fraction 由来を含む）は現在の正常文と比較して
 * 推論する（=normal→preset / それ以外→manual）。object 以外・値が空なら empty。
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
 * 正常チェックの判定（純関数・ミューテーションしない）。
 *   empty  → 正常文を preset として書く
 *   preset → クリアする（トグル）
 *   manual → 手入力を守り、エディタを開いて人間に委ねる
 * normal が空のフォーマットではチェック入力は成立しない（openEditor に倒す）。
 */
export function decidePresetToggle(stored: unknown, currentNormal: unknown): PresetToggleDecision {
  const normal = String(currentNormal ?? '');
  const { source } = normalizeTextEntry(stored, normal);
  if (normal === '') return { action: 'openEditor' };
  if (source === 'empty') return { action: 'write', value: { value: normal, source: 'preset' } };
  if (source === 'preset') return { action: 'clear', value: '' };
  return { action: 'openEditor' };
}

/**
 * 手入力保存用の TextEntry を作る（空文字は空のまま保存し provenance を持たせない）。
 * note は旧データ由来の注記の持ち越し。編集で黙って捨てないよう呼び出し側が渡す。
 */
export function manualTextEntry(value: string, note = ''): TextEntry | '' {
  if (value === '') return note === '' ? '' : { value, source: 'manual', note };
  return note === '' ? { value, source: 'manual' } : { value, source: 'manual', note };
}

// ============================
// 配置単位のユーティリティ
// ============================

/** 配置の値レコード（formValues[placementId]）を安全に読む。 */
export function readPlacementValues(
  formValues: unknown,
  placementId: string,
): Record<string, unknown> {
  if (!isPlainObject(formValues)) return {};
  const rec = formValues[placementId];
  return isPlainObject(rec) ? rec : {};
}

/** item 1 つでも実入力（空白以外）があるか。 */
export function placementHasInput(values: Record<string, unknown>): boolean {
  for (const key of Object.keys(values)) {
    const raw = values[key];
    if (!isPlainObject(raw)) continue; // 未入力の '' / 壊れ値
    if (String(raw.value ?? '').trim() !== '') return true;
    if (String(raw.note ?? '').trim() !== '') return true;
  }
  return false;
}

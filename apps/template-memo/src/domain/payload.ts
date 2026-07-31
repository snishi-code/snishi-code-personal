// 患者画面 QR (転記用) の出力本文合成。UI 非依存にするため patient を引数で受ける純関数。
// コピー元: hospital-workspace/rounds/domain/payload.ts。固定フォーム (fixedFields) は
// テンプレート合成エンジン (domain/template.ts) へ置き換えた。
//
// 本文は現在のテンプレートで composePresetClean した合成文
// (問題 + 継続メモ + フォーム値 + 今回メモ + 空欄セクションの正常文) を出す。

import type { Patient } from './types';
import { composePresetClean, type Template } from './template';

/**
 * 患者画面 QR の本文を合成する。template が無い (null) 場合は今回メモだけに倒す
 * (クラッシュさせない fail-soft)。
 */
export function buildTabPayload(
  patient: Patient | null | undefined,
  template: Template | null | undefined,
): string {
  if (!patient) return '';
  if (template) return composePresetClean(patient, template);
  return typeof patient.visitMemo === 'string' ? patient.visitMemo.trim() : '';
}

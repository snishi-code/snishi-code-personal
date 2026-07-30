// 患者画面 QR (転記用) の出力本文合成。UI 非依存にするため patient を引数で受ける純関数。
// コピー元: hospital-workspace/rounds/domain/payload.ts。固定フォーム (fixedFields) は
// テンプレート合成エンジン (domain/template.ts) へ置き換えた。
//
// 本文:
//   - 清書 (confirmedNote) があればそれをそのまま出す (清書は composePresetClean 由来で
//     問題/申し送り/フォーム値を既に含む。二重掲載しない)。
//   - 無ければ現在のテンプレートで composeDocument した合成文 (問題 + 継続メモ +
//     常設群のフォーム値 + 今回メモ) を出す。

import type { Patient } from './types';
import { composeDocument, type Template } from './template';

/**
 * 患者画面 QR の本文を合成する。template が無い (null) 場合は清書 / 今回メモだけに倒す
 * (クラッシュさせない fail-soft)。
 */
export function buildTabPayload(
  patient: Patient | null | undefined,
  template: Template | null | undefined,
): string {
  if (!patient) return '';
  const confirmed = typeof patient.confirmedNote === 'string' ? patient.confirmedNote.trim() : '';
  if (confirmed !== '') return confirmed;
  if (template) return composeDocument(patient, template);
  return typeof patient.visitMemo === 'string' ? patient.visitMemo.trim() : '';
}

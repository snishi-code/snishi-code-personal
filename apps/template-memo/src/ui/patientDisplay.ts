// 患者表示の純ヘルパ。色値は app.css の --status-* 変数が正本 (ここはクラス名と形マークのみ)。

import { STATUS, type Patient, type PatientStatus } from '../domain/types';
import { s } from '../i18n';

/**
 * 色覚多様性対応: ステータスを色だけでなく形マークでも示す正準マッピング。
 * 青は ★ (十字ルールにより ＋ は使わない)。i18n 対象外。
 */
export const STATUS_MARK: Readonly<Record<PatientStatus, string>> = Object.freeze({
  [STATUS.NONE]: '−',
  [STATUS.YELLOW]: '▲',
  [STATUS.GREEN]: '✓',
  [STATUS.GRAY]: '✕',
  [STATUS.BLUE]: '★',
});

export function statusClass(status: PatientStatus | string): string {
  if (status === STATUS.YELLOW) return 'status-yellow';
  if (status === STATUS.GREEN) return 'status-green';
  if (status === STATUS.GRAY) return 'status-gray';
  if (status === STATUS.BLUE) return 'status-blue';
  return '';
}

interface StatusOption {
  status: PatientStatus;
  label: string;
  mark: string;
}

/** ステータス選択ポップアップの選択肢 (色は CSS クラス側)。 */
export function getStatusOptions(): StatusOption[] {
  const labels: Record<PatientStatus, string> = {
    [STATUS.NONE]: s.tagStatus.none,
    [STATUS.YELLOW]: s.tagStatus.yellow,
    [STATUS.GREEN]: s.tagStatus.green,
    [STATUS.GRAY]: s.tagStatus.gray,
    [STATUS.BLUE]: s.tagStatus.blue,
  };
  return (Object.values(STATUS) as PatientStatus[]).map((status) => ({
    status,
    label: labels[status],
    mark: STATUS_MARK[status],
  }));
}

/** 「部屋 氏名」表示。 */
export function formatPatientLabel(p: Patient | null | undefined, fallback: string): string {
  const name = p && p.name ? p.name : fallback || '';
  const room = String(p?.room ?? '').trim();
  return room ? `${room} ${name}` : name;
}

function patientRoomCompare(a: Patient, b: Patient): number {
  const ar = String(a.room ?? '').trim();
  const br = String(b.room ?? '').trim();
  if (ar && br) {
    const ai = parseInt(ar, 10);
    const bi = parseInt(br, 10);
    if (!isNaN(ai) && !isNaN(bi)) return ai - bi;
    return ar.localeCompare(br);
  }
  if (ar) return -1;
  if (br) return 1;
  return 0;
}

/**
 * 表示順の in-place ソート (部屋番号順)。各 view の描画前にだけ呼ぶ (表示中は動かさない)。
 * 編集モード中は呼ばないこと (行が別患者を指す患者取り違え防止)。
 * ※ 次回診察日ソート (nextVisit) は移植時に剥離した (作者決定)。
 */
export function ensurePatientOrder(patients: Patient[]): void {
  patients.sort(patientRoomCompare);
}

export function sanitizeRoomInput(raw: string): string {
  return String(raw ?? '').replace(/[^0-9]/g, '');
}

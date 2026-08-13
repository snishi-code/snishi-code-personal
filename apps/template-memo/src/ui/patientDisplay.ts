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

/**
 * 位置の比較器。数字混じりの文字列を人間の期待どおりに並べる (A2 < A10)。
 * 位置は自由文字列なので parseInt では英字始まりが全部同着になり、素の localeCompare では
 * 桁数の違う数字が辞書順になる (A10 < A2)。numeric: true の Collator が両方を満たす。
 */
const roomCollator = new Intl.Collator(undefined, { numeric: true });

export function patientRoomCompare(a: Patient, b: Patient): number {
  const ar = String(a.room ?? '').trim();
  const br = String(b.room ?? '').trim();
  // 同値 (未入力どうし・'007' と '7' など) は 0 を返す。Array#sort は安定なので
  // 追加した順が保たれる。pid 等で無理に決着させると、位置未入力の対象が
  // 「追加順」ではなく「id 順」というユーザーに読めない並びになる。
  if (ar && br) return roomCollator.compare(ar, br);
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

/**
 * 位置入力の掃除。数字強制はしない (A012・A-01・3F-12 のような表記を通すため)。
 * 落とすのは改行と制御文字だけ — 共有シートやメモから複数行を貼られると
 * 一覧の 1 行表示が壊れるため、そこだけを防ぐ。
 */
export function sanitizeRoomInput(raw: string): string {
  return String(raw ?? '').replace(/[\p{Cc}\p{Cf}]/gu, '');
}

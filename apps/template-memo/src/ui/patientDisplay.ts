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

/**
 * 「部屋」「氏名」の表示 2 部品。ホーム名簿は番号列と名前列を別スパンで描くため
 * (間隔と縦揃えは CSS 側)、結合前の部品を返す。氏名未入力は fallback (通し番号) へ倒す。
 */
export function patientLabelParts(
  p: Patient | null | undefined,
  fallback: string,
): { room: string; name: string } {
  return {
    room: String(p?.room ?? '').trim(),
    name: p && p.name ? p.name : fallback || '',
  };
}

/**
 * 名簿の番号 (位置) 列の幅 [ch 単位の数値]。一覧で最長の位置に合わせた共通 min-width を
 * 全行へ与え、桁数が違っても (1 と 100) 番号の頭と名前の頭がそれぞれ縦に揃うようにする。
 * 位置が 1 件も無ければ 0 = 列を作らない。
 *
 * ch は「0」の advance 幅なので、数字だけの位置なら揃いは正確 (数字は 0 と同幅以下)。
 * 全角文字は 2ch で数える近似。英字などで実幅が min-width を超える行は、その行の
 * 名前だけが右へ逃げる graceful degradation (他の行の揃えは崩れない)。
 */
export function roomColumnCh(patients: readonly Patient[]): number {
  let max = 0;
  for (const p of patients) {
    let len = 0;
    for (const c of String(p.room ?? '').trim()) len += (c.codePointAt(0) ?? 0) > 0xff ? 2 : 1;
    if (len > max) max = len;
  }
  return max;
}

/** 「部屋 氏名」の 1 行表示 (aria-label・QR ダイアログ等の文字列文脈用)。 */
export function formatPatientLabel(p: Patient | null | undefined, fallback: string): string {
  const { room, name } = patientLabelParts(p, fallback);
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

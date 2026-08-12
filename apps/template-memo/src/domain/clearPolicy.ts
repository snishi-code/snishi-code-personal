// ラウンド開始 / リセットのクリア固定ポリシー（コピー元: hospital-workspace/rounds/domain/clearPolicy.ts。
// AI整形結果・同期の群 revision 次元は剥離）。
//
// クリア対象はユーザー選択式にしない。コード側の固定ポリシーとして 1 箇所に集約し、
// UI (HomeView.runClear) はこの純関数を必ず通す。

import { nextGroupRevision } from '@snishi/foundation/sync/revision';
import { STATUS, type Patient } from './types';

/**
 * 1 患者に「ラウンド開始/リセット」のクリアを適用する (in-place 変異)。
 *
 * クリアする:
 *   - status: 黄 / 緑 / 灰 → none
 *   - 場所ごとの自由本文 (sectionTexts)
 *   - 今回分のフォーム入力値 (projectedValues)
 *   - clearTagNames に含まれる名前のタグ
 *
 * 残す:
 *   - status: 青 (持ち越し / 要注意)
 *   - 継続メモ (standingMemo)
 *   - clearTagNames に無いタグ (青のタグ・定義に無い孤児タグ名)
 *   - プロブレムリスト (problems)
 *
 * @param clearTagNames 外すタグ名の集合。色 (= 意味) の解決はここでは行わず、呼び出し側が
 *   settings.tags から domain/tags.ts の roundStartClearTagNames で作って渡す
 *   (domain のクリア方針が settings の形に依存しないようにする)。
 */
export function applyRoundStartClear(
  p: Patient,
  now: number,
  clearTagNames: ReadonlySet<string>,
): void {
  // status: 黄/緑/灰 は none に戻す。青は持ち越しとして残す。
  if (p.status === STATUS.YELLOW || p.status === STATUS.GREEN || p.status === STATUS.GRAY) {
    p.status = STATUS.NONE;
  }
  // タグ: 「外す」と指定された名前だけを落とす (集合に無い名前は残す = 安全側)。
  if (clearTagNames.size > 0 && Array.isArray(p.tags)) {
    p.tags = p.tags.filter((name) => !clearTagNames.has(name));
  }
  p.sectionTexts = {};
  // 今回分のフォーム入力値。継続メモのようには残さない (今回ラウンド分)。
  p.projectedValues = {};
  p.updatedAt = nextGroupRevision(now, p.updatedAt);
}

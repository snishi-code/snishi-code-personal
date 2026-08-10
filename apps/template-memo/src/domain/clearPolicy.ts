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
 *
 * 残す:
 *   - status: 青 (持ち越し / 要注意)
 *   - 継続メモ (standingMemo)
 *   - タグ (tags)
 *   - プロブレムリスト (problems)
 */
export function applyRoundStartClear(p: Patient, now: number): void {
  // status: 黄/緑/灰 は none に戻す。青は持ち越しとして残す。
  if (p.status === STATUS.YELLOW || p.status === STATUS.GREEN || p.status === STATUS.GRAY) {
    p.status = STATUS.NONE;
  }
  p.sectionTexts = {};
  // 今回分のフォーム入力値。継続メモのようには残さない (今回ラウンド分)。
  p.projectedValues = {};
  p.updatedAt = nextGroupRevision(now, p.updatedAt);
}

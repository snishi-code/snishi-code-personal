// 即時保存操作 (正常チェック / ステータス変更など) の成功体感の補助。
//
// 視覚フィードバックが主 (app.css の .formatNormalBtn.on アニメ等)。バイブは対応端末
// (主に Android Chrome) のみの補助で、iOS Safari / PWA では無害に no-op になる。
// 外部送信は一切しない (no-exfil)。

/** 対応端末でごく短い触覚フィードバック (10-20ms)。非対応は何もしない。 */
export function hapticTick(): void {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(15);
    }
  } catch {
    /* 触覚は補助。失敗しても本処理に影響させない */
  }
}

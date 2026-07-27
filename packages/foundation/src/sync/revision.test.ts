// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { nextGroupRevision, shouldApplyRevision } from './revision';

describe('sync/revision (Lamport/HLC-lite)', () => {
  it('shouldApplyRevision: strictly greater のみ true (重複=false / 古い=false)', () => {
    expect(shouldApplyRevision(100, 101)).toBe(true);
    expect(shouldApplyRevision(100, 100)).toBe(false);
    expect(shouldApplyRevision(100, 99)).toBe(false);
    // 数値でない/欠落は 0 扱い (fail-safe)。
    expect(shouldApplyRevision(Number.NaN, 1)).toBe(true);
    expect(shouldApplyRevision(1, Number.NaN)).toBe(false);
  });

  it('nextGroupRevision: 時計が進んでいれば now、遅れていれば prev+1 (単調増加)', () => {
    expect(nextGroupRevision(1000, 500)).toBe(1000);
    expect(nextGroupRevision(1000, 1000)).toBe(1001);
    expect(nextGroupRevision(500, 1000)).toBe(1001); // 時計が巻き戻っても revision は前進する
    expect(nextGroupRevision(1000)).toBe(1000); // prev 無し = now
    expect(nextGroupRevision(0, 0)).toBe(1);
  });

  it('相手の未来 revision を見た後の編集は、壁時計がズレていても必ず勝つ', () => {
    const remote = 2_000_000; // 進んだ時計の端末が付けた revision
    const localClock = 1_000_000; // 自端末の遅れた時計
    const next = nextGroupRevision(localClock, remote);
    expect(shouldApplyRevision(remote, next)).toBe(true);
  });
});

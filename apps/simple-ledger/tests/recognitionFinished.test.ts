/*
 * 継続コストの自動終了判定: 自動更新（repeat）の無い項目は認識完了（残価 0）で終了扱い。
 * 自動更新のある項目（毎月サブスク・3か月ごとの定期イベント等）は終了しない。
 */
import { describe, expect, it } from 'vitest';
import { isRecognitionFinished } from '../src/domain/monthlyCost';
import type { MonthlyCostItem } from '../src/domain/types';

function item(over: Partial<MonthlyCostItem>): MonthlyCostItem {
  return {
    id: 'x',
    name: 'x',
    managementScopeId: 's',
    kind: 'durable-asset',
    amount: 8000,
    costMonths: 8,
    startMonth: '2026-01',
    expenseAccountId: 'e',
    status: 'active',
    createdAt: 't',
    updatedAt: 't',
    ...over,
  };
}

describe('isRecognitionFinished', () => {
  it('償却のみ（repeat なし）は costMonths 経過で終了', () => {
    const m = item({});
    expect(isRecognitionFinished(m, '2026-08')).toBe(false); // 8 か月目（最終認識月）
    expect(isRecognitionFinished(m, '2026-09')).toBe(true); // 認識完了後
  });

  it('自動更新あり（毎月サブスク・3 か月ごとの定期イベント）は終了しない', () => {
    expect(
      isRecognitionFinished(item({ costMonths: 1, repeatEveryMonths: 1 }), '2030-01'),
    ).toBe(false);
    expect(
      isRecognitionFinished(item({ costMonths: 1, repeatEveryMonths: 3 }), '2030-01'),
    ).toBe(false);
  });

  it('開始前・認識中は終了ではない', () => {
    const m = item({});
    expect(isRecognitionFinished(m, '2025-12')).toBe(false);
    expect(isRecognitionFinished(m, '2026-04')).toBe(false);
  });
});

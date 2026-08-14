/*
 * 仕訳タップの単一正本（entryOpenPlan）。
 * 仕訳一覧・ホーム・資金繰りの 3 画面が同じ判定を共有する前提の対応表テスト。
 */
import { describe, expect, it } from 'vitest';
import { entryOpenPlan } from '../src/ui/entryOpen';
import type { JournalEntry } from '../src/domain/types';

const base = (over: Partial<JournalEntry>): JournalEntry => ({
  id: 'e',
  date: '2026-08-14',
  description: 'x',
  kind: 'normal',
  lines: [
    { accountId: 'a', side: 'debit', amount: 100 },
    { accountId: 'b', side: 'credit', amount: 100 },
  ],
  metadata: { inputMode: 'manual' },
  createdAt: '2026-08-14T00:00:00.000Z',
  updatedAt: '2026-08-14T00:00:00.000Z',
  ...over,
});

describe('entryOpenPlan', () => {
  it('通常の保存仕訳は編集シートへ', () => {
    expect(entryOpenPlan(base({}))).toEqual({ kind: 'edit' });
  });

  it('初期残高・残高補正は専用シートへ', () => {
    expect(entryOpenPlan(base({ kind: 'opening' }))).toEqual({ kind: 'opening' });
    expect(
      entryOpenPlan(
        base({
          metadata: {
            inputMode: 'manual',
            adjustment: {
              accountId: 'a',
              expectedBalance: 0,
              actualBalance: 100,
              delta: 100,
              counterpartAccountId: 'b',
            },
          },
        }),
      ),
    ).toEqual({ kind: 'adjustment' });
  });

  it('導出行は由来へ（ルール・継続コスト・投資科目）、名乗らないものは開かない', () => {
    expect(
      entryOpenPlan(
        base({ metadata: { inputMode: 'manual', virtual: true, recurringRuleId: 'r1' } }),
      ),
    ).toEqual({ kind: 'rule', ruleId: 'r1' });
    expect(
      entryOpenPlan(
        base({ metadata: { inputMode: 'manual', virtual: true, continuousCostId: 'm1' } }),
      ),
    ).toEqual({ kind: 'item', itemId: 'm1' });
    expect(
      entryOpenPlan(
        base({ metadata: { inputMode: 'manual', virtual: true, investmentProjectionOf: 'acc1' } }),
      ),
    ).toEqual({ kind: 'account', accountId: 'acc1' });
    expect(entryOpenPlan(base({ metadata: { inputMode: 'manual', virtual: true } }))).toEqual({
      kind: 'none',
    });
  });

  it('継続コスト絡みでも**保存された**仕訳（購入・回収）は編集シートへ（由来リンクではない）', () => {
    // 以前ホームはこの行を仕訳一覧へ飛ばしていた（monthlyCostId を見て誤分類）。
    expect(entryOpenPlan(base({ metadata: { inputMode: 'manual', monthlyCostId: 'm1' } }))).toEqual(
      { kind: 'edit' },
    );
  });
});

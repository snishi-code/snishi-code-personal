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
    ).toEqual({ kind: 'adjustment', entryId: 'e' });
  });

  it('補正の按分スライスは宣言した stored の補正へ（自分の ID ではない・v13.4 ①）', () => {
    expect(
      entryOpenPlan(
        base({
          id: 'adj-slice-pin1-2026-03',
          metadata: { virtual: true, adjustmentSliceOf: 'pin1' },
        }),
      ),
    ).toEqual({ kind: 'adjustment', entryId: 'pin1' });
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

  it('くり返し記帳が起票した**保存済み**仕訳も由来ルールへ（読み取り専用・2026-08-15）', () => {
    expect(
      entryOpenPlan(
        base({
          metadata: { inputMode: 'manual', recurringRuleId: 'r1', recurringMonth: '2026-08' },
        }),
      ),
    ).toEqual({ kind: 'rule', ruleId: 'r1' });
    // 由来メタが欠けた破損データでも、決定的 ID だけで由来へ倒す（fail-closed）。
    expect(entryOpenPlan(base({ id: 'rec-r1-2026-08' }))).toEqual({ kind: 'rule', ruleId: 'r1' });
    // 持ち込み扱いの起票（貸方が equity）でも初期残高シートへは流さない。
    expect(entryOpenPlan(base({ id: 'rec-r1-2026-08', kind: 'opening' }))).toEqual({
      kind: 'rule',
      ruleId: 'r1',
    });
    // 回収の振替は利用者自身の実仕訳なので、ccr- item を指していても編集シート。
    expect(
      entryOpenPlan(
        base({
          metadata: {
            inputMode: 'transfer',
            monthlyCostId: 'ccr-r1-2026-08',
            monthlyCostRecovery: true,
          },
        }),
      ),
    ).toEqual({ kind: 'edit' });
  });
});

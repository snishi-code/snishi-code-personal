/*
 * ローン = 月割り台帳 item（負債版・v13.13）の純関数と返済導出エンジン。
 *  - 判別子 = repaymentSourceAccountId の有無（構造による判別）。
 *  - 刻み = allocationCuts（k 番目 = addMonthsToDate(購入日, k)・端数は monthlyAmounts）。
 *  - 合計厳密一致: Σ導出返済 = 借入総額（端数が負債残高に残らない・旧 floor 設計の廃止）。
 *  - 同日一致: 返済の行は 借方 負債 / 貸方 返済元 の 1 本（台帳経由 2 本・1 刻み遅れの廃止）。
 *  - 一括返済（loanSettlement 仕訳）は spreadTotal から控除して残りを再按分する。
 */
import { describe, expect, it } from 'vitest';
import './setup';
import {
  isLoanItem,
  loanFirstRepaymentDate,
  loanInstallmentPreviewCount,
  loanItemForLiability,
  loanItemRemainingInstallments,
  loanItemSortAmount,
  loanQuickEndDate,
  loanRemainingDebt,
  loanRepaymentEntries,
  loanRepaymentEntriesForItem,
  loanRepaymentSchedule,
  loanSettledAmountsByItem,
  loanSpreadTotalOf,
} from '../src/domain/loan';
import { addMonthsToDate } from '../src/domain/allocation';
import { sumAmounts } from '../src/domain/safeSum';
import type { JournalEntry, MonthlyCostItem } from '../src/domain/types';

/** 基準: 10,000 借入・2026-08-18 購入・6 回払い（完済日 = 2027-02-18）。 */
function loan(over: Partial<MonthlyCostItem> = {}): MonthlyCostItem {
  return {
    id: 'loan1',
    name: '家電ローン',
    amount: 10000,
    startDate: '2026-08-18',
    endDate: '2027-02-18',
    expenseAccountId: 'liab',
    repaymentSourceAccountId: 'cash',
    createdAt: '2026-08-18T00:00:00.000Z',
    updatedAt: '2026-08-18T00:00:00.000Z',
    ...over,
  };
}

function settlementEntry(over: Partial<JournalEntry> & { amount: number }): JournalEntry {
  const { amount, ...rest } = over;
  return {
    id: rest.id ?? 's1',
    date: rest.date ?? '2026-11-01',
    description: '一括返済',
    kind: 'normal',
    lines: [
      { accountId: 'liab', side: 'debit', amount },
      { accountId: 'cash', side: 'credit', amount },
    ],
    metadata: { loanItemId: 'loan1', loanSettlement: true },
    createdAt: 'x',
    updatedAt: 'x',
    ...rest,
  };
}

describe('ローン item の判定（repaymentSourceAccountId の有無）', () => {
  it('返済元を持つ item だけがローン', () => {
    expect(isLoanItem(loan())).toBe(true);
    const normal = { ...loan() };
    delete normal.repaymentSourceAccountId;
    expect(isLoanItem(normal)).toBe(false);
  });

  it('負債からローン item を引ける（無ければ undefined = 台帳に出ない負債）', () => {
    const items = [loan()];
    expect(loanItemForLiability(items, 'liab')?.id).toBe('loan1');
    expect(loanItemForLiability(items, 'card')).toBeUndefined();
    // 返済元なしで計上先が同じ負債でも、ローンではないので引かない。
    const normal = { ...loan(), id: 'n1' };
    delete normal.repaymentSourceAccountId;
    expect(loanItemForLiability([normal], 'liab')).toBeUndefined();
  });
});

describe('返済スケジュール（合計厳密一致・監査 D の再現値）', () => {
  it('10,000 ÷ 6 は端数を先頭刻みへ配り、合計がちょうど 10,000（旧 floor 設計との差の固定）', () => {
    const cuts = loanRepaymentSchedule(loan());
    // 刻み日 = 購入日の同日通過（9/18〜翌2/18 の 6 本）。
    expect(cuts.map((c) => c.date)).toEqual([
      '2026-09-18',
      '2026-10-18',
      '2026-11-18',
      '2026-12-18',
      '2027-01-18',
      '2027-02-18',
    ]);
    // monthlyAmounts: base 1666・余り 4 を先頭 4 本へ +1 = [1667,1667,1667,1667,1666,1666]。
    expect(cuts.map((c) => c.amount)).toEqual([1667, 1667, 1667, 1667, 1666, 1666]);
    // 旧設計は floor 月額 1,666×6 = 9,996 で 4 が負債残高に残った。新設計は厳密一致。
    expect(sumAmounts(cuts.map((c) => c.amount))).toBe(10000);
  });

  it('任意の総額・期間で Σ = 総額（property 的な数パターン）', () => {
    for (const [amount, months] of [
      [1000000, 60],
      [999999, 7],
      [12000000, 1200],
      [7, 3],
      [1, 1],
    ] as const) {
      // 完済日 = 購入日 + months か月（inclusive）→ 刻みはちょうど months 本。
      const end = addMonthsToDate('2000-02-15', months);
      const cuts = loanRepaymentSchedule(loan({ amount, startDate: '2000-02-15', endDate: end }));
      expect(cuts).toHaveLength(months);
      expect(sumAmounts(cuts.map((c) => c.amount))).toBe(amount);
    }
  });

  it('縮退: 完済日が購入 1 か月後より前なら完済日に全額 1 本（起票ゼロ拒否は廃止）', () => {
    const cuts = loanRepaymentSchedule(loan({ endDate: '2026-08-30' }));
    expect(cuts).toEqual([{ date: '2026-08-30', amount: 10000 }]);
    // 購入当日完済も同じ（当日に全額）。
    expect(loanRepaymentSchedule(loan({ endDate: '2026-08-18' }))).toEqual([
      { date: '2026-08-18', amount: 10000 },
    ]);
    expect(loanInstallmentPreviewCount('2026-08-18', '2026-08-30')).toBe(1);
    expect(loanInstallmentPreviewCount('2026-08-18', '2027-02-18')).toBe(6);
  });

  it('完済日なし（ローンとして不正なデータ）は fail-soft に 1 本も生まれない', () => {
    const broken = { ...loan() };
    delete broken.endDate;
    expect(loanRepaymentSchedule(broken)).toEqual([]);
    expect(loanRepaymentEntriesForItem(broken, '2100-12-31')).toEqual([]);
  });

  it('初回返済日 = 購入日の 1 か月後（月末クランプ）・クイックチップは購入日 + n 年', () => {
    expect(loanFirstRepaymentDate('2026-08-18')).toBe('2026-09-18');
    expect(loanFirstRepaymentDate('2026-01-31')).toBe('2026-02-28');
    expect(loanQuickEndDate('2026-08-18', 1)).toBe('2027-08-18');
    expect(loanQuickEndDate('2026-08-18', 5)).toBe('2031-08-18');
    // + n 年の完済日で刻みはちょうど 12n 本。
    expect(
      loanRepaymentSchedule(loan({ endDate: loanQuickEndDate('2026-08-18', 1) })),
    ).toHaveLength(12);
  });
});

describe('返済の導出行（同日一致・借方 負債 / 貸方 返済元）', () => {
  it('各刻みに 1 本・資金の出と負債の減りが同日同額（1 刻み遅れの解消）', () => {
    const entries = loanRepaymentEntriesForItem(loan(), '2100-12-31');
    expect(entries).toHaveLength(6);
    const first = entries[0]!;
    expect(first.id).toBe('loan-pay-loan1-2026-09');
    expect(first.date).toBe('2026-09-18');
    expect(first.lines).toEqual([
      { accountId: 'liab', side: 'debit', amount: 1667 },
      { accountId: 'cash', side: 'credit', amount: 1667 },
    ]);
    // 由来の印は継続コストの導出行と同じ軸（entryOpen / derivedOrigin が item へ辿れる）。
    expect(first.metadata).toEqual({
      virtual: true,
      continuousCostId: 'loan1',
      ccKind: 'loan-repayment',
    });
  });

  it('upTo で切れる・ローンでない item からは生まれない', () => {
    expect(loanRepaymentEntriesForItem(loan(), '2026-10-01')).toHaveLength(1);
    const normal = { ...loan() };
    delete normal.repaymentSourceAccountId;
    expect(loanRepaymentEntriesForItem(normal, '2100-12-31')).toEqual([]);
  });
});

describe('一括返済（loanSettlement）の控除と残債', () => {
  it('一括返済の合計を item ごとに集計し、spreadTotal = amount − 合計', () => {
    const settled = loanSettledAmountsByItem([
      settlementEntry({ amount: 3000 }),
      settlementEntry({ id: 's2', amount: 1000 }),
      // 別 item・印なしは混ざらない。
      settlementEntry({
        id: 's3',
        amount: 500,
        metadata: { loanItemId: 'other', loanSettlement: true },
      }),
      settlementEntry({ id: 's4', amount: 700, metadata: {} }),
    ]);
    expect(settled.get('loan1')).toBe(4000);
    expect(loanSpreadTotalOf(loan(), settled)).toBe(6000);
    // 控除後も合計厳密一致（6,000 を 6 本に再按分）。
    const cuts = loanRepaymentSchedule(loan(), 6000);
    expect(sumAmounts(cuts.map((c) => c.amount))).toBe(6000);
  });

  it('理論残債 = spreadTotal − 経過刻み（remainingValue と同型）・残回数は基準日より後の刻み数', () => {
    const item = loan();
    // 2026-10-01 時点: 9/18 の 1,667 だけ経過。
    expect(loanRemainingDebt(item, '2026-10-01')).toBe(10000 - 1667);
    expect(loanRemainingDebt(item, '2026-08-18')).toBe(10000);
    expect(loanRemainingDebt(item, '2027-02-18')).toBe(0);
    expect(loanItemRemainingInstallments(item, '2026-08-18')).toBe(6);
    expect(loanItemRemainingInstallments(item, '2026-09-18')).toBe(5);
    expect(loanItemRemainingInstallments(item, '2027-02-18')).toBe(0);
  });

  it('金額 0 の刻みは導出・残回数の両方でスキップされる（既存エンジンと同じ）', () => {
    // spreadTotal 2 を 6 本へ → [1,1,0,0,0,0]。
    const entries = loanRepaymentEntriesForItem(loan(), '2100-12-31', 2);
    expect(entries).toHaveLength(2);
    expect(loanItemRemainingInstallments(loan(), '2026-08-18', 2)).toBe(2);
  });
});

describe('並び替え・複数 item の連結', () => {
  it('ローン item の額は負として比べる（表示は絶対値のまま）', () => {
    expect(loanItemSortAmount(loan())).toBe(-10000);
    const normal = { ...loan() };
    delete normal.repaymentSourceAccountId;
    expect(loanItemSortAmount(normal)).toBe(10000);
  });

  it('loanRepaymentEntries は一括返済を real から織り込んで全ローンを展開する', () => {
    const normal = { ...loan(), id: 'n1' };
    delete normal.repaymentSourceAccountId;
    const entries = loanRepaymentEntries(
      [loan(), normal],
      [settlementEntry({ amount: 4000 })],
      '2100-12-31',
    );
    // 6,000 へ再按分された 6 本だけ（normal からは生まれない）。
    expect(entries).toHaveLength(6);
    expect(sumAmounts(entries.map((e) => e.lines[0]!.amount))).toBe(6000);
  });
});

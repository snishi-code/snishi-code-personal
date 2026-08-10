/*
 * 継続コスト資産の「計算で生まれる仕訳」エンジンの不変条件を固定する。
 *  - 購入の仕訳は保存される仕訳（このエンジンからは生まれない）。生まれるのは費用行だけ。
 *  - 初月の月割り日は startDate ＝どの日付断面でも台帳がマイナスにならない（§13-5）。
 *  - 終了日なしは 1 本も生まれない（§13-2）。
 *  - 回収の振替は割り振る総額から差し引かれ、台帳は終了時に 0 で閉じる（§13-8）。
 */
import { describe, expect, it } from 'vitest';
import './setup';
import {
  CONTINUOUS_COST_HARD_CAP,
  continuousCostEntriesForItem,
  entriesWithContinuousCost,
  recoveredAmountsByItem,
} from '../src/domain/continuousCost';
import { CONTINUOUS_COST_LEDGER_ACCOUNT_ID } from '../src/domain/constants';
import { accountBalance, filterByDateRange } from '../src/domain/accounting';
import type { JournalEntry, MonthlyCostItem } from '../src/domain/types';

const LEDGER = CONTINUOUS_COST_LEDGER_ACCOUNT_ID;

function item(over: Partial<MonthlyCostItem>): MonthlyCostItem {
  return {
    id: 'yt',
    name: 'YouTube',
    amount: 12000,
    startDate: '2031-01-15',
    endDate: '2031-12-31',
    expenseAccountId: 'fun',
    createdAt: 'x',
    updatedAt: 'x',
    ...over,
  };
}

function withoutEnd(base: MonthlyCostItem): MonthlyCostItem {
  const next = { ...base };
  delete next.endDate;
  return next;
}

/** 購入の仕訳（保存される仕訳）を組み立てる（借方 台帳 / 貸方 支払い元）。 */
function purchaseOf(target: MonthlyCostItem, creditAccountId = 'cash'): JournalEntry {
  return {
    id: `p-${target.id}`,
    date: target.startDate,
    description: target.name,
    kind: 'normal',
    lines: [
      { accountId: LEDGER, side: 'debit', amount: target.amount },
      { accountId: creditAccountId, side: 'credit', amount: target.amount },
    ],
    metadata: { inputMode: 'expense', monthlyCostId: target.id },
    createdAt: 'x',
    updatedAt: 'x',
  };
}

/** 回収の振替（借方 振替先 / 貸方 台帳）。 */
function recoveryOf(target: MonthlyCostItem, amount: number, date: string): JournalEntry {
  return {
    id: `r-${target.id}`,
    date,
    description: target.name,
    kind: 'normal',
    lines: [
      { accountId: 'cash', side: 'debit', amount },
      { accountId: LEDGER, side: 'credit', amount },
    ],
    metadata: { inputMode: 'transfer', monthlyCostId: target.id, monthlyCostRecovery: true },
    createdAt: 'x',
    updatedAt: 'x',
  };
}

const balanceAt = (entries: JournalEntry[], accountId: string, asOf: string) =>
  accountBalance(accountId, 'asset', filterByDateRange(entries, undefined, asOf));

describe('continuousCostEntriesForItem', () => {
  it('年払い: 費用行 12 件・初月は startDate・2ヶ月目以降は月初・合計 = amount', () => {
    const es = continuousCostEntriesForItem(item({}), '2031-12-31');
    expect(es).toHaveLength(12);
    expect(es[0]?.date).toBe('2031-01-15');
    expect(es[1]?.date).toBe('2031-02-01');
    expect(es.every((e) => e.metadata?.ccKind === 'monthly-allocation')).toBe(true);
    expect(es.every((e) => e.metadata?.virtual === true)).toBe(true);
    const total = es.reduce(
      (s, e) => s + (e.lines.find((l) => l.side === 'debit')?.amount ?? 0),
      0,
    );
    expect(total).toBe(12000);
  });
  it('ID は cc-alloc-{itemId}-{YYYY-MM}（決定的）', () => {
    const es = continuousCostEntriesForItem(item({}), '2031-12-31');
    expect(es[0]?.id).toBe('cc-alloc-yt-2031-01');
    expect(es[11]?.id).toBe('cc-alloc-yt-2031-12');
    expect(continuousCostEntriesForItem(item({}), '2031-12-31').map((e) => e.id)).toEqual(
      es.map((e) => e.id),
    );
  });
  it('upTo で切れる・startDate 前の upTo では 1 本も出ない', () => {
    expect(continuousCostEntriesForItem(item({}), '2031-03-31')).toHaveLength(3);
    expect(continuousCostEntriesForItem(item({}), '2031-01-14')).toHaveLength(0);
  });
  it('終了日なしは何も生まれない（§13-2）', () => {
    expect(continuousCostEntriesForItem(withoutEnd(item({})), '2100-12-31')).toHaveLength(0);
  });
  it('HARD_CAP(2100-12-31) を超える upTo は打ち切られる', () => {
    const far = item({ startDate: '2100-11-01', endDate: '2101-06-30' });
    const es = continuousCostEntriesForItem(far, '2105-01-01');
    expect(es.every((e) => e.date <= CONTINUOUS_COST_HARD_CAP)).toBe(true);
  });
});

describe('台帳残高（購入の仕訳 + 費用行）', () => {
  it('初月に台帳がマイナスにならない（§13-5: startDate=2026-07-20）', () => {
    const mid = item({ id: 'w', startDate: '2026-07-20', endDate: '2027-06-30', amount: 12000 });
    const derived = entriesWithContinuousCost([purchaseOf(mid)], [mid], '2027-12-31');
    for (const asOf of ['2026-07-01', '2026-07-10', '2026-07-19', '2026-07-20', '2026-07-31']) {
      expect(balanceAt(derived, LEDGER, asOf)).toBeGreaterThanOrEqual(0);
    }
    // 購入前の断面では 0（費用行が購入より先に立たない）。
    expect(balanceAt(derived, LEDGER, '2026-07-19')).toBe(0);
  });
  it('終了日以降の台帳残高は 0・貸借一致（§13-4）', () => {
    const yr = item({});
    const derived = entriesWithContinuousCost([purchaseOf(yr)], [yr], '2032-12-31');
    expect(balanceAt(derived, LEDGER, '2031-12-31')).toBe(0);
    expect(balanceAt(derived, LEDGER, '2033-01-01')).toBe(0);
    // 貸借一致: 全行で debit 合計 = credit 合計。
    const debit = derived.flatMap((e) => e.lines).filter((l) => l.side === 'debit');
    const credit = derived.flatMap((e) => e.lines).filter((l) => l.side === 'credit');
    expect(debit.reduce((s, l) => s + l.amount, 0)).toBe(credit.reduce((s, l) => s + l.amount, 0));
  });
  it('終了日なし: 台帳残高 = 全額のまま・費用 0（§13-2）', () => {
    const open = withoutEnd(item({}));
    const derived = entriesWithContinuousCost([purchaseOf(open)], [open], '2035-12-31');
    expect(balanceAt(derived, LEDGER, '2035-12-31')).toBe(12000);
    expect(accountBalance('fun', 'expense', derived)).toBe(0);
  });
});

describe('費用化の開始日（購入日との分離 §D・受け入れ基準）', () => {
  it('今日 60,000 で購入・費用化 = 6ヶ月後の1ヶ月 → それまで台帳 60,000・費用 0、費用化月に全額', () => {
    // 購入 2026-08-10・費用化 2027-02-01〜2027-02-28（= 6ヶ月後の 1 ヶ月）。
    const deferred = item({
      id: 'd',
      amount: 60000,
      startDate: '2026-08-10',
      allocationStartDate: '2027-02-01',
      endDate: '2027-02-28',
    });
    const derived = entriesWithContinuousCost([purchaseOf(deferred)], [deferred], '2027-12-31');
    // 購入月〜費用化前月の各断面: 台帳残高 60,000・費用 0。
    for (const asOf of ['2026-08-10', '2026-08-31', '2026-11-30', '2027-01-31']) {
      expect(balanceAt(derived, LEDGER, asOf)).toBe(60000);
      expect(accountBalance('fun', 'expense', filterByDateRange(derived, undefined, asOf))).toBe(0);
    }
    // 費用化月に 60,000 が計上先へ乗り、台帳は 0 で閉じる。
    expect(
      accountBalance('fun', 'expense', filterByDateRange(derived, undefined, '2027-02-01')),
    ).toBe(60000);
    expect(balanceAt(derived, LEDGER, '2027-02-01')).toBe(0);
    // どの断面でも台帳がマイナスにならない（購入前は 0）。
    expect(balanceAt(derived, LEDGER, '2026-08-09')).toBe(0);
    for (const asOf of ['2026-08-09', '2026-08-10', '2027-01-31', '2027-02-01', '2027-12-31']) {
      expect(balanceAt(derived, LEDGER, asOf)).toBeGreaterThanOrEqual(0);
    }
    // 費用行は 1 本だけ・日付 = 費用化の開始日。
    const allocations = derived.filter((e) => e.metadata?.ccKind === 'monthly-allocation');
    expect(allocations).toHaveLength(1);
    expect(allocations[0]?.date).toBe('2027-02-01');
  });
  it('計上先が収入カテゴリ（差引形）でも同じく費用化月に乗る（借方 = 計上先）', () => {
    const deferred = item({
      id: 'sal',
      amount: 60000,
      startDate: '2026-08-10',
      allocationStartDate: '2027-02-01',
      endDate: '2027-02-28',
      expenseAccountId: 'salary',
    });
    const derived = entriesWithContinuousCost(
      [purchaseOf(deferred, 'bank')],
      [deferred],
      '2027-12-31',
    );
    const allocations = derived.filter((e) => e.metadata?.ccKind === 'monthly-allocation');
    expect(allocations).toHaveLength(1);
    expect(allocations[0]?.lines[0]).toEqual({ accountId: 'salary', side: 'debit', amount: 60000 });
    expect(balanceAt(derived, LEDGER, '2027-02-01')).toBe(0);
  });
  it('回収ありでも spreadTotal の再配分は費用化期間で効く・台帳は 0 で閉じる', () => {
    // 購入 2026-01-15・費用化 2026-07-01〜2026-12-31（6ヶ月）・回収 30,000。
    const deferred = item({
      id: 'r',
      amount: 60000,
      startDate: '2026-01-15',
      allocationStartDate: '2026-07-01',
      endDate: '2026-12-31',
    });
    const real = [purchaseOf(deferred), recoveryOf(deferred, 30000, '2026-12-31')];
    const derived = entriesWithContinuousCost(real, [deferred], '2027-12-31');
    const allocations = derived.filter((e) => e.metadata?.ccKind === 'monthly-allocation');
    expect(allocations).toHaveLength(6);
    expect(allocations[0]?.date).toBe('2026-07-01');
    expect(allocations.every((e) => e.lines[0]?.amount === 5000)).toBe(true);
    // 費用化前の断面は台帳 = 全額のまま。
    expect(balanceAt(derived, LEDGER, '2026-06-30')).toBe(60000);
    // 全期間の費用 = 30,000・台帳は 0 で閉じる（60,000 − 30,000 − 30,000）。
    expect(accountBalance('fun', 'expense', derived)).toBe(30000);
    expect(balanceAt(derived, LEDGER, '2027-12-31')).toBe(0);
  });
  it('HARD_CAP(2100-12-31) は費用化の開始日を使う item にも従来どおり効く', () => {
    const far = item({
      id: 'far',
      startDate: '2099-01-01',
      allocationStartDate: '2100-11-01',
      endDate: '2101-06-30',
    });
    const es = continuousCostEntriesForItem(far, '2105-01-01');
    expect(es.length).toBeGreaterThan(0);
    expect(es.every((e) => e.date <= CONTINUOUS_COST_HARD_CAP)).toBe(true);
  });
});

describe('回収の振替（アーカイブの売却・返金）', () => {
  it('recoveredAmountsByItem: 回収の振替だけを item ごとに合計する', () => {
    const yr = item({});
    const recovered = recoveredAmountsByItem([
      purchaseOf(yr),
      recoveryOf(yr, 30000, '2031-06-15'),
      recoveryOf({ ...yr, id: 'other' }, 500, '2031-06-15'),
    ]);
    expect(recovered.get('yt')).toBe(30000);
    expect(recovered.get('other')).toBe(500);
  });
  it('洗濯機 240,000 を 25ヶ月目に 30,000 で売却 → 月あたり 8,400・台帳 0・収入は増えない（§13-8）', () => {
    const washer = item({
      id: 'w',
      name: '洗濯機',
      amount: 240000,
      startDate: '2024-06-01',
      endDate: '2026-06-15',
      expenseAccountId: 'fixedcost',
    });
    const real = [purchaseOf(washer, 'bank'), recoveryOf(washer, 30000, '2026-06-15')];
    const derived = entriesWithContinuousCost(real, [washer], '2026-12-31');
    const allocations = derived.filter((e) => e.metadata?.ccKind === 'monthly-allocation');
    expect(allocations).toHaveLength(25); // 2024-06〜2026-06
    expect(allocations[0]?.lines[0]?.amount).toBe(8400); // 210,000 / 25
    // 全期間の費用合計 = 210,000（実際に減った価値）
    expect(accountBalance('fixedcost', 'expense', derived)).toBe(210000);
    // 台帳は 0 で閉じる: 240,000 − 210,000 − 30,000
    expect(balanceAt(derived, LEDGER, '2026-12-31')).toBe(0);
    // 収入は 1 行も生まれない
    expect(
      derived.some((e) => e.metadata?.virtual && e.lines.some((l) => l.accountId === 'income')),
    ).toBe(false);
  });
  it('年払い保険 60,000 を 6ヶ月で解約・30,000 返金 → 月あたり 5,000 のまま（§13-8）', () => {
    const insurance = item({
      id: 'ins',
      amount: 60000,
      startDate: '2026-01-01',
      endDate: '2026-06-30',
    });
    const real = [purchaseOf(insurance), recoveryOf(insurance, 30000, '2026-06-30')];
    const derived = entriesWithContinuousCost(real, [insurance], '2026-12-31');
    const allocations = derived.filter((e) => e.metadata?.ccKind === 'monthly-allocation');
    expect(allocations).toHaveLength(6);
    expect(allocations.every((e) => e.lines[0]?.amount === 5000)).toBe(true);
    expect(balanceAt(derived, LEDGER, '2026-12-31')).toBe(0);
  });
  it('回収額が購入額を超えたら費用行がマイナス＝過去にわたる費用減（上限なし・作者決定）', () => {
    const flipped = item({
      id: 'f',
      amount: 10000,
      startDate: '2026-01-01',
      endDate: '2026-02-28',
    });
    const real = [purchaseOf(flipped), recoveryOf(flipped, 16000, '2026-02-28')];
    const derived = entriesWithContinuousCost(real, [flipped], '2026-12-31');
    // 割り振る総額 = 10,000 − 16,000 = −6,000 → 月 −3,000
    expect(accountBalance('fun', 'expense', derived)).toBe(-6000);
    // 台帳は 0 で閉じる: 10,000 − (−6,000) − 16,000
    expect(balanceAt(derived, LEDGER, '2026-12-31')).toBe(0);
  });
});

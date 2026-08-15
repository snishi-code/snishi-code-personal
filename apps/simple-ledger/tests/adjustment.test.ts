import { describe, expect, it } from 'vitest';
import './setup';
import {
  buildAdjustmentEntry,
  counterpartName,
  counterpartRole,
  type AdjustmentInput,
} from '../src/domain/adjustment';

function base(over: Partial<AdjustmentInput>): AdjustmentInput {
  return {
    accountId: 'acc',
    accountType: 'asset',
    date: '2026-06-01',
    description: '残高補正',
    expectedBalance: 10000,
    actualBalance: 10000,
    counterpartAccountId: 'ctr',
    ...over,
  };
}

describe('counterpartRole / counterpartName', () => {
  it('損益方向', () => {
    expect(counterpartRole('asset', 2000)).toBe('revenue'); // 資産増 = 益
    expect(counterpartRole('asset', -2000)).toBe('expense'); // 資産減 = 損
    expect(counterpartRole('liability', 2000)).toBe('expense'); // 負債増 = 損
    expect(counterpartRole('liability', -2000)).toBe('revenue'); // 負債減 = 益
  });
  it('名称', () => {
    expect(counterpartName('expense')).toBe('残高調整費');
    expect(counterpartName('revenue')).toBe('残高調整収入');
  });
  it('費用・収入も正規方向で決まる（全科目化・作者決定 2026-08-15）', () => {
    // 借方正規（asset と同向）: 費用の実累計が多い = 借方 費用 なので相手は貸方 = 調整収入。
    expect(counterpartRole('expense', 2000)).toBe('revenue');
    expect(counterpartRole('expense', -2000)).toBe('expense');
    // 貸方正規（liability と同向）: 収入の実累計が多い = 貸方 収入 なので相手は借方 = 調整費。
    expect(counterpartRole('revenue', 2000)).toBe('expense');
    expect(counterpartRole('revenue', -2000)).toBe('revenue');
  });
});

describe('buildAdjustmentEntry', () => {
  it('資産 actual<expected: 借方 相手(費) / 貸方 資産', () => {
    const e = buildAdjustmentEntry(base({ expectedBalance: 10000, actualBalance: 8000 }))!;
    expect(e.lines.find((l) => l.side === 'debit')).toMatchObject({
      accountId: 'ctr',
      amount: 2000,
    });
    expect(e.lines.find((l) => l.side === 'credit')).toMatchObject({
      accountId: 'acc',
      amount: 2000,
    });
    expect(e.metadata?.adjustment?.delta).toBe(-2000);
  });
  it('資産 actual>expected: 借方 資産 / 貸方 相手(収入)', () => {
    const e = buildAdjustmentEntry(base({ expectedBalance: 10000, actualBalance: 12000 }))!;
    expect(e.lines.find((l) => l.side === 'debit')).toMatchObject({
      accountId: 'acc',
      amount: 2000,
    });
    expect(e.lines.find((l) => l.side === 'credit')).toMatchObject({
      accountId: 'ctr',
      amount: 2000,
    });
  });
  it('負債 actual>expected: 借方 相手(費) / 貸方 負債', () => {
    const e = buildAdjustmentEntry(
      base({ accountType: 'liability', expectedBalance: 10000, actualBalance: 12000 }),
    )!;
    expect(e.lines.find((l) => l.side === 'debit')).toMatchObject({
      accountId: 'ctr',
      amount: 2000,
    });
    expect(e.lines.find((l) => l.side === 'credit')).toMatchObject({
      accountId: 'acc',
      amount: 2000,
    });
  });
  it('負債 actual<expected: 借方 負債 / 貸方 相手(収入)', () => {
    const e = buildAdjustmentEntry(
      base({ accountType: 'liability', expectedBalance: 10000, actualBalance: 8000 }),
    )!;
    expect(e.lines.find((l) => l.side === 'debit')).toMatchObject({
      accountId: 'acc',
      amount: 2000,
    });
    expect(e.lines.find((l) => l.side === 'credit')).toMatchObject({
      accountId: 'ctr',
      amount: 2000,
    });
  });
  it('delta=0 は仕訳を作らない（null）', () => {
    expect(buildAdjustmentEntry(base({ expectedBalance: 5000, actualBalance: 5000 }))).toBeNull();
  });
  it('existing 指定で id / createdAt を引き継ぎ、updatedAt は更新する（編集の上書き）', () => {
    const e = buildAdjustmentEntry(
      base({
        expectedBalance: 10000,
        actualBalance: 8000,
        existing: { id: 'fixed-id', createdAt: '2026-01-01T00:00:00.000Z' },
      }),
    )!;
    expect(e.id).toBe('fixed-id');
    expect(e.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(e.updatedAt).not.toBe(e.createdAt);
  });
});

describe('buildAdjustmentEntry: 費用・収入（全科目化・作者決定 2026-08-15）', () => {
  // 費用は借方正規なので資産と同向、収入は貸方正規なので負債と同向になる。
  // 金額はすべて |7000 − 5000| = 2000（手計算）。
  it('費用 実累計が多い(delta>0): 借方 対象費用 / 貸方 相手(調整収入)', () => {
    const e = buildAdjustmentEntry(
      base({ accountType: 'expense', expectedBalance: 5000, actualBalance: 7000 }),
    )!;
    expect(e.lines.find((l) => l.side === 'debit')).toMatchObject({
      accountId: 'acc',
      amount: 2000,
    });
    expect(e.lines.find((l) => l.side === 'credit')).toMatchObject({
      accountId: 'ctr',
      amount: 2000,
    });
    expect(e.metadata?.adjustment?.delta).toBe(2000);
  });
  it('費用 実累計が少ない(delta<0): 借方 相手(調整費) / 貸方 対象費用', () => {
    const e = buildAdjustmentEntry(
      base({ accountType: 'expense', expectedBalance: 7000, actualBalance: 5000 }),
    )!;
    expect(e.lines.find((l) => l.side === 'debit')).toMatchObject({
      accountId: 'ctr',
      amount: 2000,
    });
    expect(e.lines.find((l) => l.side === 'credit')).toMatchObject({
      accountId: 'acc',
      amount: 2000,
    });
    expect(e.metadata?.adjustment?.delta).toBe(-2000);
  });
  it('収入 実累計が多い(delta>0): 貸方 対象収入 / 借方 相手(調整費)（負債と同向）', () => {
    const e = buildAdjustmentEntry(
      base({ accountType: 'revenue', expectedBalance: 5000, actualBalance: 7000 }),
    )!;
    expect(e.lines.find((l) => l.side === 'debit')).toMatchObject({
      accountId: 'ctr',
      amount: 2000,
    });
    expect(e.lines.find((l) => l.side === 'credit')).toMatchObject({
      accountId: 'acc',
      amount: 2000,
    });
  });
  it('収入 実累計が少ない(delta<0): 借方 対象収入 / 貸方 相手(調整収入)', () => {
    const e = buildAdjustmentEntry(
      base({ accountType: 'revenue', expectedBalance: 7000, actualBalance: 5000 }),
    )!;
    expect(e.lines.find((l) => l.side === 'debit')).toMatchObject({
      accountId: 'acc',
      amount: 2000,
    });
    expect(e.lines.find((l) => l.side === 'credit')).toMatchObject({
      accountId: 'ctr',
      amount: 2000,
    });
  });
});

describe('ADJUSTABLE_ACCOUNT_ROLES（補正対象の正本）', () => {
  it('資産・負債・費用・収入の役割を許し、内部集約と残高調整自身・equity を外す', async () => {
    const { ADJUSTABLE_ACCOUNT_ROLES } = await import('../src/domain/accountRoles');
    expect([...ADJUSTABLE_ACCOUNT_ROLES].sort()).toEqual(
      [
        'daily-asset',
        'investment-asset',
        'payment-liability',
        'other-liability',
        'income-category',
        'expense-category',
      ].sort(),
    );
    // 相手側（system-adjustment）は type が expense / revenue なので、
    // type だけを広げると入り込みうる。明示除外されていること。
    expect(ADJUSTABLE_ACCOUNT_ROLES).not.toContain('system-adjustment');
    expect(ADJUSTABLE_ACCOUNT_ROLES).not.toContain('continuing-cost-asset');
    expect(ADJUSTABLE_ACCOUNT_ROLES).not.toContain('equity');
  });
});

describe('残高調整科目の同定は role + type（name 非依存・指示書v3 §B-4）', () => {
  it('改名済みの残高調整科目でも二重生成せず再利用する', async () => {
    const { createAdjustment, loadLedger, upsertAccount } = await import('../src/data/repository');
    const { nowIso } = await import('../src/util/time');
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.role === 'daily-asset')!;
    // 1 回目の補正で残高調整科目（expense 側）が生まれる。
    await createAdjustment({ accountId: cash.id, date: '2026-03-01', actualBalance: -100 });
    let accounts = (await loadLedger()).accounts.filter(
      (a) => a.role === 'system-adjustment' && a.type === 'expense',
    );
    expect(accounts).toHaveLength(1);
    // 名前を変えても（= name 同定なら見つからなくなる状況でも）同じ科目が再利用される。
    await upsertAccount({ ...accounts[0]!, name: '調整（改名済み）', updatedAt: nowIso() });
    await createAdjustment({ accountId: cash.id, date: '2026-03-02', actualBalance: -200 });
    accounts = (await loadLedger()).accounts.filter(
      (a) => a.role === 'system-adjustment' && a.type === 'expense',
    );
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.name).toBe('調整（改名済み）');
  });
});

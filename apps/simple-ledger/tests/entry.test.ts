import { describe, expect, it } from 'vitest';
import './setup';
import {
  buildSimpleEntry,
  reserveBalanceShortfall,
  reversalInput,
  toSimpleInput,
  transferFlowValid,
  validateSimpleEntry,
} from '../src/domain/entry';
import type { Account, JournalEntry, ReserveItem } from '../src/domain/types';
import { DEFAULT_MANAGEMENT_SCOPE_ID, RESERVE_LEDGER_ACCOUNT_ID } from '../src/domain/constants';

describe('reserveBalanceShortfall（目的別資金の残高不足）', () => {
  const accounts: Account[] = [
    {
      id: 'res',
      name: '自動車購入資金',
      type: 'asset',
      role: 'reserve-asset',
      archived: false,
      createdAt: 'x',
      updatedAt: 'x',
    },
    {
      id: 'cash',
      name: '現金',
      type: 'asset',
      role: 'daily-asset',
      archived: false,
      createdAt: 'x',
      updatedAt: 'x',
    },
    {
      id: 'fixed',
      name: '固定資産',
      type: 'asset',
      role: 'fixed-asset',
      archived: false,
      createdAt: 'x',
      updatedAt: 'x',
    },
  ];
  // 既存: 現金 → 自動車購入資金 へ 100,000 を移し、res 残高 = 100,000。
  const funding: JournalEntry = {
    id: 'fund',
    date: '2026-01-10',
    description: '積立',
    kind: 'normal',
    managementScopeId: DEFAULT_MANAGEMENT_SCOPE_ID,
    lines: [
      { accountId: 'res', side: 'debit', amount: 100000 },
      { accountId: 'cash', side: 'credit', amount: 100000 },
    ],
    createdAt: 'x',
    updatedAt: 'x',
  };
  const purchase = (amount: number, date: string): JournalEntry => ({
    id: 'buy',
    date,
    description: '自動車購入',
    kind: 'normal',
    managementScopeId: DEFAULT_MANAGEMENT_SCOPE_ID,
    lines: [
      { accountId: 'fixed', side: 'debit', amount },
      { accountId: 'res', side: 'credit', amount },
    ],
    createdAt: 'x',
    updatedAt: 'x',
  });

  it('残高内の支出は null（不足なし）', () => {
    expect(reserveBalanceShortfall(purchase(80000, '2026-02-01'), accounts, [funding])).toBeNull();
  });
  it('残高を超える支出は不足（その資金を返す）', () => {
    const short = reserveBalanceShortfall(purchase(150000, '2026-02-01'), accounts, [funding]);
    expect(short?.accountId).toBe('res');
  });
  it('未来日付でも、その日までの積立を含めて判定する', () => {
    // 積立(1/10)より前の日付では残高 0 → 不足。
    expect(
      reserveBalanceShortfall(purchase(50000, '2026-01-05'), accounts, [funding]),
    ).not.toBeNull();
  });
  it('reserve-asset を貸方で減らさない仕訳は対象外（null）', () => {
    const incomeToReserve: JournalEntry = {
      id: 'x',
      date: '2026-02-01',
      description: '入金',
      kind: 'normal',
      managementScopeId: DEFAULT_MANAGEMENT_SCOPE_ID,
      lines: [
        { accountId: 'res', side: 'debit', amount: 5000 },
        { accountId: 'cash', side: 'credit', amount: 5000 },
      ],
      createdAt: 'x',
      updatedAt: 'x',
    };
    expect(reserveBalanceShortfall(incomeToReserve, accounts, [funding])).toBeNull();
  });
});

describe('reserveBalanceShortfall（集約モデル: 目的(reserveId)単位で判定）', () => {
  const accounts: Account[] = [
    {
      id: RESERVE_LEDGER_ACCOUNT_ID,
      name: '取り置き資金',
      type: 'asset',
      role: 'reserve-asset',
      archived: false,
      createdAt: 'x',
      updatedAt: 'x',
    },
    {
      id: 'cash',
      name: '現金',
      type: 'asset',
      role: 'daily-asset',
      archived: false,
      createdAt: 'x',
      updatedAt: 'x',
    },
    {
      id: 'exp',
      name: '変動費',
      type: 'expense',
      role: 'expense-category',
      archived: false,
      createdAt: 'x',
      updatedAt: 'x',
    },
  ];
  const reserves: ReserveItem[] = [
    {
      id: 'trip',
      name: '旅行',
      reserveAccountId: RESERVE_LEDGER_ACCOUNT_ID,
      createdAt: 'x',
      updatedAt: 'x',
    },
    {
      id: 'old',
      name: '老後',
      reserveAccountId: RESERVE_LEDGER_ACCOUNT_ID,
      createdAt: 'x',
      updatedAt: 'x',
    },
  ];
  // 集約口座へ: 老後に 50,000 取り置き（旅行は 0）。
  const fundOld: JournalEntry = {
    id: 'f-old',
    date: '2026-01-10',
    description: '老後へ取り置き',
    kind: 'normal',
    managementScopeId: DEFAULT_MANAGEMENT_SCOPE_ID,
    metadata: { reserveId: 'old' },
    lines: [
      { accountId: RESERVE_LEDGER_ACCOUNT_ID, side: 'debit', amount: 50000 },
      { accountId: 'cash', side: 'credit', amount: 50000 },
    ],
    createdAt: 'x',
    updatedAt: 'x',
  };
  const spendFromTrip: JournalEntry = {
    id: 'spend',
    date: '2026-02-01',
    description: '旅行から支払い',
    kind: 'normal',
    managementScopeId: DEFAULT_MANAGEMENT_SCOPE_ID,
    metadata: { reserveId: 'trip' },
    lines: [
      { accountId: 'exp', side: 'debit', amount: 30000 },
      { accountId: RESERVE_LEDGER_ACCOUNT_ID, side: 'credit', amount: 30000 },
    ],
    createdAt: 'x',
    updatedAt: 'x',
  };

  it('旅行が 0 円なら、集約口座に老後の残高があっても旅行からの支出は不足になる', () => {
    const short = reserveBalanceShortfall(spendFromTrip, accounts, [fundOld], reserves);
    expect(short).not.toBeNull();
    expect(short?.name).toBe('旅行'); // 目的名で返す
  });
  it('その目的に残高があれば不足しない（老後から 40,000）', () => {
    const spendFromOld: JournalEntry = {
      ...spendFromTrip,
      id: 'spend2',
      metadata: { reserveId: 'old' },
      lines: [
        { accountId: 'exp', side: 'debit', amount: 40000 },
        { accountId: RESERVE_LEDGER_ACCOUNT_ID, side: 'credit', amount: 40000 },
      ],
    };
    expect(reserveBalanceShortfall(spendFromOld, accounts, [fundOld], reserves)).toBeNull();
  });
});

describe('transferFlowValid（振替の役割組み合わせ）', () => {
  it('資金 ↔ 資金（日常/目的別）は valid', () => {
    expect(transferFlowValid('daily-asset', 'daily-asset')).toBe(true);
    expect(transferFlowValid('daily-asset', 'reserve-asset')).toBe(true);
    expect(transferFlowValid('reserve-asset', 'daily-asset')).toBe(true);
  });
  it('資金 → 負債（返済）は valid', () => {
    expect(transferFlowValid('daily-asset', 'payment-liability')).toBe(true);
    expect(transferFlowValid('reserve-asset', 'other-liability')).toBe(true);
  });
  it('負債 → 資金（借入・ローン実行）は valid', () => {
    expect(transferFlowValid('other-liability', 'reserve-asset')).toBe(true);
    expect(transferFlowValid('payment-liability', 'daily-asset')).toBe(true);
  });
  it('負債 → 負債 や 費用/収入/固定資産が絡む組み合わせは invalid', () => {
    expect(transferFlowValid('other-liability', 'payment-liability')).toBe(false);
    expect(transferFlowValid('expense-category', 'daily-asset')).toBe(false);
    expect(transferFlowValid('daily-asset', 'expense-category')).toBe(false);
    expect(transferFlowValid('income-category', 'daily-asset')).toBe(false);
    expect(transferFlowValid('daily-asset', 'fixed-asset')).toBe(false);
  });
});

describe('validateSimpleEntry', () => {
  it('完全な入力はエラーなし', () => {
    expect(
      validateSimpleEntry({
        date: '2026-06-01',
        description: 'ランチ',
        debitAccountId: 'a',
        creditAccountId: 'b',
        amount: 1000,
      }),
    ).toEqual([]);
  });
  it('未入力・同一科目・不正金額を検出', () => {
    const errs = validateSimpleEntry({
      date: '',
      description: '  ',
      debitAccountId: 'a',
      creditAccountId: 'a',
      amount: 0,
    });
    expect(errs).toContain('date-required');
    expect(errs).toContain('description-required');
    expect(errs).toContain('same-account');
    expect(errs).toContain('amount-invalid');
  });
});

describe('buildSimpleEntry', () => {
  it('借方・貸方 2 行の同額仕訳を作る', () => {
    const e = buildSimpleEntry({
      date: '2026-06-01',
      description: ' ランチ ',
      debitAccountId: 'food',
      creditAccountId: 'cash',
      amount: 1000,
    });
    expect(e.lines).toHaveLength(2);
    expect(e.description).toBe('ランチ');
    expect(e.lines.find((l) => l.side === 'debit')).toMatchObject({
      accountId: 'food',
      amount: 1000,
    });
    expect(e.lines.find((l) => l.side === 'credit')).toMatchObject({
      accountId: 'cash',
      amount: 1000,
    });
    expect(e.kind).toBe('normal');
    expect(e.id).toBeTruthy();
  });
  it('編集時は id/createdAt を引き継ぐ', () => {
    const e = buildSimpleEntry(
      {
        date: '2026-06-02',
        description: 'x',
        debitAccountId: 'a',
        creditAccountId: 'b',
        amount: 5,
      },
      { id: 'keep', createdAt: 'orig' },
    );
    expect(e.id).toBe('keep');
    expect(e.createdAt).toBe('orig');
  });
});

describe('toSimpleInput', () => {
  it('round-trip で借方/貸方/金額を復元', () => {
    const e = buildSimpleEntry({
      date: '2026-06-01',
      description: 'ランチ',
      debitAccountId: 'food',
      creditAccountId: 'cash',
      amount: 1000,
      memo: 'メモ',
    });
    const input = toSimpleInput(e);
    expect(input).toMatchObject({
      debitAccountId: 'food',
      creditAccountId: 'cash',
      amount: 1000,
      memo: 'メモ',
    });
  });
});

describe('buildSimpleEntry metadata', () => {
  it('inputMode を保持する', () => {
    const e = buildSimpleEntry({
      date: '2026-06-01',
      description: '給料',
      debitAccountId: 'cash',
      creditAccountId: 'salary',
      amount: 300000,
      metadata: { inputMode: 'income' },
    });
    expect(e.metadata?.inputMode).toBe('income');
  });
  it('空 metadata は付けない', () => {
    const e = buildSimpleEntry({
      date: '2026-06-01',
      description: 'x',
      debitAccountId: 'a',
      creditAccountId: 'b',
      amount: 1,
      metadata: {},
    });
    expect(e.metadata).toBeUndefined();
  });
});

describe('reversalInput', () => {
  const source: JournalEntry = {
    id: 'orig',
    date: '2026-06-01',
    description: 'クレジットで食費',
    kind: 'normal',
    managementScopeId: DEFAULT_MANAGEMENT_SCOPE_ID,
    lines: [
      { accountId: 'food', side: 'debit', amount: 1000 },
      { accountId: 'card', side: 'credit', amount: 1000 },
    ],
    createdAt: 'x',
    updatedAt: 'x',
  };

  it('借方/貸方を入れ替えた逆仕訳の入力を作る', () => {
    const input = reversalInput(source);
    // 元: 借方 food / 貸方 card → 逆: 借方 card / 貸方 food
    expect(input.debitAccountId).toBe('card');
    expect(input.creditAccountId).toBe('food');
    expect(input.amount).toBe(1000);
    expect(input.description).toBe('取消: クレジットで食費');
    expect(input.metadata?.inputMode).toBe('reversal');
    expect(input.metadata?.reversalOfEntryId).toBe('orig');
  });

  it('初期日付は元仕訳と同じ（未来取引の取消が今日を汚さない）', () => {
    const future = buildSimpleEntry({
      date: '2036-06-01',
      description: '車購入',
      debitAccountId: 'car',
      creditAccountId: 'card',
      amount: 3000000,
    });
    expect(reversalInput(future).date).toBe('2036-06-01');
    expect(reversalInput(source).date).toBe('2026-06-01');
  });

  it('逆仕訳を仕訳化すると元と反対向き・同額で貸借一致する', () => {
    const reversal = buildSimpleEntry(reversalInput(source));
    const debit = reversal.lines.find((l) => l.side === 'debit');
    const credit = reversal.lines.find((l) => l.side === 'credit');
    expect(debit).toMatchObject({ accountId: 'card', amount: 1000 });
    expect(credit).toMatchObject({ accountId: 'food', amount: 1000 });
    expect(reversal.id).not.toBe(source.id); // 元は別仕訳（削除しない）
  });
});

describe('reversalInput は仕訳全体タグ・管理区分・支払い手段を引き継ぐ', () => {
  it('全体タグ・管理区分を引き継ぎ、支払い手段は借方/貸方の入れ替えに合わせる', () => {
    const source: JournalEntry = {
      id: 's',
      date: '2026-06-01',
      description: '旅行',
      kind: 'normal',
      managementScopeId: 'scope-x',
      tagIds: ['trip'],
      lines: [
        { accountId: 'food', side: 'debit', amount: 1000, instrumentId: 'inst-food' },
        { accountId: 'cash', side: 'credit', amount: 1000, instrumentId: 'inst-pay' },
      ],
      createdAt: 'x',
      updatedAt: 'x',
    };
    const input = reversalInput(source);
    expect(input.tagIds).toEqual(['trip']);
    expect(input.managementScopeId).toBe('scope-x');
    // 元の貸方(inst-pay)が新しい借方、元の借方(inst-food)が新しい貸方
    expect(input.debitInstrumentId).toBe('inst-pay');
    expect(input.creditInstrumentId).toBe('inst-food');
  });
});

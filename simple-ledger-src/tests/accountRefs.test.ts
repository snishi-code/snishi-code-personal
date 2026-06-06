import { describe, expect, it } from 'vitest';
import { isAccountReferenced, referencedAccountIds } from '../src/domain/accountRefs';
import type { AccountRefCollections } from '../src/domain/accountRefs';
import type {
  AllocationItem,
  CashflowSchedule,
  JournalEntry,
  MonthlyCostItem,
  ReserveItem,
} from '../src/domain/types';

const empty: AccountRefCollections = {
  entries: [],
  schedules: [],
  reserves: [],
  allocations: [],
  monthlyCostItems: [],
  fundingGoals: [],
};

const monthlyCost: MonthlyCostItem = {
  id: 'mc1',
  name: 'x',
  kind: 'durable-asset',
  amount: 1000,
  costMonths: 10,
  startMonth: '2026-06',
  expenseAccountId: 'mc-exp',
  paymentAccountId: 'mc-pay',
  repaymentAccountId: 'mc-repay',
  status: 'active',
  createdAt: 'x',
  updatedAt: 'x',
};

const entry: JournalEntry = {
  id: 'e1',
  date: '2026-06-01',
  description: 'x',
  kind: 'normal',
  lines: [
    { accountId: 'cash', side: 'debit', amount: 100 },
    { accountId: 'food', side: 'credit', amount: 100 },
  ],
  createdAt: 'x',
  updatedAt: 'x',
};

const schedule: CashflowSchedule = {
  id: 's1',
  title: 'x',
  dueDate: '2026-07-10',
  amount: 100,
  direction: 'outflow',
  accountId: 'sched-acc',
  counterAccountId: 'sched-counter',
  source: 'manual',
  status: 'planned',
  createdAt: 'x',
  updatedAt: 'x',
};

const reserve: ReserveItem = {
  id: 'r1',
  name: 'x',
  reserveAccountId: 'res-acc',
  createdAt: 'x',
  updatedAt: 'x',
};

const allocation: AllocationItem = {
  id: 'a1',
  name: 'x',
  totalAmount: 300,
  months: 3,
  startMonth: '2026-06',
  expenseAccountId: 'alloc-exp',
  paymentAccountId: 'alloc-pay',
  deferredAccountId: 'alloc-def',
  sourceEntryId: 'se',
  recognitionEntryIds: ['r1e', 'r2e', 'r3e'],
  status: 'active',
  createdAt: 'x',
  updatedAt: 'x',
};

describe('isAccountReferenced（仕訳/予定CF/目的別資金/按分）', () => {
  it('仕訳明細の参照を検出する', () => {
    expect(isAccountReferenced('cash', { ...empty, entries: [entry] })).toBe(true);
    expect(isAccountReferenced('food', { ...empty, entries: [entry] })).toBe(true);
    expect(isAccountReferenced('nope', { ...empty, entries: [entry] })).toBe(false);
  });
  it('予定CF（account/counter）の参照を検出する', () => {
    expect(isAccountReferenced('sched-acc', { ...empty, schedules: [schedule] })).toBe(true);
    expect(isAccountReferenced('sched-counter', { ...empty, schedules: [schedule] })).toBe(true);
  });
  it('目的別資金の参照を検出する', () => {
    expect(isAccountReferenced('res-acc', { ...empty, reserves: [reserve] })).toBe(true);
  });
  it('按分（expense/payment/deferred）の参照を検出する', () => {
    expect(isAccountReferenced('alloc-exp', { ...empty, allocations: [allocation] })).toBe(true);
    expect(isAccountReferenced('alloc-pay', { ...empty, allocations: [allocation] })).toBe(true);
    expect(isAccountReferenced('alloc-def', { ...empty, allocations: [allocation] })).toBe(true);
  });
  it('月額化コスト（expense/payment/repayment）の参照を検出する', () => {
    expect(isAccountReferenced('mc-exp', { ...empty, monthlyCostItems: [monthlyCost] })).toBe(true);
    expect(isAccountReferenced('mc-pay', { ...empty, monthlyCostItems: [monthlyCost] })).toBe(true);
    expect(isAccountReferenced('mc-repay', { ...empty, monthlyCostItems: [monthlyCost] })).toBe(
      true,
    );
  });
});

describe('referencedAccountIds', () => {
  it('全コレクションの参照 ID を集める', () => {
    const ids = referencedAccountIds({
      entries: [entry],
      schedules: [schedule],
      reserves: [reserve],
      allocations: [allocation],
      monthlyCostItems: [monthlyCost],
      fundingGoals: [],
    });
    for (const id of [
      'cash',
      'food',
      'sched-acc',
      'sched-counter',
      'res-acc',
      'alloc-exp',
      'alloc-pay',
      'alloc-def',
      'mc-exp',
      'mc-pay',
      'mc-repay',
    ]) {
      expect(ids.has(id)).toBe(true);
    }
    expect(ids.has('unused')).toBe(false);
  });
});

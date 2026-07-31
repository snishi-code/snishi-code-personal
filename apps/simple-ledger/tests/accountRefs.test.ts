import { describe, expect, it } from 'vitest';
import './setup';
import { isAccountReferenced, referencedAccountIds } from '../src/domain/accountRefs';
import type { AccountRefCollections } from '../src/domain/accountRefs';
import type {
  CashflowSchedule,
  JournalEntry,
  MonthlyCostItem,
  RecurringRule,
} from '../src/domain/types';

const empty: AccountRefCollections = {
  entries: [],
  schedules: [],
  monthlyCostItems: [],
  recurringRules: [],
};

const monthlyCost: MonthlyCostItem = {
  id: 'mc1',
  name: 'x',
  amount: 1000,
  startDate: '2026-06-01',
  endDate: '2027-03-31',
  expenseAccountId: 'mc-exp',
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

const rule: RecurringRule = {
  id: 'r1',
  name: 'x',
  amount: 100,
  dayOfMonth: 1,
  everyMonths: 1,
  spreadExpenseAccountId: 'rule-spread',
  debitAccountId: 'rule-debit',
  creditAccountId: 'rule-credit',
  startMonth: '2026-06',
  startDate: '2026-06-01',
  createdAt: 'x',
  updatedAt: 'x',
};

describe('isAccountReferenced（仕訳/予定CF/継続コスト）', () => {
  it('仕訳明細の参照を検出する', () => {
    expect(isAccountReferenced('cash', { ...empty, entries: [entry] })).toBe(true);
    expect(isAccountReferenced('food', { ...empty, entries: [entry] })).toBe(true);
    expect(isAccountReferenced('nope', { ...empty, entries: [entry] })).toBe(false);
  });
  it('予定CF（account/counter）の参照を検出する', () => {
    expect(isAccountReferenced('sched-acc', { ...empty, schedules: [schedule] })).toBe(true);
    expect(isAccountReferenced('sched-counter', { ...empty, schedules: [schedule] })).toBe(true);
  });
  it('継続コスト資産の参照は費用の行き先だけ（支払い元は購入の仕訳が仕訳側で参照する）', () => {
    expect(isAccountReferenced('mc-exp', { ...empty, monthlyCostItems: [monthlyCost] })).toBe(true);
    expect(isAccountReferenced('mc-src', { ...empty, monthlyCostItems: [monthlyCost] })).toBe(
      false,
    );
  });
  it('定期ルールの借方・貸方・費用の行き先を参照として検出する（未起票でも保護する・監査 P1-7）', () => {
    expect(isAccountReferenced('rule-debit', { ...empty, recurringRules: [rule] })).toBe(true);
    expect(isAccountReferenced('rule-credit', { ...empty, recurringRules: [rule] })).toBe(true);
    expect(isAccountReferenced('rule-spread', { ...empty, recurringRules: [rule] })).toBe(true);
    expect(isAccountReferenced('nope', { ...empty, recurringRules: [rule] })).toBe(false);
  });
});

describe('referencedAccountIds', () => {
  it('全コレクションの参照 ID を集める', () => {
    const ids = referencedAccountIds({
      entries: [entry],
      schedules: [schedule],
      monthlyCostItems: [monthlyCost],
      recurringRules: [rule],
    });
    for (const id of [
      'cash',
      'food',
      'sched-acc',
      'sched-counter',
      'mc-exp',
      'rule-debit',
      'rule-credit',
      'rule-spread',
    ]) {
      expect(ids.has(id)).toBe(true);
    }
    expect(ids.has('unused')).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import {
  defaultRoleForType,
  inferRole,
  roleAllowsType,
  rolesForType,
} from '../src/domain/accountRoles';
import { groupedAccountsByRole } from '../src/ui/accountOptions';
import type { Account } from '../src/domain/types';

function acc(over: Partial<Account>): Account {
  return {
    id: 'x',
    name: 'x',
    type: 'asset',
    role: 'daily-asset',
    archived: false,
    createdAt: 'x',
    updatedAt: 'x',
    ...over,
  };
}

describe('role と type の整合', () => {
  it('roleAllowsType', () => {
    expect(roleAllowsType('daily-asset', 'asset')).toBe(true);
    expect(roleAllowsType('daily-asset', 'expense')).toBe(false);
    expect(roleAllowsType('system-adjustment', 'expense')).toBe(true);
    expect(roleAllowsType('system-adjustment', 'revenue')).toBe(true);
    expect(roleAllowsType('payment-liability', 'liability')).toBe(true);
  });
  it('defaultRoleForType', () => {
    expect(defaultRoleForType('asset')).toBe('daily-asset');
    expect(defaultRoleForType('liability')).toBe('other-liability');
    expect(defaultRoleForType('revenue')).toBe('income-category');
    expect(defaultRoleForType('expense')).toBe('expense-category');
    expect(defaultRoleForType('equity')).toBe('equity');
  });
  it('rolesForType はその type の role だけを返す', () => {
    expect(rolesForType('asset')).toEqual([
      'daily-asset',
      'reserve-asset',
      'deferred-asset',
      'investment-asset',
      'fixed-asset',
      'continuing-cost-asset',
    ]);
    expect(rolesForType('liability')).toEqual(['payment-liability', 'other-liability']);
  });
  it('fixed-asset は asset のみ許可（現金ではない資産）', () => {
    expect(roleAllowsType('fixed-asset', 'asset')).toBe(true);
    expect(roleAllowsType('fixed-asset', 'expense')).toBe(false);
    expect(roleAllowsType('fixed-asset', 'liability')).toBe(false);
  });
});

describe('inferRole', () => {
  const ctx = { deferredIds: new Set(['def']), reserveIds: new Set(['res']) };
  it('按分中資産・目的別資金・カード・調整科目を推定する', () => {
    expect(inferRole(acc({ id: 'def', name: '按分中資産' }), ctx)).toBe('deferred-asset');
    expect(inferRole(acc({ id: 'res', name: '貯金' }), ctx)).toBe('reserve-asset');
    expect(inferRole(acc({ id: 'c', name: '現金' }), ctx)).toBe('daily-asset');
    expect(inferRole(acc({ type: 'liability', name: 'クレジットカード（未払）' }), ctx)).toBe(
      'payment-liability',
    );
    expect(inferRole(acc({ type: 'liability', name: '住宅ローン' }), ctx)).toBe('other-liability');
    expect(inferRole(acc({ type: 'expense', name: '残高調整費' }), ctx)).toBe('system-adjustment');
    expect(inferRole(acc({ type: 'revenue', name: '給与収入' }), ctx)).toBe('income-category');
  });
});

describe('groupedAccountsByRole（日常入力の候補絞り込み）', () => {
  const accounts: Account[] = [
    acc({ id: 'cash', name: '現金', role: 'daily-asset' }),
    acc({ id: 'def', name: '按分中資産', role: 'deferred-asset' }),
    acc({ id: 'res', name: '貯金', role: 'reserve-asset' }),
    acc({ id: 'inv', name: '投資', role: 'investment-asset' }),
  ];
  it('daily-asset だけに絞ると、按分中/目的別/投資は出ない', () => {
    const groups = groupedAccountsByRole(accounts, ['daily-asset']);
    const ids = groups.flatMap((g) => g.accounts.map((a) => a.id));
    expect(ids).toEqual(['cash']);
  });
  it('includeId は役割に関わらず残る（編集中の既存選択値）', () => {
    const groups = groupedAccountsByRole(accounts, ['daily-asset'], 'def');
    const ids = groups.flatMap((g) => g.accounts.map((a) => a.id));
    expect(ids).toContain('def');
  });
});

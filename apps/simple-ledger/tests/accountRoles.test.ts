import { describe, expect, it } from 'vitest';
import './setup';
import {
  defaultRoleForType,
  inferRole,
  isInternalRole,
  roleAllowsType,
  rolesForType,
} from '../src/domain/accountRoles';
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
  it('rolesForType はその type の role だけを返す（内部ロールは除く）', () => {
    // continuing-cost-asset（継続コスト台帳）と reserve-asset（取り置き・聖域化）は内部ロールなので
    // ユーザー選択肢に出さない。
    expect(rolesForType('asset')).toEqual([
      'daily-asset',
      'deferred-asset',
      'investment-asset',
      'fixed-asset',
    ]);
    expect(rolesForType('asset')).not.toContain('continuing-cost-asset');
    expect(rolesForType('asset')).not.toContain('reserve-asset');
    expect(rolesForType('liability')).toEqual(['payment-liability', 'other-liability']);
  });
  it('isInternalRole は continuing-cost-asset / reserve-asset（内部・聖域化）を真にする', () => {
    expect(isInternalRole('continuing-cost-asset')).toBe(true);
    expect(isInternalRole('reserve-asset')).toBe(true);
    expect(isInternalRole('daily-asset')).toBe(false);
    expect(isInternalRole('fixed-asset')).toBe(false);
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

// NOTE(UI 移植担当へ): v1 の groupedAccountsByRole（日常入力の候補絞り込み）のテストは
// src/ui/accountOptions.ts に依存するため、UI 層の移植時に accountOptions.ts と併せて復元すること
// （v1 tests/accountRoles.test.ts の「groupedAccountsByRole」describe ブロックが正本）。

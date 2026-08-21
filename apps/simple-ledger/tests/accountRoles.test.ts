import { describe, expect, it } from 'vitest';
import './setup';
import {
  defaultRoleForType,
  isInternalRole,
  roleAllowsType,
  rolesForType,
} from '../src/domain/accountRoles';

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
    // continuing-cost-asset（継続コスト台帳）は内部ロールなのでユーザー選択肢に出さない。
    expect(rolesForType('asset')).toEqual(['daily-asset']);
    expect(rolesForType('asset')).not.toContain('continuing-cost-asset');
    expect(rolesForType('liability')).toEqual(['payment-liability', 'other-liability']);
  });
  it('isInternalRole は continuing-cost-asset（内部・聖域化）を真にする', () => {
    expect(isInternalRole('continuing-cost-asset')).toBe(true);
    expect(isInternalRole('daily-asset')).toBe(false);
  });
});

// NOTE: groupedAccountsByRole（日常入力の候補絞り込み）のテストは src/ui/accountOptions.ts に
// 依存する。accountOptions.ts を追加するときに、そのテストも併せて用意すること。

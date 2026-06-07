/*
 * 既存按分(AllocationItem)から月額化コスト(MonthlyCostItem)への移行生成。
 * migration（v6→v7）と起動時補完の両方で使う純関数。決定的（乱数・現在時刻を使わない）。
 *
 * 既存按分は「総額を months か月に分けて費用認識する」もの＝1 回限りの束（repeatEveryMonths なし）。
 * 種類は既定で 'durable-asset'（既存の意味は厳密には不明なため。詳細は docs/dev/ledger-concept.md）。
 */
import { DEFAULT_MANAGEMENT_SCOPE_ID } from './constants';
import type { AllocationItem, MonthlyCostItem } from './types';

export function monthlyCostItemFromAllocation(al: AllocationItem): MonthlyCostItem {
  return {
    id: `mc-${al.id}`,
    name: al.name,
    managementScopeId: DEFAULT_MANAGEMENT_SCOPE_ID,
    kind: 'durable-asset',
    amount: al.totalAmount,
    costMonths: al.months,
    startMonth: al.startMonth,
    expenseAccountId: al.expenseAccountId,
    paymentAccountId: al.paymentAccountId,
    sourceAllocationId: al.id,
    status: al.status === 'active' ? 'active' : 'ended',
    createdAt: al.createdAt,
    updatedAt: al.updatedAt,
  };
}

export function monthlyCostItemsFromAllocations(allocations: AllocationItem[]): MonthlyCostItem[] {
  return allocations.map(monthlyCostItemFromAllocation);
}

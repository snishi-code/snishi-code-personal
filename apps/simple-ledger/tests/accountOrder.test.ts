/*
 * 勘定科目の並び替え: compareAccountOrder（sortIndex 優先 → 名前順）と
 * reorderAccounts（配列順を sortIndex として保存）・箱グルーピングへの反映。
 */
import { describe, expect, it } from 'vitest';
import './setup';
import { loadLedger, reorderAccounts } from '../src/data/repository';
import { compareAccountOrder } from '../src/domain/accountOrder';
import { groupAccountsByBox } from '../src/ui/accountBoxes';
import { ledgerExportPackageSchema } from '../src/domain/schema';
import { buildExportPackage } from '../src/data/exportImport';
import type { Account } from '../src/domain/types';

function acc(name: string, sortIndex?: number): Account {
  return {
    id: name,
    name,
    type: 'asset',
    role: 'daily-asset',
    archived: false,
    ...(sortIndex !== undefined ? { sortIndex } : {}),
    createdAt: 't',
    updatedAt: 't',
  };
}

describe('compareAccountOrder', () => {
  it('sortIndex 昇順が最優先・未設定は名前順で末尾', () => {
    const list = [acc('あ'), acc('ん', 0), acc('か', 2), acc('さ', 1)];
    const sorted = [...list].sort(compareAccountOrder);
    expect(sorted.map((a) => a.name)).toEqual(['ん', 'さ', 'か', 'あ']);
  });
});

describe('reorderAccounts', () => {
  it('配列順を sortIndex 0..n として保存し、箱の表示順に反映される', async () => {
    const ledger = await loadLedger();
    const cashBox = groupAccountsByBox(ledger.accounts, false).find((g) => g.box.key === 'cash')!;
    expect(cashBox.accounts.length).toBeGreaterThanOrEqual(3);
    const reversed = [...cashBox.accounts].reverse().map((a) => a.id);

    await reorderAccounts(reversed);

    const after = await loadLedger();
    const afterBox = groupAccountsByBox(after.accounts, false).find((g) => g.box.key === 'cash')!;
    expect(afterBox.accounts.map((a) => a.id)).toEqual(reversed);
    expect(afterBox.accounts[0]!.sortIndex).toBe(0);

    // export → schema 検証も通る（sortIndex は追加 optional フィールド）。
    const parsed = ledgerExportPackageSchema.safeParse(buildExportPackage(after));
    expect(parsed.success).toBe(true);
  });

  it('存在しない id は fail-closed に弾く', async () => {
    await expect(reorderAccounts(['no-such-id'])).rejects.toThrow();
  });
});

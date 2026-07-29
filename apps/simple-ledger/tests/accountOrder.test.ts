/*
 * 勘定科目の並び替え: compareAccountOrder（type → role → sortIndex → 名前）と
 * reorderAccounts（配列順を sortIndex として保存）・箱グルーピングへの反映。
 */
import { describe, expect, it } from 'vitest';
import './setup';
import { loadLedger, reorderAccounts, upsertAccount } from '../src/data/repository';
import { compareAccountOrder } from '../src/domain/accountOrder';
import { ACCOUNT_BOXES, groupAccountsByBox } from '../src/ui/accountBoxes';
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

function roleAcc(
  id: string,
  type: Account['type'],
  role: Account['role'],
  sortIndex?: number,
): Account {
  return {
    id,
    name: id,
    type,
    role,
    archived: false,
    ...(sortIndex !== undefined ? { sortIndex } : {}),
    createdAt: 't',
    updatedAt: 't',
  };
}

describe('compareAccountOrder', () => {
  it('同じ role では sortIndex 昇順を優先し、未設定は名前順で末尾に置く', () => {
    const list = [acc('あ'), acc('ん', 0), acc('か', 2), acc('さ', 1)];
    const sorted = [...list].sort(compareAccountOrder);
    expect(sorted.map((a) => a.name)).toEqual(['ん', 'さ', 'か', 'あ']);
  });

  it('資産は現預金 → 取り置き → 継続コスト → 投資の role 優先順にする', () => {
    const list = [
      roleAcc('投資', 'asset', 'investment-asset', 0),
      roleAcc('継続', 'asset', 'continuing-cost-asset', 0),
      roleAcc('取り置き', 'asset', 'reserve-asset', 0),
      roleAcc('現金B', 'asset', 'daily-asset', 1),
      roleAcc('現金A', 'asset', 'daily-asset', 0),
    ];

    expect([...list].sort(compareAccountOrder).map((a) => a.id)).toEqual([
      '現金A',
      '現金B',
      '取り置き',
      '継続',
      '投資',
    ]);
  });

  it('負債・収入・費用でも role を sortIndex より先にし、補正を各収支の末尾にする', () => {
    const list = [
      roleAcc('補正費', 'expense', 'system-adjustment', 0),
      roleAcc('通常費', 'expense', 'expense-category', 99),
      roleAcc('補正収入', 'revenue', 'system-adjustment', 0),
      roleAcc('通常収入', 'revenue', 'income-category', 99),
      roleAcc('長期負債', 'liability', 'other-liability', 0),
      roleAcc('決済負債', 'liability', 'payment-liability', 99),
    ];

    expect([...list].sort(compareAccountOrder).map((a) => a.id)).toEqual([
      '決済負債',
      '長期負債',
      '通常収入',
      '補正収入',
      '通常費',
      '補正費',
    ]);
  });
});

describe('loadLedger の科目順', () => {
  it('保存順に依存せず role の単一正本で並べて返す', async () => {
    const inserted = [
      roleAcc('sort-investment', 'asset', 'investment-asset', 0),
      roleAcc('sort-continuing', 'asset', 'continuing-cost-asset', 0),
      roleAcc('sort-reserve', 'asset', 'reserve-asset', 0),
      roleAcc('sort-daily', 'asset', 'daily-asset', 99),
    ];
    for (const account of inserted) await upsertAccount(account);

    const ids = new Set(inserted.map((account) => account.id));
    const ordered = (await loadLedger()).accounts
      .filter((account) => ids.has(account.id))
      .map((account) => account.id);

    expect(ordered).toEqual(['sort-daily', 'sort-reserve', 'sort-continuing', 'sort-investment']);
  });
});

describe('ACCOUNT_BOXES と role 順の整合', () => {
  it('画面に出す箱は比較関数と同じ順で、内部の取り置き・継続コストを独立箱にしない', () => {
    expect(ACCOUNT_BOXES.map((box) => box.key)).toEqual([
      'cash',
      'investment',
      'shortTermDebt',
      'longTermDebt',
      'income',
      'expense',
    ]);
    const representatives = ACCOUNT_BOXES.map((box) => {
      const role = box.roles[0];
      if (!role) throw new Error(`account box has no role: ${box.key}`);
      return roleAcc(box.key, box.type, role);
    });

    expect([...representatives].sort(compareAccountOrder).map((account) => account.id)).toEqual(
      representatives.map((account) => account.id),
    );
    const boxedRoles = ACCOUNT_BOXES.flatMap((box) => box.roles);
    expect(boxedRoles).not.toContain('reserve-asset');
    expect(boxedRoles).not.toContain('continuing-cost-asset');
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

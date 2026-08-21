/*
 * 表示順マスタ（domain/displayOrder）:
 *  - 科目の並び: compareAccountOrder（type → role → sortIndex → 名前）と
 *    reorderAccounts（配列順を sortIndex として保存）・箱グルーピングへの反映。
 *  - 箱の並び: DISPLAY_BOX_KEYS が唯一の正本で、各画面の箱・枠・グループはその射影であること。
 *  - 6 分類の並び: 恒等式の行（収支・純資産）が式の後ろへ自動で入ること。
 *
 * 「マスタを差し替えると全画面が追従する」ことは displayOrder.mutation.*.test.tsx が見る。
 */
import { describe, expect, it } from 'vitest';
import './setup';
import { loadLedger, reorderAccounts, upsertAccount } from '../src/data/repository';
import {
  ASSET_GROUP_KEYS,
  DISPLAY_BOX_KEYS,
  DISPLAY_SECTION_GROUPS,
  DISPLAY_SECTION_KEYS,
  accountsInDisplayBox,
  compareAccountOrder,
  displayBoxOf,
  isIdentitySection,
  orderedDisplayBoxes,
} from '../src/domain/displayOrder';
import { buildLensRowTree } from '../src/domain/lensRows';
import { ACCOUNT_BOXES, groupAccountsByBox, timelineBoxForAccount } from '../src/ui/accountBoxes';
import { TIMELINE_ACCOUNT_BOXES } from '../src/ui/accountBoxes';
import { ledgerExportPackageSchema } from '../src/domain/schema';
import { buildExportPackage } from '../src/data/exportImport';
import { CONTINUOUS_COST_LEDGER_ACCOUNT_ID } from '../src/domain/constants';
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

describe('表示順マスタ（箱）', () => {
  it('箱の並びは現状のコード定数で固定（ユーザー並び替えなし）', () => {
    expect([...DISPLAY_BOX_KEYS]).toEqual([
      'assetFree',
      'assetFixed',
      'continuingCost',
      'shortTermDebt',
      'longTermDebt',
      'income',
      'expense',
      'equity',
    ]);
  });

  it('タイムラインの箱・勘定科目画面の箱・資産 3 グループはすべてマスタの射影', () => {
    // タイムラインは 8 箱そのまま。
    expect(TIMELINE_ACCOUNT_BOXES.map((box) => box.key)).toEqual([...DISPLAY_BOX_KEYS]);
    // 勘定科目画面は聖域（継続コスト台帳・純資産）を除いた部分集合で、相対順はマスタと一致。
    expect(ACCOUNT_BOXES.map((box) => box.box)).toEqual(
      orderedDisplayBoxes(ACCOUNT_BOXES.map((box) => box.box)),
    );
    // 資産 3 グループの並びも箱の並びから導出される。
    expect([...ASSET_GROUP_KEYS]).toEqual(['free', 'fixed', 'ledger']);
  });

  it('箱 → 所属科目は科目の正本順で返る（accountsInDisplayBox）', () => {
    const accounts = [
      roleAcc('現金B', 'asset', 'daily-asset', 1),
      roleAcc('現金A', 'asset', 'daily-asset', 0),
      { ...roleAcc('投資', 'asset', 'daily-asset', 0), movable: false as const },
    ];
    expect(accountsInDisplayBox('assetFree', accounts).map((a) => a.id)).toEqual([
      '現金A',
      '現金B',
    ]);
    expect(accountsInDisplayBox('assetFixed', accounts).map((a) => a.id)).toEqual(['投資']);
  });

  it('資産はどの箱にも入らないことがない（箱の合計 = 総資産を壊さない）', () => {
    const stray = { ...roleAcc('謎資産', 'asset', 'daily-asset'), movable: true };
    expect(displayBoxOf(stray)).toBe('assetFree');
  });
});

describe('表示順マスタ（6 分類）', () => {
  it('恒等式の行は式の後ろへ自動で入る（収支 = 支出の後・純資産 = 負債の後）', () => {
    expect([...DISPLAY_SECTION_KEYS]).toEqual([
      'revenue',
      'expense',
      'net',
      'totalAssets',
      'totalLiabilities',
      'netAssets',
    ]);
    expect(isIdentitySection('net')).toBe(true);
    expect(isIdentitySection('netAssets')).toBe(true);
    expect(isIdentitySection('revenue')).toBe(false);
  });

  it('ホームの段（フロー / ストック）を平坦にしたものが 6 分類の並び', () => {
    expect(DISPLAY_SECTION_GROUPS.flatMap((group) => group.sections)).toEqual([
      ...DISPLAY_SECTION_KEYS,
    ]);
    // 区切り線は行の stock 性の変化から引く（PeriodMatrixTable 側・v13.8 監査 C）。
  });

  it('3 レンズ共通の木は箱の並び + 恒等行の自動配置（式の右辺の最後の箱の直後）', () => {
    expect(buildLensRowTree([]).map((row) => row.id)).toEqual([
      'box:assetFree',
      'box:assetFixed',
      'box:continuingCost',
      'box:shortTermDebt',
      'box:longTermDebt',
      // 純資産 = 資産 − 負債 → 負債の最後の箱の直後。
      'identity:netAssets',
      'box:income',
      'box:expense',
      // 収支 = 収入 − 支出 → 支出の箱の直後。
      'identity:net',
      'box:equity',
    ]);
    // フロー（期間の発生額）はグラフに描けない行。ストック性はマスタの段から導く。
    expect(
      buildLensRowTree([])
        .filter((row) => !row.stock)
        .map((row) => row.id),
    ).toEqual(['box:income', 'box:expense', 'identity:net']);
  });
});

describe('compareAccountOrder', () => {
  it('同じ role では sortIndex 昇順を優先し、未設定は名前順で末尾に置く', () => {
    const list = [acc('あ'), acc('ん', 0), acc('か', 2), acc('さ', 1)];
    const sorted = [...list].sort(compareAccountOrder);
    expect(sorted.map((a) => a.name)).toEqual(['ん', 'さ', 'か', 'あ']);
  });

  it('資産は現預金 → 継続コストの role 優先順にする', () => {
    const list = [
      roleAcc('継続', 'asset', 'continuing-cost-asset', 0),
      roleAcc('現金B', 'asset', 'daily-asset', 1),
      roleAcc('現金A', 'asset', 'daily-asset', 0),
    ];

    expect([...list].sort(compareAccountOrder).map((a) => a.id)).toEqual([
      '現金A',
      '現金B',
      '継続',
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
      roleAcc(CONTINUOUS_COST_LEDGER_ACCOUNT_ID, 'asset', 'continuing-cost-asset', 0),
      roleAcc('sort-daily', 'asset', 'daily-asset', 99),
    ];
    for (const account of inserted) await upsertAccount(account);

    const ids = new Set(inserted.map((account) => account.id));
    const ordered = (await loadLedger()).accounts
      .filter((account) => ids.has(account.id))
      .map((account) => account.id);

    expect(ordered).toEqual(['sort-daily', CONTINUOUS_COST_LEDGER_ACCOUNT_ID]);
  });
});

describe('ACCOUNT_BOXES と role 順の整合', () => {
  it('画面に出す箱は比較関数と同じ順で、内部の継続コスト台帳を独立箱にしない', () => {
    expect(ACCOUNT_BOXES.map((box) => box.key)).toEqual([
      'cash',
      'cashFixed', // 現預金の movable 分割（作者決定 2026-08-14・保存形式は不変）
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
    expect(boxedRoles).not.toContain('continuing-cost-asset');
  });
});

describe('残高調整科目の箱所属（表示だけ普通に・C-7）', () => {
  const adjExpense = roleAcc('残高調整費', 'expense', 'system-adjustment');
  const adjRevenue = roleAcc('残高調整収入', 'revenue', 'system-adjustment');
  const capital = roleAcc('初期残高', 'equity', 'equity');
  const internal = roleAcc('継続コスト台帳', 'asset', 'continuing-cost-asset');
  const income = roleAcc('給与', 'revenue', 'income-category', 0);
  const expense = roleAcc('変動費', 'expense', 'expense-category', 0);

  it('type に基づき収入・費用の箱へ含め、通常内訳の後ろに並ぶ', () => {
    const groups = groupAccountsByBox(
      [adjExpense, adjRevenue, capital, internal, income, expense],
      false,
    );
    expect(groups.find((g) => g.box.key === 'income')!.accounts.map((a) => a.id)).toEqual([
      '給与',
      '残高調整収入',
    ]);
    expect(groups.find((g) => g.box.key === 'expense')!.accounts.map((a) => a.id)).toEqual([
      '変動費',
      '残高調整費',
    ]);
    // equity・内部集約は引き続きどの箱にも出ない（聖域のまま）。
    const shown = groups.flatMap((g) => g.accounts.map((a) => a.id));
    expect(shown).not.toContain('初期残高');
    expect(shown).not.toContain('継続コスト台帳');
  });

  it('タイムラインの箱も同じ type ベースの所属（timelineBoxForAccount）', () => {
    expect(timelineBoxForAccount(adjRevenue)?.key).toBe('income');
    expect(timelineBoxForAccount(adjExpense)?.key).toBe('expense');
    expect(timelineBoxForAccount(capital)?.key).toBe('equity');
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

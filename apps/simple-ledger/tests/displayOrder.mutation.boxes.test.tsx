/*
 * mutation 検証 ①（箱の並び）。
 *
 * 表示順マスタ（domain/displayOrder）の**箱の並びだけ**をテスト内で反転し、
 * 箱を出すすべての画面がそれに追従することを見る。追従しない画面が残っていれば
 * = その画面が独自の並びを持っている、ということなのでここが落ちる。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { ToastProvider } from '@snishi/foundation/ui/toast';
import { patchDialogIfNeeded } from '@snishi/foundation/ui/test-utils';
import type { DisplayBoxKey } from '../src/domain/displayOrder';

vi.mock('../src/domain/displayOrder', async () => {
  const actual = await vi.importActual<typeof import('../src/domain/displayOrder')>(
    '../src/domain/displayOrder',
  );
  const boxKeys = [...actual.DISPLAY_BOX_KEYS].reverse();
  const indexOf = (key: DisplayBoxKey) => {
    const index = boxKeys.indexOf(key);
    return index === -1 ? boxKeys.length : index;
  };
  return {
    ...actual,
    DISPLAY_BOX_KEYS: boxKeys,
    // 資産 4 グループの並びは箱の並びの射影なので、同じだけ反転する。
    ASSET_GROUP_KEYS: [...actual.ASSET_GROUP_KEYS].reverse(),
    displayBoxIndex: indexOf,
    sortByDisplayBox: <T,>(items: readonly T[], keyOf: (item: T) => DisplayBoxKey) =>
      [...items].sort((a, b) => indexOf(keyOf(a)) - indexOf(keyOf(b))),
    orderedDisplayBoxes: (keys: readonly DisplayBoxKey[]) => {
      const wanted = new Set<DisplayBoxKey>(keys);
      return boxKeys.filter((key) => wanted.has(key));
    },
  };
});

const { ACCOUNT_BOXES, TIMELINE_ACCOUNT_BOXES } = await import('../src/ui/accountBoxes');
const { buildLensRowTree } = await import('../src/domain/lensRows');
const { Accounts } = await import('../src/ui/screens/Accounts');
const { Breakdown } = await import('../src/ui/screens/Breakdown');
const { LedgerProvider, useLedger } = await import('../src/state/store');
const { createOpenings, loadLedger, upsertAccount } = await import('../src/data/repository');
const { UI } = await import('../src/ui-contract');
const { _resetOverlaysForTests } = await import('../src/ui/overlays');
await import('./setup');

beforeAll(() => {
  patchDialogIfNeeded();
});

afterEach(() => {
  cleanup();
  _resetOverlaysForTests();
});

function Ready({ children }: { children: React.ReactNode }) {
  const { status } = useLedger();
  return status === 'ready' ? <>{children}</> : null;
}

function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      <LedgerProvider>
        <Ready>{children}</Ready>
      </LedgerProvider>
    </ToastProvider>
  );
}

/** data-ui 属性の値を DOM 順で拾う。 */
function uiOrder(selector: string): string[] {
  return [...document.querySelectorAll(`[data-ui^="${selector}"]`)].map(
    (element) => element.getAttribute('data-ui') ?? '',
  );
}

const REVERSED_BOXES: DisplayBoxKey[] = [
  'equity',
  'expense',
  'income',
  'longTermDebt',
  'shortTermDebt',
  'continuingCost',
  'investment',
  'assetFixed',
  'assetFree',
];

describe('mutation: 箱の並びを反転すると全画面が追従する', () => {
  it('タイムラインの箱・勘定科目画面の箱定義がマスタに従う', () => {
    expect(TIMELINE_ACCOUNT_BOXES.map((box) => box.key)).toEqual(REVERSED_BOXES);
    // 勘定科目画面は 7 箱（聖域 2 箱を持たない）。相対順は反転後のマスタと一致する。
    expect(ACCOUNT_BOXES.map((box) => box.key)).toEqual([
      'expense',
      'income',
      'longTermDebt',
      'shortTermDebt',
      'investment',
      'cashFixed',
      'cash',
    ]);
  });

  it('3 レンズ共通の木が箱の並びに追従し、恒等行も差し込み直される', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const charge = ledger.accounts.find((a) => a.name === 'チャージ残高')!;
    const invest = ledger.accounts.find((a) => a.name === '投資')!;
    await upsertAccount({ ...charge, movable: false });
    await createOpenings([
      { accountId: cash.id, amount: 30_000, date: '2026-01-01' },
      { accountId: charge.id, amount: 5_000, date: '2026-01-01' },
      { accountId: invest.id, amount: 50_000, date: '2026-01-01' },
    ]);
    const after = await loadLedger();
    const rows = buildLensRowTree(after.accounts);

    // 箱は反転後のマスタ順。恒等行は「式の右辺の最後の箱の直後」なので、
    // 反転で最後になった箱の後ろへ**自動で移る**（位置をどこにも書いていない証拠）。
    expect(rows.map((row) => row.id)).toEqual([
      'box:equity',
      'box:expense',
      // 収支 = 収入 − 支出 → 支出の箱の直後（反転しても支出の直後のまま）。
      'identity:net',
      'box:income',
      'box:longTermDebt',
      'box:shortTermDebt',
      // 純資産 = 資産 − 負債 → 反転後の「負債の最後の箱」= shortTermDebt の直後。
      'identity:netAssets',
      'box:continuingCost',
      'box:investment',
      'box:assetFixed',
      'box:assetFree',
    ]);
    // 科目の子も箱の所属どおりに付く（投資の箱に投資科目）。
    const investmentBox = rows.find((row) => row.id === 'box:investment')!;
    expect(investmentBox.children.map((child) => child.accountId)).toContain(invest.id);
  });

  it('勘定科目画面の箱見出しがマスタの順で描画される', async () => {
    render(
      <Providers>
        <Accounts />
      </Providers>,
    );
    await waitFor(() => {
      expect(document.querySelector(`[data-ui="${UI.accounts.view}"]`)).toBeInTheDocument();
    });
    expect(uiOrder(`${UI.accounts.box}.`)).toEqual([
      `${UI.accounts.box}.expense`,
      `${UI.accounts.box}.income`,
      `${UI.accounts.box}.longTermDebt`,
      `${UI.accounts.box}.shortTermDebt`,
      `${UI.accounts.box}.investment`,
      `${UI.accounts.box}.cashFixed`,
      `${UI.accounts.box}.cash`,
    ]);
  });

  it('資産の内訳の枠もマスタの順で描画される', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const charge = ledger.accounts.find((a) => a.name === 'チャージ残高')!;
    const invest = ledger.accounts.find((a) => a.name === '投資')!;
    await upsertAccount({ ...charge, movable: false });
    await createOpenings([
      { accountId: cash.id, amount: 30_000, date: '2026-01-01' },
      { accountId: charge.id, amount: 5_000, date: '2026-01-01' },
      { accountId: invest.id, amount: 50_000, date: '2026-01-01' },
    ]);

    render(
      <Providers>
        <Breakdown
          section="asset"
          period={{ mode: 'all' }}
          onPeriodChange={() => undefined}
          onDrillDown={() => undefined}
          onNavigate={() => undefined}
        />
      </Providers>,
    );
    await waitFor(() => {
      expect(document.querySelector(`[data-ui="${UI.assetsBreakdown.view}"]`)).toBeInTheDocument();
    });
    expect(uiOrder(`${UI.assetsBreakdown.frame}.`)).toEqual([
      `${UI.assetsBreakdown.frame}.investment`,
      `${UI.assetsBreakdown.frame}.fixed`,
      `${UI.assetsBreakdown.frame}.free`,
    ]);
  });
});

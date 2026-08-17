/*
 * 負債の自然符号ソートと数字色（C-2）。
 *  - 金額ソートの比較は自然符号（貸方残高は負）。月割り台帳の負債セクションにも効き、
 *    昇順ではローン（最も大きな負債）が先頭・降順では末尾に来る。
 *  - 表示は絶対値のまま（マイナス記号は付けない）。負債残高の数字だけ専用トークンの
 *    クラス（amount--liability）が付く。適用箇所 = 月割り台帳の負債セクション・
 *    資金繰りの負債行・勘定科目一覧の負債残高。
 *  - 振替（投資積立など）・資産の残高には付けない。
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { ToastProvider } from '@snishi/foundation/ui/toast';
import { patchDialogIfNeeded } from '@snishi/foundation/ui/test-utils';
import { LedgerProvider, useLedger } from '../src/state/store';
import { Allocations } from '../src/ui/screens/Allocations';
import { Accounts } from '../src/ui/screens/Accounts';
import { Cashflow } from '../src/ui/screens/Cashflow';
import { createOpenings, loadLedger, upsertAccount } from '../src/data/repository';
import { debitSignedBalance } from '../src/domain/accounting';
import { UI } from '../src/ui-contract';
import { _resetOverlaysForTests } from '../src/ui/overlays';
import { todayLocal } from '../src/util/time';
import type { ReportPeriod } from '../src/domain/reportPeriod';
import './setup';

beforeAll(() => {
  patchDialogIfNeeded();
});

afterEach(() => {
  cleanup();
  _resetOverlaysForTests();
});

const all = (name: string) => [...document.querySelectorAll<HTMLElement>(`[data-ui="${name}"]`)];

function Ready({ children }: { children: React.ReactNode }) {
  const { status } = useLedger();
  return status === 'ready' ? <>{children}</> : null;
}

function View({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      <LedgerProvider>
        <Ready>{children}</Ready>
      </LedgerProvider>
    </ToastProvider>
  );
}

const LOAN = {
  id: 'tone-loan',
  name: '住宅ローン',
  type: 'liability' as const,
  role: 'other-liability' as const,
  archived: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

/** 現金・カード（小さい負債）・ローン（大きい負債）の台帳。 */
async function seed() {
  const ledger = await loadLedger();
  const cash = ledger.accounts.find((a) => a.name === '現金')!;
  const card = ledger.accounts.find((a) => a.role === 'payment-liability')!;
  await upsertAccount(LOAN);
  await createOpenings([
    { accountId: cash.id, amount: 100000000, date: '2000-01-01' },
    { accountId: card.id, amount: 3000000, date: '2000-01-01' },
    { accountId: LOAN.id, amount: 20000000, date: '2000-01-01' },
  ]);
  return { cash, card };
}

const period: ReportPeriod = { mode: 'date', date: todayLocal() };

describe('自然符号の金額ソート', () => {
  it('資産と負債を 1 本の数直線へ並べる（貸方残高は負）', () => {
    expect(debitSignedBalance('asset', 1000)).toBe(1000);
    expect(debitSignedBalance('expense', 1000)).toBe(1000);
    // 表示は絶対値の正でも、比較では負として並ぶ。
    expect(debitSignedBalance('liability', 1000)).toBe(-1000);
    expect(debitSignedBalance('revenue', 1000)).toBe(-1000);
    expect(debitSignedBalance('equity', 1000)).toBe(-1000);
  });

  it.each([
    { direction: 'asc' as const, dataUi: UI.allocations.sortAsc, first: '住宅ローン' },
    { direction: 'desc' as const, dataUi: UI.allocations.sortDesc, first: 'カード' },
  ])('月割り台帳の金額ソートは負債セクションに効く（$direction）', async ({ dataUi, first }) => {
    await seed();
    render(
      <View>
        <Allocations period={period} onEditEntry={() => undefined} target={null} />
      </View>,
    );
    await waitFor(() => {
      expect(all(UI.allocations.liabilityRow)).toHaveLength(2);
    });

    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.sortByAmount}"]`)!);
    fireEvent.click(document.querySelector(`[data-ui="${dataUi}"]`)!);

    const names = all(UI.allocations.liabilityRow).map(
      (row) => row.querySelector('.list__title')?.textContent ?? '',
    );
    expect(names).toHaveLength(2);
    expect(names[0]).toContain(first);
  });
});

describe('負債残高の数字色', () => {
  it('月割り台帳の負債行の残高に専用クラスが付く（絶対値のまま・記号なし）', async () => {
    await seed();
    render(
      <View>
        <Allocations period={period} onEditEntry={() => undefined} target={null} />
      </View>,
    );
    await waitFor(() => {
      expect(all(UI.allocations.liabilityRow)).toHaveLength(2);
    });
    const amounts = all(UI.allocations.liabilityRow).map((row) =>
      row.querySelector('.row-trailing .list__amount span'),
    );
    for (const amount of amounts) {
      expect(amount).toHaveClass('amount--liability');
      expect(amount?.textContent ?? '').not.toContain('-');
    }
    expect(amounts.map((a) => a?.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining('200,000')]),
    );
  });

  it('資金繰りの負債行の残高に専用クラスが付く', async () => {
    await seed();
    render(
      <View>
        <Cashflow
          period={period}
          onEditEntry={() => undefined}
          onOpenAllocations={() => undefined}
          onOpenAccount={() => undefined}
          onOpenEntry={() => undefined}
        />
      </View>,
    );
    await waitFor(() => {
      expect(all(UI.cashflow.liabilityRow)).toHaveLength(2);
    });
    for (const row of all(UI.cashflow.liabilityRow)) {
      expect(row.querySelector('.amount--liability')).not.toBeNull();
    }
  });

  it('勘定科目一覧は負債の箱の残高だけに付く（資産の残高には付けない）', async () => {
    await seed();
    render(
      <View>
        <Accounts period={period} />
      </View>,
    );
    await waitFor(() => {
      expect(document.querySelector(`[data-ui="${UI.accounts.list}"]`)).not.toBeNull();
    });
    const box = (key: string) =>
      document
        .querySelector(`[data-ui="${UI.accounts.box}.${key}"]`)
        ?.parentElement?.querySelectorAll('.list__amount span');

    const liabilityAmounts = [...(box('shortTermDebt') ?? []), ...(box('longTermDebt') ?? [])];
    expect(liabilityAmounts.length).toBeGreaterThan(0);
    for (const amount of liabilityAmounts) expect(amount).toHaveClass('amount--liability');

    const assetAmounts = [...(box('cash') ?? [])];
    expect(assetAmounts.length).toBeGreaterThan(0);
    for (const amount of assetAmounts) expect(amount).not.toHaveClass('amount--liability');
  });
});

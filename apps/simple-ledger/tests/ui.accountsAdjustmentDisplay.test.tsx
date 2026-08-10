/*
 * 勘定科目一覧の表示（C-7 / C-1）:
 *  - 残高調整科目（system-adjustment）を収入・費用の内訳として表示する（「自動」バッジ付き）。
 *    管理操作（編集・アーカイブ・並び替え・振替導線）は出さない＝科目管理は聖域のまま。
 *  - 行き先ピッカー（継続コストの計上先）には引き続き選べない（fail-closed 現状維持）。
 *  - 費用・収入科目はヘッダー期間（ホームと同じ選択期間）の発生額を表示し、期間で値が変わる。
 *    資産・負債はスライス時点の残高のまま。
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '@snishi/foundation/ui/toast';
import { patchDialogIfNeeded } from '@snishi/foundation/ui/test-utils';
import { LedgerProvider, useLedger } from '../src/state/store';
import { Accounts } from '../src/ui/screens/Accounts';
import { createAdjustment, createOpenings, loadLedger, upsertEntry } from '../src/data/repository';
import { buildSimpleEntry } from '../src/domain/entry';
import {
  groupedMonthlyAllocationAccounts,
  monthlyAllocationAccountOptions,
} from '../src/ui/accountOptions';
import { formatMoney } from '../src/util/format';
import { UI } from '../src/ui-contract';
import { _resetOverlaysForTests } from '../src/ui/overlays';
import type { ReportPeriod } from '../src/domain/reportPeriod';
import './setup';

beforeAll(() => {
  patchDialogIfNeeded();
});

afterEach(() => {
  cleanup();
  _resetOverlaysForTests();
});

function View({ period }: { period?: ReportPeriod }) {
  return (
    <ToastProvider>
      <LedgerProvider>
        <ReadyView {...(period ? { period } : {})} />
      </LedgerProvider>
    </ToastProvider>
  );
}

function ReadyView({ period }: { period?: ReportPeriod }) {
  const { status } = useLedger();
  if (status !== 'ready') return null;
  return period ? <Accounts period={period} /> : <Accounts />;
}

async function renderReady(period?: ReportPeriod) {
  render(<View {...(period ? { period } : {})} />);
  await waitFor(() => {
    expect(document.querySelector(`[data-ui="${UI.accounts.view}"]`)).toBeInTheDocument();
  });
}

function rowOf(name: string): HTMLElement {
  const row = screen.getByText(name).closest('li');
  expect(row).not.toBeNull();
  return row!;
}

/** 実残高との差額 2,000 の補正で 残高調整費 を実際の保存経路で生成する。 */
async function seedAdjustmentExpense() {
  const ledger = await loadLedger();
  const cash = ledger.accounts.find((a) => a.name === '現金')!;
  await createOpenings([{ accountId: cash.id, amount: 10_000, date: '2020-01-01' }]);
  await createAdjustment({ accountId: cash.id, date: '2026-01-15', actualBalance: 8_000 });
  return cash;
}

describe('残高調整科目の一覧表示（C-7・表示だけ普通に）', () => {
  it('費用の箱に「自動」バッジ付きで表示され、管理操作が出ない', async () => {
    await seedAdjustmentExpense();
    await renderReady();

    // 表示: 費用の箱の内訳として現れ、「自動」バッジが付く。
    const row = rowOf('残高調整費');
    expect(row.querySelector(`[data-ui="${UI.accounts.systemBadge}"]`)).toHaveTextContent('自動');
    // 発生額（全期間・ヘッダー期間の既定）も通常の費用として表示される。
    expect(row.textContent).toContain('全期間の発生額');
    expect(row.textContent).toContain(formatMoney(2_000, 'JPY'));

    // 管理操作は一切出さない（編集・アーカイブ・振替導線）。
    expect(screen.queryByRole('button', { name: '編集: 残高調整費' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'アーカイブ: 残高調整費' })).toBeNull();
    expect(
      screen.queryByRole('button', { name: '累計を振り替えてアーカイブ: 残高調整費' }),
    ).toBeNull();
    expect(screen.queryByRole('button', { name: '補正: 残高調整費' })).toBeNull();
    // 通常の費用科目には従来どおり管理操作がある（抑止の範囲が広すぎないこと）。
    expect(screen.getByRole('button', { name: '編集: 固定費' })).toBeInTheDocument();
  });

  it('並び替えモードでも残高調整科目は対象外', async () => {
    await seedAdjustmentExpense();
    await renderReady();

    fireEvent.click(document.querySelector(`[data-ui="${UI.accounts.reorderToggle}"]`)!);
    expect(screen.getByRole('button', { name: '上へ: 固定費' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '上へ: 残高調整費' })).toBeNull();
    expect(screen.queryByRole('button', { name: '下へ: 残高調整費' })).toBeNull();
  });

  it('計上先ピッカーには引き続き選べない（fail-closed 現状維持）', async () => {
    await seedAdjustmentExpense();
    const ledger = await loadLedger();
    const adjustment = ledger.accounts.find((a) => a.role === 'system-adjustment')!;

    expect(monthlyAllocationAccountOptions(ledger.accounts).map((o) => o.value)).not.toContain(
      adjustment.id,
    );
    expect(
      groupedMonthlyAllocationAccounts(ledger.accounts)
        .flatMap((g) => g.accounts)
        .map((a) => a.id),
    ).not.toContain(adjustment.id);
  });
});

describe('科目一覧の費用・収入表示（C-1・ヘッダー期間の発生額）', () => {
  async function seedYearlyExpenses() {
    const ledger = await loadLedger();
    const bank = ledger.accounts.find((a) => a.name === '預金')!;
    const fixed = ledger.accounts.find((a) => a.name === '固定費')!;
    await createOpenings([{ accountId: bank.id, amount: 10_000, date: '2020-01-01' }]);
    await upsertEntry(
      buildSimpleEntry({
        date: '2025-03-10',
        description: '2025年の固定費',
        debitAccountId: fixed.id,
        creditAccountId: bank.id,
        amount: 500,
        kind: 'normal',
      }),
    );
    await upsertEntry(
      buildSimpleEntry({
        date: '2026-06-15',
        description: '2026年の固定費',
        debitAccountId: fixed.id,
        creditAccountId: bank.id,
        amount: 1_000,
        kind: 'normal',
      }),
    );
  }

  it('費用科目はヘッダー期間の発生額を表示し、期間を変えると値が変わる', async () => {
    await seedYearlyExpenses();

    await renderReady({ mode: 'year', year: 2026 });
    const row2026 = rowOf('固定費');
    expect(row2026.textContent).toContain('2026年の発生額');
    expect(row2026.textContent).toContain(formatMoney(1_000, 'JPY'));

    cleanup();
    await renderReady({ mode: 'year', year: 2025 });
    const row2025 = rowOf('固定費');
    expect(row2025.textContent).toContain('2025年の発生額');
    expect(row2025.textContent).toContain(formatMoney(500, 'JPY'));

    cleanup();
    await renderReady();
    const rowAll = rowOf('固定費');
    expect(rowAll.textContent).toContain('全期間の発生額');
    expect(rowAll.textContent).toContain(formatMoney(1_500, 'JPY'));
  });

  it('資産はスライス時点の残高のまま（表示仕様は変えない）', async () => {
    await seedYearlyExpenses();

    await renderReady({ mode: 'year', year: 2025 });
    const bank2025 = rowOf('預金');
    // 2025-12-31 断面: 10,000 − 500。発生額ラベルにしない。
    expect(bank2025.textContent).toContain('残高');
    expect(bank2025.textContent).not.toContain('発生額');
    expect(bank2025.textContent).toContain(formatMoney(9_500, 'JPY'));

    cleanup();
    await renderReady();
    const bankAll = rowOf('預金');
    expect(bankAll.textContent).toContain(formatMoney(8_500, 'JPY'));
  });
});

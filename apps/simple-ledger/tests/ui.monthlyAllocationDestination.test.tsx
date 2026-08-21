import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ToastProvider } from '@snishi/foundation/ui/toast';
import { patchDialogIfNeeded } from '@snishi/foundation/ui/test-utils';
import { LedgerProvider } from '../src/state/store';
import { EntrySheet } from '../src/ui/screens/EntrySheet';
import { Allocations } from '../src/ui/screens/Allocations';
import { createContinuousCost, loadLedger, upsertAccount } from '../src/data/repository';
import {
  groupedMonthlyAllocationAccounts,
  monthlyAllocationAccountOptions,
} from '../src/ui/accountOptions';
import { ACCOUNT_ROLES, type AccountRole } from '../src/domain/accountRoles';
import { CONTINUOUS_COST_LEDGER_ACCOUNT_ID } from '../src/domain/constants';
import { UI } from '../src/ui-contract';
import { _resetOverlaysForTests } from '../src/ui/overlays';
import type { Account, AccountType } from '../src/domain/types';
import './setup';

beforeAll(() => {
  patchDialogIfNeeded();
});

afterEach(() => {
  cleanup();
  _resetOverlaysForTests();
});

function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      <LedgerProvider>{children}</LedgerProvider>
    </ToastProvider>
  );
}

const timestamp = '2026-07-27T00:00:00.000Z';

function account(
  id: string,
  name: string,
  type: AccountType,
  role: AccountRole,
  archived = false,
): Account {
  return {
    id,
    name,
    type,
    role,
    archived,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

async function addCandidateFixtures() {
  await loadLedger();
  const fixtures = {
    investment: account('allocation-investment', '行き先・投資', 'asset', 'daily-asset'),
    liability: account(
      'allocation-liability',
      '行き先・その他負債',
      'liability',
      'other-liability',
    ),
    archived: {
      ...account('allocation-archived', '行き先・アーカイブ済み', 'asset', 'daily-asset', true),
      startDate: '2026-07-27',
      endDate: '2026-07-30',
    },
    currentArchived: account(
      'allocation-current-archived',
      '行き先・編集中のアーカイブ',
      'revenue',
      'income-category',
    ),
    internal: account(
      CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
      '行き先・内部台帳',
      'asset',
      'continuing-cost-asset',
    ),
    adjustment: account(
      'allocation-adjustment',
      '行き先・残高調整',
      'expense',
      'system-adjustment',
    ),
  };
  for (const fixture of Object.values(fixtures)) await upsertAccount(fixture);
  return fixtures;
}

async function expectBroadCandidates(container: HTMLElement, excludedNames: string[]) {
  await waitFor(() => {
    for (const name of [
      '現金',
      '行き先・投資',
      'クレジットカード',
      '行き先・その他負債',
      '初期残高',
      '給与',
      '固定費',
    ]) {
      expect(within(container).getByRole('option', { name })).toBeInTheDocument();
    }
  });
  for (const name of excludedNames) {
    expect(within(container).queryByRole('option', { name })).not.toBeInTheDocument();
  }
}

describe('継続コスト資産の費用の行き先候補', () => {
  it('共通候補は通常科目を全会計区分から返し、内部・調整・アーカイブを除外する', () => {
    const roleType: Record<AccountRole, AccountType> = {
      'daily-asset': 'asset',
      'continuing-cost-asset': 'asset',
      'payment-liability': 'liability',
      'other-liability': 'liability',
      equity: 'equity',
      'income-category': 'revenue',
      'expense-category': 'expense',
      'system-adjustment': 'expense',
    };
    const accounts = ACCOUNT_ROLES.map((role) =>
      account(`role-${role}`, role, roleType[role], role),
    );
    const archived = account(
      'archived-current',
      'archived-current',
      'revenue',
      'income-category',
      true,
    );
    const ids = monthlyAllocationAccountOptions([...accounts, archived]).map(
      (option) => option.value,
    );

    expect(ids).toEqual(
      expect.arrayContaining([
        'role-daily-asset',
        'role-payment-liability',
        'role-other-liability',
        'role-equity',
        'role-income-category',
        'role-expense-category',
      ]),
    );
    expect(ids).not.toEqual(
      expect.arrayContaining(['role-continuing-cost-asset', 'role-system-adjustment', archived.id]),
    );
    expect(
      monthlyAllocationAccountOptions([...accounts, archived], archived.id).map(
        (option) => option.value,
      ),
    ).toContain(archived.id);
    expect(
      monthlyAllocationAccountOptions(accounts, 'role-system-adjustment').map(
        (option) => option.value,
      ),
    ).not.toContain('role-system-adjustment');
    expect(
      groupedMonthlyAllocationAccounts([...accounts, archived])
        .flatMap((group) => group.accounts)
        .map((candidate) => candidate.id),
    ).toEqual(expect.arrayContaining(ids));
  });

  it('支出入力の「継続コスト資産として持つ」で資産・負債・純資産・収入・支出を行き先に選べる', async () => {
    await addCandidateFixtures();
    render(
      <Providers>
        <EntrySheet init={{ kind: 'create', mode: 'expense' }} onClose={() => undefined} />
      </Providers>,
    );

    const toggle = await waitFor(() => {
      const found = document.querySelector(`[data-ui="${UI.journal.entry.ccToggle}"]`);
      expect(found).toBeInTheDocument();
      return found!;
    });
    fireEvent.click(toggle);
    // v13.7 I3: 支出の 1 ページ目は選択だけ。持ち物の入力は次のページ（項目・金額を埋めて進む）。
    fireEvent.change(document.querySelector(`[data-ui="${UI.journal.entry.item}"]`)!, {
      target: { value: '継続コストの行き先' },
    });
    fireEvent.change(document.querySelector(`[data-ui="${UI.journal.entry.amount}"]`)!, {
      target: { value: '1000' },
    });
    // 支払い元（貸方）は 1 ページ目の必須（持ち物を選んでも支払いは起きる）。
    const sourceChip = await waitFor(() => {
      const found = document.querySelector(
        `[data-ui="${UI.journal.entry.flowSource}"] label.chip input`,
      );
      expect(found).toBeInTheDocument();
      return found!;
    });
    fireEvent.click(sourceChip);
    fireEvent.click(document.querySelector(`[data-ui="${UI.journal.entry.next}"]`)!);
    await waitFor(() => {
      expect(document.querySelector(`[data-ui="${UI.journal.entry.ccName}"]`)).toBeInTheDocument();
    });

    // 終了日は任意の日付ピッカー（空のままでよい）。月数欄は存在しない。
    const endDate = document.querySelector(
      `[data-ui="${UI.journal.entry.ccEndDate}"]`,
    ) as HTMLInputElement;
    expect(endDate).toBeInTheDocument();
    expect(endDate.type).toBe('date');
    expect(endDate.value).toBe('');

    const picker = await waitFor(() => {
      const found = document.querySelector(
        `[data-ui="${UI.journal.entry.ccCategory}"]`,
      ) as HTMLElement | null;
      expect(found).toBeInTheDocument();
      return found!;
    });
    // 計上先 = 中立表記（income 行きの差引形も通るため「費用の行き先」とは表示しない）。
    expect(within(picker).getByText('計上先')).toBeInTheDocument();
    await waitFor(() => {
      for (const name of [
        '現金',
        '行き先・投資',
        'クレジットカード',
        '行き先・その他負債',
        '初期残高',
        '給与',
        '固定費',
      ]) {
        expect(within(picker).getByRole('radio', { name })).toBeInTheDocument();
      }
    });
    for (const name of ['行き先・アーカイブ済み', '行き先・内部台帳', '行き先・残高調整']) {
      expect(within(picker).queryByRole('radio', { name })).not.toBeInTheDocument();
    }
  });

  it('簿記編集の新規作成では支払い元の役割に関係なく継続コスト化を選べる', async () => {
    await loadLedger();
    render(
      <Providers>
        <EntrySheet init={{ kind: 'create', mode: 'manual' }} onClose={() => undefined} />
      </Providers>,
    );

    // 貸方を選ぶ前（役割チェックなし）からトグルが出る。
    const toggle = await waitFor(() => {
      const found = document.querySelector(`[data-ui="${UI.journal.entry.ccToggle}"]`);
      expect(found).toBeInTheDocument();
      return found!;
    });
    fireEvent.click(toggle);

    // 借方側は継続コスト資産の名前に変わり（科目ピッカーは消える）、費用の行き先が出る。
    expect(document.querySelector(`[data-ui="${UI.journal.entry.ccName}"]`)).toBeInTheDocument();
    expect(
      document.querySelector(`[data-ui="${UI.journal.entry.ccCategory}"]`),
    ).toBeInTheDocument();
    expect(
      document.querySelector(`[data-ui="${UI.journal.entry.flowDestination}"]`),
    ).not.toBeInTheDocument();
    expect(
      document.querySelector(`[data-ui="${UI.journal.entry.flowSource}"]`),
    ).toBeInTheDocument();
  });

  it('持ち込みシートでも同じ費用の行き先候補を使う', async () => {
    await addCandidateFixtures();
    render(
      <Providers>
        <Allocations period={{ mode: 'all' }} onEditEntry={() => undefined} />
      </Providers>,
    );
    fireEvent.click(
      await waitFor(() => {
        const found = document.querySelector(`[data-ui="${UI.allocations.unifiedAdd}"]`);
        expect(found).toBeInTheDocument();
        return found!;
      }),
    );
    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.addChooser}.asset"]`)!);
    const select = await screen.findByLabelText('計上先');
    await expectBroadCandidates(select, [
      '行き先・アーカイブ済み',
      '行き先・内部台帳',
      '行き先・残高調整',
    ]);
  });

  it('itemが参照中の行き先科目はitem期間より前に終了できない', async () => {
    const fixtures = await addCandidateFixtures();
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((candidate) => candidate.name === '現金')!;
    const item = await createContinuousCost({
      name: '行き先編集テスト',
      amount: 12000,
      startDate: '2026-01-15',
      endDate: '2026-12-31',
      expenseAccountId: fixtures.currentArchived.id,
      creditAccountId: cash.id,
    });
    await expect(
      upsertAccount({ ...fixtures.currentArchived, archived: true }),
    ).rejects.toMatchObject({ code: 'error.account.referenceOutsidePeriod' });
    expect(item.expenseAccountId).toBe(fixtures.currentArchived.id);
  });
});

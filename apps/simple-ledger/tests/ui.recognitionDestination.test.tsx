import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ToastProvider } from '@snishi/foundation/ui/toast';
import { patchDialogIfNeeded } from '@snishi/foundation/ui/test-utils';
import { LedgerProvider } from '../src/state/store';
import { EntrySheet } from '../src/ui/screens/EntrySheet';
import { Allocations } from '../src/ui/screens/Allocations';
import {
  createContinuousCost,
  loadLedger,
  upsertAccount,
} from '../src/data/repository';
import {
  groupedRecognitionAccounts,
  recognitionAccountOptions,
} from '../src/ui/accountOptions';
import { ACCOUNT_ROLES, type AccountRole } from '../src/domain/accountRoles';
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
    fixed: account('recognition-fixed', '認識先・固定資産', 'asset', 'fixed-asset'),
    liability: account(
      'recognition-liability',
      '認識先・その他負債',
      'liability',
      'other-liability',
    ),
    archived: account(
      'recognition-archived',
      '認識先・アーカイブ済み',
      'asset',
      'daily-asset',
      true,
    ),
    currentArchived: account(
      'recognition-current-archived',
      '認識先・編集中のアーカイブ',
      'revenue',
      'income-category',
    ),
    internal: account(
      'recognition-internal',
      '認識先・内部台帳',
      'asset',
      'continuing-cost-asset',
    ),
    reserve: account('recognition-reserve', '認識先・取り置き', 'asset', 'reserve-asset'),
    adjustment: account(
      'recognition-adjustment',
      '認識先・残高調整',
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
      '認識先・固定資産',
      'クレジットカード',
      '認識先・その他負債',
      '開始残高',
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

describe('継続コストの認識先候補', () => {
  it('共通候補は通常科目を全会計区分から返し、内部・調整・アーカイブを除外する', () => {
    const roleType: Record<AccountRole, AccountType> = {
      'daily-asset': 'asset',
      'reserve-asset': 'asset',
      'deferred-asset': 'asset',
      'investment-asset': 'asset',
      'fixed-asset': 'asset',
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
    const ids = recognitionAccountOptions([...accounts, archived]).map((option) => option.value);

    expect(ids).toEqual(
      expect.arrayContaining([
        'role-daily-asset',
        'role-deferred-asset',
        'role-investment-asset',
        'role-fixed-asset',
        'role-payment-liability',
        'role-other-liability',
        'role-equity',
        'role-income-category',
        'role-expense-category',
      ]),
    );
    expect(ids).not.toEqual(
      expect.arrayContaining([
        'role-reserve-asset',
        'role-continuing-cost-asset',
        'role-system-adjustment',
        archived.id,
      ]),
    );
    expect(
      recognitionAccountOptions([...accounts, archived], archived.id).map(
        (option) => option.value,
      ),
    ).toContain(archived.id);
    expect(
      recognitionAccountOptions(accounts, 'role-system-adjustment').map(
        (option) => option.value,
      ),
    ).not.toContain('role-system-adjustment');
    expect(
      groupedRecognitionAccounts([...accounts, archived])
        .flatMap((group) => group.accounts)
        .map((candidate) => candidate.id),
    ).toEqual(expect.arrayContaining(ids));
  });

  it('支出入力の継続コスト化で資産・負債・純資産・収入・支出を認識先に選べる', async () => {
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

    const picker = await waitFor(() => {
      const found = document.querySelector(
        `[data-ui="${UI.journal.entry.ccCategory}"]`,
      ) as HTMLElement | null;
      expect(found).toBeInTheDocument();
      return found!;
    });
    expect(within(picker).getByText('認識先')).toBeInTheDocument();
    await waitFor(() => {
      for (const name of [
        '現金',
        '認識先・固定資産',
        'クレジットカード',
        '認識先・その他負債',
        '開始残高',
        '給与',
        '固定費',
      ]) {
        expect(within(picker).getByRole('radio', { name })).toBeInTheDocument();
      }
    });
    for (const name of [
      '認識先・アーカイブ済み',
      '認識先・内部台帳',
      '認識先・取り置き',
      '認識先・残高調整',
    ]) {
      expect(within(picker).queryByRole('radio', { name })).not.toBeInTheDocument();
    }
  });

  it('契約持ち込みと開始残高からの持ち込みで同じ認識先候補を使う', async () => {
    await addCandidateFixtures();
    const excluded = [
      '認識先・アーカイブ済み',
      '認識先・内部台帳',
      '認識先・取り置き',
      '認識先・残高調整',
    ];

    const subscription = render(
      <Providers>
        <Allocations />
      </Providers>,
    );
    fireEvent.click(
      await waitFor(() => {
        const found = document.querySelector(`[data-ui="${UI.allocations.unifiedAdd}"]`);
        expect(found).toBeInTheDocument();
        return found!;
      }),
    );
    fireEvent.click(
      document.querySelector(
        `[data-ui="${UI.allocations.addChooser}.sub-migration"]`,
      )!,
    );
    const subscriptionSelect = await screen.findByLabelText('認識先');
    await expectBroadCandidates(subscriptionSelect, excluded);
    subscription.unmount();
    _resetOverlaysForTests();

    render(
      <Providers>
        <Allocations />
      </Providers>,
    );
    fireEvent.click(
      await waitFor(() => {
        const found = document.querySelector(`[data-ui="${UI.allocations.unifiedAdd}"]`);
        expect(found).toBeInTheDocument();
        return found!;
      }),
    );
    fireEvent.click(
      document.querySelector(`[data-ui="${UI.allocations.addChooser}.asset"]`)!,
    );
    const openingSelect = await screen.findByLabelText('認識先');
    await expectBroadCandidates(openingSelect, excluded);
  });

  it('既存項目の編集では現在値だけアーカイブ済みでも残し、他のアーカイブは除外する', async () => {
    const fixtures = await addCandidateFixtures();
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((candidate) => candidate.name === '現金')!;
    const item = await createContinuousCost({
      name: '認識先編集テスト',
      kind: 'prepaid-service',
      amount: 12000,
      costMonths: 12,
      startMonth: '2026-01',
      expenseAccountId: fixtures.currentArchived.id,
      paymentSourceAccountId: cash.id,
    });
    await upsertAccount({ ...fixtures.currentArchived, archived: true });

    render(
      <Providers>
        <Allocations />
      </Providers>,
    );
    fireEvent.click(
      await screen.findByRole('button', { name: `編集: ${item.name}` }),
    );

    const select = await waitFor(() => {
      const found = document.querySelector(
        `[data-ui="${UI.allocations.editExpense}"]`,
      ) as HTMLSelectElement | null;
      expect(found).toBeInTheDocument();
      return found!;
    });
    expect(select).toHaveAccessibleName('認識先');
    expect(select).toHaveValue(fixtures.currentArchived.id);
    expect(within(select).getByRole('option', { name: fixtures.currentArchived.name })).toBeInTheDocument();
    expect(
      within(select).queryByRole('option', { name: fixtures.archived.name }),
    ).not.toBeInTheDocument();
    expect(
      within(select).queryByRole('option', { name: fixtures.internal.name }),
    ).not.toBeInTheDocument();
    await expectBroadCandidates(select, [
      fixtures.archived.name,
      fixtures.internal.name,
      fixtures.reserve.name,
      fixtures.adjustment.name,
    ]);
  });
});

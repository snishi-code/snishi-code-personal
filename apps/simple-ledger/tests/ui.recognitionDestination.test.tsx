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
    investment: account(
      'recognition-investment',
      '行き先・投資資産',
      'asset',
      'investment-asset',
    ),
    liability: account(
      'recognition-liability',
      '行き先・その他負債',
      'liability',
      'other-liability',
    ),
    archived: account(
      'recognition-archived',
      '行き先・アーカイブ済み',
      'asset',
      'daily-asset',
      true,
    ),
    currentArchived: account(
      'recognition-current-archived',
      '行き先・編集中のアーカイブ',
      'revenue',
      'income-category',
    ),
    internal: account(
      'recognition-internal',
      '行き先・内部台帳',
      'asset',
      'continuing-cost-asset',
    ),
    adjustment: account(
      'recognition-adjustment',
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
      '行き先・投資資産',
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
      'investment-asset': 'asset',
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
        'role-investment-asset',
        'role-payment-liability',
        'role-other-liability',
        'role-equity',
        'role-income-category',
        'role-expense-category',
      ]),
    );
    expect(ids).not.toEqual(
      expect.arrayContaining([
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
    expect(within(picker).getByText('費用の行き先')).toBeInTheDocument();
    await waitFor(() => {
      for (const name of [
        '現金',
        '行き先・投資資産',
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
        <Allocations onEditEntry={() => undefined} />
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
    const select = await screen.findByLabelText('費用の行き先');
    await expectBroadCandidates(select, [
      '行き先・アーカイブ済み',
      '行き先・内部台帳',
      '行き先・残高調整',
    ]);
  });

  it('既存項目の編集では現在値だけアーカイブ済みでも残し、他のアーカイブは除外する', async () => {
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
    await upsertAccount({ ...fixtures.currentArchived, archived: true });

    render(
      <Providers>
        <Allocations onEditEntry={() => undefined} />
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
    expect(select).toHaveAccessibleName('費用の行き先');
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
      fixtures.adjustment.name,
    ]);
  });
});

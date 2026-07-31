/*
 * 毎月のもの（4項目モデル）の UI 回帰:
 *  - 追加チューザーは 2 択（くり返し記帳 / 持ち込み）
 *  - 持ち込み登録（過去日・終了日なし可・貸方 = 初期残高）
 *  - 終了まで1ヶ月以内の行のマーカー（data-ending）
 *  - アーカイブ動線（終了日のみ / 残存価値の回収の振替 = ホームの振替シート再利用・既定値）
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ToastProvider } from '@snishi/foundation/ui/toast';
import { patchDialogIfNeeded } from '@snishi/foundation/ui/test-utils';
import { LedgerProvider, useLedger } from '../src/state/store';
import { Allocations } from '../src/ui/screens/Allocations';
import { createContinuousCost, loadLedger } from '../src/data/repository';
import { CONTINUOUS_COST_LEDGER_ACCOUNT_ID } from '../src/domain/constants';
import { addMonthsToDate } from '../src/domain/allocation';
import { UI } from '../src/ui-contract';
import { _resetOverlaysForTests } from '../src/ui/overlays';
import { todayLocal } from '../src/util/time';
import './setup';

beforeAll(() => {
  patchDialogIfNeeded();
});

afterEach(() => {
  cleanup();
  _resetOverlaysForTests();
});

function View() {
  return (
    <ToastProvider>
      <LedgerProvider>
        <ReadyView />
      </LedgerProvider>
    </ToastProvider>
  );
}

function ReadyView() {
  const { status } = useLedger();
  return status === 'ready' ? <Allocations onEditEntry={() => undefined} /> : null;
}

async function renderReady() {
  render(<View />);
  await waitFor(() => {
    expect(document.querySelector(`[data-ui="${UI.allocations.view}"]`)).toBeInTheDocument();
  });
}

describe('追加チューザー', () => {
  it('2 択（くり返し記帳 / いま持っているものを登録）だけを出す', async () => {
    await renderReady();
    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.unifiedAdd}"]`)!);
    const chooser = document.querySelector(`[data-ui="${UI.allocations.addChooser}"]`)!;
    expect(chooser).toBeInTheDocument();
    expect(
      document.querySelector(`[data-ui="${UI.allocations.addChooser}.rule"]`),
    ).toBeInTheDocument();
    expect(
      document.querySelector(`[data-ui="${UI.allocations.addChooser}.asset"]`),
    ).toBeInTheDocument();
    // 旧 5 択（支出/収入/振替の個別選択・契約持ち込み）は存在しない。
    expect(chooser.querySelectorAll('[data-ui^="allocations.add.chooser."]')).toHaveLength(2);
  });
});

describe('定期ルールの継続コスト化（月割り）', () => {
  it('独自の種別セレクタを出さず、貸方=給与のルールを作成・再編集できる', async () => {
    const ledger = await loadLedger();
    const bank = ledger.accounts.find((a) => a.name === '預金')!;
    const salary = ledger.accounts.find((a) => a.name === '給与')!;

    await renderReady();
    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.unifiedAdd}"]`)!);
    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.addChooser}.rule"]`)!);

    expect(screen.queryByText('種別')).not.toBeInTheDocument();
    const spreadToggle = document.querySelector(
      `[data-ui="${UI.allocations.recurringManualSpread}"]`,
    ) as HTMLInputElement;
    expect(spreadToggle).toBeInTheDocument();
    expect(spreadToggle.checked).toBe(false);
    const every = document.querySelector(
      `[data-ui="${UI.allocations.recurringEvery}"]`,
    ) as HTMLInputElement;
    expect(every.value).toBe('1');
    fireEvent.change(document.querySelector(`[data-ui="${UI.allocations.recurringName}"]`)!, {
      target: { value: '給与振込' },
    });
    fireEvent.change(document.querySelector(`[data-ui="${UI.allocations.recurringAmount}"]`)!, {
      target: { value: '300000' },
    });
    fireEvent.click(
      within(document.querySelector(`[data-ui="${UI.allocations.recurringFrom}"]`)!).getByRole(
        'radio',
        { name: salary.name },
      ),
    );
    fireEvent.click(
      within(document.querySelector(`[data-ui="${UI.allocations.recurringTo}"]`)!).getByRole(
        'radio',
        { name: bank.name },
      ),
    );
    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.recurringSave}"]`)!);
    await waitFor(
      () => {
        expect(
          document.querySelector(`[data-ui="${UI.allocations.recurringSheet}"]`),
        ).not.toBeInTheDocument();
      },
      { timeout: 3000 },
    );

    const rule = (await loadLedger()).recurringRules.find((r) => r.name === '給与振込');
    expect(rule).toBeDefined();
    expect(rule!.everyMonths).toBe(1);
    expect(rule!.spreadExpenseAccountId).toBeUndefined();
    expect(rule!.debitAccountId).toBe(bank.id);
    expect(rule!.creditAccountId).toBe(salary.id);

    const editButton = await waitFor(() => {
      const found = document.querySelector(`[data-ui="${UI.allocations.recurringEdit}"]`);
      expect(found).toBeInTheDocument();
      return found!;
    });
    fireEvent.click(editButton);
    await waitFor(() => {
      expect(
        within(document.querySelector(`[data-ui="${UI.allocations.recurringFrom}"]`)!).getByRole(
          'radio',
          { name: salary.name },
        ),
      ).toBeChecked();
    });
    expect(
      within(document.querySelector(`[data-ui="${UI.allocations.recurringTo}"]`)!).getByRole(
        'radio',
        { name: bank.name },
      ),
    ).toBeChecked();
    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.recurringSave}"]`)!);
    await waitFor(() => {
      expect(
        document.querySelector(`[data-ui="${UI.allocations.recurringSheet}"]`),
      ).not.toBeInTheDocument();
    });
  });

  it('「継続コストとして扱う」で台帳経由にでき、借方欄は費用の行き先になる', async () => {
    const ledger = await loadLedger();
    const bank = ledger.accounts.find((a) => a.name === '預金')!;
    const salary = ledger.accounts.find((a) => a.name === '給与')!;

    await renderReady();
    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.unifiedAdd}"]`)!);
    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.addChooser}.rule"]`)!);

    // チェックは既定 OFF。ON にすると借方欄のラベルが「費用の行き先」になる。
    const spreadToggle = document.querySelector(
      `[data-ui="${UI.allocations.recurringManualSpread}"]`,
    ) as HTMLInputElement;
    expect(spreadToggle.checked).toBe(false);
    fireEvent.click(spreadToggle);
    const toPicker = document.querySelector(
      `[data-ui="${UI.allocations.recurringTo}"]`,
    ) as HTMLElement;
    expect(toPicker).toHaveTextContent('費用の行き先');

    fireEvent.change(document.querySelector(`[data-ui="${UI.allocations.recurringName}"]`)!, {
      target: { value: '健康保険' },
    });
    fireEvent.change(document.querySelector(`[data-ui="${UI.allocations.recurringAmount}"]`)!, {
      target: { value: '4000' },
    });
    fireEvent.click(
      within(document.querySelector(`[data-ui="${UI.allocations.recurringFrom}"]`)!).getByRole(
        'radio',
        { name: bank.name },
      ),
    );
    // 例: 健康保険 = 貸方 銀行口座・費用の行き先 給与（収入カテゴリも行き先にできる）。
    fireEvent.click(within(toPicker).getByRole('radio', { name: salary.name }));
    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.recurringSave}"]`)!);
    await waitFor(
      () => {
        expect(
          document.querySelector(`[data-ui="${UI.allocations.recurringSheet}"]`),
        ).not.toBeInTheDocument();
      },
      { timeout: 3000 },
    );

    const rule = (await loadLedger()).recurringRules.find((r) => r.name === '健康保険');
    expect(rule).toBeDefined();
    expect(rule!.spreadExpenseAccountId).toBe(salary.id);
    expect(rule!.debitAccountId).toBe(CONTINUOUS_COST_LEDGER_ACCOUNT_ID);
    expect(rule!.creditAccountId).toBe(bank.id);

    // 再編集でもチェック ON と選択中の科目を保持する。
    const editButton = await waitFor(
      () => {
        const found = document.querySelector(`[data-ui="${UI.allocations.recurringEdit}"]`);
        expect(found).toBeInTheDocument();
        return found!;
      },
      { timeout: 3000 },
    );
    fireEvent.click(editButton);
    await waitFor(() => {
      expect(
        document.querySelector(`[data-ui="${UI.allocations.recurringManualSpread}"]`),
      ).toBeInTheDocument();
    });
    expect(
      (
        document.querySelector(
          `[data-ui="${UI.allocations.recurringManualSpread}"]`,
        ) as HTMLInputElement
      ).checked,
    ).toBe(true);
    expect(
      within(document.querySelector(`[data-ui="${UI.allocations.recurringTo}"]`)!).getByRole(
        'radio',
        { name: salary.name },
      ),
    ).toBeChecked();
  });
});

describe('持ち込み登録（継続コスト資産シート）', () => {
  it('過去日 + 終了日なしで登録でき、購入の仕訳は貸方 = 初期残高で立つ', async () => {
    await renderReady();
    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.unifiedAdd}"]`)!);
    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.addChooser}.asset"]`)!);

    fireEvent.change(document.querySelector(`[data-ui="${UI.allocations.editName}"]`)!, {
      target: { value: '過去の洗濯機' },
    });
    fireEvent.change(document.querySelector(`[data-ui="${UI.allocations.editAmount}"]`)!, {
      target: { value: '240000' },
    });
    // 過去日で普通に登録できる（min 制約なし・警告なし）。
    const startInput = document.querySelector(
      `[data-ui="${UI.allocations.editStartDate}"]`,
    ) as HTMLInputElement;
    expect(startInput.type).toBe('date');
    expect(startInput.min).toBe('');
    fireEvent.change(startInput, { target: { value: '2023-04-15' } });
    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.editSave}"]`)!);

    await waitFor(async () => {
      const ledger = await loadLedger();
      const item = ledger.monthlyCostItems.find((m) => m.name === '過去の洗濯機');
      expect(item).toMatchObject({ amount: 240000, startDate: '2023-04-15' });
      expect(item!.endDate).toBeUndefined();
      const purchase = ledger.journalEntries.find(
        (e) => e.metadata?.monthlyCostId === item!.id && e.metadata.monthlyCostRecovery !== true,
      );
      expect(purchase).toBeDefined();
      expect(purchase!.date).toBe('2023-04-15');
      expect(purchase!.kind).toBe('opening');
      const credit = purchase!.lines.find((l) => l.side === 'credit')!;
      const creditAccount = ledger.accounts.find((a) => a.id === credit.accountId);
      expect(creditAccount?.role).toBe('equity');
      const debit = purchase!.lines.find((l) => l.side === 'debit')!;
      expect(debit.accountId).toBe(CONTINUOUS_COST_LEDGER_ACCOUNT_ID);
    });
  });

  it('編集シートの開始日は読み取り専用表示で、購入の仕訳を開く導線がある', async () => {
    const ledger = await loadLedger();
    const expense = ledger.accounts.find((a) => a.role === 'expense-category')!;
    const item = await createContinuousCost({
      name: '編集対象',
      amount: 12000,
      startDate: '2026-01-10',
      expenseAccountId: expense.id,
    });

    await renderReady();
    fireEvent.click(await screen.findByRole('button', { name: `編集: ${item.name}` }));

    const startDate = document.querySelector(`[data-ui="${UI.allocations.editStartDate}"]`)!;
    expect(startDate.querySelector('input')).toBeNull();
    expect(startDate).toHaveTextContent('2026-01-10');
    expect(
      document.querySelector(`[data-ui="${UI.allocations.editOpenPurchase}"]`),
    ).toBeInTheDocument();
  });
});

describe('終了まで1ヶ月以内のマーカー', () => {
  it('1ヶ月以内の項目だけ data-ending が付き、並びは終了が近い順', async () => {
    const ledger = await loadLedger();
    const expense = ledger.accounts.find((a) => a.role === 'expense-category')!;
    const today = todayLocal();
    await createContinuousCost({
      name: 'もうすぐ終了',
      amount: 12000,
      startDate: '2026-01-01',
      endDate: addMonthsToDate(today, 1),
      expenseAccountId: expense.id,
    });
    await createContinuousCost({
      name: 'まだ先',
      amount: 12000,
      startDate: '2026-01-01',
      endDate: addMonthsToDate(today, 12),
      expenseAccountId: expense.id,
    });
    await createContinuousCost({
      name: '終了日なし',
      amount: 12000,
      startDate: '2026-01-01',
      expenseAccountId: expense.id,
    });

    await renderReady();
    await screen.findByText('もうすぐ終了');
    const cards = Array.from(
      document.querySelectorAll(`[data-ui="${UI.allocations.item}"]`),
    ) as HTMLElement[];
    expect(cards).toHaveLength(3);
    // 終了が近い順（終了日なしは最後）。
    expect(cards[0]).toHaveTextContent('もうすぐ終了');
    expect(cards[1]).toHaveTextContent('まだ先');
    expect(cards[2]).toHaveTextContent('終了日なし');
    expect(cards[0]!.dataset['ending']).toBe('true');
    expect(cards[1]!.dataset['ending']).toBeUndefined();
    expect(cards[2]!.dataset['ending']).toBeUndefined();
  });
});

describe('アーカイブ動線', () => {
  it('振替せずアーカイブ = 終了日だけ設定される（既定 = 今日）', async () => {
    const ledger = await loadLedger();
    const expense = ledger.accounts.find((a) => a.role === 'expense-category')!;
    const item = await createContinuousCost({
      name: '捨てる項目',
      amount: 60000,
      startDate: '2026-01-01',
      endDate: '2027-12-31',
      expenseAccountId: expense.id,
    });

    await renderReady();
    fireEvent.click(await screen.findByRole('button', { name: `アーカイブ: ${item.name}` }));

    const dateInput = document.querySelector(
      `[data-ui="${UI.allocations.archiveDate}"]`,
    ) as HTMLInputElement;
    // 未終了の項目のアーカイブ既定日 = 今日。
    expect(dateInput.value).toBe(todayLocal());
    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.archiveConfirm}"]`)!);

    await waitFor(async () => {
      const after = (await loadLedger()).monthlyCostItems.find((m) => m.id === item.id);
      expect(after?.endDate).toBe(todayLocal());
      // 回収の振替は作られていない。
      const recoveries = (await loadLedger()).journalEntries.filter(
        (e) => e.metadata?.monthlyCostRecovery === true,
      );
      expect(recoveries).toHaveLength(0);
    });
  });

  it('残存価値が残るときはホームの振替と同じシートで回収し、既定値 = 残存価値・振替元は台帳に固定', async () => {
    const ledger = await loadLedger();
    const expense = ledger.accounts.find((a) => a.role === 'expense-category')!;
    // 終了日なし = 残存価値は全額（60,000）。
    const item = await createContinuousCost({
      name: '売る項目',
      amount: 60000,
      startDate: '2026-01-01',
      expenseAccountId: expense.id,
    });

    await renderReady();
    fireEvent.click(await screen.findByRole('button', { name: `アーカイブ: ${item.name}` }));

    const dialog = document.querySelector(`[data-ui="${UI.allocations.archiveDialog}"]`)!;
    expect(dialog).toHaveTextContent('残存価値');
    const transferButton = document.querySelector(
      `[data-ui="${UI.allocations.archiveTransfer}"]`,
    )!;
    expect(transferButton).toBeInTheDocument();
    fireEvent.click(transferButton);

    // ホームの振替と同じシート（EntrySheet transfer 再利用）。金額の既定 = 残存価値・編集可。
    const amountInput = await waitFor(() => {
      const found = document.querySelector(
        `[data-ui="${UI.journal.entry.amount}"]`,
      ) as HTMLInputElement | null;
      expect(found).toBeInTheDocument();
      return found!;
    });
    expect(amountInput.value).toBe('60000');
    // 振替元（貸方）は台帳に固定 = ピッカーが無い。振替先だけ選ぶ。
    expect(
      document.querySelector(`[data-ui="${UI.journal.entry.flowSource}"]`),
    ).not.toBeInTheDocument();
    fireEvent.change(amountInput, { target: { value: '30000' } });
    const destination = document.querySelector(
      `[data-ui="${UI.journal.entry.flowDestination}"]`,
    ) as HTMLElement;
    // 回収先は簿記編集と同じく費用カテゴリも選べる。
    fireEvent.click(within(destination).getByRole('radio', { name: expense.name }));
    fireEvent.click(document.querySelector(`[data-ui="${UI.journal.entry.save}"]`)!);

    await waitFor(async () => {
      const after = await loadLedger();
      const saved = after.monthlyCostItems.find((m) => m.id === item.id);
      expect(saved?.endDate).toBe(todayLocal());
      const recovery = after.journalEntries.find(
        (e) => e.metadata?.monthlyCostRecovery === true && e.metadata.monthlyCostId === item.id,
      );
      expect(recovery).toBeDefined();
      const debit = recovery!.lines.find((l) => l.side === 'debit')!;
      const credit = recovery!.lines.find((l) => l.side === 'credit')!;
      expect(debit.accountId).toBe(expense.id);
      expect(credit.accountId).toBe(CONTINUOUS_COST_LEDGER_ACCOUNT_ID);
      expect(credit.amount).toBe(30000);
      // 金額は絶対に変更しない（購入の仕訳とのミラー維持）。
      expect(saved?.amount).toBe(60000);
    });
  });
});

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
import { archiveMonthlyCost, createContinuousCost, loadLedger } from '../src/data/repository';
import { CONTINUOUS_COST_LEDGER_ACCOUNT_ID } from '../src/domain/constants';
import { addMonthsToDate } from '../src/domain/allocation';
import type { ReportPeriod } from '../src/domain/reportPeriod';
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

function View({ period }: { period: ReportPeriod }) {
  return (
    <ToastProvider>
      <LedgerProvider>
        <ReadyView period={period} />
      </LedgerProvider>
    </ToastProvider>
  );
}

function ReadyView({ period }: { period: ReportPeriod }) {
  const { status } = useLedger();
  return status === 'ready' ? <Allocations period={period} onEditEntry={() => undefined} /> : null;
}

async function renderReady(period: ReportPeriod = { mode: 'all' }) {
  const view = render(<View period={period} />);
  await waitFor(() => {
    expect(document.querySelector(`[data-ui="${UI.allocations.view}"]`)).toBeInTheDocument();
  });
  return view;
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
    expect(document.querySelector('[data-ui="allocations.recurring.manualSpread"]')).toBeNull();
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

  it('行き先に費用科目を選ぶだけで自動的に台帳経由になる', async () => {
    const ledger = await loadLedger();
    const bank = ledger.accounts.find((a) => a.name === '預金')!;
    const fixed = ledger.accounts.find((a) => a.name === '固定費')!;

    await renderReady();
    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.unifiedAdd}"]`)!);
    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.addChooser}.rule"]`)!);

    const toPicker = document.querySelector(
      `[data-ui="${UI.allocations.recurringTo}"]`,
    ) as HTMLElement;
    expect(document.querySelector('[data-ui="allocations.recurring.manualSpread"]')).toBeNull();

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
    fireEvent.click(within(toPicker).getByRole('radio', { name: fixed.name }));
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
    expect(rule!.spreadExpenseAccountId).toBe(fixed.id);
    expect(rule!.debitAccountId).toBe(CONTINUOUS_COST_LEDGER_ACCOUNT_ID);
    expect(rule!.creditAccountId).toBe(bank.id);

    // 再編集でもチェックは存在せず、論理的な行き先だけを保持する。
    const editButton = await waitFor(
      () => {
        const found = document.querySelector(`[data-ui="${UI.allocations.recurringEdit}"]`);
        expect(found).toBeInTheDocument();
        return found!;
      },
      { timeout: 3000 },
    );
    fireEvent.click(editButton);
    expect(document.querySelector('[data-ui="allocations.recurring.manualSpread"]')).toBeNull();
    expect(
      within(document.querySelector(`[data-ui="${UI.allocations.recurringTo}"]`)!).getByRole(
        'radio',
        { name: fixed.name },
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

describe('ヘッダー日付に追従する一覧と金額', () => {
  it('選択日より後の項目を隠し、回収は全知識としてどの断面にも同じ配分で表示する', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.role === 'daily-asset')!;
    const expense = ledger.accounts.find((a) => a.role === 'expense-category')!;

    const historical = await createContinuousCost({
      name: '当時の年払い',
      amount: 12000,
      startDate: '2024-01-01',
      expenseAccountId: expense.id,
      creditAccountId: cash.id,
    });
    // 回収日は 6 月末だが、現在の全知識としてすべての月割り対象月へ遡及して再配分する。
    await archiveMonthlyCost({
      id: historical.id,
      endDate: '2024-06-30',
      recovery: { destinationAccountId: cash.id, amount: 6000 },
    });
    await createContinuousCost({
      name: '未来開始の項目',
      amount: 6000,
      startDate: '2026-07-01',
      endDate: '2026-12-31',
      expenseAccountId: expense.id,
      creditAccountId: cash.id,
    });

    const view = await renderReady({ mode: 'date', date: '2023-12-31' });
    expect(screen.queryByText(historical.name)).not.toBeInTheDocument();
    expect(screen.queryByText('未来開始の項目')).not.toBeInTheDocument();
    expect(screen.getByText(/まだ登録がありません/)).toBeInTheDocument();

    view.rerender(<View period={{ mode: 'date', date: '2024-05-31' }} />);
    const historicalCard = (await screen.findByText(historical.name)).closest(
      `[data-ui="${UI.allocations.item}"]`,
    ) as HTMLElement;
    expect(historicalCard).not.toBeNull();
    expect(screen.queryByText('未来開始の項目')).not.toBeInTheDocument();
    // 実際の今日は終了済みでも、選択日にはまだ有効。終了まで1ヶ月なのでマーカーも D 基準。
    expect(historicalCard.dataset['ending']).toBe('true');
    // どの断面でも 6,000 / 6ヶ月 = 月1,000。5月末の残りは1,000。
    expect(within(historicalCard).getByText('残存価値').closest('.kv')).toHaveTextContent('1,000');
    expect(within(historicalCard).getByText('今月の計上額').closest('.kv')).toHaveTextContent(
      '1,000',
    );

    view.rerender(<View period={{ mode: 'date', date: '2024-06-30' }} />);
    const recoveredCard = (await screen.findByText(historical.name)).closest(
      `[data-ui="${UI.allocations.item}"]`,
    ) as HTMLElement;
    // 回収後は割り振る総額 6,000 / 6ヶ月 = 月1,000、終了日時点の残りは0。
    expect(within(recoveredCard).getByText('月あたり').closest('.kv')).toHaveTextContent('1,000');
    expect(within(recoveredCard).getByText('残存価値').closest('.kv')).toHaveTextContent('0');
    expect(within(recoveredCard).getByText('今月の計上額').closest('.kv')).toHaveTextContent(
      '1,000',
    );
  });

  it('過去断面のカードとアーカイブ操作が同じ全知識の回収額を使う', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.role === 'daily-asset')!;
    const expense = ledger.accounts.find((a) => a.role === 'expense-category')!;
    const item = await createContinuousCost({
      name: '回収済みの過去項目',
      amount: 12000,
      startDate: '2024-01-01',
      expenseAccountId: expense.id,
      creditAccountId: cash.id,
    });
    await archiveMonthlyCost({
      id: item.id,
      endDate: '2024-06-30',
      recovery: { destinationAccountId: cash.id, amount: 6000 },
    });

    await renderReady({ mode: 'date', date: '2024-05-31' });
    const card = (await screen.findByText(item.name)).closest(
      `[data-ui="${UI.allocations.item}"]`,
    ) as HTMLElement;
    // 後日の回収を全知識として反映するため、過去断面でも残存価値は1,000。
    expect(within(card).getByText('残存価値').closest('.kv')).toHaveTextContent('1,000');

    fireEvent.click(screen.getByRole('button', { name: `アーカイブ: ${item.name}` }));
    const dialog = document.querySelector(
      `[data-ui="${UI.allocations.archiveDialog}"]`,
    ) as HTMLElement;
    // 配分最終日では回収額にかかわらず残存0になるため、途中日へ変えて差を固定する。
    fireEvent.change(
      document.querySelector(`[data-ui="${UI.allocations.archiveDate}"]`) as HTMLInputElement,
      { target: { value: '2024-05-31' } },
    );
    // 表示と操作の両方が同じ全知識を使うため、値は変わらない。
    expect(within(dialog).getByText('残存価値').closest('.kv')).toHaveTextContent('1,000');
    expect(
      document.querySelector(`[data-ui="${UI.allocations.archiveTransfer}"]`),
    ).toBeInTheDocument();
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
    const transferButton = document.querySelector(`[data-ui="${UI.allocations.archiveTransfer}"]`)!;
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

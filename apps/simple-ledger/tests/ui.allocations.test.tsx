/*
 * 毎月のもの（4項目モデル）の UI 回帰:
 *  - 追加チューザーは 2 択（くり返し記帳 / 持ち込み）
 *  - 持ち込み登録（過去日・終了日なし可・貸方 = 初期残高）
 *  - 終了まで1ヶ月以内の行のマーカー（data-ending）
 *  - アーカイブシート（終了日 + 回収額/回収先 + 残りの扱いを 1 枚で決める）
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ToastProvider } from '@snishi/foundation/ui/toast';
import { patchDialogIfNeeded } from '@snishi/foundation/ui/test-utils';
import { LedgerProvider, useLedger } from '../src/state/store';
import { Allocations } from '../src/ui/screens/Allocations';
import {
  archiveMonthlyCost,
  createContinuousCost,
  createRecurringRule,
  loadLedger,
} from '../src/data/repository';
import { CONTINUOUS_COST_LEDGER_ACCOUNT_ID } from '../src/domain/constants';
import { addMonthsToDate } from '../src/domain/allocation';
import type { ReportPeriod } from '../src/domain/reportPeriod';
import { UI } from '../src/ui-contract';
import { firstRuleRow } from './tapTargets';
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
    // v13.1（c 案）: 収入ルールも保存形は台帳経由（計上先 = 利用者が選んだ行き先）。
    expect(rule!.spreadExpenseAccountId).toBe(bank.id);
    expect(rule!.debitAccountId).toBe(CONTINUOUS_COST_LEDGER_ACCOUNT_ID);
    expect(rule!.creditAccountId).toBe(salary.id);

    const editButton = await waitFor(() => {
      const found = firstRuleRow();
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
        const found = firstRuleRow();
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

  it('行き先に収入科目（差引形）を選んでも台帳経由になり、種別が「収入」と表示されない', async () => {
    const ledger = await loadLedger();
    const bank = ledger.accounts.find((a) => a.name === '預金')!;
    const salary = ledger.accounts.find((a) => a.name === '給与')!;

    await renderReady();
    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.unifiedAdd}"]`)!);
    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.addChooser}.rule"]`)!);

    fireEvent.change(document.querySelector(`[data-ui="${UI.allocations.recurringName}"]`)!, {
      target: { value: '医師賠償責任保険' },
    });
    fireEvent.change(document.querySelector(`[data-ui="${UI.allocations.recurringAmount}"]`)!, {
      target: { value: '60000' },
    });
    fireEvent.click(
      within(document.querySelector(`[data-ui="${UI.allocations.recurringFrom}"]`)!).getByRole(
        'radio',
        { name: bank.name },
      ),
    );
    const toPicker = document.querySelector(
      `[data-ui="${UI.allocations.recurringTo}"]`,
    ) as HTMLElement;
    fireEvent.click(within(toPicker).getByRole('radio', { name: salary.name }));
    // 収入行き（差引形）でもラベルは中立の「計上先」になる（費用行きと同じ扱い）。
    expect(within(toPicker).getByText(/計上先/)).toBeInTheDocument();
    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.recurringSave}"]`)!);
    await waitFor(
      () => {
        expect(
          document.querySelector(`[data-ui="${UI.allocations.recurringSheet}"]`),
        ).not.toBeInTheDocument();
      },
      { timeout: 3000 },
    );

    // 保存正規形は費用ルールと同一（借方 = 台帳・spread = 元の収入科目）。
    const rule = (await loadLedger()).recurringRules.find((r) => r.name === '医師賠償責任保険');
    expect(rule).toBeDefined();
    expect(rule!.spreadExpenseAccountId).toBe(salary.id);
    expect(rule!.debitAccountId).toBe(CONTINUOUS_COST_LEDGER_ACCOUNT_ID);
    expect(rule!.creditAccountId).toBe(bank.id);

    // 一覧の種別タグが「収入（給与など）」と誤読されない（差引形は簿記編集扱い）。
    const list = await waitFor(() => {
      const found = document.querySelector(`[data-ui="${UI.allocations.recurringList}"]`);
      expect(found).toBeInTheDocument();
      return found as HTMLElement;
    });
    expect(within(list).getByText('簿記編集（科目を直接指定）')).toBeInTheDocument();
    expect(within(list).queryByText('収入（給与など）')).not.toBeInTheDocument();
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
      expect(item).toMatchObject({ amount: 24000000, startDate: '2023-04-15' });
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
      amount: 1200000,
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

describe('期間クイックボタンと終了日の解除', () => {
  it('期間クイックボタンの起点は購入日', async () => {
    const ledger = await loadLedger();
    const expense = ledger.accounts.find((a) => a.role === 'expense-category')!;
    const item = await createContinuousCost({
      name: '前払いの保守',
      amount: 6000000,
      startDate: '2026-01-10',
      expenseAccountId: expense.id,
    });

    await renderReady();
    fireEvent.click(await screen.findByRole('button', { name: `編集: ${item.name}` }));
    const quickSpan = document.querySelector(
      `[data-ui="${UI.allocations.editQuickSpan}"]`,
    ) as HTMLElement;
    const endInput = document.querySelector(
      `[data-ui="${UI.allocations.editEndDate}"]`,
    ) as HTMLInputElement;

    fireEvent.click(within(quickSpan).getByRole('button', { name: '1年' }));
    expect(endInput.value).toBe('2026-12-31');
  });

  it('「終了日を解除」で空にして保存すると終了日が消える（iOS の date input は空へ戻せないため）', async () => {
    const ledger = await loadLedger();
    const expense = ledger.accounts.find((a) => a.role === 'expense-category')!;
    const item = await createContinuousCost({
      name: '解除する保守',
      amount: 6000000,
      startDate: '2026-01-10',
      endDate: '2026-12-31',
      expenseAccountId: expense.id,
    });

    await renderReady();
    fireEvent.click(await screen.findByRole('button', { name: `編集: ${item.name}` }));
    const endInput = document.querySelector(
      `[data-ui="${UI.allocations.editEndDate}"]`,
    ) as HTMLInputElement;
    expect(endInput.value).toBe('2026-12-31');

    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.editEndDateClear}"]`)!);
    expect(endInput.value).toBe('');
    // 空になったら解除ボタン自体も消える（押す対象が無い）。
    expect(document.querySelector(`[data-ui="${UI.allocations.editEndDateClear}"]`)).toBeNull();

    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.editSave}"]`)!);
    await waitFor(async () => {
      const after = (await loadLedger()).monthlyCostItems.find((m) => m.id === item.id)!;
      expect(after.endDate).toBeUndefined();
    });
  });
});

describe('終了まで1ヶ月以内のマーカー', () => {
  it('1ヶ月以内の項目だけ data-ending が付き、並びは終了が近い順', async () => {
    const ledger = await loadLedger();
    const expense = ledger.accounts.find((a) => a.role === 'expense-category')!;
    const today = todayLocal();
    await createContinuousCost({
      name: 'もうすぐ終了',
      amount: 1200000,
      startDate: '2026-01-01',
      endDate: addMonthsToDate(today, 1),
      expenseAccountId: expense.id,
    });
    await createContinuousCost({
      name: 'まだ先',
      amount: 1200000,
      startDate: '2026-01-01',
      endDate: addMonthsToDate(today, 12),
      expenseAccountId: expense.id,
    });
    await createContinuousCost({
      name: '終了日なし',
      amount: 1200000,
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
      amount: 1200000,
      startDate: '2024-01-01',
      expenseAccountId: expense.id,
      creditAccountId: cash.id,
    });
    // 回収日は 6 月末だが、現在の全知識としてすべての月割り対象月へ遡及して再配分する。
    await archiveMonthlyCost({
      id: historical.id,
      endDate: '2024-06-30',
      recoveries: [{ destinationAccountId: cash.id, amount: 600000 }],
    });
    await createContinuousCost({
      name: '未来開始の項目',
      amount: 600000,
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
    // 同日刻み: 2024-01-01 起点の刻み日は 2024-02-01〜2024-06-01 の 5 本（2024-07-01 は
    // 終了日 2024-06-30 超）。割り振る総額 = 12,000 − 回収 6,000 = 6,000 → 1 本 1,200。
    // 5月末は 4 本（2〜5月）ぶん 4,800 が費用化済みなので、残りは 1,200。
    expect(within(historicalCard).getByText('残存価値').closest('.kv')).toHaveTextContent('1,200');
    expect(within(historicalCard).getByText('今月の計上額').closest('.kv')).toHaveTextContent(
      '1,200',
    );

    view.rerender(<View period={{ mode: 'date', date: '2024-06-30' }} />);
    const recoveredCard = (await screen.findByText(historical.name)).closest(
      `[data-ui="${UI.allocations.item}"]`,
    ) as HTMLElement;
    // 回収後は割り振る総額 6,000 / 5 刻み = 1,200、最終刻み（6/01）を過ぎた 6月末は残り 0。
    expect(within(recoveredCard).getByText('月あたり').closest('.kv')).toHaveTextContent('1,200');
    expect(within(recoveredCard).getByText('残存価値').closest('.kv')).toHaveTextContent('0');
    expect(within(recoveredCard).getByText('今月の計上額').closest('.kv')).toHaveTextContent(
      '1,200',
    );
  });

  it('過去断面のカードとアーカイブ操作が同じ全知識の回収額を使う', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.role === 'daily-asset')!;
    const expense = ledger.accounts.find((a) => a.role === 'expense-category')!;
    const item = await createContinuousCost({
      name: '回収済みの過去項目',
      amount: 1200000,
      startDate: '2024-01-01',
      expenseAccountId: expense.id,
      creditAccountId: cash.id,
    });
    await archiveMonthlyCost({
      id: item.id,
      endDate: '2024-06-30',
      recoveries: [{ destinationAccountId: cash.id, amount: 600000 }],
    });

    await renderReady({ mode: 'date', date: '2024-05-31' });
    const card = (await screen.findByText(item.name)).closest(
      `[data-ui="${UI.allocations.item}"]`,
    ) as HTMLElement;
    // 後日の回収を全知識として反映するため、過去断面でも残存価値は 1,200
    //（同日刻み 2024-02-01〜06-01 の 5 本 × 1,200 のうち、5月末までに 4 本ぶん済み）。
    expect(within(card).getByText('残存価値').closest('.kv')).toHaveTextContent('1,200');

    fireEvent.click(screen.getByRole('button', { name: `終了: ${item.name}` }));
    const dialog = document.querySelector(
      `[data-ui="${UI.allocations.archiveDialog}"]`,
    ) as HTMLElement;
    // 最終刻み（2024-06-01）以降は回収額にかかわらず残存 0 になるため、途中日へ変えて差を固定する。
    fireEvent.change(
      document.querySelector(`[data-ui="${UI.allocations.archiveDate}"]`) as HTMLInputElement,
      { target: { value: '2024-05-31' } },
    );
    // 表示と操作の両方が同じ全知識を使うため、値は変わらない。
    expect(within(dialog).getByText('残存価値').closest('.kv')).toHaveTextContent('1,200');
    // 回収額の既定もその同じ残存価値（シート内で計算し直さない）。
    expect(
      (
        document.querySelector(
          `[data-ui="${UI.allocations.archiveRecoveryAmount}"]`,
        ) as HTMLInputElement
      ).value,
    ).toBe('1200');
  });
});

describe('ルール由来の item カード（導出・読み取り専用）', () => {
  it('未来断面にその日の周期の item がカードで出る。区別タグは付けず、編集はルールを開く', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.role === 'daily-asset')!;
    const expense = ledger.accounts.find((a) => a.role === 'expense-category')!;
    // 未来開始のルール（保存される item は無く、断面ごとに導出されるだけ）。
    await createRecurringRule({
      name: '未来のサブスク',
      amount: 3000,
      dayOfMonth: 5,
      debitAccountId: expense.id,
      creditAccountId: cash.id,
      startMonth: '2031-02',
    });

    // 断面 2031-04-30: 導出される周期 2/5・3/5・4/5 のうち
    // [2/5,3/5]（終了 3/5 < 断面）と [3/5,4/5]（終了 4/5 < 断面）はアーカイブ済みで隠れ、
    // [4/5,5/5] だけがその日の状態として見える（同日刻み・endDate = 次回起票日）。
    await renderReady({ mode: 'date', date: '2031-04-30' });
    const cards = document.querySelectorAll('[data-derived-rule]');
    expect(cards).toHaveLength(1);
    const card = within(cards[0] as HTMLElement);
    expect(card.getByText('未来のサブスク')).toBeInTheDocument();
    // 実 item のルール由来カードと同じタグ（「予定」等の追加区別は付けない）。
    expect(card.getByText('くり返し記帳から')).toBeInTheDocument();
    // 期間 = [起票日, 次回起票日]・残存価値 = 全額（刻み 5/5 は断面より未来）。
    expect(card.getByText(/2031-04-05 〜 2031-05-05/)).toBeInTheDocument();
    // アーカイブ・削除は出さない（実在しない item に対する操作は無い）。
    expect(card.queryByRole('button', { name: /アーカイブ/ })).not.toBeInTheDocument();
    expect(card.queryByRole('button', { name: /削除/ })).not.toBeInTheDocument();
    // 編集 = カードそのもののタップで由来ルールのシートが開く（derivedOrigin と同じ導線）。
    fireEvent.click(cards[0] as HTMLElement);
    await waitFor(() => {
      expect(
        document.querySelector(`[data-ui="${UI.allocations.recurringSheet}"]`),
      ).toBeInTheDocument();
    });
  });

  it('過去の周期も未来の周期も 1 枚ずつ出る（同じ周期が二重にならない）', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.role === 'daily-asset')!;
    const expense = ledger.accounts.find((a) => a.role === 'expense-category')!;
    const today = todayLocal();
    // 今日始まりの毎月ルール。v13 では今日ぶんも来月ぶんも同じ導出カードで、
    // 「起票済み / 未起票」の区別は無い。
    await createRecurringRule({
      name: '今日始まりのサブスク',
      amount: 3000,
      dayOfMonth: Number.parseInt(today.slice(8, 10), 10),
      debitAccountId: expense.id,
      creditAccountId: cash.id,
      startMonth: today.slice(0, 7),
    });
    expect((await loadLedger()).monthlyCostItems).toHaveLength(0);

    const nextMonth = addMonthsToDate(today, 1);
    await renderReady({ mode: 'date', date: nextMonth });
    const names = screen.getAllByText('今日始まりのサブスク');
    const cards = [...document.querySelectorAll(`[data-ui="${UI.allocations.item}"]`)].filter(
      (el) => el.textContent?.includes('今日始まりのサブスク'),
    );
    // 今日の周期 [今日, 来月同日] と来月の周期 [来月同日, 再来月同日] の 2 枚だけ。
    expect(cards).toHaveLength(2);
    expect(cards[0]).toHaveTextContent(`${today} 〜 ${nextMonth}`);
    expect(cards[1]).toHaveTextContent(`${nextMonth} 〜 ${addMonthsToDate(today, 2)}`);
    // data-derived-rule はルール由来の全カードに付く（保存の有無で見た目が割れない）。
    expect(cards.filter((el) => el.hasAttribute('data-derived-rule'))).toHaveLength(2);
    expect(names.length).toBeGreaterThanOrEqual(2);
  });
});

/*
 * アーカイブシート（終了日 + 回収 + 残りの扱いを 1 枚で決める・2026-08-15）。
 * 旧「終了日ダイアログ → 振替シート」の 2 段構えは無い。
 */
describe('アーカイブシート', () => {
  /** 1,200,000 を 12 刻み（各 100,000）で割り切る item。回収前の残存価値は 600,000。 */
  async function seedEvenItem() {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.role === 'daily-asset')!;
    const expense = ledger.accounts.find((a) => a.role === 'expense-category')!;
    const item = await createContinuousCost({
      name: '割り切れる項目',
      amount: 1200000,
      startDate: '2026-01-01',
      endDate: '2027-01-01',
      expenseAccountId: expense.id,
      creditAccountId: cash.id,
    });
    return { item, cash, expense };
  }

  function sheet(): HTMLElement {
    return document.querySelector(`[data-ui="${UI.allocations.archiveDialog}"]`) as HTMLElement;
  }
  function dateInput(): HTMLInputElement {
    return document.querySelector(`[data-ui="${UI.allocations.archiveDate}"]`) as HTMLInputElement;
  }
  function recoveryInput(): HTMLInputElement {
    return document.querySelector(
      `[data-ui="${UI.allocations.archiveRecoveryAmount}"]`,
    ) as HTMLInputElement;
  }
  function remainderRadio(mode: 'spread' | 'expense'): HTMLInputElement {
    const dataUi =
      mode === 'spread'
        ? UI.allocations.archiveRemainderSpread
        : UI.allocations.archiveRemainderExpense;
    return document.querySelector(`[data-ui="${dataUi}"]`) as HTMLInputElement;
  }
  async function openSheet(name: string) {
    fireEvent.click(await screen.findByRole('button', { name: `終了: ${name}` }));
    await waitFor(() => expect(sheet()).toBeInTheDocument());
  }
  function save() {
    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.archiveConfirm}"]`)!);
  }
  async function recoveriesOf(itemId: string) {
    return (await loadLedger()).journalEntries.filter(
      (e) => e.metadata?.monthlyCostRecovery === true && e.metadata.monthlyCostId === itemId,
    );
  }

  it('回収 0 でアーカイブ = 終了日だけ設定される（既定 = 今日・按分が既定）', async () => {
    const ledger = await loadLedger();
    const expense = ledger.accounts.find((a) => a.role === 'expense-category')!;
    const item = await createContinuousCost({
      name: '捨てる項目',
      amount: 6000000,
      startDate: '2026-01-01',
      endDate: '2027-12-31',
      expenseAccountId: expense.id,
    });

    await renderReady();
    await openSheet(item.name);
    // 未終了の項目のアーカイブ既定日 = 今日。残りの扱いの既定は「期間に割り振る」。
    expect(dateInput().value).toBe(todayLocal());
    expect(remainderRadio('spread').checked).toBe(true);
    // 回収額を 0 にすると回収先ピッカーは消える（作る仕訳が無いので選ばせない）。
    fireEvent.change(recoveryInput(), { target: { value: '0' } });
    expect(
      document.querySelector(`[data-ui="${UI.allocations.archiveRecoveryTo}"]`),
    ).not.toBeInTheDocument();
    save();

    await waitFor(async () => {
      const after = (await loadLedger()).monthlyCostItems.find((m) => m.id === item.id);
      expect(after?.endDate).toBe(todayLocal());
    });
    expect(await recoveriesOf(item.id)).toHaveLength(0);
  });

  it('回収額の既定 = その終了日時点の残存価値。終了日を変えると既定が追従する', async () => {
    const { item } = await seedEvenItem();

    await renderReady();
    await openSheet(item.name);
    // 既定日（今日 = 2026-08-15 相当）ではなく、明示した終了日での残存価値を出す。
    fireEvent.change(dateInput(), { target: { value: '2026-07-01' } });
    // 2026-02-01〜07-01 の 6 刻み（各 1,000）が済み、残り 6,000。
    expect(recoveryInput().value).toBe('6000');
    fireEvent.change(dateInput(), { target: { value: '2026-04-01' } });
    // 3 刻み済みなら残り 9,000。手で触っていないので既定が追従する。
    expect(recoveryInput().value).toBe('9000');
    // 手で直した後は終了日を動かしても上書きしない（判定はフラグではなく値）。
    fireEvent.change(recoveryInput(), { target: { value: '1234' } });
    fireEvent.change(dateInput(), { target: { value: '2026-07-01' } });
    expect(recoveryInput().value).toBe('1234');
  });

  it('回収先を選んで 1 枚で保存する（終了日 + 回収の振替が同じ操作）', async () => {
    const { item, cash } = await seedEvenItem();

    await renderReady();
    await openSheet(item.name);
    fireEvent.change(dateInput(), { target: { value: '2026-07-01' } });
    fireEvent.change(recoveryInput(), { target: { value: '2000' } });
    const picker = document.querySelector(
      `[data-ui="${UI.allocations.archiveRecoveryTo}"]`,
    ) as HTMLElement;
    // 回収先は費用カテゴリを出さない（保存境界が item の費用の行き先以外を拒否するため）。
    expect(within(picker).queryByRole('radio', { name: '娯楽費' })).not.toBeInTheDocument();
    fireEvent.click(within(picker).getByRole('radio', { name: cash.name }));
    save();

    await waitFor(async () => {
      const saved = (await loadLedger()).monthlyCostItems.find((m) => m.id === item.id);
      expect(saved?.endDate).toBe('2026-07-01');
      // 金額は絶対に変更しない（購入の仕訳とのミラー維持）。
      expect(saved?.amount).toBe(1200000);
    });
    const recoveries = await recoveriesOf(item.id);
    expect(recoveries).toHaveLength(1);
    expect(recoveries[0]!.date).toBe('2026-07-01');
    expect(recoveries[0]!.lines).toEqual([
      { accountId: cash.id, side: 'debit', amount: 200000 },
      { accountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID, side: 'credit', amount: 200000 },
    ]);
  });

  it('「終了日に全額費用にする」= 残り全額の第 2 振替が費用の行き先へ立つ', async () => {
    const { item, expense } = await seedEvenItem();

    await renderReady();
    await openSheet(item.name);
    fireEvent.change(dateInput(), { target: { value: '2026-07-01' } });
    fireEvent.change(recoveryInput(), { target: { value: '0' } });
    fireEvent.click(remainderRadio('expense'));
    save();

    await waitFor(async () => {
      expect(await recoveriesOf(item.id)).toHaveLength(1);
    });
    const [second] = await recoveriesOf(item.id);
    // 借方 = item の費用の行き先・金額 = 残存価値（6,000）・日付 = 終了日。
    expect(second!.date).toBe('2026-07-01');
    expect(second!.lines).toEqual([
      { accountId: expense.id, side: 'debit', amount: 600000 },
      { accountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID, side: 'credit', amount: 600000 },
    ]);
  });

  it('部分回収 + 「終了日に全額」= 資産へ R・費用へ（残存 − R）の 2 本を 1 tx で', async () => {
    const { item, cash, expense } = await seedEvenItem();

    await renderReady();
    await openSheet(item.name);
    fireEvent.change(dateInput(), { target: { value: '2026-07-01' } });
    fireEvent.change(recoveryInput(), { target: { value: '2000' } });
    fireEvent.click(
      within(
        document.querySelector(`[data-ui="${UI.allocations.archiveRecoveryTo}"]`) as HTMLElement,
      ).getByRole('radio', { name: cash.name }),
    );
    fireEvent.click(remainderRadio('expense'));
    save();

    await waitFor(async () => {
      expect(await recoveriesOf(item.id)).toHaveLength(2);
    });
    const recoveries = await recoveriesOf(item.id);
    expect(
      recoveries
        .map((e) => `${e.lines.find((l) => l.side === 'debit')!.accountId}:${e.lines[0]!.amount}`)
        .sort(),
    ).toEqual([`${cash.id}:200000`, `${expense.id}:400000`].sort());
  });

  it('残り 0（ちょうど回収）・超過回収では「終了日に全額」を選べない', async () => {
    const { item, cash } = await seedEvenItem();

    await renderReady();
    await openSheet(item.name);
    fireEvent.change(dateInput(), { target: { value: '2026-07-01' } });
    // 既定 = 残存価値ちょうど → 残り 0。
    expect(recoveryInput().value).toBe('6000');
    expect(remainderRadio('expense').disabled).toBe(true);
    // 超過回収（残りが負 = 過去にわたる費用減）でも選べない。
    fireEvent.change(recoveryInput(), { target: { value: '9000' } });
    expect(remainderRadio('expense').disabled).toBe(true);
    // 一部だけ回収すれば選べる。
    fireEvent.change(recoveryInput(), { target: { value: '2000' } });
    expect(remainderRadio('expense').disabled).toBe(false);

    // 超過回収は従来どおり保存できる（回収額に上限は無い）。
    fireEvent.change(recoveryInput(), { target: { value: '9000' } });
    fireEvent.click(
      within(
        document.querySelector(`[data-ui="${UI.allocations.archiveRecoveryTo}"]`) as HTMLElement,
      ).getByRole('radio', { name: cash.name }),
    );
    save();
    await waitFor(async () => {
      expect(await recoveriesOf(item.id)).toHaveLength(1);
    });
    expect((await recoveriesOf(item.id))[0]!.lines[0]!.amount).toBe(900000);
  });
});

/*
 * 行の設計図（v13.2・作者確定 2026-08-16）:
 *  - 一覧の行は「左 = 名前と説明 / 右 = 固定列」。右列は上段に金額、下段に操作（または状態）。
 *    金額とボタンが行をまたいで縦に揃う（v13.1 までは操作がある行だけ金額が内側へ押されていた）
 *  - 一等地の動詞は tonal ボタン（btn--ghost は地も枠も透明でボタンに見えない）
 *  - 操作が出ない行も同じ位置を状態チップで埋める（空白にしない）
 */
describe('行の設計図（右端列・tonal ボタン・状態チップ）', () => {
  async function seedRules() {
    const ledger = await loadLedger();
    const bank = ledger.accounts.find((a) => a.role === 'daily-asset')!;
    const expense = ledger.accounts.find((a) => a.role === 'expense-category')!;
    // 継続中（操作あり）・終了予定（未来の終了点）・終了済み（過去の終了点）の 3 状態。
    await createRecurringRule({
      name: '継続中ルール',
      amount: 1000,
      dayOfMonth: 5,
      everyMonths: 1,
      debitAccountId: expense.id,
      creditAccountId: bank.id,
      startMonth: '2026-01',
      startDate: '2026-01-05',
    });
    await createRecurringRule({
      name: '終了予定ルール',
      amount: 2000,
      dayOfMonth: 6,
      everyMonths: 1,
      debitAccountId: expense.id,
      creditAccountId: bank.id,
      startMonth: '2026-01',
      startDate: '2026-01-06',
      endDate: '2030-01-01',
    });
    await createRecurringRule({
      name: '終了済みルール',
      amount: 3000,
      dayOfMonth: 7,
      everyMonths: 1,
      debitAccountId: expense.id,
      creditAccountId: bank.id,
      startMonth: '2026-01',
      startDate: '2026-01-07',
      endDate: '2026-02-01',
    });
  }

  it('ルール行は右列に金額・操作を積み、全行の右端が揃う', async () => {
    await seedRules();
    render(<View period={{ mode: 'all' }} />);
    await waitFor(() => {
      expect(document.querySelector(`[data-ui="${UI.allocations.recurringList}"]`)).not.toBeNull();
    });
    // 「終了分も表示」で 3 行そろえる。
    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.showCompleted}"]`)!);

    const rows = [
      ...document.querySelectorAll(`[data-ui="${UI.allocations.recurringList}"] .list__item`),
    ];
    expect(rows.length).toBe(3);
    for (const row of rows) {
      // 金額と操作/状態は同じ右列（.row-trailing）の中にあり、行の最終要素はその列。
      const trailing = row.lastElementChild!;
      expect(trailing.classList.contains('row-trailing')).toBe(true);
      expect(trailing.querySelector('.list__amount')).not.toBeNull();
      // 操作が無い行も空にしない（状態チップで埋める）。
      expect(trailing.children.length).toBe(2);
    }
  });

  it('継続中は tonal ボタン、終了予定・終了済みは状態チップを同じ位置に出す', async () => {
    await seedRules();
    render(<View period={{ mode: 'all' }} />);
    await waitFor(() => {
      expect(document.querySelector(`[data-ui="${UI.allocations.recurringList}"]`)).not.toBeNull();
    });
    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.showCompleted}"]`)!);

    const rowOf = (name: string) =>
      [
        ...document.querySelectorAll(`[data-ui="${UI.allocations.recurringList}"] .list__item`),
      ].find((row) => row.textContent?.includes(name))!;

    // 継続中: 切替・終了が tonal ボタン（btn--ghost ではない = 押せる面を持つ）。
    const active = rowOf('継続中ルール');
    const switchBtn = active.querySelector(`[data-ui="${UI.allocations.recurringSwitch}"]`)!;
    const endBtn = active.querySelector(`[data-ui="${UI.allocations.recurringEnd}"]`)!;
    expect(switchBtn.classList.contains('btn--tonal')).toBe(true);
    expect(endBtn.classList.contains('btn--tonal')).toBe(true);
    expect(switchBtn.classList.contains('btn--ghost')).toBe(false);
    expect(active.querySelector(`[data-ui="${UI.allocations.recurringStatus}"]`)).toBeNull();

    // 終了予定・終了済み: 操作は出さず、同じ右列に状態チップ。
    // 終了予定は「いつまで動くか」を日付で名乗る（v13.3: 終了済みとの違いが読める）。
    // 日付 = 排他的終了点 2030-01-01 の前日。
    const scheduled = rowOf('終了予定ルール');
    expect(scheduled.querySelector(`[data-ui="${UI.allocations.recurringEnd}"]`)).toBeNull();
    expect(
      scheduled.querySelector(`[data-ui="${UI.allocations.recurringStatus}"]`),
    ).toHaveTextContent('2029-12-31 まで');
    const ended = rowOf('終了済みルール');
    expect(ended.querySelector(`[data-ui="${UI.allocations.recurringStatus}"]`)).toHaveTextContent(
      '終了済み',
    );
  });

  it('持ち物カードも右列に金額を積み、ルール由来は終了ボタンの位置に由来チップを出す', async () => {
    const ledger = await loadLedger();
    const expense = ledger.accounts.find((a) => a.role === 'expense-category')!;
    const bank = ledger.accounts.find((a) => a.role === 'daily-asset')!;
    await createContinuousCost({
      name: '手で登録した持ち物',
      amount: 120_000,
      startDate: '2026-01-01',
      endDate: '2027-01-01',
      expenseAccountId: expense.id,
      creditAccountId: bank.id,
    });
    await createRecurringRule({
      name: 'ルール由来の持ち物',
      amount: 1000,
      dayOfMonth: 5,
      everyMonths: 1,
      debitAccountId: expense.id,
      creditAccountId: bank.id,
      startMonth: '2026-01',
      startDate: '2026-01-05',
    });
    render(<View period={{ mode: 'all' }} />);
    await waitFor(() => {
      expect(document.querySelector(`[data-ui="${UI.allocations.item}"]`)).not.toBeNull();
    });

    const cards = [...document.querySelectorAll(`[data-ui="${UI.allocations.item}"]`)];
    const manual = cards.find((c) => c.textContent?.includes('手で登録した持ち物'))!;
    const derived = cards.find((c) => c.textContent?.includes('ルール由来の持ち物'))!;
    for (const card of [manual, derived]) {
      const trailing = card.querySelector('.row-trailing')!;
      expect(trailing.querySelector('.list__amount')).not.toBeNull();
      expect(trailing.children.length).toBe(2);
    }
    // 手動 item は終了ボタン、ルール由来は同じ位置に由来チップ（読み取り専用の理由が読める）。
    expect(manual.querySelector(`[data-ui="${UI.allocations.archive}"]`)).not.toBeNull();
    expect(derived.querySelector(`[data-ui="${UI.allocations.archive}"]`)).toBeNull();
    expect(derived.querySelector('.row-trailing .tag')).toHaveTextContent('くり返し記帳から');
  });
});

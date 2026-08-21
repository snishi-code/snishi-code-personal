/*
 * 支出の「ローンで払う」（v13.13: 保存先はルールではなく**ローン item**）。
 *  - 押すと支払い元が「新しいローンの名前」に変わり、摘要が自動で入る。
 *  - 完済日（inclusive）は 1/3/5 年チップ（任意日も可）。回数・月々の額は完済日から導出し、
 *    合計は借入額にちょうど一致する（端数の明示は不要になった）。
 *  - 返済元は**全科目**から選べる（自由に動かせるお金に限定しない = 無差別原則）。
 *  - 保存 = 負債科目 + 借入の仕訳（loanItemId）+ ローン item（+ 持ち物）を 1 tx。ルールは作らない。
 *  - **既存ローンへ足す導線は無い**（毎回 1 本組む）。
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { ToastProvider } from '@snishi/foundation/ui/toast';
import { patchDialogIfNeeded } from '@snishi/foundation/ui/test-utils';
import { LedgerProvider } from '../src/state/store';
import { EntrySheet } from '../src/ui/screens/EntrySheet';
import { createOpenings, loadLedger } from '../src/data/repository';
import { addMonthsToDate } from '../src/domain/allocation';
import { CONTINUOUS_COST_LEDGER_ACCOUNT_ID } from '../src/domain/constants';
import { isLoanItem, loanQuickEndDate } from '../src/domain/loan';
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

const q = (name: string) => document.querySelector<HTMLElement>(`[data-ui="${name}"]`);
const qa = (name: string) => [...document.querySelectorAll<HTMLElement>(`[data-ui="${name}"]`)];

function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      <LedgerProvider>{children}</LedgerProvider>
    </ToastProvider>
  );
}

async function seed() {
  const ledger = await loadLedger();
  const cash = ledger.accounts.find((a) => a.name === '現金')!;
  await createOpenings([{ accountId: cash.id, amount: 500000000, date: '2000-01-01' }]);
  return { cash };
}

/**
 * 支出シートの 1 ページ目を埋めて「ローンで払う」を**選ぶ**（v13.7 I3: 1 ページ目は選択だけ）。
 * ローンの入力欄はまだ出ない。
 */
async function selectLoan(amountText = '1200000') {
  render(
    <Providers>
      <EntrySheet init={{ kind: 'create', mode: 'expense' }} onClose={() => undefined} />
    </Providers>,
  );
  // 科目が読み込まれる（チップが出る）まで待つ。
  const destination = await waitFor(() => {
    const chip = q(UI.journal.entry.flowDestination)?.querySelector('label.chip input');
    expect(chip).toBeInTheDocument();
    return chip!;
  });
  fireEvent.change(q(UI.journal.entry.item)!, { target: { value: '自動車' } });
  fireEvent.change(q(UI.journal.entry.amount)!, { target: { value: amountText } });
  // 使い道（費用カテゴリ）を選ぶ。
  fireEvent.click(destination);
  fireEvent.click(q(UI.journal.entry.loanArrange)!);
  await waitFor(() => expect(q(UI.journal.entry.loanSelected)).toBeInTheDocument());
}

/** 「ローンを入力する」で 2 ページ目（ローンの入力）まで進む。 */
async function openLoanMode(amountText = '1200000') {
  await selectLoan(amountText);
  fireEvent.click(q(UI.journal.entry.next)!);
  await waitFor(() => expect(q(UI.journal.entry.loanName)).toBeInTheDocument());
}

/** ピッカーの中から名前でチップを選ぶ（flow ピッカーは v13.16 で checkbox 化・役割非依存）。 */
function pick(dataUi: string, name: string) {
  const scope = within(q(dataUi)!);
  fireEvent.click(scope.queryByRole('radio', { name }) ?? scope.getByRole('checkbox', { name }));
}

describe('ローンで払う（支出シート）', () => {
  it('1 ページ目は選択だけ・2 ページ目で摘要が名前へ自動で入り、既存ローンを選ぶ導線は無い', async () => {
    await seed();
    await selectLoan();
    // 1 ページ目にローンの入力欄は無い（選んだことだけを名乗る）。
    expect(q(UI.journal.entry.loanName)).not.toBeInTheDocument();
    expect(q(UI.journal.entry.loanEndDate)).not.toBeInTheDocument();
    // 支払い元のピッカーは消える（= 既存の負債を選ぶ経路が無い）。
    expect(q(UI.journal.entry.flowSource)).not.toBeInTheDocument();
    // 保存ボタンは「ローンを入力する」へ変わる（この段では保存しない）。
    expect(q(UI.journal.entry.save)).not.toBeInTheDocument();
    expect(q(UI.journal.entry.next)).toHaveTextContent('ローンを入力する');

    fireEvent.click(q(UI.journal.entry.next)!);
    await waitFor(() => expect(q(UI.journal.entry.loanName)).toBeInTheDocument());
    expect((q(UI.journal.entry.loanName) as HTMLInputElement).value).toBe('自動車');
    // 「やめる」で選択が外れ、1 ページ目の支払い元へ戻る。
    fireEvent.click(q(UI.journal.entry.loanArrangeBack)!);
    await waitFor(() => expect(q(UI.journal.entry.flowSource)).toBeInTheDocument());
    expect(q(UI.journal.entry.save)).toBeInTheDocument();
  });

  it('1/3/5/10 年チップが完済日を入れ、回数と月々の額（合計 = 借入額ちょうど）を見せる', async () => {
    await seed();
    await openLoanMode();
    const chips = qa(UI.journal.entry.loanQuickSpan);
    expect(chips.map((c) => c.textContent)).toEqual(['1年', '3年', '5年', '10年']);

    fireEvent.click(chips[0]!);
    // 完済日 = 購入日 + 1 年（inclusive）→ 刻みはちょうど 12 回。
    expect((q(UI.journal.entry.loanEndDate) as HTMLInputElement).value).toBe(
      loanQuickEndDate(todayLocal(), 1),
    );
    // 借入額 1,200,000 を 12 回に割る（割り切れる例。合計は常に借入額と厳密一致）。
    expect(q(UI.journal.entry.loanPreview)).toHaveTextContent('100,000 円 × 12 回');
    expect(q(UI.journal.entry.loanPreview)).toHaveTextContent('合計はちょうど 1,200,000 円');

    fireEvent.click(chips[2]!);
    expect(q(UI.journal.entry.loanPreview)).toHaveTextContent('× 60 回');

    // 金額は 1 ページ目の欄。「戻る」で直しても、進むとローンの入力は残っている。
    // 割り切れない額（10,000 ÷ 60）でも端数の注意書きは出ない（合計厳密一致・v13.13）。
    fireEvent.click(q(UI.journal.entry.stepBack)!);
    await waitFor(() => expect(q(UI.journal.entry.amount)).toBeInTheDocument());
    fireEvent.change(q(UI.journal.entry.amount)!, { target: { value: '10000' } });
    fireEvent.click(q(UI.journal.entry.next)!);
    await waitFor(() => expect(q(UI.journal.entry.loanEndDate)).toBeInTheDocument());
    expect((q(UI.journal.entry.loanEndDate) as HTMLInputElement).value).toBe(
      loanQuickEndDate(todayLocal(), 5),
    );
    expect(q(UI.journal.entry.loanPreview)).toHaveTextContent('合計はちょうど 10,000 円');
  });

  it('返済元は全科目から選べる（収入カテゴリも候補に出る）', async () => {
    await seed();
    await openLoanMode();
    const from = q(UI.journal.entry.loanFrom)!;
    for (const name of ['現金', 'クレジットカード', '給与']) {
      expect(within(from).getByRole('radio', { name })).toBeInTheDocument();
    }
    // 内部集約（月割り台帳）は候補に出さない。
    expect(within(from).queryByRole('radio', { name: '月割り台帳' })).not.toBeInTheDocument();
  });

  it('保存で負債科目・借入の仕訳・ローン item が 1 tx で生まれる（ルールは作らない）', async () => {
    const { cash } = await seed();
    await openLoanMode();
    fireEvent.click(qa(UI.journal.entry.loanQuickSpan)[0]!);
    pick(UI.journal.entry.loanFrom, '現金');
    fireEvent.click(q(UI.journal.entry.save)!);

    const ledger = await waitFor(async () => {
      const next = await loadLedger();
      expect(next.monthlyCostItems).toHaveLength(1);
      return next;
    });
    expect(ledger.recurringRules).toHaveLength(0);
    const liability = ledger.accounts.find((a) => a.name === '自動車')!;
    expect(liability.role).toBe('other-liability');
    expect(liability.type).toBe('liability');

    // ローン item: 計上先 = 負債・返済元 = 現金・完済日 = 購入日 + 1 年（inclusive）。
    const loanItem = ledger.monthlyCostItems[0]!;
    expect(isLoanItem(loanItem)).toBe(true);
    expect(loanItem.expenseAccountId).toBe(liability.id);
    expect(loanItem.repaymentSourceAccountId).toBe(cash.id);
    expect(loanItem.startDate).toBe(todayLocal());
    expect(loanItem.endDate).toBe(loanQuickEndDate(todayLocal(), 1));
    expect(loanItem.amount).toBe(120000000);

    // 借入の仕訳: 借方 費用カテゴリ / 貸方 その負債・loanItemId 付き（item とミラー）。
    const purchase = ledger.journalEntries.find((e) => e.description === '自動車')!;
    expect(purchase.date).toBe(todayLocal());
    expect(purchase.metadata?.loanItemId).toBe(loanItem.id);
    expect(purchase.lines.find((l) => l.side === 'credit')!.accountId).toBe(liability.id);
    expect(purchase.lines.find((l) => l.side === 'debit')!.amount).toBe(120000000);
  });

  it('持ち物として登録すると、費用化の item とローン item が両立する（ローン → 持ち物 → 保存）', async () => {
    await seed();
    // 1 ページ目で両方を選ぶ（入力はまだしない）。
    await selectLoan();
    fireEvent.click(q(UI.journal.entry.ccToggle)!);
    await waitFor(() => expect(q(UI.journal.entry.ccSelected)).toBeInTheDocument());
    expect(q(UI.journal.entry.ccName)).not.toBeInTheDocument();

    // 2 ページ目 = ローン。次は「持ち物を入力する」になる（保存はまだ出ない）。
    fireEvent.click(q(UI.journal.entry.next)!);
    await waitFor(() => expect(q(UI.journal.entry.loanEndDate)).toBeInTheDocument());
    fireEvent.click(qa(UI.journal.entry.loanQuickSpan)[0]!);
    pick(UI.journal.entry.loanFrom, '現金');
    expect(q(UI.journal.entry.save)).not.toBeInTheDocument();
    expect(q(UI.journal.entry.next)).toHaveTextContent('持ち物を入力する');

    // 3 ページ目 = 持ち物。ここで初めて「保存」。
    fireEvent.click(q(UI.journal.entry.next)!);
    await waitFor(() => expect(q(UI.journal.entry.ccName)).toBeInTheDocument());
    expect((q(UI.journal.entry.ccName) as HTMLInputElement).value).toBe('自動車');
    pick(UI.journal.entry.ccCategory, '固定費');
    fireEvent.change(q(UI.journal.entry.ccEndDate)!, {
      target: { value: addMonthsToDate(todayLocal(), 60) },
    });
    fireEvent.click(q(UI.journal.entry.save)!);

    const ledger = await waitFor(async () => {
      const next = await loadLedger();
      expect(next.monthlyCostItems).toHaveLength(2);
      return next;
    });
    const loanItem = ledger.monthlyCostItems.find((m) => isLoanItem(m))!;
    const item = ledger.monthlyCostItems.find((m) => !isLoanItem(m))!;
    // 借入の仕訳は 1 本で、持ち物の購入とローンの借入を兼ねる（monthlyCostId + loanItemId）。
    const purchase = ledger.journalEntries.find((e) => e.metadata?.loanItemId === loanItem.id)!;
    expect(purchase.metadata?.monthlyCostId).toBe(item.id);
    // 購入の借方は月割り台帳（持ち物の規約）・貸方は新しいローン。
    expect(purchase.lines.find((l) => l.side === 'debit')!.accountId).toBe(
      CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
    );
    const liability = ledger.accounts.find((a) => a.name === '自動車')!;
    expect(purchase.lines.find((l) => l.side === 'credit')!.accountId).toBe(liability.id);
    expect(loanItem.expenseAccountId).toBe(liability.id);
    // ルールは作られない。
    expect(ledger.recurringRules).toHaveLength(0);
  });

  it('完済日 = 今日（1 か月未満の縮退）も保存できる（完済日に全額 1 本・起票ゼロ拒否の廃止）', async () => {
    await seed();
    await openLoanMode();
    fireEvent.change(q(UI.journal.entry.loanEndDate)!, {
      target: { value: todayLocal() },
    });
    // 縮退のプレビュー: 完済日に全額 1 回。
    await waitFor(() =>
      expect(q(UI.journal.entry.loanPreview)).toHaveTextContent(/完済日 .* に全額 1,200,000 円/),
    );
    pick(UI.journal.entry.loanFrom, '現金');
    fireEvent.click(q(UI.journal.entry.save)!);
    const ledger = await waitFor(async () => {
      const next = await loadLedger();
      expect(next.monthlyCostItems).toHaveLength(1);
      return next;
    });
    expect(ledger.monthlyCostItems[0]!.endDate).toBe(todayLocal());
  });

  it('購入日より前の完済日は保存せず理由を示す', async () => {
    await seed();
    await openLoanMode();
    fireEvent.change(q(UI.journal.entry.loanEndDate)!, {
      target: { value: '2000-01-01' },
    });
    pick(UI.journal.entry.loanFrom, '現金');
    fireEvent.click(q(UI.journal.entry.save)!);
    await waitFor(() =>
      expect(q(UI.journal.entry.loanPanel)).toHaveTextContent(
        '購入日以降の完済日を入れてください。',
      ),
    );
    const ledger = await loadLedger();
    expect(ledger.monthlyCostItems).toHaveLength(0);
    expect(ledger.accounts.some((a) => a.name === '自動車')).toBe(false);
  });
});

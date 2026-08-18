/*
 * 支出の「ローンで払う」（v13.6 H4）。登録導線は**持ち物の参照**:
 *  - 押すと支払い元が「新しいローンの名前」に変わり、摘要が自動で入る。
 *  - 終了日は 1/3/5 年チップ（任意日も可）。回数・月額は終了日からの導出をその場に出す。
 *  - 返済元は**全科目**から選べる（自由に動かせるお金に限定しない = 無差別原則）。
 *  - 保存 = 負債科目 + 購入の仕訳 + 返済ルール（+ 持ち物）を 1 tx。
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
import { loanFirstRepaymentDate, loanRuleEndDate } from '../src/domain/loan';
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

/** ピッカーの中から名前でチップ（radio）を選ぶ。 */
function pick(dataUi: string, name: string) {
  fireEvent.click(within(q(dataUi)!).getByRole('radio', { name }));
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

  it('1/3/5 年チップが終了日を入れ、回数と月額を導出して見せる', async () => {
    await seed();
    await openLoanMode();
    const chips = qa(UI.journal.entry.loanQuickSpan);
    expect(chips.map((c) => c.textContent)).toEqual(['1年', '3年', '5年']);

    fireEvent.click(chips[0]!);
    const first = loanFirstRepaymentDate(todayLocal());
    expect((q(UI.journal.entry.loanEndDate) as HTMLInputElement).value).toBe(
      loanRuleEndDate(first, 12),
    );
    // 借入額 1,200,000 を 12 回に割る（月額は導出。回数も終了日からの導出）。
    expect(q(UI.journal.entry.loanPreview)).toHaveTextContent('毎月 100,000 円 × 12 回');
    expect(q(UI.journal.entry.loanPreview)).toHaveTextContent('合計 1,200,000 円');
    expect(q(UI.journal.entry.loanRemainder)).not.toBeInTheDocument();

    fireEvent.click(chips[2]!);
    expect(q(UI.journal.entry.loanPreview)).toHaveTextContent('× 60 回');

    // 金額は 1 ページ目の欄。「戻る」で直しても、進むとローンの入力は残っている。
    fireEvent.click(q(UI.journal.entry.stepBack)!);
    await waitFor(() => expect(q(UI.journal.entry.amount)).toBeInTheDocument());
    fireEvent.change(q(UI.journal.entry.amount)!, { target: { value: '10000' } });
    fireEvent.click(q(UI.journal.entry.next)!);
    await waitFor(() => expect(q(UI.journal.entry.loanEndDate)).toBeInTheDocument());
    expect((q(UI.journal.entry.loanEndDate) as HTMLInputElement).value).toBe(
      loanRuleEndDate(first, 60),
    );
    // 割り切れない額では、最後に残る差額を明示する（丸めて消さない）。
    expect(q(UI.journal.entry.loanRemainder)).toBeInTheDocument();
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

  it('保存で負債科目・購入の仕訳・返済ルールが 1 tx で生まれる', async () => {
    const { cash } = await seed();
    await openLoanMode();
    fireEvent.click(qa(UI.journal.entry.loanQuickSpan)[0]!);
    pick(UI.journal.entry.loanFrom, '現金');
    fireEvent.click(q(UI.journal.entry.save)!);

    const ledger = await waitFor(async () => {
      const next = await loadLedger();
      expect(next.recurringRules).toHaveLength(1);
      return next;
    });
    const liability = ledger.accounts.find((a) => a.name === '自動車')!;
    expect(liability.role).toBe('other-liability');
    expect(liability.type).toBe('liability');

    // 購入の仕訳: 借方 費用カテゴリ / 貸方 その負債。
    const purchase = ledger.journalEntries.find((e) => e.description === '自動車')!;
    expect(purchase.date).toBe(todayLocal());
    expect(purchase.lines.find((l) => l.side === 'credit')!.accountId).toBe(liability.id);
    expect(purchase.lines.find((l) => l.side === 'debit')!.amount).toBe(120000000);

    // 返済ルール: 計上先 = 負債 / 源泉 = 返済元 / 借方 = 月割り台帳（全ルール共通の保存形）。
    const rule = ledger.recurringRules[0]!;
    expect(rule.name).toBe('自動車');
    expect(rule.spreadExpenseAccountId).toBe(liability.id);
    expect(rule.creditAccountId).toBe(cash.id);
    expect(rule.debitAccountId).toBe(CONTINUOUS_COST_LEDGER_ACCOUNT_ID);
    expect(rule.everyMonths).toBe(1);
    expect(rule.amount).toBe(10000000);
    // 存在期間は借りた日から・終了日は初回返済 + 12 ヶ月（排他）。
    expect(rule.startDate).toBe(todayLocal());
    expect(rule.endDate).toBe(loanRuleEndDate(loanFirstRepaymentDate(todayLocal()), 12));
    // 持ち物は作らない（併用したときだけ生まれる）。
    expect(ledger.monthlyCostItems).toHaveLength(0);
  });

  it('持ち物として登録すると、費用化の item と返済ルールが両立する（ローン → 持ち物 → 保存）', async () => {
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
      expect(next.monthlyCostItems).toHaveLength(1);
      return next;
    });
    const item = ledger.monthlyCostItems[0]!;
    const purchase = ledger.journalEntries.find((e) => e.metadata?.monthlyCostId === item.id)!;
    // 購入の借方は月割り台帳（持ち物の規約）・貸方は新しいローン。
    expect(purchase.lines.find((l) => l.side === 'debit')!.accountId).toBe(
      CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
    );
    const liability = ledger.accounts.find((a) => a.name === '自動車')!;
    expect(purchase.lines.find((l) => l.side === 'credit')!.accountId).toBe(liability.id);
    // 返済ルールも同じ tx でできている。
    expect(ledger.recurringRules).toHaveLength(1);
    expect(ledger.recurringRules[0]!.spreadExpenseAccountId).toBe(liability.id);
  });

  it('1 回も返済できない終了日は保存せず理由を示す（起票ゼロの不変則）', async () => {
    await seed();
    await openLoanMode();
    fireEvent.change(q(UI.journal.entry.loanEndDate)!, {
      target: { value: todayLocal() },
    });
    pick(UI.journal.entry.loanFrom, '現金');
    fireEvent.click(q(UI.journal.entry.save)!);
    await waitFor(() =>
      expect(q(UI.journal.entry.loanPanel)).toHaveTextContent(
        '1 回以上返済できる終了日を入れてください。',
      ),
    );
    const ledger = await loadLedger();
    expect(ledger.recurringRules).toHaveLength(0);
    expect(ledger.accounts.some((a) => a.name === '自動車')).toBe(false);
  });
});

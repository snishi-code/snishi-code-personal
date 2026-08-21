/*
 * 支出登録のマルチステップ（v13.7 I3・作者決定 2026-08-18）。
 *
 *  - 1 ページ目は支出そのもの。ローン・持ち物は**使うかどうかの選択だけ**（入力欄は出ない）
 *  - 選ぶと主ボタンが「ローンを入力する」→「持ち物を入力する」→ 最後だけ「保存」
 *  - 「戻る」で 1 ページ目へ戻れる。**入力は保持する**（前後しても書き直させない）
 *  - 1 ページ目の必須は 1 ページ目で止める（後のページで前のページのエラーを出さない）
 *  - どちらも選ばなければページは 1 枚 = 従来どおりその場で保存（挙動不変）
 *
 * mutation check:
 *  ① ステップ遷移で state を作り直す（入力を捨てる）と「戻る/進むで残る」の 2 本が落ちる
 *  ② onPrimary から validateBaseStep を外すと「金額が空でも進めない」が落ちる
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { ToastProvider } from '@snishi/foundation/ui/toast';
import { patchDialogIfNeeded } from '@snishi/foundation/ui/test-utils';
import { LedgerProvider } from '../src/state/store';
import { EntrySheet } from '../src/ui/screens/EntrySheet';
import { createOpenings, loadLedger } from '../src/data/repository';
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
const value = (name: string) => (q(name) as HTMLInputElement | null)?.value;
const pick = (dataUi: string, name: string) => {
  // flow ピッカーは v13.16 で checkbox（複数選択）になった。役割に依存せず名前で押す。
  const scope = within(q(dataUi)!);
  fireEvent.click(scope.queryByRole('radio', { name }) ?? scope.getByRole('checkbox', { name }));
};

async function seed() {
  const ledger = await loadLedger();
  const cash = ledger.accounts.find((a) => a.name === '現金')!;
  await createOpenings([{ accountId: cash.id, amount: 500000000, date: '2000-01-01' }]);
  return { cash };
}

/** 支出シートの 1 ページ目を開き、項目・金額・使い道を埋める（支払い元は呼び出し側）。 */
async function openExpense() {
  render(
    <ToastProvider>
      <LedgerProvider>
        <EntrySheet init={{ kind: 'create', mode: 'expense' }} onClose={() => undefined} />
      </LedgerProvider>
    </ToastProvider>,
  );
  await waitFor(() => {
    expect(q(UI.journal.entry.flowDestination)?.querySelector('label.chip input')).toBeTruthy();
  });
  fireEvent.change(q(UI.journal.entry.item)!, { target: { value: '自動車' } });
  fireEvent.change(q(UI.journal.entry.amount)!, { target: { value: '1200000' } });
  pick(UI.journal.entry.flowDestination, '固定費');
}

describe('支出登録のページ分け', () => {
  it('どちらも選ばなければ 1 枚のまま保存できる（挙動不変）', async () => {
    await seed();
    await openExpense();
    pick(UI.journal.entry.flowSource, '現金');
    // ステップ表示も「次へ」も出ない。
    expect(q(UI.journal.entry.step)).not.toBeInTheDocument();
    expect(q(UI.journal.entry.next)).not.toBeInTheDocument();
    expect(q(UI.journal.entry.stepBack)).not.toBeInTheDocument();

    fireEvent.click(q(UI.journal.entry.save)!);
    const ledger = await waitFor(async () => {
      const next = await loadLedger();
      expect(next.journalEntries.some((e) => e.description === '自動車')).toBe(true);
      return next;
    });
    // その場の 1 仕訳だけ（ルール・持ち物は生まれない）。
    expect(ledger.recurringRules).toHaveLength(0);
    expect(ledger.monthlyCostItems).toHaveLength(0);
  });

  it('1 ページ目は選択だけ・戻ると入力が残る（前後しても書き直させない）', async () => {
    await seed();
    await openExpense();
    fireEvent.click(q(UI.journal.entry.loanArrange)!);
    await waitFor(() => expect(q(UI.journal.entry.loanSelected)).toBeInTheDocument());
    // ページ数の表示が出る（1 / 2）。
    expect(q(UI.journal.entry.step)).toHaveTextContent('1 / 2');

    fireEvent.click(q(UI.journal.entry.next)!);
    await waitFor(() => expect(q(UI.journal.entry.loanEndDate)).toBeInTheDocument());
    // 2 ページ目に 1 ページ目の欄は無い（1 画面 1 決定）。
    expect(q(UI.journal.entry.step)).toHaveTextContent('2 / 2');
    expect(q(UI.journal.entry.amount)).not.toBeInTheDocument();
    expect(q(UI.journal.entry.flowDestination)).not.toBeInTheDocument();
    fireEvent.click(qa(UI.journal.entry.loanQuickSpan)[0]!);
    pick(UI.journal.entry.loanFrom, '現金');
    const endDate = value(UI.journal.entry.loanEndDate);

    // 戻る = 1 ページ目の入力はそのまま（日付・項目・金額・使い道・選択）。
    fireEvent.click(q(UI.journal.entry.stepBack)!);
    await waitFor(() => expect(q(UI.journal.entry.amount)).toBeInTheDocument());
    expect(value(UI.journal.entry.date)).toBe(todayLocal());
    expect(value(UI.journal.entry.item)).toBe('自動車');
    expect(value(UI.journal.entry.amount)).toBe('1200000');
    expect(
      within(q(UI.journal.entry.flowDestination)!).getByRole('radio', { name: '固定費' }),
    ).toBeChecked();
    expect(q(UI.journal.entry.loanSelected)).toBeInTheDocument();

    // 進み直すと 2 ページ目の入力も残っている。
    fireEvent.click(q(UI.journal.entry.next)!);
    await waitFor(() => expect(q(UI.journal.entry.loanEndDate)).toBeInTheDocument());
    expect(value(UI.journal.entry.loanEndDate)).toBe(endDate);
    expect(value(UI.journal.entry.loanName)).toBe('自動車');
    expect(
      within(q(UI.journal.entry.loanFrom)!).getByRole('radio', { name: '現金' }),
    ).toBeChecked();
  });

  it('1 ページ目の必須は 1 ページ目で止める（金額が空なら進めない）', async () => {
    await seed();
    await openExpense();
    fireEvent.change(q(UI.journal.entry.amount)!, { target: { value: '' } });
    fireEvent.click(q(UI.journal.entry.loanArrange)!);
    await waitFor(() => expect(q(UI.journal.entry.loanSelected)).toBeInTheDocument());

    fireEvent.click(q(UI.journal.entry.next)!);
    // 進まない。エラーは欄が見えているこのページに出る。
    expect(q(UI.journal.entry.loanEndDate)).not.toBeInTheDocument();
    expect(q(UI.journal.entry.amount)).toBeInTheDocument();
    expect(document.body.textContent).toContain('金額');

    fireEvent.change(q(UI.journal.entry.amount)!, { target: { value: '1200000' } });
    fireEvent.click(q(UI.journal.entry.next)!);
    await waitFor(() => expect(q(UI.journal.entry.loanEndDate)).toBeInTheDocument());
  });

  it('両方選ぶと ローン → 持ち物 → 保存 の順にページが足される', async () => {
    await seed();
    await openExpense();
    pick(UI.journal.entry.flowSource, '現金');
    fireEvent.click(q(UI.journal.entry.loanArrange)!);
    await waitFor(() => expect(q(UI.journal.entry.loanSelected)).toBeInTheDocument());
    fireEvent.click(q(UI.journal.entry.ccToggle)!);
    await waitFor(() => expect(q(UI.journal.entry.ccSelected)).toBeInTheDocument());

    expect(q(UI.journal.entry.step)).toHaveTextContent('1 / 3');
    expect(q(UI.journal.entry.next)).toHaveTextContent('ローンを入力する');
    fireEvent.click(q(UI.journal.entry.next)!);
    await waitFor(() => expect(q(UI.journal.entry.loanEndDate)).toBeInTheDocument());
    expect(q(UI.journal.entry.next)).toHaveTextContent('持ち物を入力する');

    fireEvent.click(qa(UI.journal.entry.loanQuickSpan)[0]!);
    pick(UI.journal.entry.loanFrom, '現金');
    fireEvent.click(q(UI.journal.entry.next)!);
    await waitFor(() => expect(q(UI.journal.entry.ccCategory)).toBeInTheDocument());
    // 最後のページだけが「保存」（手前で保存ボタンは出ない）。
    expect(q(UI.journal.entry.step)).toHaveTextContent('3 / 3');
    expect(q(UI.journal.entry.next)).not.toBeInTheDocument();
    expect(q(UI.journal.entry.save)).toBeInTheDocument();

    pick(UI.journal.entry.ccCategory, '固定費');
    fireEvent.click(q(UI.journal.entry.save)!);
    // v13.13: ローン item + 持ち物 item の 2 枚（ルールは作らない）。
    const ledger = await waitFor(async () => {
      const next = await loadLedger();
      expect(next.monthlyCostItems).toHaveLength(2);
      return next;
    });
    expect(ledger.recurringRules).toHaveLength(0);
    expect(ledger.monthlyCostItems.map((m) => m.name)).toContain('自動車');
  });
});

/*
 * 持ち物ページの解剖（v13.15 §2.2）: ローンページと同一骨格 —
 * 名前 → 計上先（base の使い道から自動）→ 終了日 + [1/3/5/10 年] チップ → 下部まとめカード。
 * チップはローンと同じ定数（LOAN_QUICK_YEARS）から出る。
 */
describe('持ち物ページの解剖（v13.15 §2.2）', () => {
  async function openItemStep() {
    await seed();
    await openExpense();
    pick(UI.journal.entry.flowSource, '現金');
    fireEvent.click(q(UI.journal.entry.ccToggle)!);
    await waitFor(() => expect(q(UI.journal.entry.ccSelected)).toBeInTheDocument());
    fireEvent.click(q(UI.journal.entry.next)!);
    await waitFor(() => expect(q(UI.journal.entry.ccCategory)).toBeInTheDocument());
  }

  it('計上先は base の使い道から自動で入り、チップは 1/3/5/10 年（ローンと同じ定数）', async () => {
    await openItemStep();
    // 名前 → 計上先 → 終了日の順（ローンページと同一解剖）。
    expect(value(UI.journal.entry.ccName)).toBe('自動車');
    const picked = within(q(UI.journal.entry.ccCategory)!).getByRole('radio', {
      name: '固定費',
    }) as HTMLInputElement;
    expect(picked.checked).toBe(true);
    const chips = qa(UI.journal.entry.ccQuickSpan);
    expect(chips.map((c) => c.textContent)).toEqual(['1年', '3年', '5年', '10年']);
  });

  it('終了日を入れると下部まとめカード（月あたり × か月・合計一致）が出る', async () => {
    await openItemStep();
    expect(q(UI.journal.entry.ccPreview)).not.toBeInTheDocument();
    // 10 年チップ = 開始月 + 119 か月の月末（quickSpanEndDate の既存規約）→ 刻み 119 回。
    // 1,200,000 ÷ 119 の先頭刻み = 10,084 円（端数は先頭で調整）。
    fireEvent.click(qa(UI.journal.entry.ccQuickSpan)[3]!);
    expect(q(UI.journal.entry.ccPreview)).toHaveTextContent('月あたり');
    expect(q(UI.journal.entry.ccPreview)).toHaveTextContent('10,084 円 × 119 か月');
    expect(q(UI.journal.entry.ccPreview)).toHaveTextContent('合計はちょうど 1,200,000 円');
  });

  it('同日通過なしの終了日は「終了日に全額 1 本」の縮退を名乗る', async () => {
    await openItemStep();
    // 終了日 = 今日（購入日と同じ）→ 刻み 0 = 終了日に全額。
    fireEvent.change(q(UI.journal.entry.ccEndDate)!, { target: { value: todayLocal() } });
    expect(q(UI.journal.entry.ccPreview)).toHaveTextContent('全額 1,200,000 円');
  });
});

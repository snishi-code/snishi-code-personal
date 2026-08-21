/*
 * 「ルールにする」トグルと rule ページ（v13.15 §2.2・§2.3）。
 *
 *  - 全モード直交: 収入・支出・振替で出る（ローントグルは支出のみ）・簿記編集には出ない
 *  - 保存 = ルールだけ（完全導出 — 実仕訳 0 本）・写像は全モード単一規則
 *    （計上先 = base の借方 / 源泉 = base の貸方）・初回起票日 = base の日付
 *  - ルール ON で持ち物トグルが畳まれヒントが出る・OFF で復帰（§2.3）
 *  - トグル/ページ順 = ローン → 持ち物 → ルール（作者確定 2026-08-22）
 *  - 車ユース: 支出 + ローン + ルール → loan ブロック付きルール 1 本が保存される（§2.4）
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { ToastProvider } from '@snishi/foundation/ui/toast';
import { patchDialogIfNeeded } from '@snishi/foundation/ui/test-utils';
import { LedgerProvider } from '../src/state/store';
import { EntrySheet } from '../src/ui/screens/EntrySheet';
import { createOpenings, loadLedger } from '../src/data/repository';
import { CONTINUOUS_COST_LEDGER_ACCOUNT_ID } from '../src/domain/constants';
import { UI } from '../src/ui-contract';
import { _resetOverlaysForTests } from '../src/ui/overlays';
import { todayLocal } from '../src/util/time';
import type { FormMode } from '../src/ui/entryModes';
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
const pick = (dataUi: string, name: string) =>
  fireEvent.click(within(q(dataUi)!).getByRole('radio', { name }));

async function seed() {
  const ledger = await loadLedger();
  const cash = ledger.accounts.find((a) => a.name === '現金')!;
  await createOpenings([{ accountId: cash.id, amount: 500000000, date: '2000-01-01' }]);
}

async function openSheet(mode: FormMode) {
  render(
    <ToastProvider>
      <LedgerProvider>
        <EntrySheet init={{ kind: 'create', mode }} onClose={() => undefined} />
      </LedgerProvider>
    </ToastProvider>,
  );
  await waitFor(() => {
    expect(q(UI.journal.entry.flowSource)?.querySelector('label.chip input')).toBeTruthy();
  });
}

describe('「ルールにする」トグル（直交性・§2.2）', () => {
  it('収入・支出・振替の全モードで出る。ローントグルは支出のみ・順はローン → 持ち物 → ルール', async () => {
    await seed();
    for (const mode of ['income', 'transfer'] as const) {
      await openSheet(mode);
      expect(q(UI.journal.entry.ruleToggle)).toBeInTheDocument();
      expect(q(UI.journal.entry.loanArrange)).not.toBeInTheDocument();
      expect(q(UI.journal.entry.ccToggle)).not.toBeInTheDocument();
      cleanup();
      _resetOverlaysForTests();
    }
    await openSheet('expense');
    expect(q(UI.journal.entry.ruleToggle)).toBeInTheDocument();
    // 性質トグル列の順序 = ローン → 持ち物 → ルール（DOM 順で固定・作者確定 2026-08-22）。
    const toggles = [...q(UI.journal.entry.nature)!.querySelectorAll('input[data-ui]')].map((el) =>
      el.getAttribute('data-ui'),
    );
    expect(toggles).toEqual([
      UI.journal.entry.loanArrange,
      UI.journal.entry.ccToggle,
      UI.journal.entry.ruleToggle,
    ]);
  });

  it('ルール ON で持ち物トグルが畳まれヒントが出る・OFF で復帰（§2.3）', async () => {
    await seed();
    await openSheet('expense');
    expect(q(UI.journal.entry.ccToggle)).toBeInTheDocument();
    expect(q(UI.journal.entry.ccFoldedByRule)).not.toBeInTheDocument();
    fireEvent.click(q(UI.journal.entry.ruleToggle)!);
    await waitFor(() => expect(q(UI.journal.entry.ccToggle)).not.toBeInTheDocument());
    expect(q(UI.journal.entry.ccFoldedByRule)).toBeInTheDocument();
    fireEvent.click(q(UI.journal.entry.ruleToggle)!);
    await waitFor(() => expect(q(UI.journal.entry.ccToggle)).toBeInTheDocument());
    expect(q(UI.journal.entry.ccFoldedByRule)).not.toBeInTheDocument();
  });
});

describe('ルール保存（完全導出・写像は全モード単一規則）', () => {
  it('支出 + ルール: ルールだけが保存される（実仕訳 0 本）・初回起票日 = base の日付', async () => {
    await seed();
    await openSheet('expense');
    fireEvent.change(q(UI.journal.entry.item)!, { target: { value: '家賃' } });
    fireEvent.change(q(UI.journal.entry.amount)!, { target: { value: '80000' } });
    pick(UI.journal.entry.flowDestination, '固定費');
    pick(UI.journal.entry.flowSource, '現金');
    fireEvent.click(q(UI.journal.entry.ruleToggle)!);
    await waitFor(() => expect(q(UI.journal.entry.next)).toHaveTextContent('ルールを入力する'));
    fireEvent.click(q(UI.journal.entry.next)!);
    await waitFor(() => expect(q(UI.journal.entry.ruleEvery)).toBeInTheDocument());
    // 起票日は base の日付から自動・説明帯は無い（フィールド + ヒント + まとめカードだけ）。
    expect((q(UI.journal.entry.rulePostingDate) as HTMLInputElement).value).toBe(todayLocal());
    expect(q(UI.journal.entry.rulePreview)).toHaveTextContent('80,000 円');
    expect(q(UI.journal.entry.save)).toHaveTextContent('ルールを登録');

    fireEvent.click(q(UI.journal.entry.save)!);
    const ledger = await waitFor(async () => {
      const next = await loadLedger();
      expect(next.recurringRules).toHaveLength(1);
      return next;
    });
    // 実仕訳は 1 本も保存されない（完全導出）。
    expect(ledger.journalEntries.filter((e) => e.description === '家賃')).toHaveLength(0);
    const rule = ledger.recurringRules[0]!;
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const fixedCost = ledger.accounts.find((a) => a.name === '固定費')!;
    expect(rule.name).toBe('家賃');
    expect(rule.amount).toBe(8000000);
    expect(rule.everyMonths).toBe(1);
    // 写像: 計上先（spread）= base の借方・源泉 = base の貸方・保存借方 = 台帳（c 案）。
    expect(rule.spreadExpenseAccountId).toBe(fixedCost.id);
    expect(rule.creditAccountId).toBe(cash.id);
    expect(rule.debitAccountId).toBe(CONTINUOUS_COST_LEDGER_ACCOUNT_ID);
    expect(rule.startDate).toBe(todayLocal());
  });

  it('振替 × ルール: 「銀行 → 投資」の定期積立が同じ写像で保存される（直交性）', async () => {
    await seed();
    await openSheet('transfer');
    fireEvent.change(q(UI.journal.entry.amount)!, { target: { value: '33333' } });
    pick(UI.journal.entry.flowSource, '預金');
    pick(UI.journal.entry.flowDestination, '投資');
    fireEvent.click(q(UI.journal.entry.ruleToggle)!);
    fireEvent.click(q(UI.journal.entry.next)!);
    await waitFor(() => expect(q(UI.journal.entry.ruleEvery)).toBeInTheDocument());
    fireEvent.click(q(UI.journal.entry.save)!);
    const ledger = await waitFor(async () => {
      const next = await loadLedger();
      expect(next.recurringRules).toHaveLength(1);
      return next;
    });
    const rule = ledger.recurringRules[0]!;
    const bank = ledger.accounts.find((a) => a.name === '預金')!;
    const invest = ledger.accounts.find((a) => a.name === '投資')!;
    expect(rule.spreadExpenseAccountId).toBe(invest.id);
    expect(rule.creditAccountId).toBe(bank.id);
    // 振替の摘要は自動（源泉 → 行き先）。
    expect(rule.name).toBe('預金 → 投資');
    expect(ledger.journalEntries.filter((e) => e.metadata?.inputMode === 'transfer')).toHaveLength(
      0,
    );
  });

  it('車ユース: 支出 + ローン + ルール → loan ブロック付きルール 1 本（負債は新設・§2.4）', async () => {
    await seed();
    await openSheet('expense');
    fireEvent.change(q(UI.journal.entry.item)!, { target: { value: '自動車' } });
    fireEvent.change(q(UI.journal.entry.amount)!, { target: { value: '3000000' } });
    pick(UI.journal.entry.flowDestination, '固定費');
    fireEvent.click(q(UI.journal.entry.loanArrange)!);
    fireEvent.click(q(UI.journal.entry.ruleToggle)!);
    await waitFor(() => expect(q(UI.journal.entry.next)).toHaveTextContent('ローンを入力する'));
    // ページ順 = base → ローン → ルール（持ち物は畳み = 自動）。
    fireEvent.click(q(UI.journal.entry.next)!);
    await waitFor(() => expect(q(UI.journal.entry.loanEndDate)).toBeInTheDocument());
    fireEvent.click(qa(UI.journal.entry.loanQuickSpan)[3]!); // 10 年後
    pick(UI.journal.entry.loanFrom, '預金');
    expect(q(UI.journal.entry.next)).toHaveTextContent('ルールを入力する');
    fireEvent.click(q(UI.journal.entry.next)!);
    await waitFor(() => expect(q(UI.journal.entry.ruleEvery)).toBeInTheDocument());
    fireEvent.change(q(UI.journal.entry.ruleEvery)!, { target: { value: '120' } });
    // まとめカード: 毎月の返済つきの一文（= 10 年ごと の言い換えヒントも出る）。
    expect(q(UI.journal.entry.rulePreview)).toHaveTextContent('25,000 円');
    fireEvent.click(q(UI.journal.entry.save)!);
    const ledger = await waitFor(async () => {
      const next = await loadLedger();
      expect(next.recurringRules).toHaveLength(1);
      return next;
    });
    const rule = ledger.recurringRules[0]!;
    const bank = ledger.accounts.find((a) => a.name === '預金')!;
    const liability = ledger.accounts.find((a) => a.id === rule.creditAccountId)!;
    expect(liability.name).toBe('自動車');
    expect(liability.role).toBe('other-liability');
    expect(rule.everyMonths).toBe(120);
    expect(rule.loan).toEqual({ repaymentSourceAccountId: bank.id, repaymentMonths: 120 });
    // 保存されるのはルール（+ 負債科目）だけ。仕訳・item は 0 件（全て導出）。
    expect(ledger.journalEntries.filter((e) => e.description === '自動車')).toHaveLength(0);
    expect(ledger.monthlyCostItems).toHaveLength(0);
  });
});

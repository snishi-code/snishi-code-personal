/*
 * 諸口の入力 UI（v13.16）: 複数選択 → 振り分けページ → createEntries 保存。
 *
 *  - 片側のみ複数選択: 一方で 2 件以上選ぶともう一方は単一選択へロック（1 件へ戻すと解除）
 *  - 複数選択中は 持ち物/ローン/ルール の 3 トグルとも畳む（宣言的相互排他）
 *  - 振り分けページ: 最後の枠は自動計算（合計 − Σ）・負/0 はエラーで保存不可
 *  - 保存 = 通常仕訳 N 本 + 同一 groupId（mutation: per-entry 保存に差し替えると
 *    groupId が付かず落ちる）・単一選択は従来どおり 1 本 + groupId なし
 *  - 簿記編集（manual）でも諸口を登録できる（単一選択の manual は 1 枚のまま）
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
const pick = (dataUi: string, name: string) => {
  const scope = within(q(dataUi)!);
  fireEvent.click(scope.queryByRole('radio', { name }) ?? scope.getByRole('checkbox', { name }));
};

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

/** 支出 10 万・使い道 固定費・源泉 3 件（現金 → 預金 → クレジットカード の選択順）。 */
async function openThreeWaySplit() {
  await seed();
  await openSheet('expense');
  fireEvent.change(q(UI.journal.entry.item)!, { target: { value: 'スマホ' } });
  fireEvent.change(q(UI.journal.entry.amount)!, { target: { value: '100000' } });
  pick(UI.journal.entry.flowDestination, '固定費');
  pick(UI.journal.entry.flowSource, '現金');
  pick(UI.journal.entry.flowSource, '預金');
  pick(UI.journal.entry.flowSource, 'クレジットカード');
}

describe('片側ロックとトグルの畳み（§2.1）', () => {
  it('源泉で 2 件選ぶと使い道は単一ロック（ヒント表示）・1 件へ戻すと解除', async () => {
    await seed();
    await openSheet('expense');
    pick(UI.journal.entry.flowDestination, '固定費');
    pick(UI.journal.entry.flowSource, '現金');
    // 1 件までは両側とも複数選択可能（checkbox）。
    expect(
      within(q(UI.journal.entry.flowDestination)!).queryByRole('checkbox', { name: '固定費' }),
    ).toBeInTheDocument();
    pick(UI.journal.entry.flowSource, '預金');
    // 源泉 2 件 → 使い道は radio（単一）へロックされ、ヒントが出る。
    await waitFor(() =>
      expect(
        within(q(UI.journal.entry.flowDestination)!).queryByRole('radio', { name: '固定費' }),
      ).toBeInTheDocument(),
    );
    expect(q(UI.journal.entry.flowDestination)).toHaveTextContent(
      'もう一方の側で複数選択中は、こちらは 1 つだけ選べます。',
    );
    // 複数側を 1 件へ戻すとロック解除（checkbox へ復帰）。
    pick(UI.journal.entry.flowSource, '預金');
    await waitFor(() =>
      expect(
        within(q(UI.journal.entry.flowDestination)!).queryByRole('checkbox', { name: '固定費' }),
      ).toBeInTheDocument(),
    );
  });

  it('複数選択中は 持ち物/ローン/ルール の 3 トグルとも畳まれヒントが出る', async () => {
    await openThreeWaySplit();
    expect(q(UI.journal.entry.loanArrange)).not.toBeInTheDocument();
    expect(q(UI.journal.entry.ccToggle)).not.toBeInTheDocument();
    expect(q(UI.journal.entry.ruleToggle)).not.toBeInTheDocument();
    expect(q(UI.journal.entry.natureFoldedBySplit)).toBeInTheDocument();
  });
});

describe('振り分けページと保存（§2.2/§2.3）', () => {
  it('末尾の枠は自動計算・保存で N 本 + 同一 groupId・合計厳密一致', async () => {
    await openThreeWaySplit();
    expect(q(UI.journal.entry.next)).toHaveTextContent('振り分けを入力する');
    fireEvent.click(q(UI.journal.entry.next)!);
    await waitFor(() => expect(q(UI.journal.entry.splitPanel)).toBeInTheDocument());
    // 手入力枠 = 選択順の先頭 2 件（現金・預金）。末尾（クレジットカード）は自動計算の表示。
    const inputs = qa(UI.journal.entry.splitAmount);
    expect(inputs).toHaveLength(2);
    fireEvent.change(inputs[0]!, { target: { value: '30000' } });
    fireEvent.change(inputs[1]!, { target: { value: '25000' } });
    expect(q(UI.journal.entry.splitAuto)).toHaveTextContent('45,000 円');

    fireEvent.click(q(UI.journal.entry.save)!);
    const ledger = await waitFor(async () => {
      const next = await loadLedger();
      expect(next.journalEntries.filter((e) => e.description === 'スマホ')).toHaveLength(3);
      return next;
    });
    const saved = ledger.journalEntries.filter((e) => e.description === 'スマホ');
    // 同一 groupId（mutation: createEntries を per-entry 保存へ差し替えると groupId が
    // 付かなくなり、ここが落ちる）。
    const groupId = saved[0]!.groupId;
    expect(groupId).toBeDefined();
    expect(saved.every((e) => e.groupId === groupId)).toBe(true);
    // 借方 = 固定費 × 振り分け額・合計は 1 minor もずれない。
    const amounts = saved
      .map((e) => e.lines.find((l) => l.side === 'debit')?.amount ?? 0)
      .sort((a, b) => a - b);
    expect(amounts).toEqual([2500000, 3000000, 4500000]);
    expect(amounts.reduce((s, a) => s + a, 0)).toBe(10000000);
  });

  it('自動枠が 0 以下になる入力はエラー表示で保存不可', async () => {
    await openThreeWaySplit();
    fireEvent.click(q(UI.journal.entry.next)!);
    await waitFor(() => expect(q(UI.journal.entry.splitPanel)).toBeInTheDocument());
    const inputs = qa(UI.journal.entry.splitAmount);
    fireEvent.change(inputs[0]!, { target: { value: '60000' } });
    fireEvent.change(inputs[1]!, { target: { value: '40000' } });
    fireEvent.click(q(UI.journal.entry.save)!);
    await waitFor(() =>
      expect(q(UI.journal.entry.splitAuto)).toHaveTextContent('自動計算の枠が 0 以下になります'),
    );
    expect((await loadLedger()).journalEntries).toHaveLength(1); // opening のみ
  });

  it('単一選択の保存は従来どおり 1 本・groupId なし（退化と対称）', async () => {
    await seed();
    await openSheet('expense');
    fireEvent.change(q(UI.journal.entry.item)!, { target: { value: '単発' } });
    fireEvent.change(q(UI.journal.entry.amount)!, { target: { value: '500' } });
    pick(UI.journal.entry.flowDestination, '固定費');
    pick(UI.journal.entry.flowSource, '現金');
    expect(q(UI.journal.entry.next)).not.toBeInTheDocument();
    fireEvent.click(q(UI.journal.entry.save)!);
    const saved = await waitFor(async () => {
      const next = (await loadLedger()).journalEntries.find((e) => e.description === '単発');
      expect(next).toBeDefined();
      return next!;
    });
    expect(saved.groupId).toBeUndefined();
  });

  it('簿記編集（manual）でも諸口を登録できる（単一選択は 1 枚のまま）', async () => {
    await seed();
    await openSheet('manual');
    fireEvent.change(q(UI.journal.entry.description)!, { target: { value: '手動按分' } });
    fireEvent.change(q(UI.journal.entry.amount)!, { target: { value: '90' } });
    pick(UI.journal.entry.flowSource, '現金');
    // 単一選択の間はページ 1 枚のまま（従来どおり）。
    expect(q(UI.journal.entry.next)).not.toBeInTheDocument();
    pick(UI.journal.entry.flowDestination, '固定費');
    pick(UI.journal.entry.flowDestination, '変動費');
    await waitFor(() => expect(q(UI.journal.entry.next)).toHaveTextContent('振り分けを入力する'));
    fireEvent.click(q(UI.journal.entry.next)!);
    await waitFor(() => expect(q(UI.journal.entry.splitPanel)).toBeInTheDocument());
    fireEvent.change(qa(UI.journal.entry.splitAmount)[0]!, { target: { value: '40' } });
    fireEvent.click(q(UI.journal.entry.save)!);
    const saved = await waitFor(async () => {
      const rows = (await loadLedger()).journalEntries.filter((e) => e.description === '手動按分');
      expect(rows).toHaveLength(2);
      return rows;
    });
    expect(saved[0]!.groupId).toBeDefined();
    expect(saved.every((e) => e.groupId === saved[0]!.groupId)).toBe(true);
    // 借方 = 各行き先 / 貸方 = 現金 の 2 本（40 + 自動 50 = 90）。
    const amounts = saved
      .map((e) => e.lines.find((l) => l.side === 'debit')?.amount ?? 0)
      .sort((a, b) => a - b);
    expect(amounts).toEqual([4000, 5000]);
  });
});

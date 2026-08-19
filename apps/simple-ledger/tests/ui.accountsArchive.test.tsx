/*
 * 勘定科目の終了（旧アーカイブ・§6-2）:
 *  - 残高 0 なら確認だけで終了
 *  - 今日時点の残高が残る資産・負債は振替シート（ホームの振替 = EntrySheet transfer 再利用）
 *    を経由し、振替仕訳 + archived=true を 1 トランザクションで保存する
 *  - キャンセルしたら終了しない
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ToastProvider } from '@snishi/foundation/ui/toast';
import { patchDialogIfNeeded } from '@snishi/foundation/ui/test-utils';
import { LedgerProvider, useLedger } from '../src/state/store';
import { Accounts } from '../src/ui/screens/Accounts';
import { createOpenings, loadLedger, upsertAccount, upsertEntry } from '../src/data/repository';
import { accountBalance } from '../src/domain/accounting';
import { buildSimpleEntry } from '../src/domain/entry';
import { todayLocal } from '../src/util/time';
import { UI } from '../src/ui-contract';
import { _resetOverlaysForTests } from '../src/ui/overlays';
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
  return status === 'ready' ? <Accounts /> : null;
}

async function renderReady() {
  render(<View />);
  await waitFor(() => {
    expect(document.querySelector(`[data-ui="${UI.accounts.view}"]`)).toBeInTheDocument();
  });
}

describe('勘定科目の終了', () => {
  it('残高 0 の科目は確認してから終了する', async () => {
    await loadLedger();
    await renderReady();
    fireEvent.click(await screen.findByRole('button', { name: '終了: チャージ残高' }));
    // 無確認では実行しない（2026-08-15 作者合意）。確認は「今日を終了点として記録する」意味。
    const confirm = await waitFor(() => {
      const found = document.querySelector(`[data-ui="${UI.accounts.archiveConfirm}"]`);
      expect(found).toBeInTheDocument();
      return found!;
    });
    expect(confirm).toHaveTextContent('今日を終了点として記録します');
    expect((await loadLedger()).accounts.find((a) => a.name === 'チャージ残高')?.archived).toBe(
      false,
    );
    fireEvent.click(confirm.querySelector(`[data-ui="${UI.dialog.confirm}"]`)!);

    await waitFor(async () => {
      const after = await loadLedger();
      expect(after.accounts.find((a) => a.name === 'チャージ残高')?.archived).toBe(true);
    });
    // 振替シートは開かない。
    expect(document.querySelector(`[data-ui="${UI.journal.entry.save}"]`)).toBeNull();
  });

  it('残高 0 の終了確認をキャンセルすると据え置く', async () => {
    await loadLedger();
    await renderReady();
    fireEvent.click(await screen.findByRole('button', { name: '終了: チャージ残高' }));
    const confirm = await waitFor(() => {
      const found = document.querySelector(`[data-ui="${UI.accounts.archiveConfirm}"]`);
      expect(found).toBeInTheDocument();
      return found!;
    });
    fireEvent.click(confirm.querySelector(`[data-ui="${UI.dialog.cancel}"]`)!);

    expect(document.querySelector(`[data-ui="${UI.accounts.archiveConfirm}"]`)).toBeNull();
    const after = await loadLedger();
    expect(after.accounts.find((a) => a.name === 'チャージ残高')?.archived).toBe(false);
    expect(after.accounts.find((a) => a.name === 'チャージ残高')?.endDate).toBeUndefined();
  });

  it('終了の解除も確認を挟み、確定で終了点を消す', async () => {
    const ledger = await loadLedger();
    const charge = ledger.accounts.find((a) => a.name === 'チャージ残高')!;
    await upsertAccount({ ...charge, archived: true, endDate: todayLocal() });

    await renderReady();
    fireEvent.click(screen.getByRole('checkbox', { name: 'この断面に存在しない科目も表示' }));
    fireEvent.click(await screen.findByRole('button', { name: '終了を解除: チャージ残高' }));
    const confirm = await waitFor(() => {
      const found = document.querySelector(`[data-ui="${UI.accounts.unarchiveConfirm}"]`);
      expect(found).toBeInTheDocument();
      return found!;
    });
    expect((await loadLedger()).accounts.find((a) => a.id === charge.id)?.archived).toBe(true);
    fireEvent.click(confirm.querySelector(`[data-ui="${UI.dialog.confirm}"]`)!);

    await waitFor(async () => {
      const after = (await loadLedger()).accounts.find((a) => a.id === charge.id)!;
      expect(after.archived).toBe(false);
      expect(after.endDate).toBeUndefined();
    });
  });

  it('残高が残る資産は振替シートを経由し、振替 + 終了が 1 回で終わる', async () => {
    const ledger = await loadLedger();
    const charge = ledger.accounts.find((a) => a.name === 'チャージ残高')!;
    await createOpenings([{ accountId: charge.id, amount: 500000, date: '2020-01-01' }]);

    await renderReady();
    fireEvent.click(await screen.findByRole('button', { name: '終了: チャージ残高' }));

    // ホームの振替と同じシート。金額の既定 = |残高|・振替元 = 対象科目（固定・ピッカー無し）。
    const amountInput = await waitFor(() => {
      const found = document.querySelector(
        `[data-ui="${UI.journal.entry.amount}"]`,
      ) as HTMLInputElement | null;
      expect(found).toBeInTheDocument();
      return found!;
    });
    expect(amountInput.value).toBe('5000');
    expect(
      document.querySelector(`[data-ui="${UI.journal.entry.flowSource}"]`),
    ).not.toBeInTheDocument();
    // 資産・負債は残高 0 必須（fail-closed）。「振替せずに終了」は出さない。
    expect(
      document.querySelector(`[data-ui="${UI.journal.entry.transferSkip}"]`),
    ).not.toBeInTheDocument();
    const destination = document.querySelector(
      `[data-ui="${UI.journal.entry.flowDestination}"]`,
    ) as HTMLElement;
    // 資産の必須振替では同区分だけを候補にする。費用科目は候補にしない。
    expect(within(destination).queryByRole('radio', { name: '変動費' })).not.toBeInTheDocument();
    fireEvent.click(within(destination).getByRole('radio', { name: '現金' }));
    fireEvent.click(document.querySelector(`[data-ui="${UI.journal.entry.save}"]`)!);

    await waitFor(async () => {
      const after = await loadLedger();
      const archived = after.accounts.find((a) => a.name === 'チャージ残高');
      expect(archived?.archived).toBe(true);
      expect(accountBalance(archived!.id, 'asset', after.journalEntries)).toBe(0);
      // 振替仕訳が保存されている（借方 現金 / 貸方 チャージ残高）。
      const cash = after.accounts.find((a) => a.name === '現金')!;
      const transfer = after.journalEntries.find(
        (e) =>
          e.lines.some((l) => l.side === 'credit' && l.accountId === archived!.id) &&
          e.lines.some((l) => l.side === 'debit' && l.accountId === cash.id),
      );
      expect(transfer).toBeDefined();
    });
  });

  it('振替シートをキャンセルすると終了しない', async () => {
    const ledger = await loadLedger();
    const charge = ledger.accounts.find((a) => a.name === 'チャージ残高')!;
    await createOpenings([{ accountId: charge.id, amount: 500000, date: '2020-01-01' }]);

    await renderReady();
    fireEvent.click(await screen.findByRole('button', { name: '終了: チャージ残高' }));
    const cancel = await waitFor(() => {
      const found = document.querySelector(`[data-ui="${UI.journal.entry.cancel}"]`);
      expect(found).toBeInTheDocument();
      return found!;
    });
    fireEvent.click(cancel);

    await waitFor(async () => {
      const after = await loadLedger();
      expect(after.accounts.find((a) => a.name === 'チャージ残高')?.archived).toBe(false);
      expect(after.journalEntries.filter((e) => e.kind !== 'opening')).toHaveLength(0);
    });
  });

  it('費用カテゴリは累計を残したまま直接終了できる', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((account) => account.name === '預金')!;
    const fixed = ledger.accounts.find((account) => account.name === '固定費')!;
    const today = todayLocal();
    await upsertEntry(
      buildSimpleEntry({
        date: today,
        description: '一時費用',
        debitAccountId: fixed.id,
        creditAccountId: cash.id,
        amount: 100_000,
        kind: 'normal',
      }),
    );

    await renderReady();
    // 累計が残る費用のアーカイブは（資産と同じ）振替シートが出る。UI を分散させない統一
    // （作者決定 2026-08-14）。最上部の「振替せずに終了」で従来の直接終了になる。
    fireEvent.click(await screen.findByRole('button', { name: `終了: ${fixed.name}` }));
    const skip = await waitFor(() => {
      const el = document.querySelector(`[data-ui="${UI.journal.entry.transferSkip}"]`);
      expect(el).not.toBeNull();
      return el!;
    });
    expect(skip).toHaveTextContent('振替せずに終了');
    fireEvent.click(skip);

    await waitFor(async () => {
      const after = await loadLedger();
      const archived = after.accounts.find((account) => account.id === fixed.id)!;
      expect(archived).toMatchObject({ archived: true, endDate: today });
      expect(accountBalance(fixed.id, 'expense', after.journalEntries)).toBe(100_000); // UI 入力 1000 = 100,000 minor
    });
    // シートは閉じている。
    expect(document.querySelector(`[data-ui="${UI.journal.entry.transferSkip}"]`)).toBeNull();
    expect(document.querySelector(`[data-ui="${UI.journal.entry.save}"]`)).toBeNull();
  });

  it('費用カテゴリも同区分へ振り替えて累計0にしてから終了点を記録する', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((account) => account.name === '預金')!;
    const fixed = ledger.accounts.find((account) => account.name === '固定費')!;
    const variable = ledger.accounts.find((account) => account.name === '変動費')!;
    const today = todayLocal();
    await upsertEntry(
      buildSimpleEntry({
        date: today,
        description: '固定費の累計',
        debitAccountId: fixed.id,
        creditAccountId: cash.id,
        amount: 100_000,
        kind: 'normal',
      }),
    );

    await renderReady();
    // 独立した振替ボタンは撤去済み。アーカイブ → 振替シート、が唯一の導線。
    fireEvent.click(await screen.findByRole('button', { name: `終了: ${fixed.name}` }));
    const destination = await waitFor(() => {
      const found = document.querySelector(
        `[data-ui="${UI.journal.entry.flowDestination}"]`,
      ) as HTMLElement | null;
      expect(found).toBeInTheDocument();
      return found!;
    });
    expect(within(destination).queryByRole('radio', { name: cash.name })).not.toBeInTheDocument();
    expect(within(destination).queryByRole('radio', { name: fixed.name })).not.toBeInTheDocument();
    fireEvent.click(within(destination).getByRole('radio', { name: variable.name }));
    fireEvent.click(document.querySelector(`[data-ui="${UI.journal.entry.save}"]`)!);

    await waitFor(async () => {
      const after = await loadLedger();
      const archived = after.accounts.find((account) => account.id === fixed.id)!;
      expect(archived).toMatchObject({ archived: true, endDate: today });
      expect(accountBalance(fixed.id, 'expense', after.journalEntries)).toBe(0);
      expect(accountBalance(variable.id, 'expense', after.journalEntries)).toBe(100_000); // UI 入力 1000 = 100,000 minor
    });
  });
});

describe('勘定科目の色分けと可動性表示', () => {
  it('箱見出しにアクセントを付け、movable=false を一覧のバッジで示す', async () => {
    const ledger = await loadLedger();
    const charge = ledger.accounts.find((account) => account.name === 'チャージ残高')!;
    await upsertAccount({ ...charge, movable: false });

    await renderReady();

    const heading = document.querySelector(`[data-ui="${UI.accounts.box}.cash"]`);
    expect(heading).toHaveAttribute('style', expect.stringContaining('--account-accent'));
    expect(screen.getByText('チャージ残高')).toBeInTheDocument();
    // チップは撤去済み（「動かせない」箱の所属がその情報を表す・2026-08-14）。
    expect(document.querySelector('[data-ui="accounts.notMovableBadge"]')).toBeNull();
  });
});

/*
 * 科目の削除 UI（v13.1・動詞体系・plan 未決①の解消）:
 *  - 削除は編集シート最下部（行アクションには出さない）
 *  - 未使用なら活性 → 確認 → 削除 / 使用中は紐づき件数を添えて不活性（fail-closed の理由開示）
 */
describe('科目の削除（編集シート最下部）', () => {
  it('未使用の科目は削除ボタン → 確認で消える', async () => {
    await loadLedger();
    await renderReady();
    // チャージ残高は seed 時点で仕訳・持ち物・ルールから参照されていない。
    fireEvent.click(await screen.findByRole('button', { name: '編集: チャージ残高' }));
    const deleteBtn = await waitFor(() => {
      const found = document.querySelector<HTMLButtonElement>(`[data-ui="${UI.accounts.delete}"]`);
      expect(found).toBeInTheDocument();
      return found!;
    });
    expect(deleteBtn).toBeEnabled();
    fireEvent.click(deleteBtn);
    const confirm = await waitFor(() => {
      const found = document.querySelector(`[data-ui="${UI.accounts.deleteConfirm}"]`);
      expect(found).toBeInTheDocument();
      return found!;
    });
    expect(confirm).toHaveTextContent('取り消せません');
    fireEvent.click(confirm.querySelector(`[data-ui="${UI.dialog.confirm}"]`)!);
    await waitFor(async () => {
      expect((await loadLedger()).accounts.find((a) => a.name === 'チャージ残高')).toBeUndefined();
    });
  });

  it('使用中の科目は件数つきで不活性（終了へ誘導）', async () => {
    const ledger = await loadLedger();
    const charge = ledger.accounts.find((a) => a.name === 'チャージ残高')!;
    const expense = ledger.accounts.find((a) => a.name === '固定費')!;
    // 1 本だけ参照を作る（仕訳 1 件）。
    await upsertEntry(
      buildSimpleEntry({
        date: todayLocal(),
        description: '削除ブロック用',
        debitAccountId: expense.id,
        creditAccountId: charge.id,
        amount: 100,
        kind: 'normal',
      }),
    );
    await renderReady();
    fireEvent.click(await screen.findByRole('button', { name: '編集: チャージ残高' }));
    const deleteBtn = await waitFor(() => {
      const found = document.querySelector<HTMLButtonElement>(`[data-ui="${UI.accounts.delete}"]`);
      expect(found).toBeInTheDocument();
      return found!;
    });
    expect(deleteBtn).toBeDisabled();
    expect(
      screen.getByText(/仕訳 1 件・持ち物 0 件・くり返し記帳 0 件から参照/),
    ).toBeInTheDocument();
    expect(screen.getByText(/「終了」を使ってください/)).toBeInTheDocument();
  });
});

/*
 * 勘定科目も月割り台帳と同じ行の設計図に載せる（v13.2）:
 *  - 右列 = 上段 残高（発生額）/ 下段 操作（または状態）。行をまたいで縦に揃う
 *  - 動詞はアイコンではなく「終了 / 終了を解除」の tonal ボタン
 *  - 表示だけの残高調整科目は、操作の代わりに「自動」を同じ位置へ置く
 */
describe('勘定科目の行の設計図（v13.2）', () => {
  it('残高は右列の上段、操作は下段に入り、行の最終要素は右列になる', async () => {
    await loadLedger();
    await renderReady();
    const rows = [...document.querySelectorAll(`[data-ui="${UI.accounts.list}"] .list__item`)];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const trailing = row.lastElementChild!;
      expect(trailing.classList.contains('row-trailing')).toBe(true);
      expect(trailing.querySelector('.list__amount')).not.toBeNull();
      // 操作が無い行（残高調整科目）も空にしない。
      expect(trailing.children.length).toBe(2);
    }
  });

  it('終了はアイコンではなく tonal の文字ボタン（終了済みは「終了を解除」）', async () => {
    await loadLedger();
    await renderReady();
    const button = await screen.findByRole('button', { name: '終了: チャージ残高' });
    expect(button.classList.contains('btn--tonal')).toBe(true);
    expect(button).toHaveTextContent('終了');
    // アイコンだけのボタン（icon-btn）ではない。
    expect(button.classList.contains('icon-btn')).toBe(false);

    fireEvent.click(button);
    fireEvent.click(
      document.querySelector(
        `[data-ui="${UI.accounts.archiveConfirm}"] [data-ui="${UI.dialog.confirm}"]`,
      )!,
    );
    const unarchive = await screen.findByRole('button', { name: '終了を解除: チャージ残高' });
    expect(unarchive.classList.contains('btn--tonal')).toBe(true);
    expect(unarchive).toHaveTextContent('終了を解除');
  });
});

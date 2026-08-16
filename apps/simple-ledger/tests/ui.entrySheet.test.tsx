/*
 * EntrySheet の画面挙動。
 *  - dirty guard: 内容を変更後にキャンセルすると「破棄確認」ダイアログが出て、
 *    未変更ならそのまま onClose を呼ぶ。
 *  - 反対仕訳（取消/返金）: この仕訳への「取消済み合計 / 残り」を常時見せ、
 *    残りを超える入力には警告だけ出す（保存は止めない）。
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { EntrySheet } from '../src/ui/screens/EntrySheet';
import { LedgerProvider, useLedger } from '../src/state/store';
import { ToastProvider } from '@snishi/foundation/ui/toast';
import { patchDialogIfNeeded } from '@snishi/foundation/ui/test-utils';
import { createContinuousCost, loadLedger, upsertEntry } from '../src/data/repository';
import { UI } from '../src/ui-contract';
import { _resetOverlaysForTests } from '../src/ui/overlays';
import { todayLocal } from '../src/util/time';
import type { JournalEntry } from '../src/domain/types';
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

/** 台帳を読み終えてから中身を描く（0 件の非表示を「まだ読めていないだけ」と取り違えない）。 */
function Ready({ children }: { children: React.ReactNode }) {
  const { status } = useLedger();
  return status === 'ready' ? <>{children}</> : null;
}

const q = (name: string) => document.querySelector<HTMLElement>(`[data-ui="${name}"]`);

describe('EntrySheet — dirty guard', () => {
  it('未変更でキャンセルすると onClose が即呼ばれる', async () => {
    const onClose = vi.fn();
    render(
      <Providers>
        <EntrySheet init={{ kind: 'create', mode: 'expense' }} onClose={onClose} />
      </Providers>,
    );
    // キャンセルボタンをクリック
    await waitFor(() => {
      expect(document.querySelector(`[data-ui="${UI.journal.entry.cancel}"]`)).toBeInTheDocument();
    });
    fireEvent.click(document.querySelector(`[data-ui="${UI.journal.entry.cancel}"]`)!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('金額を変更後にキャンセルすると確認ダイアログが出る', async () => {
    const onClose = vi.fn();
    render(
      <Providers>
        <EntrySheet init={{ kind: 'create', mode: 'expense' }} onClose={onClose} />
      </Providers>,
    );
    await waitFor(() => {
      expect(document.querySelector(`[data-ui="${UI.journal.entry.amount}"]`)).toBeInTheDocument();
    });
    // 金額フィールド（data-ui が input 自体に付く）に直接 change イベント
    const amountInput = document.querySelector<HTMLInputElement>(
      `[data-ui="${UI.journal.entry.amount}"]`,
    );
    expect(amountInput).not.toBeNull();
    fireEvent.change(amountInput!, { target: { value: '1000' } });
    // React の state 更新を flush する
    await waitFor(() => {
      expect(amountInput!.value).toBe('1000');
    });
    // キャンセルクリック → dirty = true なので onClose はまだ呼ばれない
    fireEvent.click(document.querySelector(`[data-ui="${UI.journal.entry.cancel}"]`)!);
    expect(onClose).not.toHaveBeenCalled();
    // 確認ダイアログ（dirty guard）が表示されるはず
    await waitFor(() => {
      // ConfirmDialog は role=dialog の2つ目として出る
      const dialogs = screen.getAllByRole('dialog');
      expect(dialogs.length).toBeGreaterThanOrEqual(2);
    });
  });
});

/*
 * **反対仕訳シートの「取消済み合計 / 残り」**（作者合意 2026-08-15）。
 *
 * 2 回目以降の取消も初期値は「元の金額まるごと」なので、既にいくら取り消したかが
 * 画面に無いと二重取消に気づけない。超過は**警告だけ**で保存は止めない:
 * 元仕訳は後から減額編集できるため、保存境界に入れると「保存済みの取消が超過になった」
 * 状態で編集のたびに壊れる（過去編集モデルと両立しない）。過剰返金・補償も現実にはある。
 */
describe('EntrySheet — 反対仕訳の取消済み / 残り', () => {
  // 手計算の期待値: 元 300000 minor(3,000 円) − 既存の取消 100000 minor(1,000 円)
  //   → 取消済み 1,000 円 / 残り 2,000 円（表示桁は既定の 0・単位は '円'）。
  const SOURCE = 300000;
  const FIRST = 100000;

  /** 元仕訳（+ 任意で 1 件目の取消）を台帳へ入れて、元仕訳を返す。 */
  async function seedSource(withFirstReversal: boolean): Promise<JournalEntry> {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.role === 'daily-asset')!;
    const expense = ledger.accounts.find((a) => a.role === 'expense-category')!;
    const source: JournalEntry = {
      id: 'reversal-summary-source',
      date: todayLocal(),
      description: '取消される支出',
      kind: 'normal',
      lines: [
        { accountId: expense.id, side: 'debit', amount: SOURCE },
        { accountId: cash.id, side: 'credit', amount: SOURCE },
      ],
      metadata: { inputMode: 'expense' },
      createdAt: '2026-08-15T00:00:00.000Z',
      updatedAt: '2026-08-15T00:00:00.000Z',
    };
    await upsertEntry(source);
    if (withFirstReversal) {
      await upsertEntry({
        ...source,
        id: 'reversal-summary-first',
        description: '取消: 取消される支出',
        // 借方/貸方を入れ替えた 1 件目の取消（1,000 円ぶん）。
        lines: [
          { accountId: cash.id, side: 'debit', amount: FIRST },
          { accountId: expense.id, side: 'credit', amount: FIRST },
        ],
        metadata: { inputMode: 'reversal', reversalOfEntryId: source.id },
      });
    }
    return source;
  }

  function renderReversal(source: JournalEntry) {
    render(
      <Providers>
        <Ready>
          <EntrySheet init={{ kind: 'reversal', source }} onClose={() => undefined} />
        </Ready>
      </Providers>,
    );
  }

  it('2 回目の取消では取消済み合計と残りが出る', async () => {
    const source = await seedSource(true);
    renderReversal(source);

    await waitFor(() => expect(q(UI.journal.entry.reversalSummary)).toBeInTheDocument());
    expect(q(UI.journal.entry.reversalSummary)!.textContent).toBe(
      '取消済み: 1,000 円 / 残り: 2,000 円',
    );
  });

  it('取消が 0 件なら summary 行を出さない', async () => {
    const source = await seedSource(false);
    renderReversal(source);

    await waitFor(() => expect(q(UI.journal.entry.amount)).toBeInTheDocument());
    expect(q(UI.journal.entry.reversalSummary)).toBeNull();
  });

  it('残りを超える額は警告だけ出て、そのまま保存できる', async () => {
    const source = await seedSource(true);
    renderReversal(source);

    await waitFor(() => expect(q(UI.journal.entry.amount)).toBeInTheDocument());
    const amount = q(UI.journal.entry.amount) as HTMLInputElement;
    // 初期値は元の金額まるごと（3,000 円）= 残り 2,000 円を超えるので開いた時点で警告が出る。
    expect(amount.value).toBe('3000');
    await waitFor(() => expect(q(UI.journal.entry.reversalOverWarning)).toBeInTheDocument());

    // 残りちょうど（2,000 円）まで下げると消える = 条件が常時 true ではない。
    fireEvent.change(amount, { target: { value: '2000' } });
    await waitFor(() => expect(q(UI.journal.entry.reversalOverWarning)).toBeNull());

    // 残りを超える 2,500 円へ。警告は戻るが、保存ボタンは無効化されない。
    fireEvent.change(amount, { target: { value: '2500' } });
    await waitFor(() => expect(q(UI.journal.entry.reversalOverWarning)).toBeInTheDocument());
    const save = q(UI.journal.entry.save) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    // エラー扱いにしない（role=alert ではなく status = 見落とさせないだけの注意）。
    expect(q(UI.journal.entry.reversalOverWarning)!.getAttribute('role')).toBe('status');

    fireEvent.click(save);
    // 取消の合計は 1,000 + 2,500 = 3,500 円 > 元の 3,000 円。それでも仕訳は立つ。
    await waitFor(async () => {
      const saved = (await loadLedger()).journalEntries.filter(
        (e) => e.metadata?.reversalOfEntryId === source.id,
      );
      expect(saved.map((e) => e.lines[0]!.amount).sort((a, b) => a - b)).toEqual([FIRST, 250000]);
    });
  });
});

/*
 * 動詞体系（v13.1・作者確定 2026-08-16）: 削除は編集シート最下部（赤・注意文つき）+
 * 確認ダイアログの 2 段防御。仕訳一覧の行アクションからは削除を撤去した。
 */
describe('EntrySheet — 削除（編集シート最下部）', () => {
  it('通常の仕訳は削除ボタン → 確認で消え、シートが閉じる', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.role === 'daily-asset')!;
    const expense = ledger.accounts.find((a) => a.role === 'expense-category')!;
    const entry: JournalEntry = {
      id: 'delete-target-entry',
      date: todayLocal(),
      description: '消される支出',
      kind: 'normal',
      lines: [
        { accountId: expense.id, side: 'debit', amount: 1200 },
        { accountId: cash.id, side: 'credit', amount: 1200 },
      ],
      metadata: { inputMode: 'expense' },
      createdAt: '2026-08-15T00:00:00.000Z',
      updatedAt: '2026-08-15T00:00:00.000Z',
    };
    await upsertEntry(entry);
    const onClose = vi.fn();
    render(
      <Providers>
        <Ready>
          <EntrySheet init={{ kind: 'edit', entry }} onClose={onClose} />
        </Ready>
      </Providers>,
    );

    await waitFor(() => {
      expect(q(UI.journal.entry.delete)).toBeInTheDocument();
    });
    const deleteBtn = q(UI.journal.entry.delete)!;
    expect(deleteBtn).toBeEnabled();
    fireEvent.click(deleteBtn);
    // 確認ダイアログを挟む（2 段防御）。確定で削除・onClose。
    const confirm = await screen.findByRole('dialog', { name: '仕訳を削除しますか？' });
    fireEvent.click(confirm.querySelector(`[data-ui="${UI.dialog.confirm}"]`)!);
    await waitFor(async () => {
      expect((await loadLedger()).journalEntries.find((e) => e.id === entry.id)).toBeUndefined();
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('購入の仕訳（持ち物と 1:1）は削除を理由つきで不活性にする', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.role === 'daily-asset')!;
    const expense = ledger.accounts.find((a) => a.role === 'expense-category')!;
    const item = await createContinuousCost({
      name: '削除できない購入',
      amount: 50000,
      startDate: todayLocal(),
      expenseAccountId: expense.id,
      creditAccountId: cash.id,
    });
    const purchase = (await loadLedger()).journalEntries.find(
      (e) => e.metadata?.monthlyCostId === item.id && e.metadata.monthlyCostRecovery !== true,
    )!;
    render(
      <Providers>
        <Ready>
          <EntrySheet init={{ kind: 'edit', entry: purchase }} onClose={() => undefined} />
        </Ready>
      </Providers>,
    );

    await waitFor(() => {
      expect(q(UI.journal.entry.delete)).toBeInTheDocument();
    });
    const deleteBtn = q(UI.journal.entry.delete)!;
    expect(deleteBtn).toBeDisabled();
    // fail-closed の理由を見せる（持ち物側の削除に同乗する）。
    expect(
      screen.getByText(
        '購入の仕訳は削除できません。継続コスト資産の項目（毎月のもの）を削除すると一緒に消えます。',
      ),
    ).toBeInTheDocument();
  });
});

/*
 * 貼り付け一括登録の画面（v13.10・PasteImport）:
 *  - 貼り付け → 登録 → 件数の確認ダイアログ → 保存 → テキストが消えて onDone。
 *  - エラーは行番号付きで全部列挙し、1 件も保存しない。
 */
import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { ToastProvider } from '@snishi/foundation/ui/toast';
import { patchDialogIfNeeded } from '@snishi/foundation/ui/test-utils';
import { PasteImport } from '../src/ui/screens/PasteImport';
import { App } from '../src/App';
import { LedgerProvider } from '../src/state/store';
import { loadLedger } from '../src/data/repository';
import { clearOnboardingDone, markOnboardingDone } from '../src/data/localFlags';
import { _resetOverlaysForTests } from '../src/ui/overlays';
import { UI } from '../src/ui-contract';
import './setup';

beforeAll(() => {
  patchDialogIfNeeded();
});

afterEach(() => {
  cleanup();
  _resetOverlaysForTests();
});

function q(dataUi: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-ui="${dataUi}"]`);
}

async function renderPasteImport() {
  const onDone = vi.fn();
  render(
    <ToastProvider>
      <LedgerProvider>
        <PasteImport onDone={onDone} />
      </LedgerProvider>
    </ToastProvider>,
  );
  await waitFor(() => {
    expect(q('pasteImport.view')).not.toBeNull();
    // 台帳ロード前は登録が無効（科目名を解決できない）。有効化 = ready を待つ。
    expect((q('pasteImport.submit') as HTMLButtonElement).disabled).toBe(false);
  });
  return { onDone };
}

describe('貼り付け一括登録の画面', () => {
  it('貼り付け → 確認 → 一括保存 → テキストが消えて onDone', async () => {
    const { onDone } = await renderPasteImport();
    const textarea = q('pasteImport.text') as HTMLTextAreaElement;
    fireEvent.change(textarea, {
      target: {
        value: [
          '2026-08-19,ローソン,1155,クレジットカード,変動費',
          '2026-08-18,ランチ,800,現金,変動費',
        ].join('\n'),
      },
    });
    fireEvent.click(q('pasteImport.submit')!);

    // 件数を見せる確認ダイアログ（OK がここ）。
    const dialog = await waitFor(() => {
      const el = q('dialog.confirm');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(dialog.textContent).toContain('2 件');
    fireEvent.click(within(dialog).getByRole('button', { name: '登録' }));

    await waitFor(async () => {
      const ledger = await loadLedger();
      expect(ledger.journalEntries).toHaveLength(2);
    });
    await waitFor(() => {
      expect(onDone).toHaveBeenCalledTimes(1);
    });
    expect((q('pasteImport.text') as HTMLTextAreaElement).value).toBe('');
    // 借方/貸方の割当（4 列目 = 貸方・5 列目 = 借方）と金額 minor を実データで確認。
    const ledger = await loadLedger();
    const lawson = ledger.journalEntries.find((entry) => entry.description === 'ローソン')!;
    const card = ledger.accounts.find((account) => account.name === 'クレジットカード')!;
    expect(lawson.lines).toEqual([
      expect.objectContaining({ side: 'debit', amount: 115500 }),
      expect.objectContaining({ side: 'credit', amount: 115500, accountId: card.id }),
    ]);
  });

  it('エラー行があれば行番号付きで列挙し、1 件も保存しない', async () => {
    const { onDone } = await renderPasteImport();
    fireEvent.change(q('pasteImport.text') as HTMLTextAreaElement, {
      target: {
        value: ['2026-08-19,ランチ,800,現金,変動費', '2026-08-19,謎,800,現金,実在しない科目'].join(
          '\n',
        ),
      },
    });
    fireEvent.click(q('pasteImport.submit')!);

    await waitFor(() => {
      expect(q('pasteImport.errors')).not.toBeNull();
    });
    expect(q('pasteImport.errors')!.textContent).toContain('2 行目');
    expect(q('pasteImport.errors')!.textContent).toContain('実在しない科目');
    expect(q('dialog.confirm')).toBeNull();
    expect((await loadLedger()).journalEntries).toHaveLength(0);
    expect(onDone).not.toHaveBeenCalled();
  });

  it('空のまま登録すると「行なし」を出す', async () => {
    await renderPasteImport();
    fireEvent.click(q('pasteImport.submit')!);
    await waitFor(() => {
      expect(q('pasteImport.errors')).not.toBeNull();
    });
    expect(q('dialog.confirm')).toBeNull();
  });
});

describe('成功後の遷移（App 結線・v13.12 項目 2）', () => {
  it('登録成功でホーム（dashboard）へ着地する', async () => {
    markOnboardingDone();
    const backSpy = vi.spyOn(window.history, 'back').mockImplementation(() => {});
    try {
      render(
        <ToastProvider>
          <LedgerProvider>
            <App />
          </LedgerProvider>
        </ToastProvider>,
      );
      await waitFor(() => {
        expect(q(UI.dashboard.view)).not.toBeNull();
      });
      fireEvent.click(q(UI.nav.menuButton)!);
      fireEvent.click(await waitFor(() => q('nav.pasteImport')!));
      await waitFor(() => {
        expect(q('pasteImport.view')).not.toBeNull();
        expect((q('pasteImport.submit') as HTMLButtonElement).disabled).toBe(false);
      });

      fireEvent.change(q('pasteImport.text') as HTMLTextAreaElement, {
        target: { value: '2026-08-19,ランチ,800,現金,変動費' },
      });
      fireEvent.click(q('pasteImport.submit')!);
      const dialog = await waitFor(() => {
        const el = q('dialog.confirm');
        expect(el).not.toBeNull();
        return el!;
      });
      fireEvent.click(within(dialog).getByRole('button', { name: '登録' }));

      // 着地はホーム（作者決定 2026-08-20）。仕訳一覧ではない。
      await waitFor(() => {
        expect(q(UI.dashboard.view)).not.toBeNull();
      });
      expect(q('pasteImport.view')).toBeNull();
      expect(q(UI.journal.view)).toBeNull();
      expect((await loadLedger()).journalEntries).toHaveLength(1);
    } finally {
      clearOnboardingDone();
      backSpy.mockRestore();
    }
  });
});

/*
 * Settings: importErrorMessage のマッピングと、v13.9 項目 1 の導線
 * （取り込み = 空台帳のみ・全削除 = エクスポート実行済みが前提）を検証する。
 */
import { afterEach, beforeAll, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '@snishi/foundation/ui/toast';
import { patchDialogIfNeeded } from '@snishi/foundation/ui/test-utils';
import { fireEvent } from '@testing-library/react';
import './setup';
import type { ImportOutcome } from '../src/data/exportImport';
import { t } from '../src/i18n';
import { UI } from '../src/ui-contract';
import { importErrorMessage, Settings } from '../src/ui/screens/Settings';
import { LedgerProvider } from '../src/state/store';
import * as repo from '../src/data/repository';
import { buildSimpleEntry } from '../src/domain/entry';
import { _resetOverlaysForTests } from '../src/ui/overlays';

function renderSettings() {
  return render(
    <ToastProvider>
      <LedgerProvider>
        <Settings onOpenOnboarding={() => undefined} />
      </LedgerProvider>
    </ToastProvider>,
  );
}

async function seedEntry(): Promise<void> {
  const ledger = await repo.loadLedger();
  const cash = ledger.accounts.find((a) => a.name === '現金')!;
  const food = ledger.accounts.find((a) => a.name === '変動費')!;
  await repo.upsertEntry(
    buildSimpleEntry({
      date: '2026-06-01',
      description: 'ランチ',
      debitAccountId: food.id,
      creditAccountId: cash.id,
      amount: 1000,
    }),
  );
}

beforeAll(() => {
  patchDialogIfNeeded();
});

afterEach(() => {
  cleanup();
  _resetOverlaysForTests();
  vi.restoreAllMocks();
});

describe('Settings — importErrorMessage カバレッジ確認', () => {
  it('ImportOutcome の全 kind が型として定義されている', () => {
    // コンパイル時に型チェック済み。ここでは kind 一覧が存在することを確認する。
    // v13.9 項目 1: revision-conflict（強制 import の入口）は撤去した。
    const kinds: ImportOutcome['kind'][] = [
      'ok',
      'parse-error',
      'not-our-file',
      'validation-error',
      'unsupported-version',
      'storage-error',
    ];
    expect(kinds).toHaveLength(6);
  });

  it('unsupported-version は detail を持つ（reason enum は廃止）', () => {
    const outcome: Extract<ImportOutcome, { kind: 'unsupported-version' }> = {
      kind: 'unsupported-version',
      detail: 'サポートされていないバージョン: 99',
    };
    expect(outcome.detail).toBeTruthy();
    // v2 では reason enum フィールドがない
    expect('reason' in outcome).toBe(false);
  });

  it.each([
    'error.common.staleData',
    'error.common.revisionExhausted',
    'error.import.requiresEmpty',
  ] as const)(
    'storage-error の既知コード %s を利用者向け文言へ変換する',
    (detail) => {
      expect(importErrorMessage({ kind: 'storage-error', detail })).toBe(t(detail));
    },
  );

  it('storage-error の未知 detail は診断情報としてそのまま表示する', () => {
    expect(importErrorMessage({ kind: 'storage-error', detail: 'IndexedDB error' })).toBe(
      'IndexedDB error',
    );
  });
});

describe('Settings — スナップショット失敗', () => {
  it('読込失敗を空一覧扱いにせず、実際の描画で alert と案内を出す', async () => {
    // 文言ラッパの戻り値ではなく、listSnapshots の reject → Settings の描画まで通す
    //（ラッパだけの検査では「空一覧に偽装しない」という挙動を何も守れない）。
    vi.spyOn(repo, 'listSnapshots').mockRejectedValue(new Error('IDB broken'));
    render(
      <ToastProvider>
        <LedgerProvider>
          <Settings onOpenOnboarding={() => undefined} />
        </LedgerProvider>
      </ToastProvider>,
    );
    const alert = await screen.findByText(t('snapshot.loadError'));
    expect(alert).toBeInTheDocument();
    // 「スナップショットなし」の空カードに偽装していない。
    await waitFor(() => {
      expect(screen.queryByText(t('snapshot.empty'))).not.toBeInTheDocument();
    });
  });
});

describe('Settings — 取り込みは空の台帳のみ（v13.9 項目 1）', () => {
  it('空の台帳では取り込みボタンが有効で、案内は出ない', async () => {
    renderSettings();
    const button = await waitFor(() => {
      const found = document.querySelector<HTMLButtonElement>(
        `[data-ui="${UI.settings.importJson}"]`,
      );
      expect(found).toBeTruthy();
      return found!;
    });
    expect(button.disabled).toBe(false);
    expect(document.querySelector(`[data-ui="${UI.settings.importEmptyOnlyNote}"]`)).toBeNull();
  });

  it('取引データがあると取り込みは disabled になり、理由が出る', async () => {
    await seedEntry();
    renderSettings();
    await waitFor(() => {
      const button = document.querySelector<HTMLButtonElement>(
        `[data-ui="${UI.settings.importJson}"]`,
      );
      expect(button?.disabled).toBe(true);
    });
    expect(
      document.querySelector(`[data-ui="${UI.settings.importEmptyOnlyNote}"]`),
    ).toBeInTheDocument();
  });
});

describe('Settings — 全削除はエクスポート実行済みが前提（v13.9 項目 1）', () => {
  /** jsdom には createObjectURL が無い（store.exportJson が使う）。 */
  function stubObjectUrl(): void {
    URL.createObjectURL = vi.fn(() => 'blob:stub');
    URL.revokeObjectURL = vi.fn();
  }

  async function openResetDialog(): Promise<void> {
    renderSettings();
    // ledger の読み込みが終わるまで待つ（各テストは仕訳を seed 済み = 取り込み不可の案内が
    // ledger 依存で出る）。読み込み前に開くと鮮度判定が復旧経路（ledger = null）扱いになる。
    await waitFor(() => {
      expect(document.querySelector(`[data-ui="${UI.settings.importEmptyOnlyNote}"]`)).toBeTruthy();
    });
    fireEvent.click(document.querySelector<HTMLElement>(`[data-ui="${UI.settings.resetAll}"]`)!);
    await waitFor(() => {
      expect(document.querySelector(`[data-ui="${UI.settings.resetConfirm}"]`)).toBeTruthy();
    });
  }

  function deleteButton(): HTMLButtonElement {
    return document.querySelector<HTMLButtonElement>(
      `[data-ui="${UI.settings.resetConfirmDelete}"]`,
    )!;
  }

  it('エクスポート未実施ならキーワードを入れても削除は disabled + 理由表示', async () => {
    await seedEntry();
    await openResetDialog();
    fireEvent.change(document.querySelector('#reset-confirm-keyword')!, {
      target: { value: t('reset.keyword') },
    });
    expect(deleteButton().disabled).toBe(true);
    expect(
      document.querySelector(`[data-ui="${UI.settings.resetConfirmExportRequired}"]`),
    ).toBeInTheDocument();
  });

  it('ダイアログ内のエクスポートを実行すると削除できるようになり、全削除が走る', async () => {
    stubObjectUrl();
    await seedEntry();
    await openResetDialog();
    fireEvent.change(document.querySelector('#reset-confirm-keyword')!, {
      target: { value: t('reset.keyword') },
    });
    fireEvent.click(
      document.querySelector(`[data-ui="${UI.settings.resetConfirmExport}"]`)!,
    );
    await waitFor(() => {
      expect(deleteButton().disabled).toBe(false);
    });
    fireEvent.click(deleteButton());
    await waitFor(async () => {
      expect((await repo.loadLedger()).journalEntries).toHaveLength(0);
    });
  });

  it('エクスポート後にさらに変更すると、削除は再び disabled に戻る（鮮度判定）', async () => {
    stubObjectUrl();
    await seedEntry();
    await openResetDialog();
    fireEvent.click(
      document.querySelector(`[data-ui="${UI.settings.resetConfirmExport}"]`)!,
    );
    fireEvent.change(document.querySelector('#reset-confirm-keyword')!, {
      target: { value: t('reset.keyword') },
    });
    await waitFor(() => {
      expect(deleteButton().disabled).toBe(false);
    });
    // 別経路の保存で revision が進む = 最後のエクスポートより新しい変更が生まれる。
    await seedEntry().catch(() => undefined);
    await repo.updateSettings({
      ledgerName: '変更後',
      currency: '円',
      displayFractionDigits: 0,
    });
    // ダイアログを開き直すと鮮度切れで disabled。
    cleanup();
    _resetOverlaysForTests();
    await openResetDialog();
    fireEvent.change(document.querySelector('#reset-confirm-keyword')!, {
      target: { value: t('reset.keyword') },
    });
    expect(deleteButton().disabled).toBe(true);
  });
});

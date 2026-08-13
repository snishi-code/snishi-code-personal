/*
 * Settings: import revision-conflict テスト。
 * v2 の key 変更を確認: conflict 表示には importRevision を使う。
 * また storage-error の importErrorMessage マッピングを確認する。
 */
import { afterEach, beforeAll, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '@snishi/foundation/ui/toast';
import { patchDialogIfNeeded } from '@snishi/foundation/ui/test-utils';
import './setup';
import type { ImportOutcome } from '../src/data/exportImport';
import { t } from '../src/i18n';
import { importErrorMessage, Settings } from '../src/ui/screens/Settings';
import { LedgerProvider } from '../src/state/store';
import * as repo from '../src/data/repository';

beforeAll(() => {
  patchDialogIfNeeded();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Settings — importErrorMessage カバレッジ確認', () => {
  it('ImportOutcome の全 kind が型として定義されている', () => {
    // コンパイル時に型チェック済み。ここでは kind 一覧が存在することを確認する。
    const kinds: ImportOutcome['kind'][] = [
      'ok',
      'parse-error',
      'not-our-file',
      'validation-error',
      'unsupported-version',
      'revision-conflict',
      'storage-error',
    ];
    expect(kinds).toHaveLength(7);
  });

  it('revision-conflict には localRevision と importRevision がある（v2 仕様）', () => {
    const outcome: Extract<ImportOutcome, { kind: 'revision-conflict' }> = {
      kind: 'revision-conflict',
      detail: 'conflict',
      localRevision: 5,
      importRevision: 3,
    };
    expect(outcome.localRevision).toBe(5);
    expect(outcome.importRevision).toBe(3);
    // v2 では baseRevision ではなく importRevision を使う
    expect('importRevision' in outcome).toBe(true);
    expect('baseRevision' in outcome).toBe(false);
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

  it.each(['error.common.staleData', 'error.common.revisionExhausted'] as const)(
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
          <Settings onNavigate={() => undefined} onOpenOnboarding={() => undefined} />
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

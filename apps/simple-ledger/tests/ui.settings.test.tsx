/*
 * Settings: import revision-conflict テスト。
 * v2 の key 変更を確認: conflict 表示には importRevision を使う。
 * また storage-error の importErrorMessage マッピングを確認する。
 */
import { describe, it, expect } from 'vitest';
import './setup';
import type { ImportOutcome } from '../src/data/exportImport';
import { t } from '../src/i18n';
import { importErrorMessage } from '../src/ui/screens/Settings';

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

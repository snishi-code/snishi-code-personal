/*
 * Vitest セットアップ。
 *  - jest-dom マッチャ
 *  - fake-indexeddb で IndexedDB をメモリ実装に差し替え（外部送信なし・テスト隔離）
 *  - 各テスト後に DB を破棄して状態を持ち越さない
 */
import '@testing-library/jest-dom/vitest';
import 'fake-indexeddb/auto';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import { _resetConnectionForTests, DB_NAME } from '../src/data/db';

afterEach(async () => {
  cleanup();
  _resetConnectionForTests();
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
});

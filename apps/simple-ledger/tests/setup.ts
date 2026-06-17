/*
 * テスト共通セットアップ（各テストファイルが `import './setup'` で読み込む）。
 *  - fake-indexeddb / jest-dom は foundation の test-setup（vitest.config の setupFiles）が供給する。
 *  - ここでは各テスト後に DB を破棄して状態を持ち越さない（外部送信なし・テスト隔離）。
 */
import { afterEach } from 'vitest';
import { _resetConnectionForTests } from '../src/data/db';
import { DB_NAME } from '../src/data/constants';

afterEach(async () => {
  _resetConnectionForTests();
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
});

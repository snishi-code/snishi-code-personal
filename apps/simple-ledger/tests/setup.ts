/*
 * テスト共通セットアップ（各テストファイルが `import './setup'` で読み込む）。
 *  - fake-indexeddb / jest-dom は foundation の test-setup（vitest.config の setupFiles）が供給する。
 *  - ここでは各テスト後に DB を破棄して状態を持ち越さない（外部送信なし・テスト隔離）。
 */
import { afterEach } from 'vitest';
import { _resetConnectionForTests } from '../src/data/db';
import { _resetRepositoryStateForTests } from '../src/data/repository';
import { DB_NAME } from '../src/data/constants';

afterEach(async () => {
  _resetConnectionForTests();
  // revision トラッカ等のモジュール状態を破棄する（DB を消すのに合わせてテスト間で持ち越さない）。
  _resetRepositoryStateForTests();
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
});

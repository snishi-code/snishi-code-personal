/*
 * IndexedDB 接続（foundation の薄いラッパを使用）。store 作成はここだけで行う。
 *
 * v4 = Frame / Format / TemplateDef を独立 store に保存する正規化スキーマ。
 * 作者決定により upgrade では既存 store を全削除して作り直す（データ移行なし）。
 */

import { createDatabase, type DatabaseHandle } from '@snishi/foundation/storage/idb';
import {
  DB_NAME,
  DB_VERSION,
  STORE_FORMATS,
  STORE_FRAMES,
  STORE_PATIENTS,
  STORE_PLACES,
  STORE_SETTINGS,
  STORE_SNAPSHOTS,
  STORE_TEMPLATES,
} from './constants';

export const db: DatabaseHandle = createDatabase({
  name: DB_NAME,
  version: DB_VERSION,
  upgrade(idb) {
    // 旧構成を全て捨てて作り直す（データ移行なし）。
    for (const name of Array.from(idb.objectStoreNames)) {
      idb.deleteObjectStore(name);
    }
    idb.createObjectStore(STORE_SETTINGS, { keyPath: 'key' });
    idb.createObjectStore(STORE_PATIENTS, { keyPath: 'pid' });
    idb.createObjectStore(STORE_PLACES, { keyPath: 'placeId' });
    idb.createObjectStore(STORE_TEMPLATES, { keyPath: 'id' });
    idb.createObjectStore(STORE_FRAMES, { keyPath: 'id' });
    idb.createObjectStore(STORE_FORMATS, { keyPath: 'id' });
    // 予備の kv store（out-of-line key。現在は未使用）。
    idb.createObjectStore(STORE_SNAPSHOTS);
  },
});

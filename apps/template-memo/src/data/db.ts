/*
 * IndexedDB 接続（foundation の薄いラッパを使用）。store 作成はここだけで行う。
 */

import { createDatabase, type DatabaseHandle } from '@snishi/foundation/storage/idb';
import {
  DB_NAME,
  DB_VERSION,
  STORE_GROUPS,
  STORE_SETTINGS,
  STORE_SNAPSHOTS,
  STORE_SUBJECTS,
  STORE_TEMPLATES,
} from './constants';

export const db: DatabaseHandle = createDatabase({
  name: DB_NAME,
  version: DB_VERSION,
  upgrade(idb, oldVersion) {
    if (oldVersion < 1) {
      idb.createObjectStore(STORE_SETTINGS, { keyPath: 'key' });
      idb.createObjectStore(STORE_SUBJECTS, { keyPath: 'id' });
      idb.createObjectStore(STORE_GROUPS, { keyPath: 'id' });
      idb.createObjectStore(STORE_TEMPLATES, { keyPath: 'id' });
      // Undo スナップショットは out-of-line key（固定キー 1 レコードの kv 用途）。
      idb.createObjectStore(STORE_SNAPSHOTS);
    }
  },
});

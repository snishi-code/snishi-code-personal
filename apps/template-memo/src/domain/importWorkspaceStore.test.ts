/*
 * ワークスペース移行の永続化まわり（HrStore.appendImported）のリグレッションテスト。
 *
 * 一時機能なので store.test.ts には混ぜない（移行が終わったらこのファイルごと消す。
 * 削除手順の正本 = ./importWorkspace.ts 冒頭の削除手順マニフェスト）。
 * 作法は src/data/store.test.ts の「書き込み途中で失敗しても残さない」テストから借りた。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, type DatabaseHandle } from '@snishi/foundation/storage/idb';
import {
  DB_VERSION,
  STORE_FORMATS,
  STORE_FRAMES,
  STORE_PATIENTS,
  STORE_PLACES,
  STORE_SETTINGS,
  STORE_SNAPSHOTS,
  STORE_TEMPLATES,
} from '../data/constants';
import { createHrStore, type HrStore } from '../data/store';
import { convertWorkspaceBackup, type WorkspaceImportData } from './importWorkspace';

const NOW = 1_800_000_000_000;

let dbSeq = 0;

function makeTestDb(): DatabaseHandle {
  dbSeq += 1;
  return createDatabase({
    name: `template-memo-import-test-${dbSeq}`,
    version: DB_VERSION,
    upgrade(idb) {
      idb.createObjectStore(STORE_SETTINGS, { keyPath: 'key' });
      idb.createObjectStore(STORE_PATIENTS, { keyPath: 'pid' });
      idb.createObjectStore(STORE_PLACES, { keyPath: 'placeId' });
      idb.createObjectStore(STORE_TEMPLATES, { keyPath: 'id' });
      idb.createObjectStore(STORE_FRAMES, { keyPath: 'id' });
      idb.createObjectStore(STORE_FORMATS, { keyPath: 'id' });
      idb.createObjectStore(STORE_SNAPSHOTS);
    },
  });
}

/** store.test.ts と同じ理由（Node のスタブ localStorage では pointer が no-op に縮退する）。 */
function makeMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
  } as Storage;
}

beforeEach(() => {
  vi.stubGlobal('localStorage', makeMemoryStorage());
});

/** medical 側 buildWorkspaceBackup の envelope / DB schema v7 に沿う最小の合成 fixture。 */
function makeWorkspaceBackupJson(): string {
  return JSON.stringify({
    kind: 'HOSPITAL_WORKSPACE_BACKUP',
    version: 1,
    appId: 'hospital-workspace',
    createdAt: '2026-07-30T00:00:00.000Z',
    schemaVersion: 7,
    stores: {
      appSettings: [
        {
          key: 'placesConfig',
          items: [
            { placeId: 'place_1', name: '東エリア' },
            { placeId: 'place_2', name: '西エリア' },
          ],
        },
      ],
      users: [{ id: 'usr_a', name: '利用者A' }],
      patients: [
        {
          patientId: 'pt_1',
          name: '移行対象1',
          room: 'A-01',
          placeId: 'place_1',
          problems: ['継続課題'],
          createdAt: 100,
          updatedAt: 110,
        },
        {
          patientId: 'pt_2',
          name: '移行対象2',
          room: '',
          // 定義の無い place を指す = 変換後は placeId 未解決 ('')。
          placeId: 'place_gone',
          problems: [],
          createdAt: 200,
        },
      ],
      roundsUserStates: [
        {
          key: 'usr_a::pt_1',
          userId: 'usr_a',
          patientId: 'pt_1',
          standingMemo: '継続メモ',
          updatedAt: 120,
        },
      ],
    },
  });
}

function importData(): WorkspaceImportData {
  return convertWorkspaceBackup(makeWorkspaceBackupJson(), 'usr_a', { nowMs: NOW });
}

async function setup(): Promise<{ db: DatabaseHandle; store: HrStore }> {
  const db = makeTestDb();
  const store = createHrStore({ db });
  await store.initStore();
  return { db, store };
}

describe('HrStore.appendImported', () => {
  it('既存の対象・グループ・テンプレートを 1 件も変えずに追記する', async () => {
    const { db, store } = await setup();
    const existingPid = await store.createPatientInActivePlace('既存の対象');
    await store.persistActiveOrThrow();
    const before = {
      places: structuredClone(await db.getAll(STORE_PLACES)),
      patients: structuredClone(await db.getAll(STORE_PATIENTS)),
      frames: structuredClone(await db.getAll(STORE_FRAMES)),
      formats: structuredClone(await db.getAll(STORE_FORMATS)),
      templates: structuredClone(await db.getAll(STORE_TEMPLATES)),
    };
    const data = importData();

    await store.appendImported(data);

    // 既存 row は 1 件も書き換わっていない（追記されたぶんだけが増える）。
    const places = await db.getAll(STORE_PLACES);
    const patients = await db.getAll(STORE_PATIENTS);
    expect(places).toHaveLength(before.places.length + data.places.length);
    expect(patients).toHaveLength(before.patients.length + data.patients.length);
    for (const row of before.places) expect(places).toContainEqual(row);
    for (const row of before.patients) expect(patients).toContainEqual(row);
    // テンプレート系は移行対象外なので完全に不変。
    expect(await db.getAll(STORE_FRAMES)).toEqual(before.frames);
    expect(await db.getAll(STORE_FORMATS)).toEqual(before.formats);
    expect(await db.getAll(STORE_TEMPLATES)).toEqual(before.templates);
    // 既存の対象はそのまま live に残り、移行ぶんが同じビューへ現れる。
    expect(store.getAppState().patients.map((p) => p.pid)).toContain(existingPid);
    expect(store.listPlaces().map((place) => place.name)).toEqual([
      'グループ1',
      '東エリア',
      '西エリア',
    ]);
  });

  it('追記の前に現ビューの未保存分を確定させる（他の変更系 API と同じ不変条件）', async () => {
    const { db, store } = await setup();
    const pid = await store.createPatientInActivePlace('既存の対象');
    const live = store.getAppState().patients.find((p) => p.pid === pid)!;
    live.name = '編集中の名前';
    store.scheduleSave(); // debounce 中 = まだ DB へ落ちていない
    const rows = async () =>
      (await db.getAll(STORE_PATIENTS)) as Array<{ pid: string; name: string }>;
    expect((await rows()).find((p) => p.pid === pid)?.name).toBe('既存の対象');

    await store.appendImported(importData());

    expect((await rows()).find((p) => p.pid === pid)?.name).toBe('編集中の名前');
  });

  it('place 未解決の対象は先頭 place へ倒す（未所属で不可視にしない）', async () => {
    const { db, store } = await setup();
    const data = importData();
    // 変換時点では参照先が無く未解決のまま（落とさずに store 側で救う）。
    expect(data.patients.find((p) => p.name === '移行対象2')?.placeId).toBe('');
    const east = data.places[0];
    expect(east?.name).toBe('東エリア');

    await store.appendImported(data);

    const stored = store.exportData().patients;
    expect(stored.find((p) => p.name === '移行対象2')?.placeId).toBe(east?.placeId);
    expect(stored.find((p) => p.name === '移行対象1')?.placeId).toBe(east?.placeId);
    expect(stored.every((p) => p.placeId !== '')).toBe(true);
    // 永続化された row も同じ（メモリだけの救済にしない）。
    const persisted = (await db.getAll(STORE_PATIENTS)) as Array<{ name: string; placeId: string }>;
    expect(persisted.find((p) => p.name === '移行対象2')?.placeId).toBe(east?.placeId);
    // 「東エリア」へ切り替えれば 2 件とも見える。
    await store.switchPlace(east!.placeId);
    expect(store.getAppState().patients.map((p) => p.name)).toEqual(['移行対象1', '移行対象2']);
  });

  it('途中で失敗したら places も patients も残さない（1 tx・fail-closed）', async () => {
    const db = makeTestDb();
    let failImportWrite = false;
    const failingDb: DatabaseHandle = {
      ...db,
      runWrite(stores, fn) {
        return db.runWrite(stores, (tx) => {
          fn(tx);
          if (failImportWrite && stores.includes(STORE_PLACES) && stores.includes(STORE_PATIENTS)) {
            throw new Error('test: import write failed');
          }
        });
      },
    };
    const store = createHrStore({ db: failingDb });
    await store.initStore();
    const before = {
      places: structuredClone(await db.getAll(STORE_PLACES)),
      patients: structuredClone(await db.getAll(STORE_PATIENTS)),
      settings: structuredClone(await db.getAll(STORE_SETTINGS)),
    };

    failImportWrite = true;
    await expect(store.appendImported(importData())).rejects.toThrow('test: import write failed');

    expect(await db.getAll(STORE_PLACES)).toEqual(before.places);
    expect(await db.getAll(STORE_PATIENTS)).toEqual(before.patients);
    expect(await db.getAll(STORE_SETTINGS)).toEqual(before.settings);
    // 再起動しても移行ぶんは現れない。
    const reopened = createHrStore({ db });
    await reopened.initStore();
    expect(reopened.listPlaces().map((place) => place.name)).toEqual(['グループ1']);
    expect(reopened.exportData().patients).toHaveLength(0);
  });
});

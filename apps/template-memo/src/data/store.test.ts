/*
 * HrStore（workspace 回診 surface からコピーした adapter）のリグレッションテスト。
 * fake-indexeddb（foundation の test-setup が供給）で実 IndexedDB 経路ごと検証する。
 *
 * 対象: 初回 seed / 患者 CRUD / ラウンド開始クリア（固定ポリシー）/ アーカイブ・復帰 /
 * Undo（snapshot 復元）/ place（グループ）CRUD。
 * クリアと Undo は UI（HomeView.runClear / SettingsView.RestoreSection）と同じ流れを
 * store API + 純関数（applyRoundStartClear / normalizePatientArray）で辿る。
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
} from './constants';
import {
  ARCHIVE_VIEW_ID,
  createHrStore,
  formatInUseMsg,
  frameInUseMsg,
  LAST_TEMPLATE_UNDELETABLE_MSG,
  PATIENT_NOT_FOUND_MSG,
  PLACE_HAS_PATIENTS_MSG,
  PLACE_ID_REQUIRED_MSG,
  type HrStore,
} from './store';
import { countActivePatients, createHrSnapshots, REASON } from './snapshots';
import { applyRoundStartClear } from '../domain/clearPolicy';
import { normalizePatientArray } from '../domain/normalize';
import type { TemplatePresetBundle } from '../domain/presets';
import type { Patient } from '../domain/types';

// ── テスト用 DB（本番 db.ts と同じ store 構成。テストごとに一意な DB 名で分離） ──

let dbSeq = 0;

function makeTestDb(): DatabaseHandle {
  dbSeq += 1;
  return createDatabase({
    name: `template-memo-test-${dbSeq}`,
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

/** 空 DB を初回起動した store（seed 済み）を作る。 */
async function setup(): Promise<{ db: DatabaseHandle; store: HrStore }> {
  const db = makeTestDb();
  const store = createHrStore({ db });
  await store.initStore();
  return { db, store };
}

/** 再起動相当: 同じ DB を別 store インスタンスで読み直す（永続化の検証用）。 */
async function reopen(db: DatabaseHandle): Promise<HrStore> {
  const store = createHrStore({ db });
  await store.initStore();
  return store;
}

function livePatient(store: HrStore, pid: string): Patient {
  const p = store.getAppState().patients.find((x) => x.pid === pid);
  if (!p) throw new Error(`test: live patient not found: ${pid}`);
  return p;
}

function activeBundle(store: HrStore): TemplatePresetBundle {
  const template = store
    .getTemplateDefs()
    .find((candidate) => candidate.id === store.getSettings().activeTemplateId)!;
  const frame = store.getFrames().find((candidate) => candidate.id === template.frameId)!;
  const formatIds = new Set(template.placements.map((placement) => placement.formatId));
  const formats = store.getFormats().filter((format) => formatIds.has(format.id));
  return structuredClone({ frame, formats, template });
}

// この vitest 環境の global localStorage は Node のスタブ（getItem 等のメソッド無し）で、
// そのままだと PointerStore が no-op へ縮退し pointer 依存の挙動（ビュー切替の永続化）を
// 検証できない。実装付きの in-memory Storage をテストごとに差し替えて供給する
// （テスト間でポインタ tm.active_place / snapshot tombstone を持ち越さない効果も兼ねる）。
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

// ============================
// 初回 seed
// ============================

describe('initStore の初回 seed', () => {
  it('プリセット 2 種 + place『グループ1』を seed し、回診メモが active になる', async () => {
    const { store } = await setup();

    expect(store.listPlaces().map((p) => p.name)).toEqual(['グループ1']);
    expect(store.getActivePlace()?.name).toBe('グループ1');
    expect(store.isArchiveViewActive()).toBe(false);

    expect(store.getTemplateDefs().map((t) => t.name)).toEqual(['回診メモ', '日報']);
    expect(store.getFrames().map((frame) => frame.name)).toEqual(['SOAP', '日報']);
    expect(store.getFormats().map((format) => format.name)).toEqual([
      'バイタル',
      '身体所見',
      '血糖',
      '検査所見',
    ]);
    expect(store.getActiveTemplate()?.name).toBe('回診メモ');
    expect(store.getSettings().newlineMode).toBe('crlf');
    expect(store.getAppState().patients).toEqual([]);
  });

  it('initStore は memoize され、二重呼び出し・再起動でも seed が重複しない', async () => {
    const { db, store } = await setup();
    // StrictMode の二重 effect 相当（同一インスタンスの再呼び出し）。
    await store.initStore();
    // 再起動相当（settings が既にあるので seed しない）。
    const store2 = await reopen(db);

    expect(store2.listPlaces()).toHaveLength(1);
    expect(store2.getTemplateDefs()).toHaveLength(2);
    expect(await db.getAll(STORE_PLACES)).toHaveLength(1);
    expect(await db.getAll(STORE_TEMPLATES)).toHaveLength(2);
    expect(await db.getAll(STORE_FRAMES)).toHaveLength(2);
    expect(await db.getAll(STORE_FORMATS)).toHaveLength(4);
  });
});

// ============================
// フレーム / フォーマット / テンプレート定義
// ============================

describe('正規化テンプレート部品 CRUD', () => {
  it('active テンプレートは配置 ID を持つ解決済み形で返す', async () => {
    const { store } = await setup();
    const definition = store.getTemplateDefs().find((template) => template.name === '回診メモ')!;
    const resolved = store.getActiveTemplate();
    const placementIds = definition.placements.map((placement) => placement.id);
    expect(
      resolved?.sections.flatMap((section) => section.formats.map((placed) => placed.id)),
    ).toEqual(placementIds);
  });

  it('使用中のフレームとフォーマットは参照テンプレート名を示して削除拒否する', async () => {
    const { store } = await setup();
    const definition = store.getTemplateDefs().find((template) => template.name === '回診メモ')!;
    const formatId = definition.placements[0]!.formatId;

    await expect(store.deleteFrame(definition.frameId)).rejects.toThrow(
      frameInUseMsg(['回診メモ']),
    );
    await expect(store.deleteFormat(formatId)).rejects.toThrow(formatInUseMsg(['回診メモ']));
  });

  it('フレームとフォーマットの複製は子 ID も新しくし、再起動後も残る', async () => {
    const { db, store } = await setup();
    const sourceFrame = store.getFrames()[0]!;
    const sourceFormat = store.getFormats()[0]!;

    const copiedFrame = await store.duplicateFrame(sourceFrame.id);
    const copiedFormat = await store.duplicateFormat(sourceFormat.id);

    expect(copiedFrame.name).toBe(`${sourceFrame.name}のコピー`);
    expect(copiedFrame.id).not.toBe(sourceFrame.id);
    expect(copiedFrame.sections.map((section) => section.id)).not.toEqual(
      sourceFrame.sections.map((section) => section.id),
    );
    expect(copiedFormat.name).toBe(`${sourceFormat.name}のコピー`);
    expect(copiedFormat.id).not.toBe(sourceFormat.id);
    expect(copiedFormat.items.map((item) => item.id)).not.toEqual(
      sourceFormat.items.map((item) => item.id),
    );
    copiedFormat.items[0]!.label = 'コピーだけ変更';
    await store.saveFormat(copiedFormat);
    expect(
      store.getFormats().find((format) => format.id === sourceFormat.id)?.items[0]?.label,
    ).toBe(sourceFormat.items[0]?.label);

    const reopened = await reopen(db);
    expect(reopened.getFrames().some((frame) => frame.id === copiedFrame.id)).toBe(true);
    expect(reopened.getFormats().some((format) => format.id === copiedFormat.id)).toBe(true);
  });

  it('未使用部品は削除できる', async () => {
    const { store } = await setup();
    const copiedFrame = await store.duplicateFrame(store.getFrames()[0]!.id);
    const copiedFormat = await store.duplicateFormat(store.getFormats()[0]!.id);

    await store.deleteFrame(copiedFrame.id);
    await store.deleteFormat(copiedFormat.id);

    expect(store.getFrames().some((frame) => frame.id === copiedFrame.id)).toBe(false);
    expect(store.getFormats().some((format) => format.id === copiedFormat.id)).toBe(false);
  });

  it('active テンプレートの削除は残りへ付け替え、最後の 1 個は削除できない', async () => {
    const { db, store } = await setup();
    const [round, daily] = store.getTemplateDefs();
    expect(store.getSettings().activeTemplateId).toBe(round!.id);

    await store.deleteTemplateDef(round!.id);
    expect(store.getSettings().activeTemplateId).toBe(daily!.id);
    expect(store.getActiveTemplate()?.name).toBe('日報');

    await expect(store.deleteTemplateDef(daily!.id)).rejects.toThrow(LAST_TEMPLATE_UNDELETABLE_MSG);

    // 付け替えは永続化まで含めて 1 操作（再起動しても daily が active のまま）。
    const reopened = await reopen(db);
    expect(reopened.getTemplateDefs().map((template) => template.name)).toEqual(['日報']);
    expect(reopened.getActiveTemplate()?.name).toBe('日報');
  });

  it('生成一式は全 ID を再採番して 1 tx で追加し、既存行・active・対象入力を変えない', async () => {
    const { db, store } = await setup();
    const pid = await store.createPatientInActivePlace('入力中');
    livePatient(store, pid).projectedValues = { plm_existing: { itm_existing: { value: '42' } } };
    await store.persistActiveOrThrow();

    // 既存一式そのもの（既存 ID を含む）を渡し、upsert されない二重防御を検証する。
    const bundle = activeBundle(store);
    const beforeSettings = structuredClone(store.getSettings());
    const beforeFrameRows = structuredClone(await db.getAll(STORE_FRAMES));
    const beforeFormatRows = structuredClone(await db.getAll(STORE_FORMATS));
    const beforeTemplateRows = structuredClone(await db.getAll(STORE_TEMPLATES));

    await store.saveGeneratedBundle(bundle);

    for (const row of beforeFrameRows as Array<{ id: string }>) {
      expect(await db.get(STORE_FRAMES, row.id)).toEqual(row);
    }
    for (const row of beforeFormatRows as Array<{ id: string }>) {
      expect(await db.get(STORE_FORMATS, row.id)).toEqual(row);
    }
    for (const row of beforeTemplateRows as Array<{ id: string }>) {
      expect(await db.get(STORE_TEMPLATES, row.id)).toEqual(row);
    }
    expect(store.getFrames().at(-1)?.name).toBe(`${bundle.frame.name} (2)`);
    expect(store.getTemplateDefs().at(-1)?.name).toBe(`${bundle.template.name} (2)`);
    expect(
      store
        .getFormats()
        .slice(-bundle.formats.length)
        .map((format) => format.name),
    ).toEqual(bundle.formats.map((format) => `${format.name} (2)`));
    expect(store.getSettings()).toEqual(beforeSettings);
    expect(livePatient(store, pid).projectedValues).toEqual({
      plm_existing: { itm_existing: { value: '42' } },
    });

    const registered = store.getTemplateDefs().at(-1)!;
    expect(registered.id).not.toBe(bundle.template.id);
    expect(registered.frameId).not.toBe(bundle.frame.id);
    expect(registered.placements.map((placement) => placement.id)).not.toEqual(
      bundle.template.placements.map((placement) => placement.id),
    );
    expect(store.getActiveTemplate()?.id).toBe(beforeSettings.activeTemplateId);
  });

  it('生成一式の書き込み途中で失敗してもフレーム・フォーマット・テンプレートを残さない', async () => {
    const db = makeTestDb();
    let failGeneratedWrite = false;
    const failingDb: DatabaseHandle = {
      ...db,
      runWrite(stores, fn) {
        return db.runWrite(stores, (tx) => {
          fn(tx);
          if (failGeneratedWrite && stores.includes(STORE_TEMPLATES)) {
            throw new Error('test: generated write failed');
          }
        });
      },
    };
    const store = createHrStore({ db: failingDb });
    await store.initStore();
    const bundle = activeBundle(store);
    const before = {
      frames: structuredClone(await db.getAll(STORE_FRAMES)),
      formats: structuredClone(await db.getAll(STORE_FORMATS)),
      templates: structuredClone(await db.getAll(STORE_TEMPLATES)),
    };

    failGeneratedWrite = true;
    await expect(store.saveGeneratedBundle(bundle)).rejects.toThrow('test: generated write failed');

    expect(await db.getAll(STORE_FRAMES)).toEqual(before.frames);
    expect(await db.getAll(STORE_FORMATS)).toEqual(before.formats);
    expect(await db.getAll(STORE_TEMPLATES)).toEqual(before.templates);
    expect(store.getFrames()).toHaveLength(before.frames.length);
    expect(store.getFormats()).toHaveLength(before.formats.length);
    expect(store.getTemplateDefs()).toHaveLength(before.templates.length);
  });
});

// ============================
// 患者 CRUD
// ============================

describe('患者 CRUD', () => {
  it('createPatientInActivePlace は名前だけ（空名も可）で作り、active place の live に出す', async () => {
    const { db, store } = await setup();
    const pid1 = await store.createPatientInActivePlace('対象A');
    const pid2 = await store.createPatientInActivePlace(); // 空名も許容

    expect(store.getAppState().patients.map((p) => p.pid)).toEqual([pid1, pid2]);
    expect(livePatient(store, pid1).name).toBe('対象A');
    expect(livePatient(store, pid2).name).toBe('');
    expect(livePatient(store, pid1).placeId).toBe(store.getActivePlace()?.placeId);

    // IDB へ即書きされている（scheduleSave 待ちではない）。
    const row = await db.get<Patient>(STORE_PATIENTS, pid1);
    expect(row?.name).toBe('対象A');
  });

  it('live の編集は persistActiveOrThrow で永続化され、再起動後も残る', async () => {
    const { db, store } = await setup();
    const pid = await store.createPatientInActivePlace('編集前');

    const p = livePatient(store, pid);
    p.name = '編集後';
    p.room = '101';
    p.tags = ['要確認'];
    p.problems = ['問題1'];
    p.visitMemo = '今回メモ';
    p.standingMemo = '継続メモ';
    await store.persistActiveOrThrow();

    const store2 = await reopen(db);
    const q = livePatient(store2, pid);
    expect(q).toMatchObject({
      name: '編集後',
      room: '101',
      tags: ['要確認'],
      problems: ['問題1'],
      visitMemo: '今回メモ',
      standingMemo: '継続メモ',
    });
  });

  it('movePatientToPlace は place 属性だけを変え、移動先ビューに出る', async () => {
    const { db, store } = await setup();
    const pid = await store.createPatientInActivePlace('移動対象');
    const dest = await store.addPlace('グループ2');

    await store.movePatientToPlace(pid, dest.placeId);
    // 元の place ビューからは消える。
    expect(store.getAppState().patients.some((p) => p.pid === pid)).toBe(false);
    await store.switchPlace(dest.placeId);
    expect(store.getAppState().patients.map((p) => p.pid)).toEqual([pid]);

    const row = await db.get<Patient>(STORE_PATIENTS, pid);
    expect(row?.placeId).toBe(dest.placeId);
  });

  it('movePatientToPlace の不正入力は fail-closed（place 未指定 / 患者不在）', async () => {
    const { store } = await setup();
    const pid = await store.createPatientInActivePlace('対象');
    const place = store.getActivePlace()?.placeId ?? '';

    await expect(store.movePatientToPlace(pid, '')).rejects.toThrow(PLACE_ID_REQUIRED_MSG);
    await expect(store.movePatientToPlace('pat_missing', place)).rejects.toThrow(
      PATIENT_NOT_FOUND_MSG,
    );
  });

  it('deletePatientPermanently は live と IDB から消す', async () => {
    const { db, store } = await setup();
    const pid = await store.createPatientInActivePlace('削除対象');

    await store.deletePatientPermanently(pid);
    expect(store.getAppState().patients).toEqual([]);
    expect(store.listAllPatients()).toEqual([]);
    expect(await db.get(STORE_PATIENTS, pid)).toBeUndefined();
  });
});

// ============================
// ラウンド開始クリア（固定ポリシー）
// ============================

describe('ラウンド開始クリア（HomeView.runClear と同じ固定ポリシー経路）', () => {
  it('黄/緑/灰 → 白へ戻し、青は維持する', async () => {
    const { store } = await setup();
    const yellow = await store.createPatientInActivePlace('黄');
    const green = await store.createPatientInActivePlace('緑');
    const gray = await store.createPatientInActivePlace('灰');
    const blue = await store.createPatientInActivePlace('青');
    livePatient(store, yellow).status = 'yellow';
    livePatient(store, green).status = 'green';
    livePatient(store, gray).status = 'gray';
    livePatient(store, blue).status = 'blue';
    await store.persistActiveOrThrow();

    const now = Date.now();
    for (const p of store.getAppState().patients) applyRoundStartClear(p, now);
    await store.persistActiveOrThrow();

    expect(livePatient(store, yellow).status).toBe('none');
    expect(livePatient(store, green).status).toBe('none');
    expect(livePatient(store, gray).status).toBe('none');
    expect(livePatient(store, blue).status).toBe('blue');
  });

  it('今回メモ/フォーム値をクリアし、問題/継続メモ/タグは維持する（永続化まで）', async () => {
    const { db, store } = await setup();
    const pid = await store.createPatientInActivePlace('対象A');
    const p = livePatient(store, pid);
    p.status = 'green';
    p.room = '101';
    p.tags = ['要確認'];
    p.problems = ['HF', 'DM'];
    p.visitMemo = '今回の観察メモ';
    p.standingMemo = '週明けLabo';
    p.projectedValues = { grp_v: { itm_bp: { value: '120/80' } } };
    await store.persistActiveOrThrow();
    const beforeUpdatedAt = p.updatedAt;

    for (const q of store.getAppState().patients) applyRoundStartClear(q, Date.now());
    await store.persistActiveOrThrow();

    // 再起動相当で読み直しても、クリア結果が正しく永続化されている。
    const store2 = await reopen(db);
    const after = livePatient(store2, pid);
    // クリアされる: status(黄緑灰) / 今回メモ / フォーム値。
    expect(after.status).toBe('none');
    expect(after.visitMemo).toBe('');
    expect(after.projectedValues).toEqual({});
    // 維持される: 名前 / 位置 / タグ / 問題 / 継続メモ。
    expect(after.name).toBe('対象A');
    expect(after.room).toBe('101');
    expect(after.tags).toEqual(['要確認']);
    expect(after.problems).toEqual(['HF', 'DM']);
    expect(after.standingMemo).toBe('週明けLabo');
    // updatedAt は前進する（nextGroupRevision）。
    expect(after.updatedAt).toBeGreaterThan(beforeUpdatedAt);
  });
});

// ============================
// アーカイブ / 復帰
// ============================

describe('アーカイブ（ソフトデリート）と復帰', () => {
  it('archive → place ビューから消え、アーカイブビューに出て、restore で元の place へ戻る', async () => {
    const { db, store } = await setup();
    const home = store.getActivePlace()?.placeId ?? '';
    const pid = await store.createPatientInActivePlace('アーカイブ対象');

    await store.archivePatient(pid);
    expect(store.getAppState().patients).toEqual([]);
    const row = await db.get<Patient>(STORE_PATIENTS, pid);
    expect(typeof row?.archivedAt).toBe('number');

    await store.switchPlace(ARCHIVE_VIEW_ID);
    expect(store.isArchiveViewActive()).toBe(true);
    expect(store.getActivePlace()).toBeNull();
    expect(store.getAppState().patients.map((p) => p.pid)).toEqual([pid]);

    await store.restorePatient(pid);
    // アーカイブビューからは消え、元の place で現役に戻る。
    expect(store.getAppState().patients).toEqual([]);
    await store.switchPlace(home);
    expect(livePatient(store, pid).archivedAt).toBeNull();
    expect(livePatient(store, pid).placeId).toBe(home);
  });

  it('restorePatient は指定 place へも戻せる', async () => {
    const { store } = await setup();
    const pid = await store.createPatientInActivePlace('復帰先指定');
    const dest = await store.addPlace('グループ2');

    await store.archivePatient(pid);
    await store.restorePatient(pid, dest.placeId);

    await store.switchPlace(dest.placeId);
    expect(store.getAppState().patients.map((p) => p.pid)).toEqual([pid]);
  });

  it('アーカイブビューで追加した患者は先頭 place の現役として作られる', async () => {
    const { store } = await setup();
    const home = store.listPlaces()[0]!;
    await store.switchPlace(ARCHIVE_VIEW_ID);

    const pid = await store.createPatientInActivePlace('追加');
    // アーカイブビュー（アーカイブ済みのみ表示）には出ない。
    expect(store.getAppState().patients).toEqual([]);
    const master = store.listAllPatients().find((p) => p.pid === pid);
    expect(master?.placeId).toBe(home.placeId);
    expect(master?.archivedAt).toBeNull();
  });
});

// ============================
// Undo（snapshot 復元）
// ============================

describe('Undo（snapshot: クリア前へ巻き戻す）', () => {
  it('クリア前 capture → 復元で今回メモ/ステータスが戻り、restore_undo も積まれる', async () => {
    const { db, store } = await setup();
    const snapshots = createHrSnapshots(store.storage.pointers);
    const pid = await store.createPatientInActivePlace('巻き戻し対象');
    const p = livePatient(store, pid);
    p.status = 'green';
    p.visitMemo = 'クリアで消えるメモ';
    p.projectedValues = { grp_v: { itm_hr: { value: '63' } } };
    await store.persistActiveOrThrow();

    // HomeView.runClear と同じ流れ: capture → 固定ポリシー clear → fail-closed 保存。
    const scopeId = store.storage.getActiveWorkspaceId();
    const state = store.getAppState();
    await snapshots.capture(
      REASON.CLEAR,
      scopeId,
      { title: state.title, patients: state.patients },
      String(countActivePatients(state.patients)),
    );
    for (const q of state.patients) applyRoundStartClear(q, Date.now());
    await store.persistActiveOrThrow();
    expect(livePatient(store, pid).visitMemo).toBe('');

    // SettingsView.RestoreSection と同じ流れ: 復元ポイント一覧 → setAppState + fail-closed 保存。
    const points = await snapshots.list(scopeId);
    const clearPoint = points.find((pt) => pt.reason === REASON.CLEAR);
    expect(clearPoint).toBeDefined();
    expect(clearPoint?.label).toBe('1'); // capture 時の有効患者数

    const cur = store.getAppState();
    const res = await snapshots.restore(
      clearPoint!.id,
      { title: cur.title, patients: cur.patients },
      async (data) => {
        store.setAppState({
          ...store.getAppState(),
          patients: normalizePatientArray(data.patients),
        });
        await store.persistActiveOrThrow();
      },
    );
    expect(res).toEqual({ ok: true });

    // live もマスタ（再起動後）もクリア前の状態へ戻る。
    expect(livePatient(store, pid)).toMatchObject({
      status: 'green',
      visitMemo: 'クリアで消えるメモ',
      projectedValues: { grp_v: { itm_hr: { value: '63' } } },
    });
    const store2 = await reopen(db);
    expect(livePatient(store2, pid).visitMemo).toBe('クリアで消えるメモ');

    // 復元の取り消し用に restore_undo が積まれている（クリア直後の状態）。
    const after = await snapshots.list(scopeId);
    expect(after.some((pt) => pt.reason === REASON.RESTORE_UNDO)).toBe(true);
  });
});

// ============================
// place（グループ）CRUD
// ============================

describe('place（グループ）CRUD', () => {
  it('addPlace は名前を trim して追加し、再起動後も残る', async () => {
    const { db, store } = await setup();
    const added = await store.addPlace('  グループ2  ');
    expect(added.name).toBe('グループ2');
    expect(store.listPlaces().map((p) => p.name)).toEqual(['グループ1', 'グループ2']);

    // 再起動後の並びは IDB の keyPath 順（採番 id 依存）なので、集合として比較する。
    const store2 = await reopen(db);
    expect(
      store2
        .listPlaces()
        .map((p) => p.name)
        .sort(),
    ).toEqual(['グループ1', 'グループ2']);
  });

  it('renamePlace は改名し、未知の placeId は fail-closed', async () => {
    const { db, store } = await setup();
    const place = store.listPlaces()[0]!;
    await store.renamePlace(place.placeId, '改名後');
    expect(store.getActivePlace()?.name).toBe('改名後');

    const store2 = await reopen(db);
    expect(store2.listPlaces().map((p) => p.name)).toEqual(['改名後']);

    await expect(store.renamePlace('plc_missing', 'x')).rejects.toThrow(PLACE_ID_REQUIRED_MSG);
  });

  it('deletePlace は空の place だけ消せる（アーカイブ済み患者が居ても fail-closed）', async () => {
    const { db, store } = await setup();
    const dest = await store.addPlace('削除候補');

    // 現役患者が居る place は消せない。
    await store.switchPlace(dest.placeId);
    const pid = await store.createPatientInActivePlace('居住者');
    await expect(store.deletePlace(dest.placeId)).rejects.toThrow(PLACE_HAS_PATIENTS_MSG);

    // アーカイブ（ソフトデリート）しても所属は残るので、まだ消せない。
    await store.archivePatient(pid);
    await expect(store.deletePlace(dest.placeId)).rejects.toThrow(PLACE_HAS_PATIENTS_MSG);

    // 完全削除で空になれば消せる。
    await store.deletePatientPermanently(pid);
    await store.deletePlace(dest.placeId);
    expect(store.listPlaces().map((p) => p.name)).toEqual(['グループ1']);
    expect(await db.getAll(STORE_PLACES)).toHaveLength(1);

    await expect(store.deletePlace('')).rejects.toThrow(PLACE_ID_REQUIRED_MSG);
  });

  it('switchPlace は空 ID を拒否し、ビュー切替は再起動後も復元される（ポインタ永続化）', async () => {
    const { db, store } = await setup();
    await expect(store.switchPlace('')).rejects.toThrow(PLACE_ID_REQUIRED_MSG);

    const dest = await store.addPlace('グループ2');
    await store.switchPlace(dest.placeId);
    const store2 = await reopen(db);
    expect(store2.getActivePlace()?.placeId).toBe(dest.placeId);
  });
});

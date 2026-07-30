/*
 * data/store.ts の統合テスト（fake-indexeddb 上で実 IndexedDB 経路を通す）。
 *
 * fake-indexeddb は foundation/test-setup.ts（vitest.config の setupFiles）が供給する。
 * テスト間リセットは simple-ledger/tests/setup.ts の流儀を踏襲:
 * 各テスト後にメモリ状態 (_resetStoreForTests) と DB 接続 (db._resetForTests) を破棄し、
 * indexedDB.deleteDatabase でデータも消して状態を持ち越さない。
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  APP_SETTINGS_KEY,
  DB_NAME,
  STORE_GROUPS,
  STORE_SETTINGS,
  STORE_SUBJECTS,
} from './constants';
import { db } from './db';
import {
  _resetStoreForTests,
  addGroup,
  addSubject,
  appendImported,
  archiveSubject,
  clearRound,
  deleteGroup,
  deleteTag,
  deleteTemplate,
  endRound,
  getState,
  getSubject,
  hasUndoSnapshot,
  initStore,
  moveSubject,
  reorderSubject,
  replaceAll,
  saveSnippet,
  saveTag,
  startRound,
  subjectsInGroup,
  undoLastClear,
  updateSubject,
  wipeAll,
} from './store';
import type { Template } from '../domain/template';
import { STATUS, type AppSettings, type Subject } from '../domain/types';

// 決定的な時刻（Date.now に依存しない検証用）。
const T0 = 1_000;
const T1 = 2_000;
const T2 = 3_000;
const T3 = 4_000;

function deleteDb(): Promise<void> {
  return new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

afterEach(async () => {
  db._resetForTests();
  await deleteDb();
  _resetStoreForTests();
});

/** 「今回分 + 継続」を両方持つ対象を 1 件作る（ラウンド系テストの共通土台）。 */
async function seedFilledSubject(over: Partial<Subject> = {}): Promise<Subject> {
  const created = await addSubject({ name: '対象A', code: 'C-1', location: 'L-1' }, null, T0);
  await updateSubject(
    created.id,
    {
      status: STATUS.YELLOW,
      problems: ['肺炎\n抗菌薬 3日目'],
      handover: '申し送りメモ',
      sectionText: { sec1: '今回の本文' },
      formValues: { grp1: { itm1: { value: '120/80', source: 'manual' } } },
      confirmedNote: '清書済み本文',
      tagIds: ['tag_a'],
      ...over,
    },
    T0 + 1,
  );
  const sub = getSubject(created.id);
  if (!sub) throw new Error('seedFilledSubject: 作成した対象が見つからない');
  return sub;
}

// ============================
// initStore
// ============================

describe('initStore', () => {
  it('初回はプリセット 2 件を seed し、回診メモが active・settings は既定値', async () => {
    await initStore(T0);
    const s = getState();
    expect(s.ready).toBe(true);
    expect(s.templates).toHaveLength(2);
    expect(s.templates.map((t) => t.name).sort()).toEqual(['回診メモ', '日報']);
    const active = s.templates.find((t) => t.id === s.settings.activeTemplateId);
    expect(active?.name).toBe('回診メモ');
    // settings 既定値
    expect(s.settings.key).toBe('app');
    expect(s.settings.tags).toEqual([]);
    expect(s.settings.snippets).toEqual([]);
    expect(s.settings.newlineMode).toBe('crlf');
    expect(s.settings.round).toBeNull();
    expect(s.settings.onboardingDone).toBe(false);
    // durable 側にも同じ settings が保存されている
    const stored = await db.get<AppSettings>(STORE_SETTINGS, APP_SETTINGS_KEY);
    expect(stored?.activeTemplateId).toBe(s.settings.activeTemplateId);
  });

  it('2 回目の起動では再 seed しない（テンプレ id・active が不変）', async () => {
    await initStore(T0);
    const ids = getState()
      .templates.map((t) => t.id)
      .sort();
    const activeId = getState().settings.activeTemplateId;
    // 再起動を模す: メモリと接続だけ破棄（DB データは残す）
    _resetStoreForTests();
    db._resetForTests();
    await initStore(T1);
    const s = getState();
    expect(s.templates.map((t) => t.id).sort()).toEqual(ids);
    expect(s.templates).toHaveLength(2);
    expect(s.settings.activeTemplateId).toBe(activeId);
  });

  it('同一プロセス内の二重呼び出しは同じ promise を返す', async () => {
    const p1 = initStore(T0);
    const p2 = initStore(T1);
    expect(p2).toBe(p1);
    await p1;
    expect(getState().templates).toHaveLength(2);
  });
});

// ============================
// 対象 CRUD（追加・更新・移動・並び替え）
// ============================

describe('対象 CRUD', () => {
  it('addSubject はグループ内の末尾 sortOrder を採り、fields を反映して永続化する', async () => {
    await initStore(T0);
    const a = await addSubject({ name: 'A' }, null, T0);
    const b = await addSubject({ name: 'B', code: 'C-2', location: 'L-2' }, null, T0);
    expect(a.sortOrder).toBe(1);
    expect(b.sortOrder).toBe(2);
    expect(b.name).toBe('B');
    expect(b.code).toBe('C-2');
    expect(b.location).toBe('L-2');
    expect(b.status).toBe(STATUS.NONE);
    const stored = await db.get<Subject>(STORE_SUBJECTS, b.id);
    expect(stored?.name).toBe('B');
  });

  it('updateSubject は patch を適用して updatedAt を進める・未知 id は throw', async () => {
    await initStore(T0);
    const a = await addSubject({ name: 'A' }, null, T0);
    await updateSubject(a.id, { name: 'A2', handover: '継続' }, T1);
    const cur = getSubject(a.id);
    expect(cur?.name).toBe('A2');
    expect(cur?.handover).toBe('継続');
    expect(cur?.updatedAt).toBe(T1);
    expect(cur?.createdAt).toBe(T0);
    await expect(updateSubject('sub_missing', { name: 'x' })).rejects.toThrow();
  });

  it('moveSubject は移動先グループの末尾に付ける', async () => {
    await initStore(T0);
    const g = await addGroup('G1');
    await addSubject({ name: 'G1の先客' }, g.id, T0);
    const a = await addSubject({ name: '移動する' }, null, T0);
    await moveSubject(a.id, g.id);
    const moved = getSubject(a.id);
    expect(moved?.groupId).toBe(g.id);
    expect(moved?.sortOrder).toBe(2); // 先客(1) の次
    expect(subjectsInGroup(g.id).map((x) => x.name)).toEqual(['G1の先客', '移動する']);
    expect(subjectsInGroup(null)).toHaveLength(0);
  });

  it('reorderSubject は隣と sortOrder を swap し、端では no-op', async () => {
    await initStore(T0);
    const a = await addSubject({ name: 'A' }, null, T0);
    const b = await addSubject({ name: 'B' }, null, T0);
    const c = await addSubject({ name: 'C' }, null, T0);
    await reorderSubject(b.id, -1); // B を上へ = A と swap
    expect(subjectsInGroup(null).map((x) => x.name)).toEqual(['B', 'A', 'C']);
    expect(getSubject(b.id)?.sortOrder).toBe(1);
    expect(getSubject(a.id)?.sortOrder).toBe(2);
    // 端（先頭をさらに上へ / 末尾をさらに下へ）は変化しない
    await reorderSubject(b.id, -1);
    await reorderSubject(c.id, 1);
    expect(subjectsInGroup(null).map((x) => x.name)).toEqual(['B', 'A', 'C']);
  });
});

// ============================
// ラウンド（開始 / 終了 / 手動クリア / Undo）
// ============================

describe('startRound', () => {
  it('黄/緑/灰 → 白・青は維持・今回分クリア・継続は維持・round 開始・アーカイブは不変', async () => {
    await initStore(T0);
    const yellow = await seedFilledSubject({ status: STATUS.YELLOW });
    const green = await seedFilledSubject({ status: STATUS.GREEN });
    const gray = await seedFilledSubject({ status: STATUS.GRAY });
    const blue = await seedFilledSubject({ status: STATUS.BLUE });
    const archived = await seedFilledSubject({ status: STATUS.YELLOW });
    await archiveSubject(archived.id, T0 + 2);

    await startRound(T1);
    const s = getState();

    // ステータス: 黄/緑/灰 → 白、青は維持
    expect(getSubject(yellow.id)?.status).toBe(STATUS.NONE);
    expect(getSubject(green.id)?.status).toBe(STATUS.NONE);
    expect(getSubject(gray.id)?.status).toBe(STATUS.NONE);
    expect(getSubject(blue.id)?.status).toBe(STATUS.BLUE);

    // 今回分（青も含む全 active）はクリア
    for (const id of [yellow.id, green.id, gray.id, blue.id]) {
      const cur = getSubject(id);
      expect(cur?.sectionText).toEqual({});
      expect(cur?.formValues).toEqual({});
      expect(cur?.confirmedNote).toBe('');
      expect(cur?.updatedAt).toBe(T1);
      // 継続（問題・申し送り・タグ・名前系）は維持
      expect(cur?.problems).toEqual(['肺炎\n抗菌薬 3日目']);
      expect(cur?.handover).toBe('申し送りメモ');
      expect(cur?.tagIds).toEqual(['tag_a']);
      expect(cur?.name).toBe('対象A');
      expect(cur?.code).toBe('C-1');
      expect(cur?.location).toBe('L-1');
    }

    // round が開始される
    expect(s.settings.round).toEqual({ startedAt: T1, endedAt: null });

    // アーカイブ済みは一切触らない
    const arch = getSubject(archived.id);
    expect(arch?.status).toBe(STATUS.YELLOW);
    expect(arch?.sectionText).toEqual({ sec1: '今回の本文' });
    expect(arch?.confirmedNote).toBe('清書済み本文');

    // durable 側にもクリア結果が反映されている（fail-closed: IDB 先行）
    const stored = await db.get<Subject>(STORE_SUBJECTS, yellow.id);
    expect(stored?.status).toBe(STATUS.NONE);
    expect(stored?.confirmedNote).toBe('');
  });
});

describe('endRound', () => {
  it('endedAt が立ち、二重呼び出し・未開始時は無害', async () => {
    await initStore(T0);
    // 未開始（round=null）では no-op
    await endRound(T1);
    expect(getState().settings.round).toBeNull();

    await startRound(T1);
    await endRound(T2);
    expect(getState().settings.round).toEqual({ startedAt: T1, endedAt: T2 });
    // 二重呼び出しは endedAt を進めない
    await endRound(T3);
    expect(getState().settings.round).toEqual({ startedAt: T1, endedAt: T2 });
  });
});

describe('clearRound', () => {
  it('今回分だけクリアし、round 状態は変えない', async () => {
    await initStore(T0);
    await startRound(T1);
    await endRound(T2);
    const sub = await seedFilledSubject({ status: STATUS.GREEN });

    await clearRound(T3);
    const cur = getSubject(sub.id);
    expect(cur?.status).toBe(STATUS.NONE);
    expect(cur?.sectionText).toEqual({});
    expect(cur?.formValues).toEqual({});
    expect(cur?.confirmedNote).toBe('');
    expect(cur?.handover).toBe('申し送りメモ');
    // round は開始/終了時のまま
    expect(getState().settings.round).toEqual({ startedAt: T1, endedAt: T2 });
  });
});

describe('undoLastClear', () => {
  it('subjects と round が開始前へ戻り、スナップショットは消費される（2 回目は false）', async () => {
    await initStore(T0);
    await seedFilledSubject({ status: STATUS.YELLOW });
    await seedFilledSubject({ status: STATUS.BLUE });
    const before = getState().subjects;
    expect(getState().settings.round).toBeNull();

    await startRound(T1);
    expect(getState().subjects).not.toEqual(before);
    expect(await hasUndoSnapshot()).toBe(true);

    // 1 回目: 開始前の subjects / round(null) へ戻る
    await expect(undoLastClear()).resolves.toBe(true);
    expect(getState().subjects).toEqual(before);
    expect(getState().settings.round).toBeNull();

    // スナップショットは消費済み → 2 回目は false で何も変えない
    expect(await hasUndoSnapshot()).toBe(false);
    await expect(undoLastClear()).resolves.toBe(false);
    expect(getState().subjects).toEqual(before);
  });
});

// ============================
// グループ / タグの削除（参照掃除）
// ============================

describe('deleteGroup / deleteTag', () => {
  it('deleteGroup は所属対象を未分類 (groupId=null) へ移す', async () => {
    await initStore(T0);
    const g = await addGroup('G1');
    const a = await addSubject({ name: 'A' }, g.id, T0);
    await deleteGroup(g.id);
    expect(getState().groups).toHaveLength(0);
    expect(getSubject(a.id)?.groupId).toBeNull();
    // durable 側も掃除済み（1 tx）
    const stored = await db.get<Subject>(STORE_SUBJECTS, a.id);
    expect(stored?.groupId).toBeNull();
  });

  it('deleteTag は定義と全対象の tagIds から除去する', async () => {
    await initStore(T0);
    await saveTag({ id: 'tag_1', name: '重要', sortOrder: 1 });
    await saveTag({ id: 'tag_2', name: '経過', sortOrder: 2 });
    const a = await addSubject({ name: 'A' }, null, T0);
    const b = await addSubject({ name: 'B' }, null, T0);
    await updateSubject(a.id, { tagIds: ['tag_1', 'tag_2'] }, T0);
    await updateSubject(b.id, { tagIds: ['tag_1'] }, T0);

    await deleteTag('tag_1');
    expect(getState().settings.tags.map((t) => t.id)).toEqual(['tag_2']);
    expect(getSubject(a.id)?.tagIds).toEqual(['tag_2']);
    expect(getSubject(b.id)?.tagIds).toEqual([]);
    const stored = await db.get<Subject>(STORE_SUBJECTS, a.id);
    expect(stored?.tagIds).toEqual(['tag_2']);
  });
});

// ============================
// テンプレート削除
// ============================

describe('deleteTemplate', () => {
  it('active を消すと残りへ activeTemplateId を付け替え、最後の 1 件は throw', async () => {
    await initStore(T0);
    const activeId = getState().settings.activeTemplateId;
    const other = getState().templates.find((t) => t.id !== activeId);
    if (!other) throw new Error('seed 済みなら 2 件あるはず');

    // active を削除 → 残りの 1 件へ付け替わる
    await deleteTemplate(activeId);
    expect(getState().templates.map((t) => t.id)).toEqual([other.id]);
    expect(getState().settings.activeTemplateId).toBe(other.id);
    const stored = await db.get<AppSettings>(STORE_SETTINGS, APP_SETTINGS_KEY);
    expect(stored?.activeTemplateId).toBe(other.id);

    // 最後の 1 件は削除できない（fail-closed）
    await expect(deleteTemplate(other.id)).rejects.toThrow();
    expect(getState().templates).toHaveLength(1);
  });
});

// ============================
// 旧 workspace 追記
// ============================

describe('appendImported', () => {
  it('既存データを残し、並び順を末尾へ補正して3 storeへ原子的に追記する', async () => {
    await initStore(T0);
    const existingGroup = await addGroup('既存グループ');
    await addSubject({ name: '既存対象' }, null, T0);
    await saveSnippet({ id: 'snp_existing', label: '既存定型文', body: '既存本文' });
    const importedSubject = (
      id: string,
      name: string,
      groupId: string | null,
      sortOrder: number,
    ): Subject => ({
      id,
      name,
      code: id,
      location: '',
      groupId,
      sortOrder,
      status: STATUS.NONE,
      problems: [],
      handover: '',
      sectionText: {},
      formValues: {},
      confirmedNote: '',
      tagIds: [],
      archivedAt: null,
      createdAt: T1,
      updatedAt: T1,
    });
    const incoming = {
      groups: [{ id: 'grp_imported', name: '移行グループ', sortOrder: 1 }],
      subjects: [
        importedSubject('sub_imported_grouped', '移行対象G', 'grp_imported', 1),
        importedSubject('sub_imported_none', '移行対象未分類', null, 1),
      ],
      snippets: [{ id: 'snp_imported', label: '移行定型文', body: '移行本文' }],
    };

    await appendImported(incoming);
    expect(getState().groups.map(({ id, sortOrder }) => ({ id, sortOrder }))).toEqual([
      { id: existingGroup.id, sortOrder: 1 },
      { id: 'grp_imported', sortOrder: 2 },
    ]);
    expect(subjectsInGroup(null).map(({ name, sortOrder }) => ({ name, sortOrder }))).toEqual([
      { name: '既存対象', sortOrder: 1 },
      { name: '移行対象未分類', sortOrder: 2 },
    ]);
    expect(subjectsInGroup('grp_imported')[0]?.sortOrder).toBe(1);
    expect(getState().settings.snippets.map((snippet) => snippet.id)).toEqual([
      'snp_existing',
      'snp_imported',
    ]);
    expect((await db.getAll(STORE_GROUPS)).length).toBe(2);
    expect((await db.getAll(STORE_SUBJECTS)).length).toBe(3);

    const before = getState();
    await expect(appendImported(incoming)).rejects.toThrow('import id collision');
    expect(getState()).toEqual(before);
  });
});

// ============================
// 全置換（復元）/ 全削除（再 seed）
// ============================

describe('replaceAll / wipeAll', () => {
  it('replaceAll は全 store を置換し、Undo スナップショットも破棄する', async () => {
    await initStore(T0);
    await seedFilledSubject();
    await startRound(T1); // Undo スナップショットを作っておく
    expect(await hasUndoSnapshot()).toBe(true);

    const tpl: Template = {
      id: 'tpl_restore',
      name: '復元テンプレ',
      includeProblems: false,
      includeHandover: false,
      sections: [{ id: 'sec_r', title: '本文', keepWhenEmpty: false, freeText: true, groups: [] }],
      updatedAt: T2,
    };
    const settings: AppSettings = {
      key: 'app',
      activeTemplateId: tpl.id,
      tags: [{ id: 'tag_r', name: '復元タグ', sortOrder: 1 }],
      snippets: [{ id: 'snp_r', label: '採血', body: '採血: __' }],
      newlineMode: 'lf',
      round: { startedAt: T1, endedAt: T2 },
      onboardingDone: true,
      updatedAt: T2,
    };
    const subject: Subject = {
      id: 'sub_restore',
      name: '復元対象',
      code: 'R-1',
      location: 'R棟',
      groupId: 'grp_restore',
      sortOrder: 1,
      status: STATUS.BLUE,
      problems: ['#復元問題'],
      handover: '',
      sectionText: {},
      formValues: {},
      confirmedNote: '',
      tagIds: ['tag_r'],
      archivedAt: null,
      createdAt: T0,
      updatedAt: T2,
    };
    await replaceAll({
      settings,
      subjects: [subject],
      groups: [{ id: 'grp_restore', name: '復元G', sortOrder: 1 }],
      templates: [tpl],
    });

    const s = getState();
    expect(s.settings).toEqual(settings);
    expect(s.subjects).toEqual([subject]);
    expect(s.groups.map((g) => g.id)).toEqual(['grp_restore']);
    expect(s.templates.map((t) => t.id)).toEqual([tpl.id]);
    // 旧データの Undo スナップショットは復元後の世界と無関係 → 破棄済み
    expect(await hasUndoSnapshot()).toBe(false);
    // durable 側も置換済み
    const all = await db.getAll<Subject>(STORE_SUBJECTS);
    expect(all.map((x) => x.id)).toEqual(['sub_restore']);
  });

  it('wipeAll は全データを消してプリセット 2 件を再 seed する', async () => {
    await initStore(T0);
    await addGroup('G1');
    await seedFilledSubject();
    const oldTemplateIds = getState().templates.map((t) => t.id);

    await wipeAll(T3);
    const s = getState();
    expect(s.subjects).toEqual([]);
    expect(s.groups).toEqual([]);
    expect(s.templates).toHaveLength(2);
    expect(s.templates.map((t) => t.name).sort()).toEqual(['回診メモ', '日報']);
    // プリセット id は呼び出しごとに採番 = 旧 id とは別物
    for (const t of s.templates) expect(oldTemplateIds).not.toContain(t.id);
    // settings は既定値へ戻り、active は新しい回診メモ
    const active = s.templates.find((t) => t.id === s.settings.activeTemplateId);
    expect(active?.name).toBe('回診メモ');
    expect(s.settings.round).toBeNull();
    expect(s.settings.onboardingDone).toBe(false);
    // durable 側も空
    expect(await db.getAll<Subject>(STORE_SUBJECTS)).toEqual([]);
  });
});

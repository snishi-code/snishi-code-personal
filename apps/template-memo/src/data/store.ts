/*
 * アプリ状態ストア（singleton + subscribe。React からは useSyncExternalStore で読む）。
 *
 * 書き込みは常に IndexedDB を先に完了させてからメモリへ反映する（fail-closed:
 * IDB 失敗時は throw し、可視状態を durable 状態より先に進めない）。
 * 複数レコードへ跨る操作（ラウンド開始/クリア・復元・グループ削除）は
 * runWrite の 1 トランザクションで原子的に行う。
 */

import {
  ALL_STORES,
  APP_SETTINGS_KEY,
  newId,
  STORE_GROUPS,
  STORE_SETTINGS,
  STORE_SNAPSHOTS,
  STORE_SUBJECTS,
  STORE_TEMPLATES,
  UNDO_SNAPSHOT_KEY,
} from './constants';
import { db } from './db';
import {
  buildDailyReportPreset,
  buildRoundPreset,
  type Template,
} from '../domain/template';
import {
  STATUS,
  type AppSettings,
  type Group,
  type Snippet,
  type Subject,
  type SubjectStatus,
  type Tag,
} from '../domain/types';

// ============================
// 状態と購読
// ============================

export interface StoreState {
  ready: boolean;
  settings: AppSettings;
  subjects: Subject[];
  groups: Group[];
  templates: Template[];
}

function defaultSettings(nowMs: number, activeTemplateId: string): AppSettings {
  return {
    key: 'app',
    activeTemplateId,
    tags: [],
    snippets: [],
    newlineMode: 'crlf',
    round: null,
    onboardingDone: false,
    updatedAt: nowMs,
  };
}

let state: StoreState = {
  ready: false,
  settings: defaultSettings(0, ''),
  subjects: [],
  groups: [],
  templates: [],
};

const listeners = new Set<() => void>();

function notify(next: Partial<StoreState>): void {
  state = { ...state, ...next };
  for (const fn of listeners) fn();
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getState(): StoreState {
  return state;
}

// ============================
// 初期化（初回は presets を seed）
// ============================

let initPromise: Promise<void> | null = null;

export function initStore(nowMs = Date.now()): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    let settings = await db.get<AppSettings>(STORE_SETTINGS, APP_SETTINGS_KEY);
    if (!settings) {
      // 初回起動: プリセット 2 種を seed し、回診メモを有効にする。
      const round = buildRoundPreset(nowMs);
      const daily = buildDailyReportPreset(nowMs);
      const seeded = defaultSettings(nowMs, round.id);
      await db.runWrite([STORE_SETTINGS, STORE_TEMPLATES], (tx) => {
        tx.objectStore(STORE_TEMPLATES).put(round);
        tx.objectStore(STORE_TEMPLATES).put(daily);
        tx.objectStore(STORE_SETTINGS).put(seeded);
      });
      settings = seeded;
    }
    const [subjects, groups, templates] = await Promise.all([
      db.getAll<Subject>(STORE_SUBJECTS),
      db.getAll<Group>(STORE_GROUPS),
      db.getAll<Template>(STORE_TEMPLATES),
    ]);
    notify({ ready: true, settings, subjects, groups, templates });
  })();
  return initPromise;
}

// ============================
// 参照ヘルパ（UI から呼ぶ純関数）
// ============================

export function activeTemplate(s: StoreState = state): Template | null {
  return s.templates.find((t) => t.id === s.settings.activeTemplateId) ?? null;
}

export function sortedGroups(s: StoreState = state): Group[] {
  return [...s.groups].sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
}

/** groupId のグループ内の現役対象を並び順で返す（null = 未分類）。 */
export function subjectsInGroup(groupId: string | null, s: StoreState = state): Subject[] {
  return s.subjects
    .filter((x) => x.archivedAt === null && x.groupId === groupId)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
}

export function archivedSubjects(s: StoreState = state): Subject[] {
  return s.subjects
    .filter((x) => x.archivedAt !== null)
    .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0));
}

export function getSubject(id: string, s: StoreState = state): Subject | null {
  return s.subjects.find((x) => x.id === id) ?? null;
}

// ============================
// 設定
// ============================

async function putSettings(next: AppSettings): Promise<void> {
  await db.put(STORE_SETTINGS, next);
  notify({ settings: next });
}

export async function updateSettings(
  patch: Partial<Omit<AppSettings, 'key'>>,
  nowMs = Date.now(),
): Promise<void> {
  await putSettings({ ...state.settings, ...patch, key: 'app', updatedAt: nowMs });
}

// タグ / 定型文は settings 内の配列（定義の正本はここ・Subject は id 参照）。
export async function saveTag(tag: Tag): Promise<void> {
  const tags = state.settings.tags.some((t) => t.id === tag.id)
    ? state.settings.tags.map((t) => (t.id === tag.id ? tag : t))
    : [...state.settings.tags, tag];
  await updateSettings({ tags });
}

export async function deleteTag(tagId: string): Promise<void> {
  // 参照掃除も同時に行う（Subject 側に迷子 id を残さない）。settings と subjects の
  // 2 store を 1 tx で書く。
  const tags = state.settings.tags.filter((t) => t.id !== tagId);
  const settings = { ...state.settings, tags, updatedAt: Date.now() };
  const touched = state.subjects.filter((x) => x.tagIds.includes(tagId));
  const patched = touched.map((x) => ({ ...x, tagIds: x.tagIds.filter((id) => id !== tagId) }));
  await db.runWrite([STORE_SETTINGS, STORE_SUBJECTS], (tx) => {
    tx.objectStore(STORE_SETTINGS).put(settings);
    for (const s of patched) tx.objectStore(STORE_SUBJECTS).put(s);
  });
  const byId = new Map(patched.map((x) => [x.id, x] as const));
  notify({
    settings,
    subjects: state.subjects.map((x) => byId.get(x.id) ?? x),
  });
}

export async function saveSnippet(snippet: Snippet): Promise<void> {
  const snippets = state.settings.snippets.some((s) => s.id === snippet.id)
    ? state.settings.snippets.map((s) => (s.id === snippet.id ? snippet : s))
    : [...state.settings.snippets, snippet];
  await updateSettings({ snippets });
}

export async function deleteSnippet(snippetId: string): Promise<void> {
  await updateSettings({
    snippets: state.settings.snippets.filter((s) => s.id !== snippetId),
  });
}

// ============================
// グループ
// ============================

export async function addGroup(name: string): Promise<Group> {
  const maxOrder = Math.max(0, ...state.groups.map((g) => g.sortOrder));
  const group: Group = { id: newId('grp'), name, sortOrder: maxOrder + 1 };
  await db.put(STORE_GROUPS, group);
  notify({ groups: [...state.groups, group] });
  return group;
}

export async function renameGroup(groupId: string, name: string): Promise<void> {
  const group = state.groups.find((g) => g.id === groupId);
  if (!group) return;
  const next = { ...group, name };
  await db.put(STORE_GROUPS, next);
  notify({ groups: state.groups.map((g) => (g.id === groupId ? next : g)) });
}

/** グループ削除。所属対象は未分類 (groupId=null) へ移す（対象は消さない）。 */
export async function deleteGroup(groupId: string): Promise<void> {
  const moved = state.subjects
    .filter((x) => x.groupId === groupId)
    .map((x) => ({ ...x, groupId: null }));
  await db.runWrite([STORE_GROUPS, STORE_SUBJECTS], (tx) => {
    tx.objectStore(STORE_GROUPS).delete(groupId);
    for (const s of moved) tx.objectStore(STORE_SUBJECTS).put(s);
  });
  const byId = new Map(moved.map((x) => [x.id, x] as const));
  notify({
    groups: state.groups.filter((g) => g.id !== groupId),
    subjects: state.subjects.map((x) => byId.get(x.id) ?? x),
  });
}

export async function reorderGroup(groupId: string, dir: -1 | 1): Promise<void> {
  const ordered = sortedGroups();
  const idx = ordered.findIndex((g) => g.id === groupId);
  const self = idx >= 0 ? ordered[idx] : undefined;
  const swapWith = idx >= 0 ? ordered[idx + dir] : undefined;
  if (!self || !swapWith) return;
  const a = { ...self, sortOrder: swapWith.sortOrder };
  const b = { ...swapWith, sortOrder: self.sortOrder };
  await db.runWrite([STORE_GROUPS], (tx) => {
    tx.objectStore(STORE_GROUPS).put(a);
    tx.objectStore(STORE_GROUPS).put(b);
  });
  notify({ groups: state.groups.map((g) => (g.id === a.id ? a : g.id === b.id ? b : g)) });
}

// ============================
// 対象 CRUD
// ============================

function emptySubject(nowMs: number, groupId: string | null, sortOrder: number): Subject {
  return {
    id: newId('sub'),
    name: '',
    code: '',
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
    createdAt: nowMs,
    updatedAt: nowMs,
  };
}

export async function addSubject(
  fields: Partial<Pick<Subject, 'name' | 'code' | 'location'>>,
  groupId: string | null,
  nowMs = Date.now(),
): Promise<Subject> {
  const peers = subjectsInGroup(groupId);
  const maxOrder = Math.max(0, ...peers.map((x) => x.sortOrder));
  const subject = { ...emptySubject(nowMs, groupId, maxOrder + 1), ...fields };
  await db.put(STORE_SUBJECTS, subject);
  notify({ subjects: [...state.subjects, subject] });
  return subject;
}

export async function updateSubject(
  id: string,
  patch: Partial<Omit<Subject, 'id' | 'createdAt'>>,
  nowMs = Date.now(),
): Promise<void> {
  const cur = getSubject(id);
  if (!cur) throw new Error(`subject not found: ${id}`);
  const next: Subject = { ...cur, ...patch, id, updatedAt: nowMs };
  await db.put(STORE_SUBJECTS, next);
  notify({ subjects: state.subjects.map((x) => (x.id === id ? next : x)) });
}

export async function setSubjectStatus(id: string, status: SubjectStatus): Promise<void> {
  await updateSubject(id, { status });
}

/** 対象をグループへ移動（移動先の末尾に付ける）。 */
export async function moveSubject(id: string, groupId: string | null): Promise<void> {
  const peers = subjectsInGroup(groupId);
  const maxOrder = Math.max(0, ...peers.map((x) => x.sortOrder));
  await updateSubject(id, { groupId, sortOrder: maxOrder + 1 });
}

export async function reorderSubject(id: string, dir: -1 | 1): Promise<void> {
  const cur = getSubject(id);
  if (!cur) return;
  const peers = subjectsInGroup(cur.groupId);
  const idx = peers.findIndex((x) => x.id === id);
  const self = idx >= 0 ? peers[idx] : undefined;
  const swapWith = idx >= 0 ? peers[idx + dir] : undefined;
  if (!self || !swapWith) return;
  const a = { ...self, sortOrder: swapWith.sortOrder };
  const b = { ...swapWith, sortOrder: self.sortOrder };
  await db.runWrite([STORE_SUBJECTS], (tx) => {
    tx.objectStore(STORE_SUBJECTS).put(a);
    tx.objectStore(STORE_SUBJECTS).put(b);
  });
  notify({ subjects: state.subjects.map((x) => (x.id === a.id ? a : x.id === b.id ? b : x)) });
}

export async function archiveSubject(id: string, nowMs = Date.now()): Promise<void> {
  await updateSubject(id, { archivedAt: nowMs }, nowMs);
}

export async function restoreSubject(id: string, nowMs = Date.now()): Promise<void> {
  const cur = getSubject(id);
  if (!cur) return;
  // 復元先グループが消えていたら未分類へ。末尾に付ける。
  const groupId = cur.groupId && state.groups.some((g) => g.id === cur.groupId)
    ? cur.groupId
    : null;
  const peers = subjectsInGroup(groupId);
  const maxOrder = Math.max(0, ...peers.map((x) => x.sortOrder));
  await updateSubject(id, { archivedAt: null, groupId, sortOrder: maxOrder + 1 }, nowMs);
}

/** 完全削除（アーカイブからのみ呼ぶ想定。取り消し不可）。 */
export async function purgeSubject(id: string): Promise<void> {
  await db.deleteRecord(STORE_SUBJECTS, id);
  notify({ subjects: state.subjects.filter((x) => x.id !== id) });
}

// ============================
// ラウンド（開始 / 終了 / 手動クリア / 一段階 Undo）
// ============================

/** クリアで消える「今回分」を落とした Subject を返す（純関数）。 */
export function clearedForRound(subject: Subject, nowMs: number): Subject {
  return {
    ...subject,
    // 青 = 特記は開始でも消えない。それ以外は白へ戻す。
    status: subject.status === STATUS.BLUE ? STATUS.BLUE : STATUS.NONE,
    sectionText: {},
    formValues: {},
    confirmedNote: '',
    updatedAt: nowMs,
  };
}

interface UndoSnapshot {
  at: number;
  /** 'start' = ラウンド開始 / 'clear' = 手動クリア。UI の Undo 文言用。 */
  reason: 'start' | 'clear';
  subjects: Subject[];
  round: AppSettings['round'];
}

/** スナップショット → 今回分クリア → round 状態更新 を 1 tx で行う共通処理。 */
async function snapshotAndClear(reason: 'start' | 'clear', nowMs: number): Promise<void> {
  const active = state.subjects.filter((x) => x.archivedAt === null);
  const snapshot: UndoSnapshot = {
    at: nowMs,
    reason,
    subjects: state.subjects,
    round: state.settings.round,
  };
  const cleared = active.map((x) => clearedForRound(x, nowMs));
  const round =
    reason === 'start' ? { startedAt: nowMs, endedAt: null } : state.settings.round;
  const settings: AppSettings = { ...state.settings, round, updatedAt: nowMs };
  await db.runWrite([STORE_SUBJECTS, STORE_SETTINGS, STORE_SNAPSHOTS], (tx) => {
    tx.objectStore(STORE_SNAPSHOTS).put(snapshot, UNDO_SNAPSHOT_KEY);
    for (const s of cleared) tx.objectStore(STORE_SUBJECTS).put(s);
    tx.objectStore(STORE_SETTINGS).put(settings);
  });
  const byId = new Map(cleared.map((x) => [x.id, x] as const));
  notify({
    settings,
    subjects: state.subjects.map((x) => byId.get(x.id) ?? x),
  });
}

/**
 * ラウンド開始: 直前スナップショット → 今回分クリア（黄/緑/灰→白・今回本文/フォーム値/清書を
 * 破棄。青・問題・申し送り・タグ・並びは維持）→ 進行中ラウンドを開始。
 */
export async function startRound(nowMs = Date.now()): Promise<void> {
  await snapshotAndClear('start', nowMs);
}

/** ラウンド終了: 状態だけ終了にする（入力内容は消さない）。 */
export async function endRound(nowMs = Date.now()): Promise<void> {
  const round = state.settings.round;
  if (!round || round.endedAt !== null) return;
  await updateSettings({ round: { ...round, endedAt: nowMs } }, nowMs);
}

/** 手動クリア: 開始と同じ今回分だけを消す（ラウンド状態は変えない）。 */
export async function clearRound(nowMs = Date.now()): Promise<void> {
  await snapshotAndClear('clear', nowMs);
}

/** 直前の開始/クリアを 1 段階だけ取り消す。成功時はスナップショットを消費する。 */
export async function undoLastClear(): Promise<boolean> {
  const snap = await db.getKv<UndoSnapshot>(STORE_SNAPSHOTS, UNDO_SNAPSHOT_KEY);
  if (!snap) return false;
  const settings: AppSettings = { ...state.settings, round: snap.round, updatedAt: Date.now() };
  await db.runWrite([STORE_SUBJECTS, STORE_SETTINGS, STORE_SNAPSHOTS], (tx) => {
    const store = tx.objectStore(STORE_SUBJECTS);
    store.clear();
    for (const s of snap.subjects) store.put(s);
    tx.objectStore(STORE_SETTINGS).put(settings);
    tx.objectStore(STORE_SNAPSHOTS).delete(UNDO_SNAPSHOT_KEY);
  });
  notify({ settings, subjects: snap.subjects });
  return true;
}

/** Undo できる状態か（UI のボタン活性用）。 */
export async function hasUndoSnapshot(): Promise<boolean> {
  return (await db.getKv<UndoSnapshot>(STORE_SNAPSHOTS, UNDO_SNAPSHOT_KEY)) !== undefined;
}

// ============================
// テンプレート
// ============================

export async function saveTemplate(template: Template): Promise<void> {
  await db.put(STORE_TEMPLATES, template);
  const exists = state.templates.some((t) => t.id === template.id);
  notify({
    templates: exists
      ? state.templates.map((t) => (t.id === template.id ? template : t))
      : [...state.templates, template],
  });
}

export async function deleteTemplate(templateId: string): Promise<void> {
  if (state.templates.length <= 1) throw new Error('最後のテンプレートは削除できません');
  const rest = state.templates.filter((t) => t.id !== templateId);
  const fallback = rest[0];
  if (!fallback) throw new Error('最後のテンプレートは削除できません');
  // active を消す時は残りの先頭へ付け替える（active 不在の状態を作らない）。
  if (state.settings.activeTemplateId === templateId) {
    const settings: AppSettings = {
      ...state.settings,
      activeTemplateId: fallback.id,
      updatedAt: Date.now(),
    };
    await db.runWrite([STORE_TEMPLATES, STORE_SETTINGS], (tx) => {
      tx.objectStore(STORE_TEMPLATES).delete(templateId);
      tx.objectStore(STORE_SETTINGS).put(settings);
    });
    notify({ templates: rest, settings });
    return;
  }
  await db.deleteRecord(STORE_TEMPLATES, templateId);
  notify({ templates: rest });
}

export async function setActiveTemplate(templateId: string): Promise<void> {
  if (!state.templates.some((t) => t.id === templateId)) {
    throw new Error(`template not found: ${templateId}`);
  }
  await updateSettings({ activeTemplateId: templateId });
}

// ============================
// 全置換（バックアップ復元・全データ削除）
// ============================

export interface ReplaceAllData {
  settings: AppSettings;
  subjects: Subject[];
  groups: Group[];
  templates: Template[];
}

/** 検証済みデータで全 store を 1 tx 置換する（復元用。Undo スナップショットも破棄）。 */
export async function replaceAll(data: ReplaceAllData): Promise<void> {
  await db.runWrite([...ALL_STORES], (tx) => {
    for (const name of ALL_STORES) tx.objectStore(name).clear();
    tx.objectStore(STORE_SETTINGS).put(data.settings);
    for (const s of data.subjects) tx.objectStore(STORE_SUBJECTS).put(s);
    for (const g of data.groups) tx.objectStore(STORE_GROUPS).put(g);
    for (const t of data.templates) tx.objectStore(STORE_TEMPLATES).put(t);
  });
  notify({
    settings: data.settings,
    subjects: data.subjects,
    groups: data.groups,
    templates: data.templates,
  });
}

/** 全データ削除（初期状態へ戻す = presets を再 seed）。 */
export async function wipeAll(nowMs = Date.now()): Promise<void> {
  const round = buildRoundPreset(nowMs);
  const daily = buildDailyReportPreset(nowMs);
  const settings = defaultSettings(nowMs, round.id);
  await db.runWrite([...ALL_STORES], (tx) => {
    for (const name of ALL_STORES) tx.objectStore(name).clear();
    tx.objectStore(STORE_SETTINGS).put(settings);
    tx.objectStore(STORE_TEMPLATES).put(round);
    tx.objectStore(STORE_TEMPLATES).put(daily);
  });
  notify({ settings, subjects: [], groups: [], templates: [round, daily] });
}

/** テスト用: メモリ状態を初期化する（IDB は fake-indexeddb 側でリセットする前提）。 */
export function _resetStoreForTests(): void {
  initPromise = null;
  state = {
    ready: false,
    settings: defaultSettings(0, ''),
    subjects: [],
    groups: [],
    templates: [],
  };
  listeners.clear();
}

// HrStore adapter（コピー元: hospital-workspace/surfaces/rounds/data/store.ts）。
//
// 剥離と差し替え:
//   - WorkspaceStore(ws)/ユーザー次元/役割/roster/共有タグ/担当者/AI/RoundSession は剥離。
//   - 患者はこの store が直接 IndexedDB (patients store・フラット・1件1レコード) に持つ。
//     place はただの属性で、ビューは placeId で絞る。アーカイブは archivedAt のソフトデリート。
//   - 公開 API 名はコピーした UI が使うものを維持する (getAppState/markUpdated/scheduleSave/
//     persistActiveOrThrow/switchPlace/listPlaces/isArchiveViewActive/create~/move~/archive~ 等)。
//   - 追加 API はテンプレート/設定/バックアップ (旧 v1 store の機能を HrStore へ集約)。

import { createPointerStore, type PointerStore } from '@snishi/foundation/storage/pointers';
import { nextGroupRevision } from '@snishi/foundation/sync/revision';
import {
  ALL_STORES,
  APP_SETTINGS_KEY,
  LOCAL_PREFIX,
  newId,
  STORE_FORMATS,
  STORE_FRAMES,
  STORE_PATIENTS,
  STORE_PLACES,
  STORE_SETTINGS,
  STORE_TEMPLATES,
} from './constants';
import { db as defaultDb } from './db';
import type { DatabaseHandle } from '@snishi/foundation/storage/idb';
import type { Template } from '../domain/template';
import {
  normalizeFormat,
  normalizeFrame,
  normalizeTemplateDef,
  type Format,
  type Frame,
  type TemplateDef,
} from '../domain/entities';
import { resolveTemplate } from '../domain/resolveTemplate';
import { buildDailyReportPreset, buildRoundPreset } from '../domain/presets';
import { makeDefaultPatient, normalizePatientArray } from '../domain/normalize';
import {
  prepareWorkspaceImportAppend,
  type WorkspaceImportPayload,
} from '../domain/importWorkspace';
import type { AppSettings, AppState, Patient, PlaceDef } from '../domain/types';

// ── エラー文言定数 (正本) ──
// この store のガード (fail-closed) が投げる文言。テストは定数を厳密照合し、
// UI は e.message をそのまま表示する (i18n カタログには入れない)。
export const PLACE_ID_REQUIRED_MSG = '場所が指定されていません';
export const PATIENT_NOT_FOUND_MSG = '患者が見つかりません';
export const PLACE_HAS_PATIENTS_MSG = '患者がいる場所は削除できません';
export const LAST_TEMPLATE_UNDELETABLE_MSG = '最後のテンプレートは削除できません';
export const frameInUseMsg = (names: readonly string[]) =>
  `このフレームはテンプレート「${names.join('」「')}」で使用中のため削除できません`;
export const formatInUseMsg = (names: readonly string[]) =>
  `このフォーマットはテンプレート「${names.join('」「')}」で使用中のため削除できません`;

/** アーカイブ一覧の特別ビュー ID (place ではない。復帰/完全削除の入口)。 */
export const ARCHIVE_VIEW_ID = '__archive__';

// ── 変更通知 ──
export type StoreChangeEvent =
  | { type: 'workspace'; workspaceId: string }
  | { type: 'patient'; no: number };

const PK_ACTIVE_PLACE = 'active_place';
const SAVE_DEBOUNCE_MS = 180;

/** バックアップ復元 (replaceAll) の入力 (domain/backup.ts が検証済みの形で渡す)。 */
export interface ReplaceAllData {
  settings: AppSettings;
  places: PlaceDef[];
  patients: Patient[];
  frames: Frame[];
  formats: Format[];
  templates: TemplateDef[];
}

interface HrStorage {
  pointers: PointerStore;
  /** アクティブビュー ID (placeId または ARCHIVE_VIEW_ID)。旧名のまま (呼び出し面が広いため)。 */
  getActiveWorkspaceId(): string;
}

export interface HrStore {
  storage: HrStorage;
  initStore(): Promise<void>;
  getAppState(): AppState;
  setAppState(s: AppState): void;
  getSettings(): AppSettings;
  saveSettings(): Promise<void>;
  // ── place (グループ。マスタは places store) ──
  listPlaces(): PlaceDef[];
  getActivePlace(): PlaceDef | null;
  isArchiveViewActive(): boolean;
  addPlace(name: string): Promise<PlaceDef>;
  renamePlace(placeId: string, name: string): Promise<void>;
  deletePlace(placeId: string): Promise<void>;
  /** 全患者 (アーカイブ含む・全 place)。設定の場所管理・アーカイブ件数表示用。 */
  listAllPatients(): Patient[];
  // ── 患者 ──
  createPatientInActivePlace(name?: string): Promise<string>;
  movePatientToPlace(patientId: string, placeId: string): Promise<void>;
  archivePatient(patientId: string): Promise<void>;
  restorePatient(patientId: string, placeId?: string): Promise<void>;
  deletePatientPermanently(patientId: string): Promise<void>;
  // ── テンプレート部品 ──
  getFrames(): Frame[];
  saveFrame(frame: Frame): Promise<void>;
  deleteFrame(frameId: string): Promise<void>;
  duplicateFrame(frameId: string): Promise<Frame>;
  getFormats(): Format[];
  saveFormat(format: Format): Promise<void>;
  deleteFormat(formatId: string): Promise<void>;
  duplicateFormat(formatId: string): Promise<Format>;
  getTemplateDefs(): TemplateDef[];
  saveTemplateDef(template: TemplateDef): Promise<void>;
  deleteTemplateDef(templateId: string): Promise<void>;
  getActiveTemplate(): Template | null;
  setActiveTemplate(templateId: string): Promise<void>;
  // ── バックアップ / 移行 ──
  exportData(): {
    settings: AppSettings;
    places: PlaceDef[];
    patients: Patient[];
    frames: Frame[];
    formats: Format[];
    templates: TemplateDef[];
  };
  replaceAll(data: ReplaceAllData): Promise<void>;
  wipeAll(): Promise<void>;
  appendImported(data: WorkspaceImportPayload): Promise<void>;
  // ── 保存・通知 ──
  setDataChangeHandler(fn: ((ev: StoreChangeEvent) => void) | null): void;
  scheduleSave(): void;
  persistActiveOrThrow(): Promise<void>;
  flushSavePending(): void;
  markUpdated(no: number, opts?: { bumpLight?: boolean }): void;
  /** アクティブビューを place (または ARCHIVE_VIEW_ID) へ切り替える。 */
  switchPlace(targetId: string): Promise<void>;
  requestStoragePersistence(): void;
}

interface CreateHrStoreDeps {
  db?: DatabaseHandle;
  defaultTitle?: string;
  onSaveError?: ((e: unknown) => void) | null;
  now?: () => number;
}

function defaultSettings(nowMs: number, activeTemplateId: string): AppSettings {
  return {
    key: 'app',
    activeTemplateId,
    tags: [],
    newlineMode: 'crlf',
    updatedAt: nowMs,
  };
}

/** 初回 seed の place（UI からいつでも改名できる）。 */
const DEFAULT_PLACE_NAME = 'グループ1';

function normalizePlaceRows(rows: readonly unknown[]): PlaceDef[] {
  const out: PlaceDef[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.placeId !== 'string' || r.placeId === '') continue;
    out.push({ placeId: r.placeId, name: typeof r.name === 'string' ? r.name : '' });
  }
  return out;
}

export function createHrStore(deps: CreateHrStoreDeps = {}): HrStore {
  const db = deps.db ?? defaultDb;
  const now = deps.now ?? (() => Date.now());
  const defaultTitle = deps.defaultTitle ?? '';
  const pointers = createPointerStore(LOCAL_PREFIX);

  let settings: AppSettings = defaultSettings(0, '');
  let places: PlaceDef[] = [];
  let frames: Frame[] = [];
  let formats: Format[] = [];
  let templateDefs: TemplateDef[] = [];
  /** 全患者マスタ (in-memory)。live (appState.patients) は同じ object を共有する。 */
  let allPatients: Patient[] = [];
  let appState: AppState = { title: defaultTitle, patients: [] };
  let changeHandler: ((ev: StoreChangeEvent) => void) | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  function emit(ev: StoreChangeEvent): void {
    try {
      changeHandler?.(ev);
    } catch {
      /* listener 例外は飲み込む (旧契約) */
    }
  }

  /** アクティブビュー ID = placeId または ARCHIVE_VIEW_ID。 */
  function activeViewId(): string {
    const ptr = pointers.get(PK_ACTIVE_PLACE);
    if (ptr === ARCHIVE_VIEW_ID) return ARCHIVE_VIEW_ID;
    if (ptr && places.some((p) => p.placeId === ptr)) return ptr;
    return places[0]?.placeId ?? '';
  }
  function isArchiveView(): boolean {
    return activeViewId() === ARCHIVE_VIEW_ID;
  }
  function activePlace(): PlaceDef | null {
    const id = activeViewId();
    return places.find((p) => p.placeId === id) ?? null;
  }

  /** アクティブビューの患者 (place ビュー = 非アーカイブ / アーカイブビュー = アーカイブ済み全件)。 */
  function rebuildLive(): void {
    const patients = isArchiveView()
      ? allPatients.filter((p) => p.archivedAt !== null)
      : allPatients.filter((p) => p.placeId === activeViewId() && p.archivedAt === null);
    appState = { title: defaultTitle, patients };
  }

  /** 現 live state を patients store へ書き戻す。アーカイブビューは読み取り専用なので何も書かない。 */
  async function saveActive(failClosed: boolean): Promise<void> {
    const rows = isArchiveView() ? [] : appState.patients;
    const run = async () => {
      if (rows.length === 0) return;
      await db.runWrite([STORE_PATIENTS], (tx) => {
        const os = tx.objectStore(STORE_PATIENTS);
        for (const p of rows) os.put(p);
      });
    };
    if (failClosed) {
      await run();
    } else {
      try {
        await run();
      } catch (e) {
        console.error('save failed:', e);
        deps.onSaveError?.(e);
      }
    }
  }

  function saveNow(): void {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    void saveActive(false);
  }

  async function putPatient(p: Patient): Promise<void> {
    await db.put(STORE_PATIENTS, p);
  }

  function masterOf(patientId: string): Patient {
    const p = allPatients.find((x) => x.pid === patientId);
    if (!p) throw new Error(PATIENT_NOT_FOUND_MSG);
    return p;
  }

  async function seedDefaults(): Promise<void> {
    const ts = now();
    const round = buildRoundPreset(ts);
    const daily = buildDailyReportPreset(ts);
    const seededSettings = defaultSettings(ts, round.template.id);
    const seededPlace: PlaceDef = { placeId: newId('plc'), name: DEFAULT_PLACE_NAME };
    await db.runWrite(
      [STORE_SETTINGS, STORE_TEMPLATES, STORE_FRAMES, STORE_FORMATS, STORE_PLACES],
      (tx) => {
        tx.objectStore(STORE_TEMPLATES).put(round.template);
        tx.objectStore(STORE_TEMPLATES).put(daily.template);
        tx.objectStore(STORE_FRAMES).put(round.frame);
        tx.objectStore(STORE_FRAMES).put(daily.frame);
        for (const format of round.formats) tx.objectStore(STORE_FORMATS).put(format);
        for (const format of daily.formats) tx.objectStore(STORE_FORMATS).put(format);
        tx.objectStore(STORE_PLACES).put(seededPlace);
        tx.objectStore(STORE_SETTINGS).put(seededSettings);
      },
    );
    settings = seededSettings;
    frames = [round.frame, daily.frame];
    formats = [...round.formats, ...daily.formats];
    templateDefs = [round.template, daily.template];
    places = [seededPlace];
  }

  const storage: HrStorage = {
    pointers,
    getActiveWorkspaceId: () => activeViewId(),
  };

  // 初期化は単発 (memoize)。StrictMode の二重 effect / 二重呼び出しで seed を重複させない。
  let initPromise: Promise<void> | null = null;
  async function doInit(): Promise<void> {
    const [settingsRec, placeRows, patientRows, frameRows, formatRows, templateRows] =
      await Promise.all([
        db.get<AppSettings>(STORE_SETTINGS, APP_SETTINGS_KEY),
        db.getAll<unknown>(STORE_PLACES),
        db.getAll<unknown>(STORE_PATIENTS),
        db.getAll<unknown>(STORE_FRAMES),
        db.getAll<unknown>(STORE_FORMATS),
        db.getAll<unknown>(STORE_TEMPLATES),
      ]);
    if (!settingsRec) {
      // 初回起動: プリセット 2 種 + place 1 つを seed し、回診メモを有効にする。
      await seedDefaults();
    } else {
      settings = settingsRec;
      places = normalizePlaceRows(placeRows);
      frames = frameRows.map(normalizeFrame).filter((frame): frame is Frame => frame !== null);
      formats = formatRows
        .map(normalizeFormat)
        .filter((format): format is Format => format !== null);
      templateDefs = templateRows
        .map((row) => normalizeTemplateDef(row, { frames, formats }))
        .filter((template): template is TemplateDef => template !== null);
    }
    allPatients = normalizePatientArray(patientRows);
    const view = activeViewId();
    if (view) pointers.set(PK_ACTIVE_PLACE, view);
    rebuildLive();
  }

  return {
    storage,
    initStore() {
      if (!initPromise) initPromise = doInit();
      return initPromise;
    },
    getAppState: () => appState,
    setAppState(s) {
      // 復元 (RestoreSection) 用: live を差し替え、マスタへも pid で反映する
      // (live とマスタは同じ object を共有し続ける)。
      for (const p of s.patients) {
        const i = allPatients.findIndex((m) => m.pid === p.pid);
        if (i >= 0) allPatients[i] = p;
        else allPatients.push(p);
      }
      appState = s;
    },
    getSettings: () => settings,
    async saveSettings() {
      settings.updatedAt = now();
      await db.put(STORE_SETTINGS, settings);
    },
    listPlaces: () => places,
    getActivePlace: () => activePlace(),
    isArchiveViewActive: () => isArchiveView(),
    async addPlace(name) {
      const place: PlaceDef = { placeId: newId('plc'), name: String(name ?? '').trim() };
      await db.put(STORE_PLACES, place);
      places = [...places, place];
      emit({ type: 'workspace', workspaceId: activeViewId() });
      return place;
    },
    async renamePlace(placeId, name) {
      const cur = places.find((p) => p.placeId === placeId);
      if (!cur) throw new Error(PLACE_ID_REQUIRED_MSG);
      const next = { ...cur, name: String(name ?? '').trim() };
      await db.put(STORE_PLACES, next);
      places = places.map((p) => (p.placeId === placeId ? next : p));
      emit({ type: 'workspace', workspaceId: activeViewId() });
    },
    async deletePlace(placeId) {
      if (!placeId) throw new Error(PLACE_ID_REQUIRED_MSG);
      // 所属患者 (アーカイブ済み含む) が居る place は fail-closed で弾く。
      if (allPatients.some((p) => p.placeId === placeId)) {
        throw new Error(PLACE_HAS_PATIENTS_MSG);
      }
      await db.deleteRecord(STORE_PLACES, placeId);
      places = places.filter((p) => p.placeId !== placeId);
      emit({ type: 'workspace', workspaceId: activeViewId() });
    },
    listAllPatients: () => allPatients,
    async createPatientInActivePlace(name = '') {
      // 「+患者」= 名前だけで確定 (空名も許容・シートで後から入れる)。
      await this.persistActiveOrThrow();
      const placeId = isArchiveView() ? places[0]?.placeId : activeViewId();
      if (!placeId) throw new Error(PLACE_ID_REQUIRED_MSG);
      const patient: Patient = {
        ...makeDefaultPatient(),
        name: String(name ?? ''),
        placeId,
        updatedAt: now(),
      };
      await putPatient(patient);
      allPatients = [...allPatients, patient];
      rebuildLive();
      emit({ type: 'workspace', workspaceId: activeViewId() });
      return patient.pid;
    },
    async movePatientToPlace(patientId, placeId) {
      if (!placeId) throw new Error(PLACE_ID_REQUIRED_MSG);
      // 未保存の live 編集を書き戻してから place 属性を変える (編集ロスト防止)。
      await this.persistActiveOrThrow();
      const p = masterOf(patientId);
      p.placeId = placeId;
      await putPatient(p);
      rebuildLive();
      emit({ type: 'workspace', workspaceId: activeViewId() });
    },
    async archivePatient(patientId) {
      await this.persistActiveOrThrow();
      const p = masterOf(patientId);
      p.archivedAt = now();
      await putPatient(p);
      rebuildLive();
      emit({ type: 'workspace', workspaceId: activeViewId() });
    },
    async restorePatient(patientId, placeId) {
      const p = masterOf(patientId);
      p.archivedAt = null;
      const dest =
        placeId && places.some((x) => x.placeId === placeId)
          ? placeId
          : places.some((x) => x.placeId === p.placeId)
            ? p.placeId
            : (places[0]?.placeId ?? '');
      if (!dest) throw new Error(PLACE_ID_REQUIRED_MSG);
      p.placeId = dest;
      await putPatient(p);
      rebuildLive();
      emit({ type: 'workspace', workspaceId: activeViewId() });
    },
    async deletePatientPermanently(patientId) {
      await db.deleteRecord(STORE_PATIENTS, patientId);
      allPatients = allPatients.filter((p) => p.pid !== patientId);
      rebuildLive();
      emit({ type: 'workspace', workspaceId: activeViewId() });
    },
    getFrames: () => frames,
    async saveFrame(frame) {
      const normalized = normalizeFrame(frame);
      if (!normalized) throw new Error('フレームの形式が不正です');
      await db.put(STORE_FRAMES, normalized);
      frames = frames.some((candidate) => candidate.id === normalized.id)
        ? frames.map((candidate) => (candidate.id === normalized.id ? normalized : candidate))
        : [...frames, normalized];
      emit({ type: 'workspace', workspaceId: activeViewId() });
    },
    async deleteFrame(frameId) {
      const usedBy = templateDefs
        .filter((template) => template.frameId === frameId)
        .map((template) => template.name);
      if (usedBy.length > 0) throw new Error(frameInUseMsg(usedBy));
      await db.deleteRecord(STORE_FRAMES, frameId);
      frames = frames.filter((frame) => frame.id !== frameId);
      emit({ type: 'workspace', workspaceId: activeViewId() });
    },
    async duplicateFrame(frameId) {
      const source = frames.find((frame) => frame.id === frameId);
      if (!source) throw new Error('フレームが見つかりません');
      const duplicate: Frame = {
        ...source,
        id: newId('frm'),
        name: `${source.name}のコピー`,
        sections: source.sections.map((section) => ({ ...section, id: newId('sec') })),
      };
      await this.saveFrame(duplicate);
      return duplicate;
    },
    getFormats: () => formats,
    async saveFormat(format) {
      const normalized = normalizeFormat(format);
      if (!normalized) throw new Error('フォーマットの形式が不正です');
      await db.put(STORE_FORMATS, normalized);
      formats = formats.some((candidate) => candidate.id === normalized.id)
        ? formats.map((candidate) => (candidate.id === normalized.id ? normalized : candidate))
        : [...formats, normalized];
      emit({ type: 'workspace', workspaceId: activeViewId() });
    },
    async deleteFormat(formatId) {
      const usedBy = templateDefs
        .filter((template) =>
          template.placements.some((placement) => placement.formatId === formatId),
        )
        .map((template) => template.name);
      if (usedBy.length > 0) throw new Error(formatInUseMsg(usedBy));
      await db.deleteRecord(STORE_FORMATS, formatId);
      formats = formats.filter((format) => format.id !== formatId);
      emit({ type: 'workspace', workspaceId: activeViewId() });
    },
    async duplicateFormat(formatId) {
      const source = formats.find((format) => format.id === formatId);
      if (!source) throw new Error('フォーマットが見つかりません');
      const duplicate: Format = {
        ...source,
        id: newId('fmt'),
        name: `${source.name}のコピー`,
        items: source.items.map((item) => ({ ...item, id: newId('itm') })),
      };
      await this.saveFormat(duplicate);
      return duplicate;
    },
    getTemplateDefs: () => templateDefs,
    async saveTemplateDef(template) {
      const normalized = normalizeTemplateDef(template, { frames, formats });
      if (!normalized) throw new Error('テンプレートの形式が不正です');
      await db.put(STORE_TEMPLATES, normalized);
      templateDefs = templateDefs.some((candidate) => candidate.id === normalized.id)
        ? templateDefs.map((candidate) => (candidate.id === normalized.id ? normalized : candidate))
        : [...templateDefs, normalized];
      emit({ type: 'workspace', workspaceId: activeViewId() });
    },
    async deleteTemplateDef(templateId) {
      const rest = templateDefs.filter((template) => template.id !== templateId);
      const fallback = rest[0];
      if (!fallback) throw new Error(LAST_TEMPLATE_UNDELETABLE_MSG);
      if (settings.activeTemplateId === templateId) {
        settings.activeTemplateId = fallback.id;
        settings.updatedAt = now();
        await db.runWrite([STORE_TEMPLATES, STORE_SETTINGS], (tx) => {
          tx.objectStore(STORE_TEMPLATES).delete(templateId);
          tx.objectStore(STORE_SETTINGS).put(settings);
        });
      } else {
        await db.deleteRecord(STORE_TEMPLATES, templateId);
      }
      templateDefs = rest;
      emit({ type: 'workspace', workspaceId: activeViewId() });
    },
    getActiveTemplate() {
      const definition =
        templateDefs.find((template) => template.id === settings.activeTemplateId) ?? null;
      return definition ? resolveTemplate(definition, frames, formats) : null;
    },
    async setActiveTemplate(templateId) {
      if (!templateDefs.some((template) => template.id === templateId)) {
        throw new Error(`template not found: ${templateId}`);
      }
      settings.activeTemplateId = templateId;
      await this.saveSettings();
      emit({ type: 'workspace', workspaceId: activeViewId() });
    },
    exportData() {
      return {
        settings,
        places,
        patients: allPatients,
        frames,
        formats,
        templates: templateDefs,
      };
    },
    async replaceAll(data) {
      await db.runWrite([...ALL_STORES], (tx) => {
        for (const name of ALL_STORES) tx.objectStore(name).clear();
        tx.objectStore(STORE_SETTINGS).put(data.settings);
        for (const p of data.patients) tx.objectStore(STORE_PATIENTS).put(p);
        for (const place of data.places) tx.objectStore(STORE_PLACES).put(place);
        for (const frame of data.frames) tx.objectStore(STORE_FRAMES).put(frame);
        for (const format of data.formats) tx.objectStore(STORE_FORMATS).put(format);
        for (const t of data.templates) tx.objectStore(STORE_TEMPLATES).put(t);
      });
      settings = data.settings;
      places = data.places;
      frames = data.frames;
      formats = data.formats;
      templateDefs = data.templates;
      allPatients = data.patients;
      const view = activeViewId();
      if (view) pointers.set(PK_ACTIVE_PLACE, view);
      rebuildLive();
      emit({ type: 'workspace', workspaceId: activeViewId() });
    },
    async wipeAll() {
      await db.runWrite([...ALL_STORES], (tx) => {
        for (const name of ALL_STORES) tx.objectStore(name).clear();
      });
      allPatients = [];
      await seedDefaults();
      const view = activeViewId();
      if (view) pointers.set(PK_ACTIVE_PLACE, view);
      rebuildLive();
      emit({ type: 'workspace', workspaceId: activeViewId() });
    },
    async appendImported(data) {
      const prepared = prepareWorkspaceImportAppend(data, {
        places,
        patients: allPatients,
      });
      // place 未解決 ('') の患者は先頭 place へ倒す (未所属で不可視にしない)。
      const fallbackPlace = prepared.places[0]?.placeId ?? places[0]?.placeId ?? '';
      const patients = prepared.patients.map((p) =>
        p.placeId &&
        (places.some((x) => x.placeId === p.placeId) ||
          prepared.places.some((x) => x.placeId === p.placeId))
          ? p
          : { ...p, placeId: fallbackPlace },
      );
      settings.updatedAt = now();
      await db.runWrite([STORE_PLACES, STORE_PATIENTS, STORE_SETTINGS], (tx) => {
        for (const g of prepared.places) tx.objectStore(STORE_PLACES).put(g);
        for (const p of patients) tx.objectStore(STORE_PATIENTS).put(p);
        tx.objectStore(STORE_SETTINGS).put(settings);
      });
      places = [...places, ...prepared.places];
      allPatients = [...allPatients, ...patients];
      rebuildLive();
      emit({ type: 'workspace', workspaceId: activeViewId() });
    },
    setDataChangeHandler(fn) {
      changeHandler = fn;
    },
    scheduleSave() {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(saveNow, SAVE_DEBOUNCE_MS);
    },
    async persistActiveOrThrow() {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      await saveActive(true);
    },
    flushSavePending() {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
        saveNow();
      }
    },
    markUpdated(no, opts) {
      const p = appState.patients[no - 1];
      if (!p) return;
      if (opts?.bumpLight !== false) {
        p.updatedAt = nextGroupRevision(now(), p.updatedAt);
      }
      emit({ type: 'patient', no });
    },
    async switchPlace(targetId) {
      if (!targetId) throw new Error(PLACE_ID_REQUIRED_MSG);
      await this.persistActiveOrThrow();
      pointers.set(PK_ACTIVE_PLACE, targetId);
      rebuildLive();
      emit({ type: 'workspace', workspaceId: targetId });
    },
    requestStoragePersistence() {
      try {
        void navigator.storage?.persist?.();
      } catch {
        /* best-effort */
      }
    },
  };
}

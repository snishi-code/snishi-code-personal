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
import { uniqueName } from '@snishi/foundation/qr/protocol';
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
import { planBundleReuse } from '../domain/entityReuse';
import { resolveTemplate } from '../domain/resolveTemplate';
import { buildDailyReportPreset, buildRoundPreset } from '../domain/presets';
import type { TemplatePresetBundle } from '../domain/presets';
import { makeDefaultPatient, normalizePatientArray } from '../domain/normalize';
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
  duplicateTemplateDef(templateId: string): Promise<TemplateDef>;
  saveGeneratedBundle(bundle: TemplatePresetBundle): Promise<void>;
  deleteTemplateDef(templateId: string): Promise<void>;
  /**
   * ページ (対象) が使うテンプレートの解決。patient.templateId → 所属グループの
   * templateId → アプリの defaultTemplateId の順に倒す (参照先が消えていた場合の fail-safe)。
   */
  getTemplateForPatient(patient: Patient): Template | null;
  /**
   * アプリ全体のフォールバックを変える。UI からの設定手段は 2026-08-20 に廃止
   * (テンプレート一覧の行タップは編集へ変更)。値自体は getTemplateForPatient の
   * 最終フォールバック・グループ 0 件時の addPlace・削除時のつなぎ替えで生きている。
   */
  setDefaultTemplate(templateId: string): Promise<void>;
  /** グループのデフォルトを変える (設定画面のグループ一覧のトグル)。 */
  setPlaceTemplate(placeId: string, templateId: string): Promise<void>;
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
  /**
   * タグ名の改名 / 削除を**全対象**（アクティブビュー外・アーカイブ済みを含む）へ適用する。
   * newName が null なら削除。settings と patients を 1 トランザクションで書く。
   *
   * 定義 (settings.tags) 側の更新は呼び出し側が済ませてから呼ぶ（重複判定を持つため）。
   * saveActive はアクティブビューの対象しか書かないので、この経路を通さないと他グループの
   * 対象に旧名が残り、定義に無い「孤児タグ」になる。
   */
  rewriteTagAcrossPatients(oldName: string, newName: string | null): Promise<void>;
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

function defaultSettings(nowMs: number, defaultTemplateId: string): AppSettings {
  return {
    key: 'app',
    defaultTemplateId,
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
    out.push({
      placeId: r.placeId,
      name: typeof r.name === 'string' ? r.name : '',
      templateId: typeof r.templateId === 'string' ? r.templateId : '',
    });
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
    const seededPlace: PlaceDef = {
      placeId: newId('plc'),
      name: DEFAULT_PLACE_NAME,
      templateId: round.template.id,
    };
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
      // 初回起動: プリセット 2 種 + place 1 つを seed し、回診を有効にする。
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
      // 参照修復 (fail-safe)。デフォルトの解決が空振りしない状態を起動時に作っておく:
      //   settings.defaultTemplateId が実在しなければ先頭テンプレートへ、
      //   place.templateId が実在しなければアプリのデフォルトへ倒す。
      const validId = (id: unknown) =>
        typeof id === 'string' && templateDefs.some((t) => t.id === id);
      if (!validId(settings.defaultTemplateId)) {
        settings = { ...settings, defaultTemplateId: templateDefs[0]?.id ?? '' };
      }
      places = places.map((p) =>
        validId(p.templateId) ? p : { ...p, templateId: settings.defaultTemplateId },
      );
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
      // 新しいグループのデフォルトは「1 つ上のグループ」(= 一覧末尾に追加されるので既存の
      // 末尾グループ) から写す (2026-08-20 作者決定)。グループが 1 つも無いときだけ
      // アプリのフォールバック (defaultTemplateId) を使う。
      const place: PlaceDef = {
        placeId: newId('plc'),
        name: String(name ?? '').trim(),
        templateId: places[places.length - 1]?.templateId ?? settings.defaultTemplateId,
      };
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
      // ページを増やした時のデフォルトはそのグループのデフォルト (作成時に写す)。
      const place = places.find((p) => p.placeId === placeId);
      const patient: Patient = {
        ...makeDefaultPatient(),
        name: String(name ?? ''),
        placeId,
        templateId: place?.templateId ?? settings.defaultTemplateId,
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
    async duplicateTemplateDef(templateId) {
      const source = templateDefs.find((template) => template.id === templateId);
      if (!source) throw new Error('テンプレートが見つかりません');
      const duplicate: TemplateDef = {
        ...source,
        id: newId('tpl'),
        name: `${source.name}のコピー`,
        // 配置 ID は対象ごとの入力値 (projectedValues) のキー。使い回すと複製元と複製先が
        // 同じ入力値を共有してしまうため、必ず採番し直す。
        placements: source.placements.map((placement) => ({ ...placement, id: newId('plm') })),
        // フレームは独立した再利用部品なので共有する (複製時にフレームまで増やさない)。
        updatedAt: now(),
      };
      await this.saveTemplateDef(duplicate);
      // active は変えない (複製は「使用中」を奪わない)。
      return duplicate;
    },
    async saveGeneratedBundle(bundle) {
      // 受け取った ID は信用せず、参照関係を保ったまま採番し直す。
      // これにより、呼び出し側の不具合や細工された入力があっても既存行を upsert しない。
      // ただし構造が一致する既存部品は「新規レコードを作らず既存 ID を指す」形で再利用し、
      // 同じ内容の部品が登録のたびに増えるのを防ぐ（再利用側は 1 バイトも書かない）。
      const sourceFrame = normalizeFrame(bundle.frame);
      const sourceFormats = bundle.formats.map(normalizeFormat);
      if (!sourceFrame || sourceFormats.some((format) => !format)) {
        throw new Error('生成されたテンプレート一式の形式が不正です');
      }
      const validSourceFormats = sourceFormats as Format[];
      const sourceTemplate = normalizeTemplateDef(bundle.template, {
        frames: [sourceFrame],
        formats: validSourceFormats,
      });
      if (
        !sourceTemplate ||
        sourceTemplate.placements.length !== bundle.template.placements.length ||
        new Set(sourceFrame.sections.map((section) => section.id)).size !==
          sourceFrame.sections.length ||
        new Set(validSourceFormats.map((format) => format.id)).size !== validSourceFormats.length
      ) {
        throw new Error('生成されたテンプレート一式の参照が不正です');
      }

      // 確認画面（TemplateBuilder）と同じ関数で計画を立てる（見せた内容と登録結果をずらさない）。
      const plan = planBundleReuse(
        { frame: sourceFrame, formats: validSourceFormats, template: sourceTemplate },
        frames,
        formats,
      );

      // ── フレーム: 再利用なら既存の場所 ID へ読み替え、新規なら全採番 ──
      const reusedFrame = plan.frame.existing;
      const sectionIdMap = new Map<string, string>(plan.frame.sectionIdMap);
      let generatedFrame: Frame | null = null;
      if (!reusedFrame) {
        for (const section of sourceFrame.sections) sectionIdMap.set(section.id, newId('sec'));
        generatedFrame = {
          ...sourceFrame,
          id: newId('frm'),
          name: uniqueName(
            sourceFrame.name,
            frames.map((candidate) => candidate.name),
          ),
          sections: sourceFrame.sections.map((section) => ({
            ...section,
            id: sectionIdMap.get(section.id)!,
          })),
        };
      }

      // ── フォーマット: 統合後の代表ごとに「既存を指す」か「新規採番」かを決める ──
      const usedFormatNames = new Set(formats.map((candidate) => candidate.name));
      const formatIdMap = new Map<string, string>();
      const generatedFormats: Format[] = [];
      for (const entry of plan.formats) {
        let targetId: string;
        if (entry.existing) {
          targetId = entry.existing.id;
        } else {
          targetId = newId('fmt');
          const name = uniqueName(entry.candidate.name, usedFormatNames);
          usedFormatNames.add(name);
          generatedFormats.push({
            ...entry.candidate,
            id: targetId,
            name,
            items: entry.candidate.items.map((item) => ({ ...item, id: newId('itm') })),
          });
        }
        for (const sourceId of entry.mergedIds) formatIdMap.set(sourceId, targetId);
      }

      // テンプレートは常に新規（既存テンプレートを置き換えない）。
      const generatedTemplate: TemplateDef = {
        ...sourceTemplate,
        id: newId('tpl'),
        name: uniqueName(
          sourceTemplate.name,
          templateDefs.map((candidate) => candidate.name),
        ),
        frameId: reusedFrame ? reusedFrame.id : generatedFrame!.id,
        placements: sourceTemplate.placements.map((placement) => ({
          ...placement,
          id: newId('plm'),
          // 読み替えに失敗した参照は '' になり、直後の正規化で件数が合わず保存を止める。
          sectionId: sectionIdMap.get(placement.sectionId) ?? '',
          formatId: formatIdMap.get(placement.formatId) ?? '',
        })),
      };

      // 永続化直前にも正規化する。ここで要素が落ちる状態はビルダー側の不具合なので保存しない。
      const normalizedFrame = generatedFrame ? normalizeFrame(generatedFrame) : null;
      const normalizedFormats = generatedFormats.map(normalizeFormat);
      if ((generatedFrame && !normalizedFrame) || normalizedFormats.some((format) => !format)) {
        throw new Error('生成されたテンプレート一式を正規化できませんでした');
      }
      const validFormats = normalizedFormats as Format[];
      const refFrame = normalizedFrame ?? reusedFrame;
      const normalizedTemplate = refFrame
        ? normalizeTemplateDef(generatedTemplate, {
            frames: [refFrame],
            // 再利用したフォーマットは既存側にしかないため、参照検証には両方を渡す。
            formats: [...formats, ...validFormats],
          })
        : null;
      if (
        !normalizedTemplate ||
        normalizedTemplate.placements.length !== generatedTemplate.placements.length
      ) {
        throw new Error('生成されたテンプレート一式を正規化できませんでした');
      }

      await db.runWrite([STORE_FRAMES, STORE_FORMATS, STORE_TEMPLATES], (tx) => {
        // 再利用した既存レコードは put しない（名前も内容も変えない）。
        if (normalizedFrame) tx.objectStore(STORE_FRAMES).put(normalizedFrame);
        for (const format of validFormats) tx.objectStore(STORE_FORMATS).put(format);
        tx.objectStore(STORE_TEMPLATES).put(normalizedTemplate);
      });

      // メモリ上の表示もトランザクション完了後だけ更新する。settings と active は変更しない。
      if (normalizedFrame) frames = [...frames, normalizedFrame];
      formats = [...formats, ...validFormats];
      templateDefs = [...templateDefs, normalizedTemplate];
      emit({ type: 'workspace', workspaceId: activeViewId() });
    },
    async deleteTemplateDef(templateId) {
      const rest = templateDefs.filter((template) => template.id !== templateId);
      const fallback = rest[0];
      if (!fallback) throw new Error(LAST_TEMPLATE_UNDELETABLE_MSG);
      // 消したテンプレートを指すデフォルト/ページを全部つなぎ替える (dangling 参照を残さない)。
      // アプリのデフォルトが消える場合は残りの先頭へ、グループ/ページはアプリのデフォルトへ倒す。
      const nextDefault =
        settings.defaultTemplateId === templateId ? fallback.id : settings.defaultTemplateId;
      const rewritePlaces = places.filter((p) => p.templateId === templateId);
      const rewritePatients = allPatients.filter((p) => p.templateId === templateId);
      settings = { ...settings, defaultTemplateId: nextDefault, updatedAt: now() };
      const nextPlaces = places.map((p) =>
        p.templateId === templateId ? { ...p, templateId: nextDefault } : p,
      );
      for (const p of rewritePatients) p.templateId = nextDefault; // live と共有する master を直接書く
      await db.runWrite([STORE_TEMPLATES, STORE_SETTINGS, STORE_PLACES, STORE_PATIENTS], (tx) => {
        tx.objectStore(STORE_TEMPLATES).delete(templateId);
        tx.objectStore(STORE_SETTINGS).put(settings);
        for (const p of nextPlaces) {
          if (rewritePlaces.some((old) => old.placeId === p.placeId)) {
            tx.objectStore(STORE_PLACES).put(p);
          }
        }
        for (const p of rewritePatients) tx.objectStore(STORE_PATIENTS).put(p);
      });
      places = nextPlaces;
      templateDefs = rest;
      emit({ type: 'workspace', workspaceId: activeViewId() });
    },
    getTemplateForPatient(patient) {
      // ページ → グループ → アプリ の順 (作成時に写しているので通常は 1 発で当たる。
      // 以降は削除やデータ取り込みで参照が欠けた場合の fail-safe)。
      const byId = (id: string | undefined) =>
        id ? (templateDefs.find((template) => template.id === id) ?? null) : null;
      const place = places.find((p) => p.placeId === patient.placeId);
      const definition =
        byId(patient.templateId) ?? byId(place?.templateId) ?? byId(settings.defaultTemplateId);
      return definition ? resolveTemplate(definition, frames, formats) : null;
    },
    async setDefaultTemplate(templateId) {
      if (!templateDefs.some((template) => template.id === templateId)) {
        throw new Error(`template not found: ${templateId}`);
      }
      settings.defaultTemplateId = templateId;
      await this.saveSettings();
      emit({ type: 'workspace', workspaceId: activeViewId() });
    },
    async setPlaceTemplate(placeId, templateId) {
      const cur = places.find((p) => p.placeId === placeId);
      if (!cur) throw new Error(PLACE_ID_REQUIRED_MSG);
      if (!templateDefs.some((template) => template.id === templateId)) {
        throw new Error(`template not found: ${templateId}`);
      }
      const next = { ...cur, templateId };
      await db.put(STORE_PLACES, next);
      places = places.map((p) => (p.placeId === placeId ? next : p));
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
    async rewriteTagAcrossPatients(oldName, newName) {
      // 他の変更系 API と同じ不変条件: 構造を変える前に現ビューの未保存分を確定させる。
      await this.persistActiveOrThrow();
      const touched: Patient[] = [];
      for (const p of allPatients) {
        if (!Array.isArray(p.tags) || !p.tags.includes(oldName)) continue;
        const next =
          newName === null
            ? p.tags.filter((tg) => tg !== oldName)
            : p.tags.map((tg) => (tg === oldName ? newName : tg));
        // 改名先が既に付いている対象では重複するので畳む。
        p.tags = [...new Set(next)];
        touched.push(p);
      }
      settings.updatedAt = now();
      // 定義 (settings) と対象 (patients) を 1 tx で書く。片方だけ残ると孤児タグが生まれる。
      await db.runWrite([STORE_PATIENTS, STORE_SETTINGS], (tx) => {
        const os = tx.objectStore(STORE_PATIENTS);
        for (const p of touched) os.put(p);
        tx.objectStore(STORE_SETTINGS).put(settings);
      });
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

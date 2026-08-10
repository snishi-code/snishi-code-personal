/*
 * JSON バックアップ（全データの書き出し / 検証つき読み込み）。
 *
 * 封筒は kind / appId / schemaVersion で照合し、合わない JSON は fail-closed に拒否する
 * （medical 側 hospital-workspace/shared/workspaceBackup.ts の流儀を踏襲。zod は使わず手書き検証）。
 * schemaVersion は現行一致のみ受け付ける（migration step は持たない = constants の単発変換方式。
 * v3 以前の封筒は fail-closed に拒否する）。
 *
 * 中身の検証は 2 段構え:
 *   - frames / formats / templates: entities.ts の正規化を通し、壊れ参照は捨てる。
 *     全滅したら復元先が成立しないので throw（active テンプレート不在の状態を作らない）。
 *   - patients / places / settings: 1 件ずつ防御的に正規化する。id/name の型不正 row だけを
 *     捨てて生き残りを救い、row 内の配列/オブジェクト欄は型不正なら空に落とす。
 *
 * 参照整合はここで閉じる: settings.activeTemplateId が templates に無ければ先頭へ付け替え、
 * Patient.placeId が places に無ければ先頭 place へ倒す。返り値はそのまま
 * store.replaceAll へ渡せる検証済みデータ（ReplaceAllData）。
 */

import { APP_ID, BACKUP_KIND, SCHEMA_VERSION } from '../data/constants';
import type { ReplaceAllData } from '../data/store';
import {
  normalizeFormat,
  normalizeFrame,
  normalizeTemplateDef,
  type Format,
  type Frame,
  type TemplateDef,
} from './entities';
import { normalizeProjectedValues, normalizeSectionTexts } from './normalize';
import {
  isPatientStatus,
  STATUS,
  type AppSettings,
  type Patient,
  type PlaceDef,
  type TagDef,
} from './types';

// ============================
// 封筒（envelope）
// ============================

/** バックアップ JSON の封筒。kind/appId/schemaVersion が照合キー。 */
interface BackupBundle {
  kind: typeof BACKUP_KIND;
  appId: typeof APP_ID;
  schemaVersion: number;
  /** 書き出し時刻（ISO 文字列。表示・ファイル整理用のメタで、検証キーではない）。 */
  exportedAt: string;
  settings: AppSettings;
  places: PlaceDef[];
  patients: Patient[];
  frames: Frame[];
  formats: Format[];
  templates: TemplateDef[];
}

// ── エラー文言定数（正本） ──
// parseBackupJson が投げる文言。テストは定数を厳密照合し、UI は e.message を
// settings.backupImportFailed の {reason} にそのまま流し込む（i18n カタログには入れない）。
export const BACKUP_JSON_UNREADABLE_MSG = 'バックアップのJSONを読めません';
export const BACKUP_MALFORMED_MSG = 'バックアップの形式が不正です';
export const BACKUP_WRONG_KIND_MSG = 'これはテンプレメモのバックアップではありません';
export const BACKUP_WRONG_APP_MSG = 'バックアップのアプリが違います';
export const BACKUP_NO_TEMPLATES_MSG = 'バックアップに使えるテンプレートがありません';
/** schema version 不一致（migration を持たないため fail-closed）。 */
export const backupSchemaMismatchMsg = (schemaVersion: unknown) =>
  `バックアップのスキーマ (v${typeof schemaVersion === 'number' ? schemaVersion : '?'}) がこのアプリ (v${SCHEMA_VERSION}) と一致しません`;
/** 最上位の配列欄の破損（動的な欄名を含むためビルダー関数にする）。 */
export const backupFieldBrokenMsg = (name: string) => `バックアップの ${name} が壊れています`;

// ============================
// 書き出し
// ============================

/** 全データを封筒に包んで JSON 文字列にする（人が中を確認できるよう整形出力）。 */
export function buildBackupJson(data: ReplaceAllData, nowMs = Date.now()): string {
  const bundle: BackupBundle = {
    kind: BACKUP_KIND,
    appId: APP_ID,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date(nowMs).toISOString(),
    settings: data.settings,
    places: data.places,
    patients: data.patients,
    frames: data.frames,
    formats: data.formats,
    templates: data.templates,
  };
  return JSON.stringify(bundle, null, 2);
}

// ============================
// 読み込み（検証つき）
// ============================

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** 文字列配列へ落とす（配列でなければ空・文字列以外の要素は捨てる）。 */
function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** place 1 件の正規化。placeId/name の型不正 row は捨てる。 */
function normalizePlaceRow(raw: unknown): PlaceDef | null {
  if (!isPlainObject(raw)) return null;
  if (typeof raw.placeId !== 'string' || raw.placeId === '') return null;
  if (typeof raw.name !== 'string') return null;
  return { placeId: raw.placeId, name: raw.name };
}

/**
 * patient 1 件の正規化。pid/name の型不正 row は捨て、それ以外の欄は型不正でも
 * 既定値へ倒して row を救う（status は isPatientStatus で検証し不正は「未」へ）。
 * placeId は存在する place だけを許し、迷子参照は先頭 place へ倒す。
 */
function normalizePatientRow(raw: unknown, places: readonly PlaceDef[]): Patient | null {
  if (!isPlainObject(raw)) return null;
  if (typeof raw.pid !== 'string' || raw.pid === '') return null;
  if (typeof raw.name !== 'string') return null;

  const placeId =
    typeof raw.placeId === 'string' && places.some((p) => p.placeId === raw.placeId)
      ? raw.placeId
      : (places[0]?.placeId ?? '');
  return {
    pid: raw.pid,
    name: raw.name,
    room: str(raw.room),
    placeId,
    status: isPatientStatus(raw.status) ? raw.status : STATUS.NONE,
    tags: stringArray(raw.tags),
    problems: stringArray(raw.problems),
    standingMemo: str(raw.standingMemo),
    // 場所ごとの自由本文は string 値のエントリだけを残す（store 経路と同じ whitelist）。
    sectionTexts: normalizeSectionTexts(raw.sectionTexts),
    // projectedValues の外側 2 層（placementId → itemId → 値）だけを検証する。値そのものは
    // 読み出し側の domain/formValues.ts の正規化ヘルパに委ねる（ここで形を断定せず、
    // 壊れ値は読み出し時に未入力へ倒れる）。
    projectedValues: normalizeProjectedValues(raw.projectedValues),
    updatedAt: num(raw.updatedAt),
    archivedAt: typeof raw.archivedAt === 'number' ? raw.archivedAt : null,
  };
}

/** tag 定義 1 件の正規化（settings 内の配列）。name の型不正 row は捨てる。 */
function normalizeTagRow(raw: unknown): TagDef | null {
  if (!isPlainObject(raw)) return null;
  if (typeof raw.name !== 'string' || raw.name.trim() === '') return null;
  return { name: raw.name, color: raw.color === 'amber' ? 'amber' : 'gray' };
}

/**
 * settings の正規化: 既定値の上に、型が合う欄だけを上書きマージする。
 * activeTemplateId は検証済み templates に実在するものだけを許し、
 * 無ければ先頭 template へ付け替える（active 不在の状態を作らない）。
 */
function normalizeSettings(raw: unknown, templates: readonly TemplateDef[]): AppSettings {
  const fallback = templates[0];
  if (!fallback) throw new Error(BACKUP_NO_TEMPLATES_MSG); // 呼び出し側で保証済みの防御
  const r = isPlainObject(raw) ? raw : {};
  const activeTemplateId =
    typeof r.activeTemplateId === 'string' && templates.some((t) => t.id === r.activeTemplateId)
      ? r.activeTemplateId
      : fallback.id;
  return {
    key: 'app',
    activeTemplateId,
    tags: (Array.isArray(r.tags) ? r.tags : [])
      .map(normalizeTagRow)
      .filter((t): t is TagDef => t !== null),
    newlineMode: r.newlineMode === 'lf' ? 'lf' : 'crlf',
    updatedAt: num(r.updatedAt),
  };
}

/**
 * バックアップ JSON を検証・正規化して復元用データにする（fail-closed）。
 * 封筒不一致・templates 全滅・最上位配列欄の破損は日本語 reason で throw する。
 * 返り値は store.replaceAll へそのまま渡せる。
 */
export function parseBackupJson(text: string): ReplaceAllData {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(BACKUP_JSON_UNREADABLE_MSG);
  }
  if (!isPlainObject(parsed)) throw new Error(BACKUP_MALFORMED_MSG);
  if (parsed.kind !== BACKUP_KIND) throw new Error(BACKUP_WRONG_KIND_MSG);
  if (parsed.appId !== APP_ID) throw new Error(BACKUP_WRONG_APP_MSG);
  if (parsed.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(backupSchemaMismatchMsg(parsed.schemaVersion));
  }

  if (!Array.isArray(parsed.frames)) throw new Error(backupFieldBrokenMsg('frames'));
  const frames = parsed.frames
    .map(normalizeFrame)
    .filter((frame): frame is Frame => frame !== null);

  if (!Array.isArray(parsed.formats)) throw new Error(backupFieldBrokenMsg('formats'));
  const formats = parsed.formats
    .map(normalizeFormat)
    .filter((format): format is Format => format !== null);

  // templates が全滅すると active テンプレート不在になるため、復元自体を中止する。
  if (!Array.isArray(parsed.templates)) throw new Error(backupFieldBrokenMsg('templates'));
  const templates = parsed.templates
    .map((row) => normalizeTemplateDef(row, { frames, formats }))
    .filter((template): template is TemplateDef => template !== null);
  if (templates.length === 0) throw new Error(BACKUP_NO_TEMPLATES_MSG);

  if (!Array.isArray(parsed.places)) throw new Error(backupFieldBrokenMsg('places'));
  const places = parsed.places.map(normalizePlaceRow).filter((g): g is PlaceDef => g !== null);

  if (!Array.isArray(parsed.patients)) throw new Error(backupFieldBrokenMsg('patients'));
  const patients = parsed.patients
    .map((row) => normalizePatientRow(row, places))
    .filter((s): s is Patient => s !== null);

  const settings = normalizeSettings(parsed.settings, templates);
  return { settings, patients, places, frames, formats, templates };
}

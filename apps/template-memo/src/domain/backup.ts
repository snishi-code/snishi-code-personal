/*
 * JSON バックアップ（全データの書き出し / 検証つき読み込み）。
 *
 * 封筒は kind / appId / schemaVersion で照合し、合わない JSON は fail-closed に拒否する
 * （medical 側 hospital-workspace/shared/workspaceBackup.ts の流儀を踏襲。zod は使わず手書き検証）。
 * schemaVersion は現行一致のみ受け付ける（migration step は持たない = constants の単発変換方式）。
 *
 * 中身の検証は 2 段構え:
 *   - templates: normalizeTemplate（domain/template.ts が正本）で正規化し、壊れは捨てる。
 *     全滅したら復元先が成立しないので throw（active テンプレート不在の状態を作らない）。
 *   - subjects / groups / settings: 1 件ずつ防御的に正規化する。id/name の型不正 row だけを
 *     捨てて生き残りを救い、row 内の配列/オブジェクト欄は型不正なら空に落とす。
 *
 * 参照整合はここで閉じる: settings.activeTemplateId が templates に無ければ先頭へ付け替え、
 * Subject.groupId が groups に無ければ未分類 (null) へ倒す。返り値はそのまま
 * store.replaceAll へ渡せる検証済みデータ（ReplaceAllData）。
 */

import { APP_ID, BACKUP_KIND, SCHEMA_VERSION } from '../data/constants';
import type { ReplaceAllData } from '../data/store';
import { normalizeTemplate, type Template } from './template';
import {
  isSubjectStatus,
  STATUS,
  type AppSettings,
  type FormValues,
  type Group,
  type RoundState,
  type Snippet,
  type Subject,
  type Tag,
} from './types';

// ============================
// 封筒（envelope）
// ============================

/** バックアップ JSON の封筒。kind/appId/schemaVersion が照合キー。 */
export interface BackupBundle {
  kind: typeof BACKUP_KIND;
  appId: typeof APP_ID;
  schemaVersion: number;
  /** 書き出し時刻（ISO 文字列。表示・ファイル整理用のメタで、検証キーではない）。 */
  exportedAt: string;
  settings: AppSettings;
  groups: Group[];
  subjects: Subject[];
  templates: Template[];
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
export function buildBackupJson(
  data: { settings: AppSettings; groups: Group[]; subjects: Subject[]; templates: Template[] },
  nowMs = Date.now(),
): string {
  const bundle: BackupBundle = {
    kind: BACKUP_KIND,
    appId: APP_ID,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date(nowMs).toISOString(),
    settings: data.settings,
    groups: data.groups,
    subjects: data.subjects,
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

/** group 1 件の正規化。id/name の型不正 row は捨てる。 */
function normalizeGroupRow(raw: unknown): Group | null {
  if (!isPlainObject(raw)) return null;
  if (typeof raw.id !== 'string' || raw.id === '') return null;
  if (typeof raw.name !== 'string') return null;
  return { id: raw.id, name: raw.name, sortOrder: num(raw.sortOrder) };
}

/**
 * subject 1 件の正規化。id/name の型不正 row は捨て、それ以外の欄は型不正でも
 * 既定値へ倒して row を救う（status は isSubjectStatus で検証し不正は「未」へ）。
 * groupId は存在する group だけを許し、迷子参照は未分類 (null) へ。
 */
function normalizeSubjectRow(raw: unknown, groupIds: ReadonlySet<string>): Subject | null {
  if (!isPlainObject(raw)) return null;
  if (typeof raw.id !== 'string' || raw.id === '') return null;
  if (typeof raw.name !== 'string') return null;

  const sectionText: Record<string, string> = {};
  if (isPlainObject(raw.sectionText)) {
    for (const [k, v] of Object.entries(raw.sectionText)) {
      if (typeof v === 'string') sectionText[k] = v;
    }
  }
  // formValues の外側 2 層（groupId → itemId → 値）だけを検証する。値そのものは
  // TextEntry / NumericEntry / legacy 文字列が混在し得るため、読み出し側の
  // domain/formValues.ts の正規化ヘルパに委ねる（ここで形を断定しない）。
  const formValues: FormValues = {};
  if (isPlainObject(raw.formValues)) {
    for (const [k, v] of Object.entries(raw.formValues)) {
      if (isPlainObject(v)) formValues[k] = { ...v };
    }
  }
  return {
    id: raw.id,
    name: raw.name,
    code: str(raw.code),
    location: str(raw.location),
    groupId: typeof raw.groupId === 'string' && groupIds.has(raw.groupId) ? raw.groupId : null,
    sortOrder: num(raw.sortOrder),
    status: isSubjectStatus(raw.status) ? raw.status : STATUS.NONE,
    problems: stringArray(raw.problems),
    handover: str(raw.handover),
    sectionText,
    formValues,
    confirmedNote: str(raw.confirmedNote),
    tagIds: stringArray(raw.tagIds),
    archivedAt: typeof raw.archivedAt === 'number' ? raw.archivedAt : null,
    createdAt: num(raw.createdAt),
    updatedAt: num(raw.updatedAt),
  };
}

/** tag 1 件の正規化（settings 内の配列）。id/name の型不正 row は捨てる。 */
function normalizeTagRow(raw: unknown): Tag | null {
  if (!isPlainObject(raw)) return null;
  if (typeof raw.id !== 'string' || raw.id === '') return null;
  if (typeof raw.name !== 'string') return null;
  return { id: raw.id, name: raw.name, sortOrder: num(raw.sortOrder) };
}

/** snippet 1 件の正規化（settings 内の配列)。id の型不正 row は捨てる。 */
function normalizeSnippetRow(raw: unknown): Snippet | null {
  if (!isPlainObject(raw)) return null;
  if (typeof raw.id !== 'string' || raw.id === '') return null;
  return { id: raw.id, label: str(raw.label), body: str(raw.body) };
}

/** round 状態の正規化。startedAt が数値でなければ「一度も開始していない」(null) へ。 */
function normalizeRound(raw: unknown): RoundState | null {
  if (!isPlainObject(raw)) return null;
  if (typeof raw.startedAt !== 'number') return null;
  return {
    startedAt: raw.startedAt,
    endedAt: typeof raw.endedAt === 'number' ? raw.endedAt : null,
  };
}

/**
 * settings の正規化: 既定値（data/store の defaultSettings と同形）の上に、型が合う欄だけを
 * 上書きマージする。activeTemplateId は検証済み templates に実在するものだけを許し、
 * 無ければ先頭 template へ付け替える（active 不在の状態を作らない）。
 */
function normalizeSettings(raw: unknown, templates: readonly Template[]): AppSettings {
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
      .filter((t): t is Tag => t !== null),
    snippets: (Array.isArray(r.snippets) ? r.snippets : [])
      .map(normalizeSnippetRow)
      .filter((s): s is Snippet => s !== null),
    newlineMode: r.newlineMode === 'lf' ? 'lf' : 'crlf',
    round: normalizeRound(r.round),
    onboardingDone: r.onboardingDone === true,
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

  // templates が全滅すると active テンプレート不在になるため、復元自体を中止する。
  if (!Array.isArray(parsed.templates)) throw new Error(backupFieldBrokenMsg('templates'));
  const templates = parsed.templates
    .map(normalizeTemplate)
    .filter((t): t is Template => t !== null);
  if (templates.length === 0) throw new Error(BACKUP_NO_TEMPLATES_MSG);

  if (!Array.isArray(parsed.groups)) throw new Error(backupFieldBrokenMsg('groups'));
  const groups = parsed.groups.map(normalizeGroupRow).filter((g): g is Group => g !== null);

  if (!Array.isArray(parsed.subjects)) throw new Error(backupFieldBrokenMsg('subjects'));
  const groupIds: ReadonlySet<string> = new Set(groups.map((g) => g.id));
  const subjects = parsed.subjects
    .map((row) => normalizeSubjectRow(row, groupIds))
    .filter((s): s is Subject => s !== null);

  const settings = normalizeSettings(parsed.settings, templates);
  return { settings, subjects, groups, templates };
}

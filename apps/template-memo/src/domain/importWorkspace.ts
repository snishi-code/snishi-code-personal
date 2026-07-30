/*
 * hospital-workspace の平文バックアップ → template-memo の単発・片道インポータ。
 *
 * これは同期・互換レイヤではない。移行元の現行 DB schema v7 だけを理解し、
 * template-memo へ追記できる中立型へ一度だけ変換する。暗号化バックアップは対象外
 * （旧アプリで平文を書き出し直してもらう）。患者ごとの「今回分」
 * (status / visitMemo / projectedValues / tags) は、テンプレート構造と意味が異なるため
 * 意図的に移行しない。
 */

import { newId } from '../data/constants';
import { STATUS, type Group, type Snippet, type Subject } from './types';

const WORKSPACE_BACKUP_KIND = 'HOSPITAL_WORKSPACE_BACKUP';
const WORKSPACE_BACKUP_ENCRYPTED_KIND = 'HOSPITAL_WORKSPACE_BACKUP_ENC';
const WORKSPACE_BACKUP_APP_ID = 'hospital-workspace';
const WORKSPACE_BACKUP_VERSION = 1;
/** 患者フラット化後の hospital-workspace DB schema。 */
const WORKSPACE_SCHEMA_VERSION = 7;

const STORE_APP_SETTINGS = 'appSettings';
const STORE_USERS = 'users';
const STORE_PATIENTS = 'patients';
const STORE_ROUNDS_USER_STATES = 'roundsUserStates';
const PLACES_CONFIG_KEY = 'placesConfig';
const ROUNDS_CONFIG_KEY = 'roundsConfig';

export const WORKSPACE_IMPORT_JSON_UNREADABLE_MSG = 'ワークスペースバックアップのJSONを読めません';
export const WORKSPACE_IMPORT_MALFORMED_MSG = 'ワークスペースバックアップの形式が不正です';
export const WORKSPACE_IMPORT_ENCRYPTED_MSG =
  '暗号化バックアップは移行できません。旧アプリで平文バックアップを書き出し直してください';
export const WORKSPACE_IMPORT_WRONG_KIND_MSG =
  'これは hospital-workspace の平文バックアップではありません';
export const WORKSPACE_IMPORT_WRONG_VERSION_MSG =
  'ワークスペースバックアップのバージョンが違います';
export const WORKSPACE_IMPORT_WRONG_APP_MSG = 'ワークスペースバックアップのアプリが違います';
export const WORKSPACE_IMPORT_USER_NOT_FOUND_MSG = '移行するユーザーがバックアップに見つかりません';
export const workspaceImportSchemaMismatchMsg = (schemaVersion: unknown) =>
  `ワークスペースバックアップのスキーマが v${typeof schemaVersion === 'number' ? schemaVersion : '?'} です（この移行ツールは v${WORKSPACE_SCHEMA_VERSION} 専用です）`;
export const workspaceImportStoreBrokenMsg = (name: string) =>
  `ワークスペースバックアップの ${name} が壊れています`;

export interface WorkspaceImportCandidate {
  id: string;
  name: string;
}

/** store へ全置換せず追記する永続化対象。 */
export interface WorkspaceImportPayload {
  subjects: Subject[];
  groups: Group[];
  snippets: Snippet[];
}

export type WorkspaceImportNote = 'closingPresetSkipped';

export interface WorkspaceImportData extends WorkspaceImportPayload {
  /** 移行しなかった設定など、確認画面に出せる非患者データの注記。 */
  notes: WorkspaceImportNote[];
}

interface WorkspaceBackup {
  stores: Record<string, unknown[]>;
}

interface ImportOptions {
  /** 壊れ row の timestamp fallback。テストから固定値を注入できる。 */
  nowMs?: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function finiteNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function parseWorkspaceBackup(json: string): WorkspaceBackup {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(WORKSPACE_IMPORT_JSON_UNREADABLE_MSG);
  }
  if (!isRecord(parsed)) throw new Error(WORKSPACE_IMPORT_MALFORMED_MSG);
  if (parsed.kind === WORKSPACE_BACKUP_ENCRYPTED_KIND) {
    throw new Error(WORKSPACE_IMPORT_ENCRYPTED_MSG);
  }
  if (parsed.kind !== WORKSPACE_BACKUP_KIND) {
    throw new Error(WORKSPACE_IMPORT_WRONG_KIND_MSG);
  }
  if (parsed.version !== WORKSPACE_BACKUP_VERSION) {
    throw new Error(WORKSPACE_IMPORT_WRONG_VERSION_MSG);
  }
  if (parsed.appId !== WORKSPACE_BACKUP_APP_ID) {
    throw new Error(WORKSPACE_IMPORT_WRONG_APP_MSG);
  }
  if (parsed.schemaVersion !== WORKSPACE_SCHEMA_VERSION) {
    throw new Error(workspaceImportSchemaMismatchMsg(parsed.schemaVersion));
  }
  if (!isRecord(parsed.stores)) throw new Error(WORKSPACE_IMPORT_MALFORMED_MSG);

  const stores: Record<string, unknown[]> = {};
  for (const [name, rows] of Object.entries(parsed.stores)) {
    if (!Array.isArray(rows)) throw new Error(workspaceImportStoreBrokenMsg(name));
    stores[name] = rows;
  }
  // buildWorkspaceBackup は全 store を必ず持つ。必要 store の欠落を空扱いすると、
  // 壊れたバックアップを「0件の移行成功」にしてしまうため fail-closed にする。
  for (const name of [STORE_APP_SETTINGS, STORE_USERS, STORE_PATIENTS, STORE_ROUNDS_USER_STATES]) {
    if (!Array.isArray(stores[name])) throw new Error(workspaceImportStoreBrokenMsg(name));
  }
  return { stores };
}

function candidatesFromBackup(backup: WorkspaceBackup): WorkspaceImportCandidate[] {
  const out: WorkspaceImportCandidate[] = [];
  const seen = new Set<string>();
  for (const raw of backup.stores[STORE_USERS] ?? []) {
    if (!isRecord(raw)) continue;
    if (typeof raw.id !== 'string' || raw.id === '' || seen.has(raw.id)) continue;
    if (typeof raw.name !== 'string' || raw.name.trim() === '') continue;
    seen.add(raw.id);
    out.push({ id: raw.id, name: raw.name.trim() });
  }
  return out;
}

/** バックアップ内のユーザー候補を列挙する。複数なら UI で 1 人を選ばせる。 */
export function listImportCandidates(json: string): WorkspaceImportCandidate[] {
  return candidatesFromBackup(parseWorkspaceBackup(json));
}

function settingsRow(backup: WorkspaceBackup, key: string): Record<string, unknown> | null {
  for (const raw of backup.stores[STORE_APP_SETTINGS] ?? []) {
    if (isRecord(raw) && raw.key === key) return raw;
  }
  return null;
}

/**
 * place 定義を同名でまとめ、新しい Group と placeId→groupId 対応表を作る。
 * 同名判定は前後空白を除いた完全一致。壊れた place row は捨てる。
 */
function convertGroups(backup: WorkspaceBackup): {
  groups: Group[];
  groupIdByPlaceId: Map<string, string>;
} {
  const groups: Group[] = [];
  const groupIdByName = new Map<string, string>();
  const groupIdByPlaceId = new Map<string, string>();
  const places = settingsRow(backup, PLACES_CONFIG_KEY);
  const rows = places && Array.isArray(places.items) ? places.items : [];

  for (const raw of rows) {
    if (!isRecord(raw)) continue;
    if (typeof raw.placeId !== 'string' || raw.placeId === '') continue;
    if (typeof raw.name !== 'string' || raw.name.trim() === '') continue;
    const name = raw.name.trim();
    let groupId = groupIdByName.get(name);
    if (!groupId) {
      groupId = newId('grp');
      groupIdByName.set(name, groupId);
      groups.push({ id: groupId, name, sortOrder: groups.length + 1 });
    }
    if (!groupIdByPlaceId.has(raw.placeId)) groupIdByPlaceId.set(raw.placeId, groupId);
  }
  return { groups, groupIdByPlaceId };
}

/**
 * 選択ユーザーの per-user 状態を patientId で引く。同一キーの重複があれば
 * updatedAt が新しい row を採用する。key があるのに正本形式と食い違う row は捨てる。
 */
function selectedStates(
  backup: WorkspaceBackup,
  userId: string,
): Map<string, Record<string, unknown>> {
  const states = new Map<string, Record<string, unknown>>();
  for (const raw of backup.stores[STORE_ROUNDS_USER_STATES] ?? []) {
    if (!isRecord(raw) || raw.userId !== userId) continue;
    if (typeof raw.patientId !== 'string' || raw.patientId === '') continue;
    const expectedKey = `${userId}::${raw.patientId}`;
    if (typeof raw.key !== 'string' || raw.key !== expectedKey) continue;
    const previous = states.get(raw.patientId);
    const previousAt = finiteNumber(previous?.updatedAt) ?? 0;
    const nextAt = finiteNumber(raw.updatedAt) ?? 0;
    if (!previous || nextAt >= previousAt) states.set(raw.patientId, raw);
  }
  return states;
}

function stringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.trimEnd())
    .filter((x) => x.trim() !== '');
}

function convertSubjects(
  backup: WorkspaceBackup,
  userId: string,
  groupIdByPlaceId: ReadonlyMap<string, string>,
  nowMs: number,
): Subject[] {
  const states = selectedStates(backup, userId);
  const subjects: Subject[] = [];
  const seenPatientIds = new Set<string>();
  const nextOrder = new Map<string, number>();

  for (const raw of backup.stores[STORE_PATIENTS] ?? []) {
    if (!isRecord(raw)) continue;
    if (
      typeof raw.patientId !== 'string' ||
      raw.patientId === '' ||
      seenPatientIds.has(raw.patientId)
    ) {
      continue;
    }
    if (typeof raw.name !== 'string' || raw.name.trim() === '') continue;
    seenPatientIds.add(raw.patientId);

    const groupId =
      typeof raw.placeId === 'string' ? (groupIdByPlaceId.get(raw.placeId) ?? null) : null;
    const orderKey = groupId ?? '__ungrouped__';
    const sortOrder = (nextOrder.get(orderKey) ?? 0) + 1;
    nextOrder.set(orderKey, sortOrder);

    const state = states.get(raw.patientId);
    const createdAt = finiteNumber(raw.createdAt) ?? nowMs;
    const updatedAt = Math.max(
      createdAt,
      finiteNumber(raw.updatedAt) ?? 0,
      finiteNumber(state?.updatedAt) ?? 0,
    );
    const archivedAt = finiteNumber(raw.archivedAt);
    subjects.push({
      id: newId('sub'),
      name: raw.name,
      // 指示書どおり移行元の患者IDを管理IDへ持ち込む。
      code: raw.patientId,
      location: typeof raw.room === 'string' ? raw.room : '',
      groupId,
      sortOrder,
      status: STATUS.NONE,
      problems: stringList(raw.problems),
      // 現行 source の「継続メモ」は RoundsPatientState.standingMemo。
      handover: typeof state?.standingMemo === 'string' ? state.standingMemo : '',
      // visitMemo / projectedValues は「今回分」かつテンプレ構造が異なるため移行しない。
      sectionText: {},
      formValues: {},
      confirmedNote: typeof state?.confirmedNote === 'string' ? state.confirmedNote : '',
      tagIds: [],
      archivedAt: archivedAt !== null && archivedAt > 0 ? archivedAt : null,
      createdAt,
      updatedAt,
    });
  }
  return subjects;
}

function convertSnippets(backup: WorkspaceBackup): {
  snippets: Snippet[];
  notes: WorkspaceImportNote[];
} {
  const config = settingsRow(backup, ROUNDS_CONFIG_KEY);
  const snippets: Snippet[] = [];
  const rows = config && Array.isArray(config.textSnippets) ? config.textSnippets : [];
  for (const raw of rows) {
    if (!isRecord(raw)) continue;
    if (typeof raw.label !== 'string' || raw.label.trim() === '') continue;
    snippets.push({
      id: newId('snp'),
      label: raw.label.trim(),
      body: typeof raw.body === 'string' ? raw.body : '',
    });
  }
  const notes: WorkspaceImportNote[] = [];
  if (config && typeof config.closingPreset === 'string' && config.closingPreset.trim() !== '') {
    notes.push('closingPresetSkipped');
  }
  return { snippets, notes };
}

/**
 * 選択した 1 ユーザー分を template-memo の追記用データへ変換する。
 * 入力 JSON は変更せず、返り値の ID はすべて新規採番する。
 */
export function convertWorkspaceBackup(
  json: string,
  userId: string,
  options: ImportOptions = {},
): WorkspaceImportData {
  const backup = parseWorkspaceBackup(json);
  const candidates = candidatesFromBackup(backup);
  if (!candidates.some((user) => user.id === userId)) {
    throw new Error(WORKSPACE_IMPORT_USER_NOT_FOUND_MSG);
  }
  const nowMs = finiteNumber(options.nowMs) ?? Date.now();
  const { groups, groupIdByPlaceId } = convertGroups(backup);
  const { snippets, notes } = convertSnippets(backup);
  return {
    groups,
    subjects: convertSubjects(backup, userId, groupIdByPlaceId, nowMs),
    snippets,
    notes,
  };
}

/**
 * 既存データへ安全に追記できるよう、ID衝突・参照を検証して並び順を末尾へ補正する。
 * 返すのは incoming 側だけで、既存データ自体は含めない・変更しない。
 */
export function prepareWorkspaceImportAppend(
  incoming: WorkspaceImportPayload,
  current: WorkspaceImportPayload,
): WorkspaceImportPayload {
  const idSets: Array<[string[], Set<string>]> = [
    [incoming.groups.map((row) => row.id), new Set(current.groups.map((row) => row.id))],
    [incoming.subjects.map((row) => row.id), new Set(current.subjects.map((row) => row.id))],
    [incoming.snippets.map((row) => row.id), new Set(current.snippets.map((row) => row.id))],
  ];
  if (
    idSets.some(
      ([ids, existing]) => new Set(ids).size !== ids.length || ids.some((id) => existing.has(id)),
    )
  ) {
    throw new Error('import id collision');
  }

  const importedGroupIds = new Set(incoming.groups.map((group) => group.id));
  if (
    incoming.subjects.some((subject) => subject.groupId && !importedGroupIds.has(subject.groupId))
  ) {
    throw new Error('import group reference is invalid');
  }

  const groupOffset = Math.max(0, ...current.groups.map((group) => group.sortOrder));
  const subjectOffsets = new Map<string, number>();
  for (const subject of current.subjects) {
    const key = subject.groupId ?? '';
    subjectOffsets.set(key, Math.max(subjectOffsets.get(key) ?? 0, subject.sortOrder));
  }
  return {
    groups: incoming.groups.map((group) => ({
      ...group,
      sortOrder: group.sortOrder + groupOffset,
    })),
    subjects: incoming.subjects.map((subject) => ({
      ...subject,
      sortOrder: subject.sortOrder + (subjectOffsets.get(subject.groupId ?? '') ?? 0),
    })),
    snippets: [...incoming.snippets],
  };
}

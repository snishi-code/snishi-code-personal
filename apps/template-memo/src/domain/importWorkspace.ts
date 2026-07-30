/*
 * hospital-workspace の平文バックアップ → template-memo の単発・片道インポータ。
 *
 * これは同期・互換レイヤではない。移行元の現行 DB schema v7 だけを理解し、
 * template-memo へ追記できる形へ一度だけ変換する。暗号化バックアップは対象外
 * （旧アプリで平文を書き出し直してもらう）。患者ごとの「今回分」
 * (status / visitMemo / projectedValues / tags) は意味が異なるため意図的に移行しない。
 * 旧「患者ID」(code 概念) はこのアプリに無いので落とす。
 */

import { newId } from '../data/constants';
import { STATUS, type Patient, type PlaceDef, type Snippet } from './types';
import { makeDefaultPatient } from './normalize';

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
const WORKSPACE_IMPORT_MALFORMED_MSG = 'ワークスペースバックアップの形式が不正です';
export const WORKSPACE_IMPORT_ENCRYPTED_MSG =
  '暗号化バックアップは移行できません。旧アプリで平文バックアップを書き出し直してください';
const WORKSPACE_IMPORT_WRONG_KIND_MSG =
  'これは hospital-workspace の平文バックアップではありません';
const WORKSPACE_IMPORT_WRONG_VERSION_MSG = 'ワークスペースバックアップのバージョンが違います';
const WORKSPACE_IMPORT_WRONG_APP_MSG = 'ワークスペースバックアップのアプリが違います';
export const WORKSPACE_IMPORT_USER_NOT_FOUND_MSG = '移行するユーザーがバックアップに見つかりません';
export const workspaceImportSchemaMismatchMsg = (schemaVersion: unknown) =>
  `ワークスペースバックアップのスキーマが v${typeof schemaVersion === 'number' ? schemaVersion : '?'} です（この移行ツールは v${WORKSPACE_SCHEMA_VERSION} 専用です）`;
const workspaceImportStoreBrokenMsg = (name: string) =>
  `ワークスペースバックアップの ${name} が壊れています`;

export interface WorkspaceImportCandidate {
  id: string;
  name: string;
}

/** store へ全置換せず追記する永続化対象。 */
export interface WorkspaceImportPayload {
  patients: Patient[];
  places: PlaceDef[];
  snippets: Snippet[];
}

type WorkspaceImportNote = 'closingPresetSkipped';

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
 * place 定義を同名でまとめ、新しい PlaceDef と 旧placeId→新placeId 対応表を作る。
 * 同名判定は前後空白を除いた完全一致。壊れた place row は捨てる。
 */
function convertPlaces(backup: WorkspaceBackup): {
  places: PlaceDef[];
  placeIdByOldId: Map<string, string>;
} {
  const places: PlaceDef[] = [];
  const placeIdByName = new Map<string, string>();
  const placeIdByOldId = new Map<string, string>();
  const config = settingsRow(backup, PLACES_CONFIG_KEY);
  const rows = config && Array.isArray(config.items) ? config.items : [];

  for (const raw of rows) {
    if (!isRecord(raw)) continue;
    if (typeof raw.placeId !== 'string' || raw.placeId === '') continue;
    if (typeof raw.name !== 'string' || raw.name.trim() === '') continue;
    const name = raw.name.trim();
    let placeId = placeIdByName.get(name);
    if (!placeId) {
      placeId = newId('plc');
      placeIdByName.set(name, placeId);
      places.push({ placeId, name });
    }
    if (!placeIdByOldId.has(raw.placeId)) placeIdByOldId.set(raw.placeId, placeId);
  }
  return { places, placeIdByOldId };
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

function convertPatients(
  backup: WorkspaceBackup,
  userId: string,
  placeIdByOldId: ReadonlyMap<string, string>,
  nowMs: number,
): Patient[] {
  const states = selectedStates(backup, userId);
  const patients: Patient[] = [];
  const seenPatientIds = new Set<string>();

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

    const placeId = typeof raw.placeId === 'string' ? (placeIdByOldId.get(raw.placeId) ?? '') : '';

    const state = states.get(raw.patientId);
    const createdAt = finiteNumber(raw.createdAt) ?? nowMs;
    const updatedAt = Math.max(
      createdAt,
      finiteNumber(raw.updatedAt) ?? 0,
      finiteNumber(state?.updatedAt) ?? 0,
    );
    const archivedAt = finiteNumber(raw.archivedAt);
    const confirmedNote = typeof state?.confirmedNote === 'string' ? state.confirmedNote : '';
    patients.push({
      ...makeDefaultPatient(),
      pid: newId('pat'),
      name: raw.name,
      room: typeof raw.room === 'string' ? raw.room : '',
      placeId,
      status: STATUS.NONE,
      problems: stringList(raw.problems),
      // 現行 source の「継続メモ」は RoundsPatientState.standingMemo。
      standingMemo: typeof state?.standingMemo === 'string' ? state.standingMemo : '',
      // visitMemo / projectedValues / tags は「今回分・個人分」のため移行しない。
      ...(confirmedNote !== '' ? { confirmedNote } : {}),
      archivedAt: archivedAt !== null && archivedAt > 0 ? archivedAt : null,
      updatedAt,
    });
  }
  return patients;
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
  const { places, placeIdByOldId } = convertPlaces(backup);
  const { snippets, notes } = convertSnippets(backup);
  return {
    places,
    patients: convertPatients(backup, userId, placeIdByOldId, nowMs),
    snippets,
    notes,
  };
}

/**
 * 既存データへ安全に追記できるよう、ID衝突・参照を検証する。
 * 返すのは incoming 側だけで、既存データ自体は含めない・変更しない。
 */
export function prepareWorkspaceImportAppend(
  incoming: WorkspaceImportPayload,
  current: WorkspaceImportPayload,
): WorkspaceImportPayload {
  const idSets: Array<[string[], Set<string>]> = [
    [incoming.places.map((row) => row.placeId), new Set(current.places.map((row) => row.placeId))],
    [incoming.patients.map((row) => row.pid), new Set(current.patients.map((row) => row.pid))],
    [incoming.snippets.map((row) => row.id), new Set(current.snippets.map((row) => row.id))],
  ];
  if (
    idSets.some(
      ([ids, existing]) => new Set(ids).size !== ids.length || ids.some((id) => existing.has(id)),
    )
  ) {
    throw new Error('import id collision');
  }

  const importedPlaceIds = new Set(incoming.places.map((place) => place.placeId));
  if (
    incoming.patients.some((patient) => patient.placeId && !importedPlaceIds.has(patient.placeId))
  ) {
    throw new Error('import place reference is invalid');
  }

  return {
    places: [...incoming.places],
    patients: [...incoming.patients],
    snippets: [...incoming.snippets],
  };
}

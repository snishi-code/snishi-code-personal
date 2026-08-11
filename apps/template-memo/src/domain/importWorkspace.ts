/*
 * hospital-workspace のバックアップ → template-memo の単発・片道インポータ。
 *
 * これは同期・互換レイヤではない。移行元の現行 DB schema v7 だけを理解し、
 * template-memo へ追記できる形へ一度だけ変換する。移行元は監査 H-3 で平文書き出しを
 * 廃止しているため、暗号化封筒 (HOSPITAL_WORKSPACE_BACKUP_ENC v1) をパスフレーズで
 * 復号してから読む経路を持つ（旧い平文封筒も引き続き受け付ける）。
 * 患者ごとの「今回分」(status / sectionTexts / projectedValues / tags) は意味が異なるため
 * 意図的に移行しない。旧「患者ID」(code 概念) はこのアプリに無いので落とす。
 *
 * ────────────────────────────────────────────────────────────────
 * 削除手順マニフェスト（移行が済んだらこの順で丸ごと消せる。作法は medical の
 * site/migrate-rounds と同じ。DB_VERSION / SCHEMA_VERSION には一切触れていないので、
 * 削除しても既存データの読み書きには影響しない）
 *
 *   1. src/domain/importWorkspace.ts          （このファイル。丸ごと削除）
 *   2. src/domain/importWorkspace.test.ts     （丸ごと削除）
 *   3. src/domain/importWorkspaceStore.test.ts（丸ごと削除）
 *   4. src/ui/settings/WorkspaceImportSection.tsx（丸ごと削除）
 *   5. src/ui/settings/SettingsView.tsx        （import 1行 + JSX 1行 を削除。
 *        どちらにも「一時:」マーカーのコメントが添えてあるので一緒に消す。
 *        冒頭の説明文からも「ワークスペース移行」の記述を落とす）
 *   6. 残りの参照を 3 ファイルから削除
 *        - src/i18n/rounds.ts   : settings.workspaceImport ブロック
 *        - src/ui-contract.ts   : UI.settings の workspaceImport* 5 件
 *        - src/data/store.ts    : appendImported（先頭の import 行 /
 *                                  HrStore interface の宣言 / 実装。import と実装は
 *                                  「一時: ワークスペース移行専用」フェンスで囲ってある）
 * ────────────────────────────────────────────────────────────────
 */

import { isEncrypted, unpackPayload } from '@snishi/foundation/qr/crypto';
import { newId } from '../data/constants';
import { STATUS, type Patient, type PlaceDef } from './types';
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
  '暗号化バックアップです。パスフレーズを入力して復号してください';
const WORKSPACE_IMPORT_WRONG_KIND_MSG =
  'これは hospital-workspace の平文バックアップではありません';
const WORKSPACE_IMPORT_WRONG_VERSION_MSG = 'ワークスペースバックアップのバージョンが違います';
const WORKSPACE_IMPORT_WRONG_APP_MSG = 'ワークスペースバックアップのアプリが違います';
export const WORKSPACE_IMPORT_USER_NOT_FOUND_MSG = '移行するユーザーがバックアップに見つかりません';
export const WORKSPACE_IMPORT_ID_COLLISION_MSG =
  '移行データのIDが既存データと衝突しています（移行を中止しました）';
export const WORKSPACE_IMPORT_PLACE_REF_INVALID_MSG =
  '移行データのグループ参照が壊れています（移行を中止しました）';
export const workspaceImportSchemaMismatchMsg = (schemaVersion: unknown) =>
  `ワークスペースバックアップのスキーマが v${typeof schemaVersion === 'number' ? schemaVersion : '?'} です（この移行ツールは v${WORKSPACE_SCHEMA_VERSION} 専用です）`;
const workspaceImportStoreBrokenMsg = (name: string) =>
  `ワークスペースバックアップの ${name} が壊れています`;

// ============================
// 暗号化封筒 (HOSPITAL_WORKSPACE_BACKUP_ENC v1) の復号
//
// 移植元 = snishi-code-medical/apps/hospital-workspace/src/shared/backupCrypto.ts。
// 鍵導出 (PBKDF2-SHA256 / 256bit) と base64url デコードをそのまま写し、本文の復号は
// foundation qr/crypto の unpackPayload (AES-GCM + DEFLATE raw・E2/E1) を使う
// (両 repo でバイト同一)。書き出し側は持たない = ここは読み取り専用。
// fail-closed: 封筒は strict 検証し、復号失敗は種類を漏らさず 1 種類の文言へ丸める。
// ============================

const WORKSPACE_BACKUP_KDF_ALGO = 'PBKDF2-SHA256';
/** 異常値による DoS を防ぐ復号側の上限 (移植元と同値)。 */
const WORKSPACE_BACKUP_KDF_ITERATIONS_MAX = 10_000_000;
/** base64url (RFC 4648 §5)。移植元の書き出しは padding なし。 */
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

export const WORKSPACE_IMPORT_NOT_ENCRYPTED_MSG =
  'これは暗号化ワークスペースバックアップではありません';
export const WORKSPACE_IMPORT_ENC_PARAMS_INVALID_MSG = 'バックアップの暗号化パラメータが不正です';
export const WORKSPACE_IMPORT_ENC_BODY_MISSING_MSG = 'バックアップの本文がありません';
export const WORKSPACE_IMPORT_DECRYPT_FAILED_MSG =
  'バックアップを復号できません。パスフレーズが違うか、ファイルが壊れています';
export const WORKSPACE_IMPORT_PASSPHRASE_REQUIRED_MSG = 'パスフレーズを入力してください';

function b64UrlToBytes(str: string): Uint8Array {
  let s = String(str || '')
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveKeyBytes(
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    // WebCrypto は SharedArrayBuffer 背景の view を受けないためコピーで非共有を保証する。
    { name: 'PBKDF2', hash: 'SHA-256', salt: new Uint8Array(salt), iterations },
    baseKey,
    256,
  );
  return new Uint8Array(bits);
}

interface EncryptedWorkspaceEnvelope {
  iterations: number;
  salt: string;
  data: string;
}

/** 暗号化封筒の strict 検証 (復号はしない)。 */
function validateEncryptedEnvelope(parsed: unknown): EncryptedWorkspaceEnvelope {
  if (!isRecord(parsed)) throw new Error(WORKSPACE_IMPORT_MALFORMED_MSG);
  if (parsed.kind !== WORKSPACE_BACKUP_ENCRYPTED_KIND) {
    throw new Error(WORKSPACE_IMPORT_NOT_ENCRYPTED_MSG);
  }
  if (parsed.version !== WORKSPACE_BACKUP_VERSION) {
    throw new Error(WORKSPACE_IMPORT_WRONG_VERSION_MSG);
  }
  if (parsed.appId !== WORKSPACE_BACKUP_APP_ID) {
    throw new Error(WORKSPACE_IMPORT_WRONG_APP_MSG);
  }
  const kdf = parsed.kdf;
  if (
    !isRecord(kdf) ||
    kdf.algo !== WORKSPACE_BACKUP_KDF_ALGO ||
    typeof kdf.iterations !== 'number' ||
    !Number.isInteger(kdf.iterations) ||
    kdf.iterations <= 0 ||
    kdf.iterations > WORKSPACE_BACKUP_KDF_ITERATIONS_MAX ||
    typeof kdf.salt !== 'string' ||
    !BASE64URL_RE.test(kdf.salt)
  ) {
    throw new Error(WORKSPACE_IMPORT_ENC_PARAMS_INVALID_MSG);
  }
  if (typeof parsed.data !== 'string' || !parsed.data) {
    throw new Error(WORKSPACE_IMPORT_ENC_BODY_MISSING_MSG);
  }
  // unpackPayload は prefix の無い文字列を「平文」として素通しする。暗号文であることを
  // ここで要求しないと、data を平文に差し替えた封筒がパスフレーズ無しで通ってしまう。
  if (!isEncrypted(parsed.data)) {
    throw new Error(WORKSPACE_IMPORT_ENC_PARAMS_INVALID_MSG);
  }
  return { iterations: kdf.iterations, salt: kdf.salt, data: parsed.data };
}

/**
 * 読み込んだファイルの種別判定。暗号化封筒なら 'encrypted'、それ以外 (旧平文封筒を含む)
 * は 'plain' を返し、中身の検証は既存の同期経路へ委ねる。JSON として読めなければ throw。
 */
export function detectWorkspaceBackupFile(json: string): 'encrypted' | 'plain' {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(WORKSPACE_IMPORT_JSON_UNREADABLE_MSG);
  }
  return isRecord(parsed) && parsed.kind === WORKSPACE_BACKUP_ENCRYPTED_KIND
    ? 'encrypted'
    : 'plain';
}

/**
 * 暗号化封筒をパスフレーズで復号し、中身の平文封筒 JSON 文字列を返す。
 * 返り値はそのまま listImportCandidates / convertWorkspaceBackup へ渡せる
 * (中身の検証はそちらの責務 = 二重に持たない)。
 * パスフレーズ不一致・改ざん・鍵導出不能はすべて同じ 1 文言へ丸める (oracle を作らない)。
 */
export async function decryptWorkspaceBackupJson(
  json: string,
  passphrase: string,
): Promise<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(WORKSPACE_IMPORT_JSON_UNREADABLE_MSG);
  }
  const env = validateEncryptedEnvelope(parsed);
  if (typeof passphrase !== 'string' || passphrase === '') {
    throw new Error(WORKSPACE_IMPORT_PASSPHRASE_REQUIRED_MSG);
  }
  try {
    const keyBytes = await deriveKeyBytes(passphrase, b64UrlToBytes(env.salt), env.iterations);
    return await unpackPayload(env.data, { keyBytes });
  } catch {
    throw new Error(WORKSPACE_IMPORT_DECRYPT_FAILED_MSG);
  }
}

export interface WorkspaceImportCandidate {
  id: string;
  name: string;
}

/** store へ全置換せず追記する永続化対象。 */
export interface WorkspaceImportPayload {
  patients: Patient[];
  places: PlaceDef[];
}

type WorkspaceImportNote = 'closingPresetSkipped';

export interface WorkspaceImportData extends WorkspaceImportPayload {
  /** 移行しなかった設定など、確認画面に出せる非患者データの注記。 */
  notes: WorkspaceImportNote[];
  /**
   * 継続メモは per-user なので、選択しなかったユーザーのぶんは落ちる。
   * 黙って捨てないよう、落ちる継続メモ (trim 非空) の件数を確認画面へ渡す。
   */
  otherUserStandingMemoCount: number;
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
): { patients: Patient[]; sourcePatientIds: Set<string> } {
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
      // sectionTexts / projectedValues / tags は「今回分・個人分」のため移行しない。
      archivedAt: archivedAt !== null && archivedAt > 0 ? archivedAt : null,
      updatedAt,
    });
  }
  return { patients, sourcePatientIds: seenPatientIds };
}

/**
 * 選択ユーザー以外が持つ「継続メモ」の件数。移行対象になった患者 (sourcePatientIds) に
 * 紐づく row だけを数え、同一 (userId, patientId) は 1 件に畳む。
 */
function countOtherUserStandingMemos(
  backup: WorkspaceBackup,
  userId: string,
  sourcePatientIds: ReadonlySet<string>,
): number {
  const seenKeys = new Set<string>();
  for (const raw of backup.stores[STORE_ROUNDS_USER_STATES] ?? []) {
    if (!isRecord(raw)) continue;
    if (typeof raw.userId !== 'string' || raw.userId === '' || raw.userId === userId) continue;
    if (typeof raw.patientId !== 'string' || !sourcePatientIds.has(raw.patientId)) continue;
    if (typeof raw.key !== 'string' || raw.key !== `${raw.userId}::${raw.patientId}`) continue;
    if (typeof raw.standingMemo !== 'string' || raw.standingMemo.trim() === '') continue;
    seenKeys.add(raw.key);
  }
  return seenKeys.size;
}

function importNotes(backup: WorkspaceBackup): WorkspaceImportNote[] {
  const config = settingsRow(backup, ROUNDS_CONFIG_KEY);
  const notes: WorkspaceImportNote[] = [];
  if (config && typeof config.closingPreset === 'string' && config.closingPreset.trim() !== '') {
    notes.push('closingPresetSkipped');
  }
  return notes;
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
  const { patients, sourcePatientIds } = convertPatients(backup, userId, placeIdByOldId, nowMs);
  return {
    places,
    patients,
    notes: importNotes(backup),
    otherUserStandingMemoCount: countOtherUserStandingMemos(backup, userId, sourcePatientIds),
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
  ];
  if (
    idSets.some(
      ([ids, existing]) => new Set(ids).size !== ids.length || ids.some((id) => existing.has(id)),
    )
  ) {
    throw new Error(WORKSPACE_IMPORT_ID_COLLISION_MSG);
  }

  const importedPlaceIds = new Set(incoming.places.map((place) => place.placeId));
  if (
    incoming.patients.some((patient) => patient.placeId && !importedPlaceIds.has(patient.placeId))
  ) {
    throw new Error(WORKSPACE_IMPORT_PLACE_REF_INVALID_MSG);
  }

  return {
    places: [...incoming.places],
    patients: [...incoming.patients],
  };
}

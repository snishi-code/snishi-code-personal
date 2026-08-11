import { describe, expect, it } from 'vitest';
import { packPayload } from '@snishi/foundation/qr/crypto';
import {
  WORKSPACE_IMPORT_DECRYPT_FAILED_MSG,
  WORKSPACE_IMPORT_ENCRYPTED_MSG,
  WORKSPACE_IMPORT_ENC_PARAMS_INVALID_MSG,
  WORKSPACE_IMPORT_ID_COLLISION_MSG,
  WORKSPACE_IMPORT_JSON_UNREADABLE_MSG,
  WORKSPACE_IMPORT_NOT_ENCRYPTED_MSG,
  WORKSPACE_IMPORT_PASSPHRASE_REQUIRED_MSG,
  WORKSPACE_IMPORT_PLACE_REF_INVALID_MSG,
  WORKSPACE_IMPORT_USER_NOT_FOUND_MSG,
  convertWorkspaceBackup,
  decryptWorkspaceBackupJson,
  detectWorkspaceBackupFile,
  listImportCandidates,
  prepareWorkspaceImportAppend,
  workspaceImportSchemaMismatchMsg,
} from './importWorkspace';
import { STATUS } from './types';

const NOW = 1_800_000_000_000;

/** medical 側 buildWorkspaceBackup の envelope / DB schema v7 に沿う合成 fixture。 */
function makeWorkspaceBackup(): Record<string, unknown> {
  return {
    kind: 'HOSPITAL_WORKSPACE_BACKUP',
    version: 1,
    appId: 'hospital-workspace',
    createdAt: '2026-07-30T00:00:00.000Z',
    schemaVersion: 7,
    source: { appVersion: 'test' },
    stores: {
      appSettings: [
        { key: 'app', activeSurface: 'rounds', activeUserId: 'usr_a' },
        {
          key: 'placesConfig',
          items: [
            { placeId: 'place_1', name: '東エリア', showNextVisit: false },
            { placeId: 'place_2', name: '東エリア', showNextVisit: true },
            { placeId: 'place_3', name: '西エリア', showNextVisit: false },
          ],
          updatedAt: 10,
        },
        {
          key: 'roundsConfig',
          aiTemplate: { fixedFields: [] },
          templateRevision: 3,
          closingPreset: 'A: 著変なし',
          updatedAt: 20,
        },
      ],
      users: [
        {
          id: 'usr_a',
          name: '利用者A',
          role: 'member',
          createdAt: 1,
          passhash: null,
        },
        {
          id: 'usr_b',
          name: '利用者B',
          role: 'member',
          createdAt: 2,
          passhash: null,
        },
      ],
      patients: [
        {
          patientId: 'pt_1',
          name: 'サンプル対象1',
          room: 'A-01',
          placeId: 'place_1',
          problems: ['継続課題', '', 42],
          sharedTags: ['移行しない'],
          archivedAt: 777,
          createdAt: 100,
          updatedAt: 110,
        },
        {
          patientId: 'pt_2',
          name: 'サンプル対象2',
          room: 'B-02',
          placeId: 'place_2',
          problems: [],
          createdAt: 200,
          updatedAt: 210,
        },
        {
          patientId: 'pt_3',
          name: 'サンプル対象3',
          room: '',
          placeId: 'missing_place',
          problems: ['確認事項'],
          createdAt: 300,
        },
      ],
      roundsUserStates: [
        {
          key: 'usr_a::pt_1',
          userId: 'usr_a',
          patientId: 'pt_1',
          status: 'green',
          standingMemo: 'Aの継続メモ',
          confirmedNote: 'Aの清書',
          projectedValues: { 'fixed:x': '移行しない' },
          tags: ['移行しない'],
          updatedAt: 120,
        },
        {
          key: 'usr_b::pt_1',
          userId: 'usr_b',
          patientId: 'pt_1',
          status: 'blue',
          standingMemo: 'Bの継続メモ',
          confirmedNote: 'Bの清書',
          projectedValues: {},
          tags: [],
          updatedAt: 130,
        },
        {
          key: 'usr_a::pt_2',
          userId: 'usr_a',
          patientId: 'pt_2',
          status: 'yellow',
          standingMemo: '対象2の継続メモ',
          projectedValues: { x: '破棄' },
          tags: ['破棄'],
          updatedAt: 220,
        },
      ],
      noteDocuments: [],
      noteSettings: [],
      roundsUserSettings: [],
    },
    localStorage: { current_user_id: 'usr_a' },
    counts: {},
  };
}

function jsonOf(value: unknown): string {
  return JSON.stringify(value);
}

describe('listImportCandidates', () => {
  it('バックアップの有効なユーザーを列挙し、複数ユーザーを選択可能にする', () => {
    expect(listImportCandidates(jsonOf(makeWorkspaceBackup()))).toEqual([
      { id: 'usr_a', name: '利用者A' },
      { id: 'usr_b', name: '利用者B' },
    ]);
  });

  it('壊れた user row と重複 id を捨てる', () => {
    const backup = makeWorkspaceBackup();
    const stores = backup.stores as Record<string, unknown[]>;
    (stores.users ??= []).push(
      null,
      { id: '', name: '壊れ' },
      { id: 'usr_bad' },
      { id: 'usr_a', name: '重複' },
    );
    expect(listImportCandidates(jsonOf(backup))).toEqual([
      { id: 'usr_a', name: '利用者A' },
      { id: 'usr_b', name: '利用者B' },
    ]);
  });
});

describe('convertWorkspaceBackup', () => {
  it('place 同名を 1 つにまとめ、選択ユーザーの継続メモだけを移行する', () => {
    const converted = convertWorkspaceBackup(jsonOf(makeWorkspaceBackup()), 'usr_a', {
      nowMs: NOW,
    });

    expect(converted.places.map((place) => place.name)).toEqual(['東エリア', '西エリア']);
    const east = converted.places[0];
    expect(east).toBeDefined();

    expect(converted.patients).toHaveLength(3);
    const first = converted.patients.find((patient) => patient.name === 'サンプル対象1');
    const second = converted.patients.find((patient) => patient.name === 'サンプル対象2');
    const third = converted.patients.find((patient) => patient.name === 'サンプル対象3');
    expect(first).toMatchObject({
      name: 'サンプル対象1',
      room: 'A-01',
      placeId: east?.placeId,
      status: STATUS.NONE,
      problems: ['継続課題'],
      sectionTexts: {},
      standingMemo: 'Aの継続メモ',
      tags: [],
      projectedValues: {},
      archivedAt: 777,
      updatedAt: 120,
    });
    expect(second).toMatchObject({
      placeId: east?.placeId,
      standingMemo: '対象2の継続メモ',
    });
    expect(third).toMatchObject({
      placeId: '',
      problems: ['確認事項'],
      standingMemo: '',
    });
    expect(converted.patients.every((patient) => patient.pid.startsWith('pat_'))).toBe(true);
    // 旧「患者ID」(code 概念) は持ち込まない。
    expect(JSON.stringify(converted.patients)).not.toContain('pt_1');
    expect(JSON.stringify(converted.patients)).not.toContain('fixed:x');
    expect(JSON.stringify(converted.patients)).not.toContain('sharedTags');
    // 清書 (confirmedNote) は本体廃止済み。旧バックアップにあっても持ち込まない。
    expect(JSON.stringify(converted.patients)).not.toContain('confirmedNote');
    expect(JSON.stringify(converted.patients)).not.toContain('Aの清書');
  });

  it('ユーザー選択で per-user の継続メモが切り替わる', () => {
    const converted = convertWorkspaceBackup(jsonOf(makeWorkspaceBackup()), 'usr_b', {
      nowMs: NOW,
    });
    const first = converted.patients.find((patient) => patient.name === 'サンプル対象1');
    expect(first?.standingMemo).toBe('Bの継続メモ');
    // usr_b の状態が無い対象は master だけを移し、個人メモは空。
    expect(
      converted.patients.find((patient) => patient.name === 'サンプル対象2')?.standingMemo,
    ).toBe('');
  });

  it('選択しなかったユーザーの継続メモ件数を数える（黙って捨てない）', () => {
    // usr_a を選ぶと落ちるのは usr_b の pt_1 の 1 件。
    expect(
      convertWorkspaceBackup(jsonOf(makeWorkspaceBackup()), 'usr_a', { nowMs: NOW })
        .otherUserStandingMemoCount,
    ).toBe(1);
    // usr_b を選ぶと落ちるのは usr_a の pt_1 / pt_2 の 2 件。
    expect(
      convertWorkspaceBackup(jsonOf(makeWorkspaceBackup()), 'usr_b', { nowMs: NOW })
        .otherUserStandingMemoCount,
    ).toBe(2);
  });

  it('空白だけの継続メモ・移行対象外の患者・壊れた row は取りこぼし件数に数えない', () => {
    const backup = makeWorkspaceBackup();
    const stores = backup.stores as Record<string, unknown[]>;
    (stores.roundsUserStates ??= []).push(
      { key: 'usr_b::pt_2', userId: 'usr_b', patientId: 'pt_2', standingMemo: '  \n ' },
      // 移行対象になっていない患者への state。
      { key: 'usr_b::pt_gone', userId: 'usr_b', patientId: 'pt_gone', standingMemo: 'あり' },
      // key が正本形式と食い違う row。
      { key: 'wrong', userId: 'usr_b', patientId: 'pt_3', standingMemo: 'あり' },
      null,
    );
    expect(
      convertWorkspaceBackup(jsonOf(backup), 'usr_a', { nowMs: NOW }).otherUserStandingMemoCount,
    ).toBe(1);
  });

  it('RoundsConfig.closingPreset は注記だけにする', () => {
    const converted = convertWorkspaceBackup(jsonOf(makeWorkspaceBackup()), 'usr_a', {
      nowMs: NOW,
    });
    expect(converted.notes).toEqual(['closingPresetSkipped']);
  });

  it('壊れた patient/state/place row を捨てて有効 row を救う', () => {
    const backup = makeWorkspaceBackup();
    const stores = backup.stores as Record<string, unknown[]>;
    (stores.patients ??= []).push(
      null,
      { patientId: '', name: '壊れ' },
      { patientId: 'pt_bad' },
      { patientId: 'pt_blank', name: '   ' },
      { patientId: 'pt_1', name: '重複' },
    );
    (stores.roundsUserStates ??= []).push(
      { key: 'wrong', userId: 'usr_a', patientId: 'pt_3', standingMemo: '採用しない' },
      null,
    );
    const appSettings = stores.appSettings as Record<string, unknown>[];
    const places = appSettings.find((row) => row.key === 'placesConfig');
    (places?.items as unknown[]).push(null, { placeId: '', name: '壊れ' });

    const converted = convertWorkspaceBackup(jsonOf(backup), 'usr_a', { nowMs: NOW });
    expect(converted.patients).toHaveLength(3);
    expect(converted.places).toHaveLength(2);
    expect(
      converted.patients.find((patient) => patient.name === 'サンプル対象3')?.standingMemo,
    ).toBe('');
  });

  it('未知のユーザー指定を拒否する', () => {
    expect(() =>
      convertWorkspaceBackup(jsonOf(makeWorkspaceBackup()), 'usr_missing', { nowMs: NOW }),
    ).toThrow(WORKSPACE_IMPORT_USER_NOT_FOUND_MSG);
  });
});

describe('workspace backup envelope guard', () => {
  it('壊れた JSON を拒否する', () => {
    expect(() => listImportCandidates('{bad')).toThrow(WORKSPACE_IMPORT_JSON_UNREADABLE_MSG);
  });

  it('平文経路は暗号化封筒を受け取らず、パスフレーズ入力へ誘導する', () => {
    expect(() =>
      listImportCandidates(
        jsonOf({
          kind: 'HOSPITAL_WORKSPACE_BACKUP_ENC',
          version: 1,
          appId: 'hospital-workspace',
          data: 'E2:...',
        }),
      ),
    ).toThrow(WORKSPACE_IMPORT_ENCRYPTED_MSG);
  });

  it('DB schema v7 以外は単発変換の対象外として拒否する', () => {
    const backup = { ...makeWorkspaceBackup(), schemaVersion: 6 };
    expect(() => listImportCandidates(jsonOf(backup))).toThrow(workspaceImportSchemaMismatchMsg(6));
  });
});

// ============================
// 暗号化封筒 (HOSPITAL_WORKSPACE_BACKUP_ENC v1)
//
// fixture は foundation packPayload で自作する (実データ不要)。移行元 backupCrypto.ts と
// 同じ鍵導出をここでも書き、両者がバイト互換であることを round-trip で確かめる。
// iterations はテスト時間のため小さくする (復号側は封筒の値に従う)。
// ============================

const ENC_PASSPHRASE = 'test-passphrase';
const ENC_ITERATIONS = 1000;
const ENC_SALT = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);

function bytesToB64Url(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += String.fromCharCode(byte);
  return btoa(out).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function deriveKeyBytes(
  passphrase: string,
  iterations = ENC_ITERATIONS,
): Promise<Uint8Array> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: new Uint8Array(ENC_SALT), iterations },
    baseKey,
    256,
  );
  return new Uint8Array(bits);
}

async function makeEncryptedBackup(
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const keyBytes = await deriveKeyBytes(ENC_PASSPHRASE);
  const data = await packPayload(jsonOf(makeWorkspaceBackup()), {
    encrypt: true,
    compress: true,
    keyBytes,
  });
  return {
    kind: 'HOSPITAL_WORKSPACE_BACKUP_ENC',
    version: 1,
    appId: 'hospital-workspace',
    createdAt: '2026-07-30T00:00:00.000Z',
    kdf: { algo: 'PBKDF2-SHA256', iterations: ENC_ITERATIONS, salt: bytesToB64Url(ENC_SALT) },
    data,
    ...overrides,
  };
}

describe('decryptWorkspaceBackupJson', () => {
  it('暗号化封筒を復号し、平文と同じ移行結果になる（round-trip）', async () => {
    const encrypted = await makeEncryptedBackup();
    const plain = await decryptWorkspaceBackupJson(jsonOf(encrypted), ENC_PASSPHRASE);

    expect(listImportCandidates(plain)).toEqual([
      { id: 'usr_a', name: '利用者A' },
      { id: 'usr_b', name: '利用者B' },
    ]);
    const fromEncrypted = convertWorkspaceBackup(plain, 'usr_a', { nowMs: NOW });
    const fromPlain = convertWorkspaceBackup(jsonOf(makeWorkspaceBackup()), 'usr_a', {
      nowMs: NOW,
    });
    // pid / placeId は毎回採番されるので、ID を除いた中身（place は名前）で比べる。
    const strip = (data: typeof fromPlain) => {
      const placeName = new Map(data.places.map((place) => [place.placeId, place.name]));
      return {
        places: data.places.map((place) => place.name),
        patients: data.patients.map((patient) => ({
          ...patient,
          pid: '',
          placeId: placeName.get(patient.placeId) ?? '',
        })),
        notes: data.notes,
        otherUserStandingMemoCount: data.otherUserStandingMemoCount,
      };
    };
    expect(strip(fromEncrypted)).toEqual(strip(fromPlain));
  });

  it('パスフレーズが違えば復号できない（理由は 1 種類へ丸める）', async () => {
    const encrypted = await makeEncryptedBackup();
    await expect(decryptWorkspaceBackupJson(jsonOf(encrypted), 'wrong-passphrase')).rejects.toThrow(
      WORKSPACE_IMPORT_DECRYPT_FAILED_MSG,
    );
  });

  it('空のパスフレーズは復号を試みずに拒否する', async () => {
    const encrypted = await makeEncryptedBackup();
    await expect(decryptWorkspaceBackupJson(jsonOf(encrypted), '')).rejects.toThrow(
      WORKSPACE_IMPORT_PASSPHRASE_REQUIRED_MSG,
    );
  });

  it('data の改ざんを検出する（GCM タグ検証・部分復元しない）', async () => {
    const encrypted = await makeEncryptedBackup();
    const data = String(encrypted.data);
    const last = data.slice(-1);
    const tampered = data.slice(0, -1) + (last === 'A' ? 'B' : 'A');
    expect(tampered).not.toBe(data);
    await expect(
      decryptWorkspaceBackupJson(jsonOf({ ...encrypted, data: tampered }), ENC_PASSPHRASE),
    ).rejects.toThrow(WORKSPACE_IMPORT_DECRYPT_FAILED_MSG);
  });

  it('data を平文に差し替えた封筒は拒否する（パスフレーズ迂回を作らない）', async () => {
    const encrypted = await makeEncryptedBackup({ data: jsonOf(makeWorkspaceBackup()) });
    await expect(decryptWorkspaceBackupJson(jsonOf(encrypted), ENC_PASSPHRASE)).rejects.toThrow(
      WORKSPACE_IMPORT_ENC_PARAMS_INVALID_MSG,
    );
  });

  it('kdf の異常値を fail-closed で拒否する', async () => {
    const encrypted = await makeEncryptedBackup();
    const withKdf = (kdf: unknown) => jsonOf({ ...encrypted, kdf });
    const salt = bytesToB64Url(ENC_SALT);
    const bad = [
      { algo: 'PBKDF2-SHA256', iterations: 0, salt },
      { algo: 'PBKDF2-SHA256', iterations: -1, salt },
      { algo: 'PBKDF2-SHA256', iterations: 1.5, salt },
      { algo: 'PBKDF2-SHA256', iterations: Number.NaN, salt },
      { algo: 'PBKDF2-SHA256', iterations: 10_000_001, salt },
      { algo: 'PBKDF2-SHA256', iterations: '1000', salt },
      { algo: 'PBKDF2-SHA1', iterations: ENC_ITERATIONS, salt },
      { algo: 'PBKDF2-SHA256', iterations: ENC_ITERATIONS, salt: '' },
      { algo: 'PBKDF2-SHA256', iterations: ENC_ITERATIONS, salt: 'not+base64url/' },
      null,
    ];
    for (const kdf of bad) {
      await expect(decryptWorkspaceBackupJson(withKdf(kdf), ENC_PASSPHRASE)).rejects.toThrow(
        WORKSPACE_IMPORT_ENC_PARAMS_INVALID_MSG,
      );
    }
  });

  it('暗号化封筒でないものを渡したら復号しない', async () => {
    await expect(
      decryptWorkspaceBackupJson(jsonOf(makeWorkspaceBackup()), ENC_PASSPHRASE),
    ).rejects.toThrow(WORKSPACE_IMPORT_NOT_ENCRYPTED_MSG);
    await expect(decryptWorkspaceBackupJson('{bad', ENC_PASSPHRASE)).rejects.toThrow(
      WORKSPACE_IMPORT_JSON_UNREADABLE_MSG,
    );
  });
});

describe('detectWorkspaceBackupFile', () => {
  it('暗号化封筒と平文封筒を見分け、壊れた JSON は拒否する', async () => {
    expect(detectWorkspaceBackupFile(jsonOf(await makeEncryptedBackup()))).toBe('encrypted');
    expect(detectWorkspaceBackupFile(jsonOf(makeWorkspaceBackup()))).toBe('plain');
    expect(() => detectWorkspaceBackupFile('{bad')).toThrow(WORKSPACE_IMPORT_JSON_UNREADABLE_MSG);
  });
});

describe('prepareWorkspaceImportAppend', () => {
  it('既存データを含めず、incoming 側だけを返す（変更しない）', () => {
    const incoming = convertWorkspaceBackup(jsonOf(makeWorkspaceBackup()), 'usr_a', {
      nowMs: NOW,
    });
    const current = {
      places: [{ placeId: 'plc_existing', name: '既存' }],
      patients: [
        {
          ...(incoming.patients[0] as (typeof incoming.patients)[number]),
          pid: 'pat_existing',
          placeId: '',
        },
      ],
    };

    const prepared = prepareWorkspaceImportAppend(incoming, current);
    expect(prepared.places).toEqual(incoming.places);
    expect(prepared.patients).toEqual(incoming.patients);
  });

  it('ID衝突と取り込み外 place への参照を拒否する', () => {
    const incoming = convertWorkspaceBackup(jsonOf(makeWorkspaceBackup()), 'usr_a', {
      nowMs: NOW,
    });
    expect(() =>
      prepareWorkspaceImportAppend(incoming, {
        places: [incoming.places[0] as (typeof incoming.places)[number]],
        patients: [],
      }),
    ).toThrow(WORKSPACE_IMPORT_ID_COLLISION_MSG);

    const broken = {
      ...incoming,
      patients: incoming.patients.map((patient, index) =>
        index === 0 ? { ...patient, placeId: 'plc_missing' } : patient,
      ),
    };
    expect(() => prepareWorkspaceImportAppend(broken, { places: [], patients: [] })).toThrow(
      WORKSPACE_IMPORT_PLACE_REF_INVALID_MSG,
    );
  });
});
